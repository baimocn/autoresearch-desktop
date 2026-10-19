/**
 * 工作流模式 —— 状态与渲染。
 *
 * ## 第一性原理
 *
 * 「模式」与「工具箱」的区别只有一条：**谁决定下一步做什么**。
 * 工具箱等模型想起来调用；模式在每一步开始前由状态机告诉模型。
 *
 * 由此推出三个必要条件：
 *   1. 状态必须持久 —— 否则会话恢复后模式丢失
 *   2. 注入必须自动 —— 否则又回到「模型想起来才生效」
 *   3. 注入内容必须随状态变化 —— 否则只是把同一段文字反复塞进上下文
 *
 * ## 为什么折叠命令事件而不是自定义事件
 *
 * 模式状态（是否激活）折叠自 **`command/run` 与 `command/done`** —— 都是
 * harness 的已知事件类型，与 `plan-mode` 的做法一致。
 *
 * 这不只是「照抄」：会话读取路径会**拒绝解释**含未知事件类型的日志
 * （`validateStoredEvents`：unknown and not marked ignorable → throw），
 * 而 `Session.append()` 无法为事件设置 `ignorable` 信封标记 —— 该标记只能
 * 由持久化层写入，插件够不到。
 *
 * 实测后果：我曾用自定义类型 `autoresearch/step` 写日志，导致整个会话
 * **历史加载失败**（界面上显示「历史加载失败：contains event type
 * "autoresearch/step" unknown to this harness」）。改用命令事件后，
 * 日志始终可读。
 *
 * ## 抑制指纹不持久
 *
 * 指纹只存在于进程内存，用于避免同一状态反复注入。进程重启后第一次
 * 注入必然发生 —— 这是可接受的：多注入一次无害，而把指纹写进日志
 * 需要自定义事件，代价是整个会话不可读。
 *
 * @module dsh-autoresearch/lib/workflow
 */

import z from 'zod'
import { phaseById, nextPhase } from './phases.js'
import { GATES } from './gates.js'

/** 命令名：模式开关与状态折叠都按它识别。 */
export const MODE_COMMAND = 'autoresearch'

/** 投影键。 */
export const PROJECTION_KEY = 'autoresearch'

/** 投影状态 schema。 */
export const modeStateSchema = z.object({
  /** 是否处于模式。 */
  active: z.boolean(),
  /** 最近一次命令的目标状态；用于命令执行期间的乐观判定。 */
  wanted: z.boolean().nullable(),
  /** 正在执行的命令 id；`command/done` 到达时清空。 */
  runningCommandId: z.string().nullable(),
})

/**
 * 初始状态。
 *
 * @param startActive 配置驱动激活（headless 等无人值守场景）。默认 false，
 *   因为做题与随便聊天应当区分；但双路质检、远端长跑不可能交互输入命令，
 *   却同样需要门禁纪律。
 */
export function emptyMode(startActive = false) {
  return { active: startActive, wanted: null, runningCommandId: null }
}

/**
 * 折叠一条事件到模式状态。
 *
 * 只认两种已知事件：
 *   · `command/run`  name === 'autoresearch' → 记下目标状态
 *   · `command/done` 对应 commandId 完成     → 落到目标状态
 *
 * 其它事件原样返回，因此投影对日志里的任何内容都是安全的。
 */
export function foldMode(state, event) {
  const name = event.data?.name
  if (event.type === 'command/run' && (name === MODE_COMMAND || name === 'autoresearch-off')) {
    // 两个命令都驱动同一个模式状态：/autoresearch 进入，/autoresearch-off 退出。
    // 旧的 `/autoresearch off` 参数形态已拆分为独立命令，args 判断仅为兼容历史日志。
    const args = String(event.data.args ?? '').trim()
    const entering = name === MODE_COMMAND && args !== 'off' && args !== 'exit'
    return {
      ...state,
      wanted: entering,
      runningCommandId: event.data.commandId ?? null,
    }
  }
  if (event.type === 'command/done' && state.runningCommandId !== null
    && event.data?.commandId === state.runningCommandId) {
    return {
      active: state.wanted ?? state.active,
      wanted: null,
      runningCommandId: null,
    }
  }
  return state
}

