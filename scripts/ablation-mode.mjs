/**
 * 消融实验：工作流模式到底改变了什么？
 *
 * ## 方法
 *
 * 受控消融：应用同一个插件，只切换一个变量（模式激活 / 未激活），
 * 对比系统提示章节输出与 pre-step 决定。代码路径完全相同。
 *
 * ## 为什么需要忠实的投影实现
 *
 * 模式状态存在会话投影里（这是设计选择：状态必须在日志里，才能在会话恢复后存活）。
 * 因此测试脚手架必须实现一个**真实的**投影注册表——折叠日志、按 key 读取状态——
 * 而不是让 stateOf 返回空值。否则测的是「投影缺失时的降级路径」，
 * 不是「模式本身是否有效」。
 *
 * 这个 stub 只实现插件真正用到的三个方法：register / stateOf / 日志折叠。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGES = join(HERE, '..', 'packages')
const load = (relative) => import(new URL(`file://${join(PACKAGES, relative).replace(/\\/g, '/')}`).href)

const plugin = await load('dsh-autoresearch/index.js')
const workflow = await load('dsh-autoresearch/lib/workflow.js')

/** 忠实的投影注册表：折叠事件日志，按 key 读状态。 */
function makeProjectionRegistry() {
  const units = new Map()
  return {
    register(definition) {
      units.set(definition.key, definition)
      return () => units.delete(definition.key)
    },
    stateOf(session, key) {
      const unit = units.get(key)
      if (unit === undefined) return undefined
      let state = unit.init()
      for (const event of session.events()) {
        state = unit.apply(state, event)
      }
      return state
    },
    registeredKeys: () => [...units.keys()],
  }
}

/**
 * 记录型假会话。
 *
 * **必须带 `id` 与 `header.cwd`** —— 它们不是装饰：`mode.js` 的进入命令会调
 * `bindSessionTask(dshHome, session.id, ...)` 并读 `session.header.cwd`，
 * 而 `bindSessionTask` 对空 `sessionId` 是**硬抛错**（「缺少会话标识，无法绑定任务根」）。
 *
 * 这个桩原先缺这两个字段，于是本测试**从未跑到断言就 crash** ——
 * 一直没被发现是因为它挂在「进入模式」那一步，报错看起来像产品缺陷，
 * 实际是夹具不完整。
 *
 * `cwd` **必须显式传测试的任务根，不能用 `process.cwd()` 兜底**：
 * 进入命令会 `detectTaskRoot(session.header.cwd)` 并自动绑定，
 * 而测试运行时的 `process.cwd()` 是**仓库根** —— 它本身也是一个任务根
 *（有 autoresearch-state.json），于是会话被绑到仓库根而不是临时任务根，
 * 后续 pre-step 读的是另一份状态文件。实测表现是「运行 D 状态改了却不重新注入」，
 * 排查时极易误判成产品缺陷。
 */
let sessionSeq = 0
function makeSession(cwd) {
  const log = []
  sessionSeq += 1
  return {
    id: `ablation-session-${sessionSeq}`,
    header: { cwd },
    events: () => log,
    append: (type, data) => {
      log.push({ type, data })
      return log.length
    },
    appended: () => log,
  }
}

/** 最小上下文：只实现插件真正用到的服务面，其余如实缺失。 */
function makeContext(session, taskRoot) {
  const record = { sections: [], tools: [], preStep: [], commands: [] }
  const sessionProjections = makeProjectionRegistry()
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => { fn(); return () => {} },
    on: (name, listener) => { if (name === 'agent/pre-step') record.preStep.push(listener); return () => {} },
    inject: (_services, fn) => { fn(ctx); return () => {} },
    tools: { register: (definition) => { record.tools.push(definition); return () => {} } },
    skills: { registerProvider: () => () => {} },
    sessionProjections,
    commands: { register: (definition) => { record.commands.push(definition); return () => {} } },
    systemPrompt: {
      section: (section) => { record.sections.push(section); return () => {} },
      getSectionOrder: (name) => ({ TOOL_COMPUTER_USE: 3000 }[name] ?? 0),
    },
    workingDirectory: { path: taskRoot },
  }
  return { ctx, record }
}

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

// ── 准备任务目录：阶段 authoring，一门禁 REJECT ──────────────────────────────

/**
 * 把 DSH_HOME 指向临时目录。
 *
 * **必须在 apply 之前设置**：模式装配会调 `bindSessionTask(dshHome, ...)`，
 * 而 dshHome 在未显式传入时由 `resolveDshHome()` 从 `$DSH_HOME` 解析，
 * 兜底是 `<cwd>/.dsh-home` —— 也就是**用户的真实目录**。
 *
 * 本测试此前没有会话 id，所以 `bindSessionTask` 直接抛错、从未写到盘上；
 * 给桩补上 id 后立刻暴露出这个泄漏：测试把 `ablation-session-N → <仓库根>`
 * 写进了用户真实的 `autoresearch-session-tasks.json`。
 * 测试**绝不能**碰用户的真实状态，所以这里显式隔离。
 */
