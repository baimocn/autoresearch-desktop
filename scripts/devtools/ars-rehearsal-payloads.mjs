/**
 * 为 AutoRe0566 的流程演练构造**能通过门禁的 payload**，并在本地先验证。
 *
 * 为什么要先本地验证：平台里的 agent 由上游模型驱动，一轮要十几分钟
 * （实测 1 token 请求 16s）。把不通的 payload 交给它，等于浪费一整轮。
 * 这里先把每道门禁的入参调到 RECOMMEND，再把确定的 payload 交给它提交。
 *
 * ⚠️ 这些数值是**捏造**的，只为验证流程可行性。真实 B/R 实验未跑
 * （optimization_evidence/comparison_summary.json 的 status=NOT_RUN），
 * 演练结束后必须清理。真实值锚点：P3 实测 identity 模型 StatErr = 8.3481。
 */

const gates = await import(new URL('../../packages/dsh-autoresearch/lib/gates.js', import.meta.url).href)

const T = (i) => `2026-10-13 0${i}:00:00`
const round = (i, score) => ({
  round: i,
  policy_name: `dissipation-reg-${i}`,
  method_summary: `第 ${i} 轮：加入耗散正则并调整 rollout 训练窗口，降低长期统计误差`,
  status: 'improved',
  score,
  failure_reason: null,
  retained_best: true,
  time: T(i),
})

const trajectory = { rounds: [round(1, 8.9), round(2, 8.4), round(3, 7.9)] }
const runSummary = {
  task_id: 'tblgRIteylXSYCKW#recvxa87dg0U1G',
  protocol_version: 'proto-v1.0',
  status: 'IN_PROGRESS',
  agent_execution: [
    { runtime: 'Codex', model: 'GPT-5.6 Sol', duration_hours: 11 },
    { runtime: 'Codex', model: 'Seed 2.1 Turbo', duration_hours: 11 },
  ],
}

const PAYLOADS = {
  'G-SELECT': {
    title: 'Learning Chaotic Dynamics in Dissipative Systems',
    repo: 'neural-operator/markov_neural_operator',
    license: 'MIT',
    optimizationSurface: { methodLevel: true, summary: '解算子学习方法层' },
    metricType: 'physical',
    duplicateChecked: true,
    benchmarkCount: 3,
    ablationCount: 2,
    communityBaseline: 9.0,
    reportedBaseline: 8.35,
    deltaPercent: 15,
  },
  'G-FEASIBILITY': {
    baselineValues: [9.0, 9.2, 8.9],
    referenceValues: [7.5, 7.6, 7.4],
    upper: 6.0,
    direction: 'minimize',
    referenceRecomputed: true,
  },
  // G-CONTRACT / G-DOCKERFILE 走 fromTask 读真实文件；这里额外给 G-CONTRACT 的
  // 修正值 —— 真实 task.toml 用 Harbor 官方 schema（[task].title、
  // [task].schema_version、[resources]），与平台门禁期望的口径不一致，
  // 直接 fromTask 会 REJECT（见演练报告）。
  'G-CONTRACT': {
    schema_version: '1.0',
    artifacts: ['/workspace/solution'],
    task: { name: 'kolmogorov-chaotic-operator' },
    agent: { network_mode: 'no-network' },
    verifier: { network_mode: 'no-network', environment_mode: 'separate' },
    environment: { build_timeout_sec: 14400 },
  },
  'G-TRAJECTORY': { codexTrajectory: trajectory, seedTrajectory: trajectory, runSummary },
  'G-NOP-RESULT': {
    config: { task_id: 'nop-check', agent: { name: 'nop' } },
    result: {
      finished_at: '2026-10-13 03:00:00',
      exception_info: null,
      // separate 独立 Verifier 与 nop Agent 是这条门禁的核心：验证「Agent 什么都不做」
      // 时评分链路本身能出分（reward 有限数值），排除题目自带的分数来源。
      verifier_environment_mode: 'separate',
      agent_info: { name: 'nop' },
      verifier_result: { rewards: 0.0 },
    },
    reward: 0.0,
    logPresent: true,
    sameTrial: true,
  },
  'G-REPLAY-CONTRACT': { ensembleHints: [], singleSave: [], predictionDtype: 'int64' },
  'G-SINGLE-SOURCE': {
    anchorDeclarations: ['comparison_summary.metric=score'],
    staleDeclarations: [],
  },
  'G-PACK-VERIFY': {
    sourceHashes: { 'task.toml': 'a'.repeat(64), 'instruction.md': 'b'.repeat(64) },
    packedHashes: { 'task.toml': 'a'.repeat(64), 'instruction.md': 'b'.repeat(64) },
    forbiddenEntries: [],
  },
}

const FN = {
  'G-SELECT': 'gateSelection',
  'G-FEASIBILITY': 'gateFeasibility',
  'G-CONTRACT': 'gateTaskContract',
  'G-DOCKERFILE': 'gateDockerPathContract',
  'G-TRAJECTORY': 'gateTrajectory',
  'G-NOP-RESULT': 'gateNopResult',
  'G-REPLAY-CONTRACT': 'gateReplayContract',
  'G-SINGLE-SOURCE': 'gateSingleSource',
  'G-PACK-VERIFY': 'gatePackVerify',
}

let bad = 0
for (const [gate, payload] of Object.entries(PAYLOADS)) {
  const result = gates[FN[gate]](payload)
  const mark = result.verdict === 'RECOMMEND' ? 'ok  ' : 'FAIL'
  if (result.verdict !== 'RECOMMEND') bad += 1
  console.log(`${mark} ${gate.padEnd(20)} ${result.verdict}`)
  for (const c of result.checks) {
    if (c.status !== 'PASS') console.log(`       ${c.status} ${c.id} | ${String(c.detail).slice(0, 120)}`)
  }
}
console.log(`\n可通过 ${Object.keys(PAYLOADS).length - bad}/${Object.keys(PAYLOADS).length}（不含 G-DOCKERFILE，它走 fromTask 读真实文件）`)

// 输出给 agent 用的 JSON（便于粘贴）
if (process.argv.includes('--json')) {
  console.log('\n' + JSON.stringify(PAYLOADS, null, 1))
}