/**
 * 渲染**静态模式策略** —— 供系统提示章节使用。
 *
 * 与 {@link renderStepDirective} 的分工：
 *   · 本函数（章节）：**静态且无状态依赖**。只说「模式已激活 + 纪律是什么」。
 *   · renderStepDirective（消息）：**动态**。说清这一步做什么、哪个阶段、
 *     哪些门禁未过、缺哪些交付物。
 *
 * 为什么章节刻意不含阶段：早期版本依赖阶段，导致配置驱动激活下章节渲染为空 ——
 * 一次真实会话抓包发现的。去掉依赖后，章节的输入只剩「是否激活」，不可能再分叉。
 * 阶段信息由每步注入的指令承担。
 *
 * 附注（2026-10-13 更正）：当时的理由是「章节是全局注册的，无法按会话求值」。
 * 那条**不成立** —— `section.text(context)` 收到的 `context` 是
 * `assembleContextFor(agent, signal)` 的产物，含 `agent`（见
 * `dsh-system-prompt/lib/index.js:342`），`dsh-plan-mode` 就靠它按会话求值。
 * 但章节不含阶段这个**结论仍然正确**：阶段属于「这一步做什么」，本来就该
 * 由每步注入的指令承担，塞进系统提示章节会让它随每步变化而反复失效缓存。
 *
 * @param active 模式是否激活
 * @returns 章节文本；未激活时返回空串（等于该章节不存在）
 */
export function renderModePolicy(active) {
  if (active !== true) return ''

  return [
    '<autoresearch_mode>',
    '你处于 AutoResearch 工作流模式。本模式的纪律：',
    '',
    '  · 门禁未全部通过前不得推进阶段；不允许跳级与回退',
    '  · 未知项写 UNKNOWN，缺失的命令/时间/退出码写 null 并解释，不伪造',
    '  · 每轮迭代必须留八字段记录，score 以评分脚本实际输出为准',
    '  · 交付物一改，旧的门禁结论即失效，必须重跑',
    '  · 不访问未公开评测资产、不修改 solution/ 以外的任务文件、不篡改评分脚本',
    '',
    '每一步开始时会自动收到该步的具体指令（含当前阶段、待处理门禁与缺失交付物），',
    '不需要主动查询进度。用 /autoresearch-off 退出本模式。',
    '</autoresearch_mode>',
  ].join('\n')
}

/**
 * 渲染「当前这一步的指令」。
 *
 * 含三部分：本步应做的事、待处理门禁、缺失交付物。
 * 阶段与纪律由 {@link renderModePolicy} 负责，此处不重复。
 *
 * 两个刻意的取舍：
 *   · 「本步应做的事」写在「待处理门禁」之前 —— 顺序影响模型先动哪个念头
 *   · 不写「你可以调用 X 工具」—— 工具目录已经列了；模式只说现在该做什么
 *
 * 多任务并行（方案 A）：会话绑定了任务根时，每条指令都回显绑定路径并要求
 * 工具调用显式携带 task 参数 —— 提醒在每一步都在场，比指望模型记得可靠。
 *
 * @param input.taskRoot 本会话绑定的任务根（未绑定时省略）
 * @param input.phaseId 当前阶段
 * @param input.gateResults 门禁结论（gate id → { verdict }）
 * @param input.missingRequired 缺失的必需交付物
 */