const dshHome = await mkdtemp(join(tmpdir(), 'autoresearch-ablation-home-'))
process.env.DSH_HOME = dshHome

const taskRoot = await mkdtemp(join(tmpdir(), 'autoresearch-ablation-'))
await writeFile(join(taskRoot, 'autoresearch-state.json'), JSON.stringify({
  version: 1,
  taskId: 'ablation',
  phase: 'authoring',
  createdAt: 'T',
  updatedAt: 'T',
  history: [],
  gateResults: { 'G-FEASIBILITY': { verdict: 'REJECT', at: 'T', milestone: 'M2', checks: [] } },
  deliverableChecks: {},
  identity: null,
  runs: {},
  frozenManifest: {},
  intentionalChanges: [],
}, null, 2), 'utf8')

console.log('=== 消融实验：工作流模式 ===\n')
console.log('任务状态：阶段 authoring，G-FEASIBILITY=REJECT\n')

// ── 运行 A：模式未激活 ──────────────────────────────────────────────────────

console.log('【运行 A】模式未激活')
const sessionA = makeSession(taskRoot)
const { ctx: ctxA, record: recordA } = makeContext(sessionA, taskRoot)
plugin.apply(ctxA, { taskRoot, promptSection: true, enableModeCommand: true })

report('投影已注册', recordA !== undefined && ctxA.sessionProjections.registeredKeys().includes('autoresearch'),
  ctxA.sessionProjections.registeredKeys().join(','))

const sectionA = recordA.sections.find((s) => s.name === 'autoresearch:mode')
// 章节的 text 回调不接收参数（AssembleContext 无 agent）；直接调用即可。
const textA = sectionA?.text({})
report('未激活时章节为空串', textA === '', JSON.stringify(textA))

const preA = await recordA.preStep[0](
  { agent: { session: sessionA }, signal: { aborted: false } },
  async () => ({ kind: 'enter', messages: [] }),
)
report('未激活时 pre-step 不追加', preA.messages.length === 0, `messages=${preA.messages.length}`)

// ── 运行 B：模式激活（唯一变量）────────────────────────────────────────────

console.log('\n【运行 B】模式激活（唯一变量：追加一条模式事件）')
const sessionB = makeSession(taskRoot)
const { ctx: ctxB, record: recordB } = makeContext(sessionB, taskRoot)
plugin.apply(ctxB, { taskRoot, promptSection: true, enableModeCommand: true })

const command = recordB.commands.find((entry) => entry.name === 'autoresearch')
const offRegistration = { command: recordB.commands.find((entry) => entry.name === 'autoresearch-off') }
report('退出命令已注册', offRegistration.command !== undefined)

// harness 在执行命令前后写入 command/run 与 command/done —— 这是模式状态的来源。
// 测试必须模拟这一步，否则测的是「投影收不到事件」而不是模式本身。
// commandName：'autoresearch'（进入）或 'autoresearch-off'（退出）—— 两者都是
// 独立注册的真实命令（无参进入零摩擦的设计），模式状态由各自的 run/done 折叠。
const runCommand = async (session, args, commandName = 'autoresearch', handler = command.handler) => {
  const commandId = `cmd-${Math.random().toString(36).slice(2, 8)}`
  session.append('command/run', { commandId, name: commandName, args, source: 'user' })
  const result = await handler({
    agent: { session }, rawInput: args, attachments: [],
  })
  session.append('command/done', { commandId, kind: 'success' })
  return result
}

const commandResult = await runCommand(sessionB, '')
report('命令进入模式成功', commandResult.kind === 'success')
report('命令由 command/run 记录（不写自定义事件）',
  sessionB.appended().some((e) => e.type === 'command/run' && e.data.name === 'autoresearch'))

const sectionB = recordB.sections.find((s) => s.name === 'autoresearch:mode')
const textB = sectionB.text({})
report('激活时章节非空', typeof textB === 'string' && textB.length > 0, `${textB?.length ?? 0} 字符`)

const preB = await recordB.preStep[0](
  { agent: { session: sessionB }, signal: { aborted: false } },
  async () => ({ kind: 'enter', messages: [] }),
)
report('激活时 pre-step 追加一条消息', preB.messages.length === 1, `messages=${preB.messages.length}`)
report('消息含阶段指令', preB.messages[0]?.content?.[0]?.text?.includes('<autoresearch_step') === true)
report('消息标注来源', preB.messages[0]?.source?.kind === 'autoresearch-step')
// 两条路径职责不同：章节是静态策略，消息是动态指令。断言各自内容正确，
// 而不是断言两者相等 —— 那正是先前设计缺陷的来源。
report('章节含静态纪律',
  textB.includes('autoresearch_mode') && textB.includes('不得推进阶段'))
report('消息含动态指令（本步动作）',
  preB.messages[0]?.content?.[0]?.text?.includes('本步应做的事') === true)
report('章节与消息不重复声明同一事实',
  !textB.includes('本步应做的事') && !preB.messages[0]?.content?.[0]?.text?.includes('模式纪律'))
