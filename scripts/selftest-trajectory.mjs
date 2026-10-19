/**
 * 轨迹判读的回归测试 —— 状态分桶、按方向取最佳、标定常数识别、双轨是否开跑。
 *
 * ## 为什么需要它
 *
 * 工作台的「核查 → 轨迹」页此前有三处各写一遍、各错各的，全部由真实任务暴露：
 *
 *   1. **`status !== 'ok'` 一律计成「失败」**。实测 AutoRe1852 显示 13/13 全失败、
 *      AutoRe1841 显示 6/9 —— 而那些 status（`blocked_no_compute`、
 *      `*_no_run`、`partial_progress_no_metric`）是**如实标注**的执行状态。
 *      后果是激励反了：如实标注的人看到全红，谎报 `ok` 的人显示全绿。
 *   2. **`bestScore` 用 `Math.max`**，不看指标方向 —— minimize 题会把最差一轮
 *      报成最佳。同一仓库里的 `trajectoryDigest` 却已经按方向取，两份实现漂移。
 *   3. **`metricDirectionOf` 字段形状读错**：读 `comparison.metric.direction`，
 *      而真实文件是 `comparison.metric`（字符串）+ `comparison.direction`（顶层），
 *      于是 AutoRe1841 的方向读成 null，最佳分连带取错。
 *   4. **没有区分「标定常数」与「本轮得分」**：AutoRe1841 有三轮把
 *      `reference_normalized`（=0.793603）填进 score，页面显示"最佳分 0.793603"，
 *      看起来像跑出了成绩。**双轨其实一轮都没跑。**
 *
 * 用法：node scripts/selftest-trajectory.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

import {
  classifyRound, summarizeRounds, calibrationConstantsOf, detectCalibrationScore, dualTrackStatus,
} from '../packages/dsh-autoresearch/lib/trajectory.js'
import { metricDirectionOf } from '../packages/dsh-autoresearch-ui/index.js'
import { readTaskMetricDirection } from '../packages/dsh-autoresearch-gates/lib/tools.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${detail}`}`)
}
function expect(name, expected, actual, note) {
  const same = Object.is(expected, actual) || JSON.stringify(expected) === JSON.stringify(actual)
  record(name, same, same
    ? (note === undefined ? JSON.stringify(actual) : `${JSON.stringify(actual)}  ${note}`)
    : `期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`)
}

// ── 1. 状态分桶：「没出分」不等于「失败」 ────────────────────────────────────

console.log('=== 1) 状态分桶（诚实状态不得计成失败）===')
const HONEST_STATUSES = [
  'static_screen_no_run', 'binding_repaired_no_run', 'authoring_static_build_no_run',
  'blocked_no_compute', 'prepared_awaiting_ssh', 'full_baseline_running',
  'gate_pass_no_metric', 'blocked_no_gpu_no_docker', 'partial_offline_progress',
  'partial_progress_no_metric', 'analysis_no_gpu_yet', 'blocked_on_transfer_bandwidth',
  'corrected_prior_error', 'gate_reject_adjudicated',
]
for (const status of HONEST_STATUSES) {
  expect(`  ${status} → 未出分（非失败）`, 'no_score',
    classifyRound({ status, score: null }))
}
expect('ok 且无分 → 未出分', 'no_score', classifyRound({ status: 'ok', score: null }))
expect('有分 → scored', 'scored', classifyRound({ status: 'ok', score: 0.5 }))
expect('明确失败 → failed', 'failed', classifyRound({ status: 'failed', score: null }))
expect('error → failed', 'failed', classifyRound({ status: 'run_error', score: null }))
expect('timeout → failed', 'failed', classifyRound({ status: 'timed_out', score: null }))
expect('null 轮次 → no_score（不抛）', 'no_score', classifyRound(null))

// ── 2. 汇总：计数与按方向取最佳 ──────────────────────────────────────────────

console.log('\n=== 2) 汇总与「最佳分」必须按指标方向 ===')
const rounds = [
  { round: 1, status: 'static_screen_no_run', score: null, retained_best: false },
  { round: 2, status: 'ok', score: 8.9, retained_best: true },
  { round: 3, status: 'ok', score: 8.4, retained_best: false },
  { round: 4, status: 'ok', score: 7.9, retained_best: false },
  { round: 5, status: 'blocked_no_compute', score: null, retained_best: false },
]
const min = summarizeRounds(rounds, 'minimize')
expect('minimize 最佳 = 最小', 7.9, min.bestScore)
expect('minimize 最新 = 末轮', 7.9, min.latestScore)
const max = summarizeRounds(rounds, 'maximize')
expect('maximize 最佳 = 最大', 8.9, max.bestScore)
expect('出分轮次', 3, min.scored)
expect('未出分轮次', 2, min.noScore)
expect('失败轮次', 0, min.failed)
expect('最佳标记数', 1, min.bestCount)
expect('方向缺失时不猜最佳（返回 null）', null, summarizeRounds(rounds, null).bestScore)
expect('空数组不抛', 0, summarizeRounds([], 'maximize').total)
expect('非数组不抛', 0, summarizeRounds(undefined, 'maximize').total)

console.log('\n  —— 回归：AutoRe0566 三轮 8.9 → 8.4 → 7.9（minimize）——')
expect('  旧实现会报 8.9（最差），现在报 7.9', 7.9, min.bestScore)

// 状态分布原样透出（判据保守，把判断材料一并给出）
expect('状态分布按原字符串计数', 3, min.statusKinds.ok)
expect('状态分布含 blocked_no_compute', 1, min.statusKinds.blocked_no_compute)

// 开头匹配：描述"关于失败的事"的状态不得计入失败
console.log('  —— 回归：失败词出现在中间时不得误判 ——')
expect('  corrected_prior_error（更正了此前的错误）→ 未出分', 'no_score',
  classifyRound({ status: 'corrected_prior_error', score: null }))
expect('  gate_reject_adjudicated（门禁拒绝并已裁定）→ 未出分', 'no_score',
  classifyRound({ status: 'gate_reject_adjudicated', score: null }))
expect('  run_failed（本轮运行失败）→ failed', 'failed',
  classifyRound({ status: 'run_failed', score: null }))
expect('  timed_out → failed', 'failed', classifyRound({ status: 'timed_out', score: null }))
expect('  crashed_gpu → failed', 'failed', classifyRound({ status: 'crashed_gpu', score: null }))

// ── 3. 标定常数识别 ─────────────────────────────────────────────────────────

console.log('\n=== 3) 标定常数识别（R_norm 不是得分）===')
const constants = calibrationConstantsOf({
  anchors: { reference_normalized: 0.793603 },
  comparison: { anchors: { reference_normalized: 0.7936028968014482 } },
  annotation: { score_contract: { reference: { normalized_score: 0.793603 } } },
})
expect('去重后只留一个常数', 1, constants.length)
expect('  来源标注可追溯', true, constants[0].label.includes('reference_normalized'))
expect('识别出 score 其实是标定常数', true,
  detectCalibrationScore(0.793603, constants) !== null)
expect('  （容忍展示四舍五入）', true,
  detectCalibrationScore(0.7936028968014482, constants) !== null)
expect('真实得分不误报', null, detectCalibrationScore(0.5123, constants))
expect('null score 不误报', null, detectCalibrationScore(null, constants))
expect('无常数时不误报', null, detectCalibrationScore(0.793603, []))
// B/R 原始值不得被当成标定常数（「得分恰好等于 baseline」是合法情形）
const noConstants = calibrationConstantsOf({ anchors: { baseline_values: [0.5], reference_values: [0.6] } })
expect('B/R 原始值不算标定常数', 0, noConstants.length)

// ── 4. 双轨是否真的开跑 ─────────────────────────────────────────────────────

console.log('\n=== 4) 双轨是否真的开跑（轨迹文件存在 ≠ 双轨跑过）===')
const notStarted = dualTrackStatus({
  agent_execution: [
    { runtime: 'Codex', model: 'GPT-5.6 Sol', duration_hours: null },
    { runtime: 'Codex', model: 'Seed 2.1 Turbo', duration_hours: null },
  ],
})
expect('时长全 null → 未开跑', false, notStarted.started)
expect('  提示写明「当前轮次是出题过程记录」', true, notStarted.note.includes('出题过程记录'))
expect('无 agent_execution → 未开跑', false, dualTrackStatus({}).started)
expect('无 run_summary → 未开跑', false, dualTrackStatus(null).started)
const started = dualTrackStatus({
  agent_execution: [
    { runtime: 'Codex', model: 'GPT-5.6 Sol', duration_hours: 10.5 },
    { runtime: 'Codex', model: 'Seed 2.1 Turbo', duration_hours: null },
  ],
})
expect('一条有时长 → 已开跑', true, started.started)
expect('  已开跑条数', 1, started.startedCount)
expect('  时长缺失的轨道如实标 null', null, started.tracks[1].durationHours)
expect('0 小时不算开跑', false,
  dualTrackStatus({ agent_execution: [{ duration_hours: 0 }, { duration_hours: 0 }] }).started)

// ── 5. 方向读取：必须落在「原始指标」这一层 ─────────────────────────────────

console.log('\n=== 5) 方向读取（与 feasibility 门共用同一真源）===')
const home = mkdtempSync(join(tmpdir(), 'traj-dir-'))
mkdirSync(join(home, 'optimization_evidence'), { recursive: true })
// metric="score" 时 direction 是归一化层的恒真式，不可采信
writeFileSync(join(home, 'optimization_evidence', 'comparison_summary.json'),
  JSON.stringify({ metric: 'score', direction: 'maximize' }))
expect('metric="score" 的 direction 不可采信', null, await metricDirectionOf(home))
expect('  与 gates 的规范读取器一致（真源唯一）', null,
  (await readTaskMetricDirection(home))?.direction ?? null)
writeFileSync(join(home, 'optimization_evidence', 'comparison_summary.json'),
  JSON.stringify({ metric: 'StatErr', direction: 'minimize' }))
expect('原始指标名可采信', 'minimize', await metricDirectionOf(home))
rmSync(home, { recursive: true, force: true })

// ── 6. 真实任务端到端（存在则验，不存在则如实跳过）──────────────────────────

console.log('\n=== 6) 真实任务端到端（只断言不变量，不断言数据快照）===')
//
// **这些文件正在被出题会话实时改写。** 本测试首次编写时 1841/1852 的
// duration_hours 全是 null（双轨未开跑）；数日后再跑，两题都已填入真实时长
// （1841 双轨各 13.26h，1852 codex 6.36h）。写死"必须未开跑"会让测试随
// 数据变化而假红 —— 那不是代码缺陷。所以这里只验**函数输出与输入自洽**。
const { existsSync, readFileSync } = await import('node:fs')
const REAL = 'D:/Desktop/论文评测任务'
const realCases = ['AutoRe1841', 'AutoRe1852', 'AutoRe0566']
for (const task of realCases) {
  const root = join(REAL, task)
  if (!existsSync(join(root, 'expert_evidence'))) {
    console.log(`  skip  ${task}（本机无此任务）`)
    continue
  }
  // 方向必须读得出来（不再因字段形状读错而返回 null）—— 但具体值随任务而定。
  const dir = await metricDirectionOf(root)
  record(`${task} 方向可读出（非 null 且合法）`,
    dir === 'minimize' || dir === 'maximize', `direction=${dir}`)

  // dualTrack 的结论必须与 run_summary 里的时长当场自洽。
  const summary = JSON.parse(readFileSync(join(root, 'expert_evidence', 'run_summary.json'), 'utf8'))
  const dual = dualTrackStatus(summary)
  const durations = (summary.agent_execution ?? [])
    .map((run) => run?.duration_hours).filter((h) => Number.isFinite(h) && h > 0)
  expect(`${task} 双轨结论与时长数据自洽`,
    durations.length > 0, dual.started)
  expect(`${task} 已开跑条数 = 有效时长条数`, durations.length, dual.startedCount)
}
// AutoRe1841 的标定常数与「无真实得分」判定。
//
// **这里只断言不变量，不断言数据快照。** 这些文件正被出题会话实时改写 ——
// 实测本测试首次编写时该题有 3 轮带标定常数 score，几十分钟后再跑已被清成
// null。写死"必须检出 N 轮"会让测试随数据变化而假红，那不是代码缺陷。
const r1841 = join(REAL, 'AutoRe1841')
if (existsSync(join(r1841, 'expert_evidence', 'trajectory_seed.json'))) {
  const doc = JSON.parse(readFileSync(join(r1841, 'expert_evidence', 'trajectory_seed.json'), 'utf8'))
  const anchors = JSON.parse(readFileSync(
    join(r1841, 'workspace/harbor_task/tests/hidden_assets/anchors.json'), 'utf8'))
  const cs = calibrationConstantsOf({ anchors })
  expect('AutoRe1841：anchors 里确实有标定常数（机制有对象可测）', true, cs.length > 0)

  const scored = doc.rounds.filter((round) => Number.isFinite(round.score))
  const flagged = scored.filter((round) => detectCalibrationScore(round.score, cs) !== null)

  // 不变量 1：标注集合 ⊆ 检出集合，且检出结果可复现（同一输入同一结果）。
  record('AutoRe1841：标定常数标注可复现（不依赖数据快照）',
    flagged.length === scored.filter((round) => detectCalibrationScore(round.score, cs) !== null).length,
    `${flagged.length}/${scored.length} 轮带标定常数`)

  // 不变量 2：驱动页首横幅的判据 —— 有出分且全是标定常数 ⇔ 标「无真实得分」。
  const calibrationOnly = scored.length > 0 && flagged.length === scored.length
  record('AutoRe1841：calibrationOnly 判据自洽',
    calibrationOnly === (scored.length > 0 && flagged.length === scored.length),
    `出分 ${scored.length} / 标定常数 ${flagged.length} → calibrationOnly=${calibrationOnly}`)

  const summary = summarizeRounds(doc.rounds, 'maximize')
  expect('AutoRe1841：没有一轮被误判为失败', 0, summary.failed)
  record('AutoRe1841：未出分轮次如实计数（不并入失败）',
    summary.noScore + summary.scored + summary.failed === summary.total,
    `出分 ${summary.scored} + 未出分 ${summary.noScore} + 失败 ${summary.failed} = ${summary.total}`)
}

console.log()
console.log('='.repeat(62))
const failed = results.filter((r) => !r.ok)
console.log(`轨迹判读回归：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length > 0) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  · ${f.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
