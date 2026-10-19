/**
 * 轨迹轮次的分析助手 —— 状态分桶、按方向取最佳、标定常数识别、双轨是否开跑。
 *
 * ## 为什么单独成模块
 *
 * 这三件事此前散落在两处、各写一遍，于是各错各的：
 *   · `dsh-autoresearch-ui/index.js` 的 `/trajectory` 路由用 `Math.max` 取最佳分
 *     （不看指标方向，minimize 题会把**最差**一轮报成最佳）；
 *   · 同一个文件里的 `trajectoryDigest` 却已经按方向取了 `Math.min`；
 *   · 两处都把 `status !== 'ok'` 一律计成「失败」。
 *
 * 抽成纯函数后，路由、摘要、工具、门禁共用一份判据，测试也只测这一份。
 *
 * ## 三个刻意的判定原则
 *
 * 1. **「没出分」≠「失败」。** SOP 只要求 status「填写真实执行状态」，
 *    **没有规定词表**。所以 `blocked_no_compute`（算力阻塞）、
 *    `partial_offline_progress`（离线部分推进）、`*_no_run`（本阶段本就不跑）
 *    都是**诚实的**状态，不是失败。早期把它们一律染成红色「失败」，
 *    后果是：如实标注状态的人看到 100% 失败，而谎报 `ok` 的人显示全绿 ——
 *    激励正好反了。
 *
 * 2. **失败判据保守。** 只有 status 明确表达失败才计入 `failed`；其余
 *    归入 `noScore` 并把**原始 status 原样透出**。宁可少报失败（把判断
 *    交给使用者看原始字符串），也不要把诚实状态误判成失败。
 *
 * 3. **标定常数不是得分。** `score` 按 SOP 是「声明的 Public/Dev 原始指标」。
 *    而 `R_norm`（Reference 在评分公式下的位置）是**标定常数**：B/R/U 一定
 *    它就不变，与"本轮方法改进了多少"无关。实测 AutoRe1841 的轨迹把
 *    `reference_normalized` 填进了两轮的 score，页面于是显示"有最佳分"。
 *    这里只做**事实陈述**（"该值与 anchors.reference_normalized 逐位相同"），
 *    不指控，也不擅自改数。
 *
 * @module dsh-autoresearch/lib/trajectory
 */

/**
 * 明确表达失败的 status 标记 —— 只认**开头**的失败词。
 *
 * 为什么必须限定在开头：status 是自由文本，失败词出现在中间通常是在
 * **描述一件关于失败的事**，而不是"这一轮失败了"。实测反例
 * `corrected_prior_error`（更正了此前的错误）—— 按"包含 error"判定会把
 * 一次成功的纠正算成失败，正是这个函数要避免的那类误判。
 *
 * 开头匹配下：`failed` / `error` / `run_failed` / `timed_out` / `crashed_gpu`
 * 计入失败；`corrected_prior_error` / `gate_reject_adjudicated` 不计入。
 */
const FAILURE_MARKERS = /^(failed|failure|error|errored|crash|crashed|aborted|timeout|timed_out|run_failed|run_error)([_\-\s]|$)/i

/**
 * 一条轮次属于哪一桶。
 *
 * @returns {'scored'|'failed'|'no_score'}
 */
export function classifyRound(round) {
  if (round === null || typeof round !== 'object') return 'no_score'
  if (Number.isFinite(round.score)) return 'scored'
  return FAILURE_MARKERS.test(String(round.status ?? '')) ? 'failed' : 'no_score'
}

/**
 * 汇总一组轮次。
 *
 * @param rounds 轮次数组
 * @param direction 'minimize' | 'maximize' | null
 * @returns 计数、最佳/最新分（按方向）、以及原始 status 分布
 */
