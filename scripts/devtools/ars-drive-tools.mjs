/**
 * 平台工具层驱动器 —— 脱离 LLM 直接调用平台的真实工具实现。
 *
 * ## 为什么需要它
 *
 * 演练时上游模型 API 完全不可用（实测 5/5 请求返回 502/503
 * `Upstream service temporarily unavailable`），平台如实报 `PI_AI_ERROR`，
 * 对话驱动的路径整轮失败、一个工具都没调。而**平台自身的逻辑**（阶段推进、
 * 门禁判定、状态机写入、产物核对）并不依赖 LLM —— 那些是 `defineTool` 里的
 * 纯 JS 实现。
 *
 * 这个驱动器把插件的 `apply(ctx, config)` 跑在一个最小 ctx 桩上，捕获注册的
 * 工具定义，然后按调用方的意图逐个 `execute(args, exec)`。走的路径与
 * agent 调用时**完全相同**：同样的参数校验、同样的 `resolveRootFor`、
 * 同样的 `mutate` 原子写回、同样的门禁函数。
 *
 * 区别只有一个：调用者是人而不是模型。因此它验证的是「平台能不能跑通」，
 * 不能验证「模型会不会照着步骤指令做」。
 *
 * 用法：
 *   node scripts/devtools/ars-drive-tools.mjs list
 *   node scripts/devtools/ars-drive-tools.mjs call <tool> '<json args>'
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const TASK = process.env.AR_TASK ?? 'D:/Desktop/评测任务占位'
const DSH_HOME = process.env.DSH_HOME ?? join(ROOT, '.dsh-home')

/** 捕获工具定义的最小 ctx 桩。 */
function makeCtx(captured) {
  const noop = () => () => {}
  return {
    logger: { info: () => {}, warn: (...a) => console.log('  [warn]', ...a), error: (...a) => console.log('  [error]', ...a) },
    effect: (fn) => { try { fn() } catch { /* 桩：忽略 */ } return () => {} },
    on: () => () => {},
    tools: {
      register: (definition) => { captured.set(definition.name, definition) },
      guard: () => () => {},
      restrict: () => () => {},
    },
    systemPrompt: {
      section: () => () => {},
      getSectionOrder: () => 3000,
    },
    sessionProjections: {
      register: () => () => {},
      stateOf: () => null,
    },
    agents: {},
    skills: { registerProvider: () => () => {} },
    commands: { register: () => () => {} },
    connection: { fetch: { register: () => () => {} } },
    slots: { register: () => () => {}, inject: () => () => {} },
    layout: { selectPanel: () => {} },
    inject: () => () => {},
  }
}

const captured = new Map()
const pluginPath = join(ROOT, 'packages', 'dsh-autoresearch', 'index.js')
const plugin = await import(pathToFileURL(pluginPath).href)
const ctx = makeCtx(captured)
plugin.apply(ctx, {
  taskRoot: TASK,
  dshHome: DSH_HOME,
  promptSection: false,   // 演练不需要往系统提示里塞东西
  enableModeCommand: false,
  restrictWhenActive: false,
  windowsGuard: false,
})

const [command, ...rest] = process.argv.slice(2)

if (command === 'list') {
  for (const [name, def] of captured) {
    console.log(`  ${name}`)
    const props = def.parameters ?? {}
    console.log(`      参数: ${Object.keys(props).join(', ') || '(无)'}`)
  }
} else if (command === 'call') {
  const toolName = rest[0]
  const args = rest[1] ? JSON.parse(rest[1]) : {}
  const def = captured.get(toolName)
  if (!def) {
    console.error('未注册的工具:', toolName)
    process.exit(1)
  }
  // exec 桩：显式传 task 时只需要 agent.session.id 可用（用于会话绑定回退）。
  const exec = { agent: { session: { id: null, header: { cwd: process.cwd() } }, ctx } }
  const value = await def.execute(args, exec)
  const report = typeof value?.report === 'string' ? value.report : JSON.stringify(value, null, 1)
  console.log(report)
} else {
  console.log('用法: list | call <tool> \'<json args>\'')
}
