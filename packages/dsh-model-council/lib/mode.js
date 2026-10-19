/**
 * 议会模式 —— 把议会接入一个正在跑的普通会话。
 *
 * ## 第一性原理
 *
 * 「模式」与「工具箱」的区别只有一条：**谁决定下一步做什么**。工具箱等模型
 * 想起来调用；模式在每一步开始前由状态告诉模型。
 *
 * 由此推出三个必要条件（与 `dsh-autoresearch/lib/workflow.js` 同源）：
 *   1. 状态必须持久 —— 否则会话恢复后模式丢失
 *   2. 注入必须自动 —— 否则又回到「模型想起来才生效」
 *   3. 注入内容必须随状态变化 —— 否则只是把同一段文字反复塞进上下文
 *
 * ## 为什么折叠命令事件而不是自定义事件
 *
 * 模式状态折叠自 **`command/run` 与 `command/done`**（harness 已知事件类型）。
 * 会话读取路径会**拒绝解释**含未知事件类型的日志，而 `Session.append()` 无法
 * 设置 `ignorable` 信封标记（插件够不到）—— 仓库实测踩过：自定义事件类型
 * 导致整个会话历史加载失败。命令事件没这个问题。
 *
 * ## 为什么这个章节能按会话求值
 *
 * `dsh-autoresearch` 的政策章节读的是一个**进程级全局标志**，它的注释说
 * 「AssembleContext 没有 agent 字段」。这条注释是**错的**：章节的 `text`
 * 回调收到 `{ agent, scope, signal }`，`dsh-plan-mode` 正是靠读
 * `context.agent.session` 做按会话求值。所以这里直接用 agent，不再需要
 * 全局标志 —— 多会话并行时全局标志本来就会串味。
 *
 * ## 两级强制
 *
 *   · 建议式（/council）        —— 只注入纪律 + 提供工具
 *   · 强制式（/council-strict） —— 外加：高风险工具在拿到裁定前被拒，
 *                                  且 ask_user_question 被重定向到议会
 *
 * 强制式要挂**两处**（缺一不可，理由同 autoresearch）：`agent/created`
 * 覆盖「创建时已激活」的会话（重启恢复），命令处理器覆盖「会话中途进入」。
 *
 * ## 刻意不接门禁
 *
 * 议会不参与 `advance`，也不改变任何门禁判定。它是决策辅助 —— 替人做选择，
 * 不为结果背书。把它变成硬门禁会让它退化成合规仪式（见 docs/deliberation-board.md）。
 *
 * @module dsh-model-council/lib/mode
 */

import z from 'zod'

export const MODE_COMMAND = 'council'
export const STRICT_COMMAND = 'council-strict'
export const OFF_COMMAND = 'council-off'

/** 投影键。 */
export const PROJECTION_KEY = 'model-council'

/** 命令名 → 目标等级。 */
export const LEVEL_OF_COMMAND = Object.freeze({
  [MODE_COMMAND]: 'advisory',
  [STRICT_COMMAND]: 'strict',
  [OFF_COMMAND]: 'off',
})

export const LEVEL_LABEL = Object.freeze({ off: '关闭', advisory: '建议式', strict: '强制式' })

/**
 * 强制式下被拦截的高风险工具。
 *
 * 选它们的判据是**不可逆**：写文件、改文件、执行命令。只读工具（read / glob /
 * grep / web_fetch）一律不拦 —— 拦截只读工具除了烦人没有任何安全收益。
 *
 * `ask_user_question` 不在这份清单里：它由 guard 重定向到议会，而不是简单拒绝
 * （拒绝只会让模型换个说法再问，重定向才真的替代了人工）。
 */
export const HIGH_RISK_TOOLS = Object.freeze(['bash', 'pwsh', 'write', 'edit', 'str_replace_editor'])

export const modeStateSchema = z.object({
  /** 是否处于模式（level !== 'off'）。 */
  active: z.boolean(),
  /** 生效等级。 */
  level: z.enum(['off', 'advisory', 'strict']),
  /** 最近一次命令的目标等级；命令执行期间的乐观判定用。 */
  wanted: z.enum(['off', 'advisory', 'strict']).nullable(),
  /** 正在执行的命令 id；`command/done` 到达时清空。 */
  runningCommandId: z.string().nullable(),
})