export function summarizeRounds(rounds, direction = null) {
  const list = Array.isArray(rounds) ? rounds : []
  const scored = list.filter((round) => classifyRound(round) === 'scored')
  const failed = list.filter((round) => classifyRound(round) === 'failed')
  const noScore = list.filter((round) => classifyRound(round) === 'no_score')

  const scores = scored.map((round) => round.score)
  // 最佳必须按方向取：minimize 下 Math.max 会把最差一轮报成最佳。
  // direction 缺失时**不猜**，如实返回 null（页面显示 —）。
  const bestScore = scores.length === 0 || direction === null
    ? null
    : (direction === 'minimize' ? Math.min(...scores) : Math.max(...scores))

  // 原始 status 分布原样透出：判据保守，所以把判断材料一并给出。
  const statusKinds = {}
  for (const round of list) {
    const key = String(round?.status ?? '(空)')
    statusKinds[key] = (statusKinds[key] ?? 0) + 1
  }

  return {
    total: list.length,
    scored: scored.length,
    failed: failed.length,
    noScore: noScore.length,
    bestCount: list.filter((round) => round?.retained_best === true).length,
    latestScore: scores.length > 0 ? scores[scores.length - 1] : null,
    bestScore,
    direction,
    statusKinds,
  }
}

/** 浮点近似相等（容忍展示时的四舍五入：0.793603 vs 0.7936028968…）。 */
function nearlyEqual(a, b, tolerance = 1e-6) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance
}

/**
 * 收集题目里的**标定常数** —— 那些「B/R/U 一定就不变」的派生值。
 *
 * 只收确实代表标定结果的字段，不收 B/R 原始值本身（B/R 是实测，虽也固定，
 * 但把它们列进来会让"得分恰好等于 baseline"这种合法情形被误报）。
 */
export function calibrationConstantsOf({ anchors, comparison, annotation } = {}) {
  const out = []
  const push = (value, label) => {
    if (Number.isFinite(value)) out.push({ value, label })
  }

  push(anchors?.reference_normalized, 'anchors.reference_normalized')
  push(comparison?.anchors?.reference_normalized, 'comparison_summary.anchors.reference_normalized')
  push(annotation?.score_contract?.reference?.normalized_score,
    'expert_annotation.score_contract.reference.normalized_score')
  push(annotation?.reference?.normalized_score, 'expert_annotation.reference.normalized_score')

  // 去重：同一常数常在多处出现（anchors 与 comparison 会各存一份）。
  const seen = new Set()
  return out.filter((item) => {
    const key = item.value.toFixed(6)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 一条轮次的 score 是否其实是标定常数。
 *
 * 只做**事实陈述**：返回值说明它等于哪个字段。不指控作者、不改数据 ——
 * 由调用方决定是告警还是标注。
 *
 * @returns {{constant: number, label: string}|null}
 */
export function detectCalibrationScore(score, constants) {
  if (!Number.isFinite(score)) return null
  for (const item of constants ?? []) {
    if (nearlyEqual(score, item.value)) return { constant: item.value, label: item.label }
  }
  return null
}

/**
 * 双轨（两条长程）是否**真的开跑过**。
 *
 * 判据取自 `run_summary.json` 的 `agent_execution[*].duration_hours`：
 * SOP 规则 8 要求两条轨道各自有效 ≥10h（或满足 7h 例外），所以**时长是
 * 唯一的硬证据**。轨迹文件存在 ≠ 双轨跑过 —— 出题过程本身也会记轮次，
 * 实测 AutoRe1841 的 9 轮全是静态筛查/绑定/阻塞记录，时长字段为 null。
 *
 * @returns 每轨的时长与「是否至少一轨已开跑」
 */
export function dualTrackStatus(runSummary) {
  const runs = Array.isArray(runSummary?.agent_execution) ? runSummary.agent_execution : []
  const tracks = runs.map((run) => ({
    runtime: run?.runtime ?? null,
    model: run?.model ?? null,
    durationHours: Number.isFinite(run?.duration_hours) ? run.duration_hours : null,
  }))
  const started = tracks.filter((track) => track.durationHours !== null && track.durationHours > 0)
  return {
    // 两条记录都没有时长 ⇒ 双轨尚未开跑。这正是 AutoRe1841/1852 的真实状态。
    started: started.length > 0,
    startedCount: started.length,
    recorded: tracks.length,
    tracks,
    note: runs.length === 0
      ? 'run_summary.json 没有 agent_execution 记录：双轨尚未开跑。'
      : (started.length === 0
        ? 'agent_execution 里两条轨道的 duration_hours 均为 null：双轨尚未开跑，'
          + '当前轨迹里的轮次是出题过程记录，不是双轨长跑记录。'
        : `${started.length}/${tracks.length} 条轨道已有有效时长。`),
  }
}
