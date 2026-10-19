/**
 * 工作流模式的装配。
 *
 * ## 两条投递路径
 *
 *   系统提示章节  →  renderModePolicy   静态：模式已激活 + 纪律
 *   pre-step 消息 →  renderStepDirective 动态：这一步具体做什么
 *
 * ## 状态来源
 *
 * 折叠 **`command/run` 与 `command/done`**（已知事件类型），与 plan-mode 一致。
 * 不用自定义事件类型：会话读取路径拒绝解释含未知类型的日志，而
 * `Session.append()` 无法设置 `ignorable` 信封标记 —— 插件够不到。
 * 实测踩过：自定义事件导致整个会话历史加载失败。
 *
 * ## 会话 ↔ 任务绑定（多任务并行，方案 A）
 *
 * `/autoresearch-task <路径>` 把当前会话绑定到一个任务根；绑定持久化在
 * DSH_HOME 的 autoresearch-session-tasks.json（见 lib/session-tasks.js）。
 * 每步指令回显绑定路径并要求工具调用显式携带 task 参数；工具侧的解析顺序
 * 是「显式参数 > 会话绑定 > 配置根」。一个会话驱动一个任务，多任务并行 =
 * 多个会话各绑一个根。
 *
 * ## 工具限制
 *
 * 模式激活时限制非工作流工具。限制是**每个 agent 自己的** scoped 生效，
 * 两条覆盖路径缺一不可：
 *   · agent/created —— 创建时模式已激活的会话（配置驱动激活、重启恢复）
 *   · 命令处理器   —— 会话中途进入/退出（agent 已存在，created 不会再触发）
 * 曾经的 bug：这段逻辑被错误嵌进命令处理器的 leaving 分支，导致只有退出
 * 模式才注册限制，而且无条件生效 —— 两头都错。
 *
 * ## 抑制指纹
 *
 * 只存进程内存。重启后第一次注入必然发生 —— 可接受：多注入一次无害，
 * 而持久化指纹需要自定义事件，代价是会话不可读。
 *
 * @module dsh-autoresearch/lib/mode
 */

import { randomUUID } from 'node:crypto'
import {
  MODE_COMMAND, PROJECTION_KEY, modeStateSchema,
  emptyMode, foldMode, renderModePolicy, renderStepDirective, shouldNudge, summarizeMode,
} from './workflow.js'
import {
  bindSessionTask, readSessionTask, clearSessionTask, resolveDshHome,
  detectTaskRoot, registerTaskInWorkbench, TASK_ROOT_MARKERS,
} from './session-tasks.js'

/**
 * 安装工作流模式。
 *
 * @param ctx cordis 上下文（需已声明 tools / systemPrompt / sessionProjections / commands 依赖）
 * @param deps.config 已合并的配置
 * @param deps.buildDirective 异步读取任务状态并渲染本步指令；入参为会话对象（可读绑定）→ { directive, phase }
 * @param deps.logger 日志器（可省）
 */