export function emptyMode() {
  return { active: false, level: 'off', wanted: null, runningCommandId: null }
}

/**
 * 折叠一条事件到模式状态。
 *
 * 只认两种已知事件；其它事件原样返回，因此投影对日志里的任何内容都安全。
 */
export function foldMode(state, event) {
  const name = event.data?.name
  if (event.type === 'command/run' && Object.hasOwn(LEVEL_OF_COMMAND, name)) {
    return { ...state, wanted: LEVEL_OF_COMMAND[name], runningCommandId: event.data.commandId ?? null }
  }
  if (event.type === 'command/done' && state.runningCommandId !== null
    && event.data?.commandId === state.runningCommandId) {
    const level = state.wanted ?? state.level
    return { active: level !== 'off', level, wanted: null, runningCommandId: null }
  }
  return state
}

/** 从模式状态取生效等级（未激活即 off）。 */
export function levelOfMode(mode) {
  if (mode?.active !== true) return 'off'
  return mode.level ?? 'off'
}

/**
 * 渲染议会模式的**政策章节**。
 *
 * 未激活时返回空串（等于该章节不存在）。等级决定是否追加强制式说明。
 */
export function renderCouncilPolicy(level) {
  if (level !== 'advisory' && level !== 'strict') return ''
  const lines = [
    '<model_council>',
    '你处于**模型议会模式**。议会由多个独立模型组成，按身份对抗审议（议员提案 · 对抗者攻击 · 裁决者定夺）。',
    '',
    '## 无人监管纪律',
    '',
    '当对话走到**需要人工决策**的点 —— 要在多个方案间选择、要在不可逆动作前取舍、'
    + '或本来要调用 ask_user_question 询问用户 —— **不要停下来等用户**。',
    '改为调用 `council_convene`，把「本轮上下文 + 候选选项」交给议会，'
    + '把返回的 `chosen` 当作用户的选择，然后继续执行。',
    '',
    '## 不可伪造',
    '',
    '· 议会结论**只能来自工具返回**。不得自行编造「议会认为…」「经审议决定…」。',
    '· 工具没返回裁定，就如实说没有裁定，不得假装开过议会。',
    '· 议会是决策辅助，不等于实测证据：它替你做选择，不为结果背书。',
    '',
  ]
  if (level === 'strict') {
    lines.push(
      '## 强制式（本会话）',
      '',
      `· 在拿到一次议会裁定之前，高风险工具（${HIGH_RISK_TOOLS.join(' / ')}）会被拒绝。`,
      '· 询问用户被重定向到议会 —— 不要试图换一种说法绕过。',
      '· 拿到裁定后高风险工具自动放行。',
      '',
    )
  }
  lines.push('用 /council-off 退出本模式。', '</model_council>')
  return lines.join('\n')
}

/**
 * 安装议会模式。
 *
 * @param ctx cordis 上下文（需已声明 tools / systemPrompt / sessionProjections）
 * @param deps.config 已合并配置（`restrictTools` 覆盖高风险清单）
 * @param deps.logger 日志器（可省）
 * @returns 供工具层复用的钩子：`levelOf` / `applyStrict` / `liftStrict` / `releaseHighRisk`
 */