report('日志中无自定义事件类型（否则整个会话不可读）',
  sessionB.appended().every((e) => !String(e.type).startsWith('autoresearch/')))

// ── 运行 C：抑制重复注入 ────────────────────────────────────────────────────

console.log('\n【运行 C】同状态再次 pre-step（验证抑制）')
const preB2 = await recordB.preStep[0](
  { agent: { session: sessionB }, signal: { aborted: false } },
  async () => ({ kind: 'enter', messages: [] }),
)
report('指纹未变时不重复追加', preB2.messages.length === 0, `messages=${preB2.messages.length}`)

// ── 运行 D：状态变化后恢复注入 ─────────────────────────────────────────────

console.log('\n【运行 D】门禁结论变化后应重新注入')
await writeFile(join(taskRoot, 'autoresearch-state.json'), JSON.stringify({
  version: 1, taskId: 'ablation', phase: 'authoring', createdAt: 'T', updatedAt: 'T', history: [],
  gateResults: {
    'G-FEASIBILITY': { verdict: 'RECOMMEND', at: 'T', milestone: 'M2', checks: [] },
    'G-CONTRACT': { verdict: 'RECOMMEND', at: 'T', milestone: 'M3', checks: [] },
    'G-DOCKERFILE': { verdict: 'RECOMMEND', at: 'T', milestone: 'M3', checks: [] },
    'G-NOP-RESULT': { verdict: 'RECOMMEND', at: 'T', milestone: 'M3', checks: [] },
  },
  deliverableChecks: {}, identity: null, runs: {}, frozenManifest: {}, intentionalChanges: [],
}, null, 2), 'utf8')

const preD = await recordB.preStep[0](
  { agent: { session: sessionB }, signal: { aborted: false } },
  async () => ({ kind: 'enter', messages: [] }),
)
report('状态变化后重新注入', preD.messages.length === 1, `messages=${preD.messages.length}`)
report('新指令反映已通过（建议推进）',
  preD.messages[0]?.content?.[0]?.text?.includes('已全部通过') === true)

// ── 运行 E：退出模式 ────────────────────────────────────────────────────────

console.log('\n【运行 E】退出模式')
const offCommand = offRegistration.command
await runCommand(sessionB, '', 'autoresearch-off', offCommand.handler)
const textE = sectionB.text({})
report('退出后章节恢复空串', textE === '', JSON.stringify(textE))
const preE = await recordB.preStep[0](
  { agent: { session: sessionB }, signal: { aborted: false } },
  async () => ({ kind: 'enter', messages: [] }),
)
report('退出后不再注入', preE.messages.length === 0)

// ── 运行 F：会话恢复（核心主张）────────────────────────────────────────────

console.log('\n【运行 F】会话恢复：模式是否保留（新进程，内存为空）')
// 构造一个「日志里有进入事件、但插件是全新实例」的会话
const restored = makeSession(taskRoot)
restored.append('command/run', { name: 'autoresearch', commandId: 'restore-1', args: '' })
restored.append('command/done', { commandId: 'restore-1' })
const { ctx: ctxF, record: recordF } = makeContext(restored, taskRoot)
plugin.apply(ctxF, { taskRoot, promptSection: true, enableModeCommand: true })

const sectionF = recordF.sections.find((s) => s.name === 'autoresearch:mode')
const textF = sectionF.text({})
const preF = await recordF.preStep[0](
  { agent: { session: restored }, signal: { aborted: false } },
  async () => ({ kind: 'enter', messages: [] }),
)
// 章节是全局注册的（AssembleContext 无 agent），只能读进程级标志，
// 因此**进程重启后章节为空**是已知限制，不是缺陷：模式的核心行为（每步注入
// 指令）由投影驱动，恢复后照常生效。断言如实反映这一点。
report('恢复后章节为空（已知限制：章节读进程标志，不读会话日志）',
  textF === '',
  textF === '' ? '与设计一致' : '章节意外非空')
report('恢复后仍注入指令（核心行为由投影驱动，不受限制影响）',
  preF.messages.length === 1, `messages=${preF.messages.length}`)
report('恢复后指令内容含当前阶段（阶段来自状态文件，非日志）',
  preF.messages[0]?.content?.[0]?.text?.includes('autoresearch_step') === true)

// ── 消融结论 ────────────────────────────────────────────────────────────────

console.log('\n=== 消融结论 ===')
console.log(`章节长度差：${(textB?.length ?? 0) - (textA?.length ?? 0)} 字符（A 应为 0，B 应为静态策略长度）`)
console.log(`pre-step 消息差：${preB.messages.length - preA.messages.length} 条`)
report('机制有效（开关模式产生可观测差异）',
  (textB?.length ?? 0) > 0 && (textA?.length ?? 0) === 0 && preB.messages.length === 1)

await rm(taskRoot, { recursive: true, force: true })
await rm(dshHome, { recursive: true, force: true })
delete process.env.DSH_HOME

const failed = results.filter((entry) => !entry.ok)
console.log(`\n消融实验：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
await new Promise((resolve) => setTimeout(resolve, 200))
process.exitCode = failed.length === 0 ? 0 : 1