export function installMode(ctx, deps) {
  const { buildDirective, config } = deps
  const logger = deps.logger ?? ctx.logger
  const startActive = config.modeActiveByDefault === true
  /** 模式激活时是否限制非工作流工具。 */
  const restrictWhenActive = config.restrictWhenActive === true
  /** 被限制的工具名列表。 */
  const restrictedTools = Array.isArray(config.restrictedTools) ? config.restrictedTools : []
  const dshHome = resolveDshHome(config.dshHome)

  /** 进程级激活标志：章节是全局注册的，只能读这个。 */
  let interactiveActive = false

  /** 指纹缓存：避免同一状态重复注入。进程级，不持久化。 */
  const fingerprints = new WeakMap()

  /** 已应用的工具限制（agent → disposer）：退出模式时撤除。 */
  const activeRestrictions = new WeakMap()

  const restrictionEnabled = () => restrictWhenActive && restrictedTools.length > 0

  /** 给一个 agent 套上工具限制（幂等）。 */
  const applyRestriction = (agent) => {
    if (!restrictionEnabled()) return
    if (typeof agent?.ctx?.tools?.restrict !== 'function') return
    if (activeRestrictions.has(agent)) return
    try {
      const disposer = agent.ctx.tools.restrict({ deny: restrictedTools })
      activeRestrictions.set(agent, disposer)
    } catch (error) {
      logger?.warn?.('autoresearch: 应用工具限制失败：%o', error)
    }
  }

  /** 撤除一个 agent 的工具限制（幂等）。 */
  const liftRestriction = async (agent) => {
    const disposer = activeRestrictions.get(agent)
    if (disposer === undefined) return
    activeRestrictions.delete(agent)
    try {
      await disposer()
    } catch (error) {
      logger?.warn?.('autoresearch: 撤除工具限制失败：%o', error)
    }
  }

  // ── 会话投影：折叠命令事件 ────────────────────────────────────────────────

  ctx.effect(() => ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: modeStateSchema,
    init: () => emptyMode(startActive),
    apply: (state, event) => foldMode(state, event),
  }), 'autoresearch: mode projection')

  /** 读模式状态；投影不可用时回退到「未激活」。 */
  const modeOf = (session) => {
    const registry = ctx.sessionProjections
    if (registry === undefined || typeof registry.stateOf !== 'function') {
      return emptyMode(startActive)
    }
    return registry.stateOf(session, PROJECTION_KEY) ?? emptyMode(startActive)
  }

  // ── 创建时已激活的会话：限制立即生效 ──────────────────────────────────────

  if (restrictionEnabled()) {
    ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
      const mode = modeOf(agent.session)
      if (mode.active === true) applyRestriction(agent)
    }), 'autoresearch: agent/created restriction hook')
  }

  // ── 条件式提示章节：静态纪律 ──────────────────────────────────────────────

  if (config.promptSection) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'autoresearch:mode',
      order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') + 60,
      // 章节的 text 回调**确实能拿到 agent**（`assembleContextFor(agent, signal)`
      // → `{ agent, scope, signal }`，`dsh-system-prompt/lib/index.js:342` 把它传给
      // `section.text(context)`；`dsh-plan-mode` 正是这么按会话求值的）。
      // 早期注释写「AssembleContext 无 agent 字段」，那条是错的 —— 见
      // packages/dsh-model-council/lib/mode.js 用 agent 按会话求值的写法。
      // 这里仍保留全局标志只是**不改动既有行为**（改它要重验工作流模式），
      // 不是因为没有 agent。
      text: () => renderModePolicy(startActive || interactiveActive),
    }), 'autoresearch: mode section')
  }

  // ── 进入 / 退出 / 绑定命令 ────────────────────────────────────────────────

  if (config.enableModeCommand) {
    ctx.inject(['commands'], (commandCtx) => {
      commandCtx.commands.register({
        name: MODE_COMMAND,
        description: '进入 AutoResearch 工作流模式（自动绑定并登记当前目录的任务）',
        // 刻意不声明 input：声明了 input 的命令第一次 Enter 是「认领参数」，
        // 不执行 —— 最常用的无参进入被迫按两次回车，实测用户视为「没反应」。
        // 无参路径必须零摩擦；参数化子命令拆成独立命令（/autoresearch-off、
        // /autoresearch-task，见下方注册）。
        handler: async ({ agent }) => {
          const session = agent.session

          // 不写自定义事件：命令自身已由 command/run 与 command/done 记录，
          // 投影据此折叠出模式状态。这正是 plan-mode 的做法。
          interactiveActive = true


          // ── 进入模式时自动识别并登记任务根 ─────────────────────────────────
          //
          // 不带参数进入模式 = 「把当前目录的任务纳入工作流」。命令自己把这件事
          // 做完，而不是让用户先手动登记、再绑定、再进入（三步操作是设计缺陷）。
          // 判定顺序：已绑定沿用 > 会话 cwd 是任务根 > cwd 下一级唯一任务根 >
          // 都失败则如实说明，不做任何猜测性绑定。
          let autoBound = await readSessionTask(dshHome, session.id)
          let autoNote = null
          if (autoBound === null) {
            const cwd = typeof session.header?.cwd === 'string' && session.header.cwd !== ''
              ? session.header.cwd
              : process.cwd()
            const detected = await detectTaskRoot(cwd)
            if (detected.kind === 'exact') {
              autoBound = await bindSessionTask(dshHome, session.id, detected.path)
              autoNote = `已自动绑定当前目录为任务根：${autoBound}`
            } else if (detected.kind === 'child') {
              autoBound = await bindSessionTask(dshHome, session.id, detected.path)
              autoNote = `当前目录下面发现任务根，已自动绑定：${autoBound}`
            } else if (detected.kind === 'ambiguous') {
              autoNote = [
                `当前目录下有多个任务根，未自动绑定。选一个再执行：`,
                ...detected.candidates.slice(0, 8).map((candidate) => `  /autoresearch-task ${candidate}`),
              ].join('\n')
            } else {
              autoNote = [
                `[v2] 当前目录不是任务根（markers: ${TASK_ROOT_MARKERS.join(' | ')}），也未在下一级发现唯一任务根。`,
                `  任务根会自动登记到工作台；若是新任务，先在该目录运行 autoresearch_init 初始化。`,
                `  也可手动指定：/autoresearch-task <路径>`,
              ].join('\n')
            }
          } else {
            autoNote = `本会话已绑定任务根：${autoBound}`
          }

          // 绑定的任务自动登记到工作台清单（幂等）：登记与绑定是同一件事的两面，
          // 不该让用户在工作台界面上再做一次手工登记。
          if (autoBound !== null) {
            try {
              await registerTaskInWorkbench(dshHome, autoBound)
            } catch (error) {
              logger?.warn?.('autoresearch: 登记任务到工作台失败：%o', error)
            }
          }

          const mode = modeOf(session)
          if (mode.active === true && mode.wanted === null) {
            return {
              kind: 'success',
              text: ['工作流模式本就处于激活状态。', autoNote].filter(Boolean).join('\n'),
            }
          }

          // 中途进入：agent 已存在，agent/created 不会再触发 —— 限制现在套上。
          //
          // 判据必须是 wanted || active，不能只看 active：
          // foldMode 在 `command/done` 才把 wanted 落到 active，而 harness 是先追加
          // `command/run`、**再**调用 handler、最后才追加 `command/done`。所以 handler
          // 执行期间 active 仍是**进入前**的值（新会话为 false），只看 active 会让
          // 限制永远套不上，而 agent/created 早已错过 —— 结果是 /autoresearch 变成
          // 「只提醒不约束」，模型照样能调 remote_submit / qa_dual。
          if (mode.wanted === true || mode.active === true) applyRestriction(agent)

          const { phase } = await buildDirective(session)
          return {
            kind: 'success',
            text: [
              `已进入 AutoResearch 工作流模式（阶段 ${phase?.order ?? '?'}/4：${phase?.title ?? '未知'}）。`,
              '',
              autoNote,
              '',
              '从此每步开始前会自动注入当前阶段指令，系统提示里常驻模式纪律。',
              '退出用 /autoresearch-off；绑定其他任务用 /autoresearch-task <路径>。',
            ].filter((line) => line !== null && line !== undefined).join('\n'),
          }
        },
      })

      // ── /autoresearch-off：退出模式 ────────────────────────────────────────
      commandCtx.commands.register({
        name: 'autoresearch-off',
        description: '退出 AutoResearch 工作流模式',
        handler: async ({ agent }) => {
          interactiveActive = false
          await liftRestriction(agent)
          return { kind: 'success', text: '已退出 AutoResearch 工作流模式。' }
        },
      })

      // ── /autoresearch-task：绑定本会话到任务根（参数必需，claim 合理） ──────
      commandCtx.commands.register({
        name: 'autoresearch-task',
        description: '把当前会话绑定到一个 AutoResearch 任务根（自动登记到工作台）',
        input: { hint: '<任务根路径>', attachments: false },
        handler: async ({ agent, rawInput }) => {
          const session = agent.session
          const target = String(rawInput ?? '').trim()
          if (target === '') {
            const bound = await readSessionTask(dshHome, session.id)
            return {
              kind: 'success',
              text: bound === null
                ? '本会话未绑定任务根。填写路径后提交即可绑定。'
                : `本会话绑定的任务根：${bound}。换绑直接修改路径后重新提交。`,
            }
          }
          const bound = await bindSessionTask(dshHome, session.id, target)
          try {
            await registerTaskInWorkbench(dshHome, bound)
          } catch (error) {
            logger?.warn?.('autoresearch: 登记任务到工作台失败：%o', error)
          }
          return {
            kind: 'success',
            text: [
              `已把本会话绑定到任务根：${bound}`,
              '已同步登记到工作台任务组合。',
              'autoresearch_* 工具调用应显式携带 task 参数；未携带时按会话绑定解析。',
            ].join('\n'),
          }
        },
      })
    })
  }

  // ── 每步拦截：注入动态指令 ────────────────────────────────────────────────

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    // 与 plan-mode 同样的时序：先拿到原有决定，再在其上追加。
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    const session = agent.session
    const mode = modeOf(session)
    if (mode.active !== true) return decision

    let built
    try {
      built = await buildDirective(session)
    } catch (error) {
      logger?.warn?.('autoresearch: 生成本步指令失败：%o', error)
      return decision
    }

    const { directive } = built
    const previous = fingerprints.get(session) ?? null
    if (!shouldNudge(mode.active, previous, directive.fingerprint)) return decision
    fingerprints.set(session, directive.fingerprint)

    return {
      ...decision,
      messages: [...decision.messages, createStepMessage(directive.text)],
    }
  })

  return {
    read: (session) => summarizeMode(modeOf(session)),
    stateOf: modeOf,
    policyText: () => renderModePolicy(startActive || interactiveActive),
  }
}

/**
 * 构造注入用的消息。
 *
 * 用 user 角色而非 system：system 提示在请求组装期固定，而这里要在步与步
 * 之间插入新指令。作为持久消息追加才能与日志一致。
 * `source.kind` 标记来源，便于客户端与审计把它与真人输入区分开。
 *
 * 注意：这是**消息**（走 `agent/pre-step` 的 messages 通道），不是会话事件，
 * 因此不受「未知事件类型拒绝解释」的限制。
 */
export function createStepMessage(text) {
  return {
    // id 必须在写入时就位：user/message 事件的存储校验要求每条消息有非空 id，
    // 缺 id 的会话在加载时被整体拒绝（实测踩过 —— 所有含注入消息的历史会话
    // 全部「历史加载失败」）。规范路径是 llm 包的 createUserMessage，这里
    // 不引依赖，用 randomUUID 等价生成。
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'autoresearch-step' },
  }
}