export function installCouncilMode(ctx, deps) {
  const config = deps?.config ?? {}
  const logger = deps?.logger ?? ctx.logger
  const restrictTools = Array.isArray(config.restrictTools) && config.restrictTools.length > 0
    ? config.restrictTools
    : HIGH_RISK_TOOLS

  /** agent → 限制 disposer。 */
  const restrictions = new WeakMap()
  /** agent → guard disposer。 */
  const guards = new WeakMap()

  // ── 会话投影：折叠命令事件 ────────────────────────────────────────────────

  ctx.effect(() => ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: modeStateSchema,
    init: () => emptyMode(),
    apply: (state, event) => foldMode(state, event),
  }), 'model-council: mode projection')

  const modeOf = (session) => {
    const registry = ctx.sessionProjections
    if (registry === undefined || typeof registry.stateOf !== 'function') return emptyMode()
    return registry.stateOf(session, PROJECTION_KEY) ?? emptyMode()
  }

  const levelOf = (session) => levelOfMode(modeOf(session))

  // ── 强制式的两条挂载 ──────────────────────────────────────────────────────

  /** 拦截高风险工具 + 把「询问用户」重定向到议会。幂等。 */
  const applyStrict = (agent) => {
    if (restrictions.has(agent)) return
    try {
      if (typeof agent?.ctx?.tools?.restrict === 'function') {
        restrictions.set(agent, agent.ctx.tools.restrict({ deny: restrictTools }))
      }
    } catch (error) {
      logger?.warn?.('model-council: 应用工具限制失败：%o', error)
    }
    try {
      if (typeof agent?.ctx?.tools?.guard === 'function') {
        guards.set(agent, agent.ctx.tools.guard((exec) => {
          if (exec?.name !== 'ask_user_question') return undefined
          return '无人监管的议会模式：不要询问用户。'
            + '请调用 council_convene，把本轮上下文与候选选项交给议会，把返回的 chosen 当作人类的选择。'
        }))
      }
    } catch (error) {
      logger?.warn?.('model-council: 应用询问重定向失败：%o', error)
    }
  }

  /** 只放行高风险工具，保留「不许问用户」的重定向。拿到裁定后调用。 */
  const releaseHighRisk = async (agent) => {
    const disposer = restrictions.get(agent)
    if (disposer === undefined) return
    restrictions.delete(agent)
    try { await disposer() } catch (error) { logger?.warn?.('model-council: 放行失败：%o', error) }
  }

  /** 完全撤除强制式（退出模式 / 降级到建议式）。 */
  const liftStrict = async (agent) => {
    await releaseHighRisk(agent)
    const guardDisposer = guards.get(agent)
    if (guardDisposer === undefined) return
    guards.delete(agent)
    try { await guardDisposer() } catch (error) { logger?.warn?.('model-council: 撤除重定向失败：%o', error) }
  }

  ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
    if (levelOf(agent?.session) === 'strict') applyStrict(agent)
  }), 'model-council: agent/created strict hook')

  // ── 政策章节：按会话求值 ─────────────────────────────────────────────────

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'model-council:mode',
    order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') + 70,
    // 章节的 text 回调收到 { agent, scope, signal } —— 按会话求值（plan-mode 同做法）。
    text: (context) => {
      if (context?.agent === undefined) return ''
      return renderCouncilPolicy(levelOf(context.agent.session))
    },
  }), 'model-council: mode section')

  // ── 三个命令：全部无参零摩擦 ──────────────────────────────────────────────
  //
  // 刻意不声明 `input`：声明了 input 的命令第一次 Enter 是「认领参数」而不执行，
  // 最常用的无参路径被迫按两次回车（autoresearch 实测用户视为「没反应」）。
  // 因此参数化形态拆成独立命令，而不是 /council strict。

  const COMMANDS = [
    { name: MODE_COMMAND, level: 'advisory', description: '进入模型议会模式（建议式）：需要人工决策时由议会代选' },
    { name: STRICT_COMMAND, level: 'strict', description: '进入模型议会模式（强制式）：高风险工具须先取得议会裁定' },
    { name: OFF_COMMAND, level: 'off', description: '退出模型议会模式' },
  ]

  ctx.inject(['commands'], (commandCtx) => {
    for (const entry of COMMANDS) {
      commandCtx.commands.register({
        name: entry.name,
        description: entry.description,
        handler: async ({ agent }) => {
          const session = agent.session
          const mode = modeOf(session)
          // command/run 已到达、handler 未返回，所以 active 还是旧值 —— 判定必须用 wanted。
          const effective = mode.wanted ?? mode.level
          if (effective === entry.level) {
            return { kind: 'success', text: `议会模式已是「${LEVEL_LABEL[entry.level]}」，无需重复切换。` }
          }
          if (entry.level === 'strict') applyStrict(agent)
          else await liftStrict(agent)
          return {
            kind: 'success',
            text: entry.level === 'off'
              ? '已退出议会模式。'
              : `已进入议会模式（${LEVEL_LABEL[entry.level]}）。`
                + (entry.level === 'strict'
                  ? '拿到一次议会裁定前，高风险工具会被拒绝；询问用户被重定向到议会。'
                  : '需要人工决策时，模型会把本轮上下文交给议会代选。'),
          }
        },
      })
    }
  })

  return { modeOf, levelOf, applyStrict, liftStrict, releaseHighRisk }
}