export function renderStepDirective(input) {
  const { phaseId, gateResults, missingRequired = [], taskRoot } = input
  const phase = phaseById(phaseId)

  if (phase === undefined) {
    return {
      text: `当前阶段标识 "${phaseId}" 无法识别。检查任务根目录里的 autoresearch-state.json 是否损坏。`,
      fingerprint: `unknown:${phaseId}`,
      blocking: [],
      phase: undefined,
    }
  }

  const gates = (phase.gates ?? []).map((gateId) => ({
    gateId,
    title: GATES[gateId]?.title ?? gateId,
    milestone: GATES[gateId]?.milestone ?? null,
    verdict: gateResults[gateId]?.verdict ?? null,
  }))
  // 未运行与未通过同样阻塞：不能因为某道门还没跑就跳过它。
  const blocking = gates.filter((entry) => entry.verdict !== 'RECOMMEND')

  const lines = [`<autoresearch_step phase="${phase.id}">`]

  if (taskRoot !== undefined) {
    lines.push(
      `本会话绑定的任务根：${taskRoot}`,
      '调用任何 autoresearch_* 工具都必须显式传 task 参数，值就是上面这个路径 —— 一步都不要省。',
    )
  }

  lines.push('本步应做的事：')

  if (blocking.length > 0) {
    const target = blocking[0]
    lines.push(`  1. 处理门禁 ${target.gateId}（${target.title}，里程碑 ${target.milestone}）`)
    lines.push(target.verdict === null
      ? '     该门禁尚未运行。先补齐它的输入，再运行。'
      : `     该门禁最近结论为 ${target.verdict}。失败只修当前最早失败项，后续暂停。`)
  } else {
    const next = nextPhase(phase.id)
    lines.push(next === undefined
      ? '  1. 本阶段门禁已全部通过，且已是最后阶段。整理三类交付目录并做提交前自查。'
      : `  1. 本阶段门禁已全部通过。可以推进到阶段 ${next.id}（${next.title}）。`)
  }

  if (missingRequired.length > 0) {
    lines.push(`  2. 补齐缺失的必需交付物（${missingRequired.length} 项）`)
    for (const item of missingRequired.slice(0, 3)) {
      lines.push(`     · ${item.path}${item.note === undefined ? '' : ` —— ${item.note}`}`)
    }
    if (missingRequired.length > 3) {
      lines.push(`     · 另有 ${missingRequired.length - 3} 项，见工作台「四阶段」页或任务目录`)
    }
  }

  lines.push('  3. 本轮结束后立即记录八字段轨迹；未记录的这一轮不算发生过')

  if (blocking.length > 0) {
    lines.push('', '待处理门禁：')
    for (const entry of blocking) {
      lines.push(`  ${entry.gateId}（${entry.milestone}）${entry.verdict ?? '未运行'}`)
    }
  }

  lines.push('</autoresearch_step>')

  const fingerprint = [
    phase.id,
    ...gates.map((entry) => `${entry.gateId}=${entry.verdict ?? 'null'}`),
    `missing=${missingRequired.length}`,
    taskRoot === undefined ? 'root=default' : `root=${taskRoot}`,
  ].join('|')

  return { text: lines.join('\n'), fingerprint, blocking, phase }
}

/**
 * 是否需要注入。
 *
 * 指纹由「阶段 + 各门禁结论 + 缺失数量」构成，未变时不重复注入 ——
 * 否则同一段文字会在每一轮反复进入上下文，既浪费预算又稀释注意力。
 *
 * `lastFingerprint` 由调用方在内存中维护（见 {@link import('./mode.js')}）。
 */
export function shouldNudge(active, lastFingerprint, fingerprint) {
  if (active !== true) return false
  if (lastFingerprint === null || lastFingerprint === undefined) return true
  return lastFingerprint !== fingerprint
}

/** 模式摘要，供状态工具与界面显示。 */
export function summarizeMode(state) {
  if (state.active !== true) {
    return { active: false, text: '工作流模式未激活。' }
  }
  return { active: true, text: '工作流模式已激活：每步开始前注入当前阶段指令与模式纪律。' }
}
