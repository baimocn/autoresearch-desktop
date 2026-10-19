/**
 * 自检：在无 harness 运行时的情况下验证门禁内核、状态机、脚手架、技能目录与工具包装。
 * 覆盖教程与 SOP 的关键判据，避免「静态全绿、真机必挂」。
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGES = join(HERE, '..', 'packages')
const load = (relative) => import(new URL(`file://${join(PACKAGES, relative).replace(/\\/g, '/')}`).href)

const gates = await load('dsh-autoresearch/lib/gates.js')
const state = await load('dsh-autoresearch/lib/state.js')
const scaffold = await load('dsh-autoresearch/lib/scaffold.js')
const phases = await load('dsh-autoresearch/lib/phases.js')
const catalog = await load('dsh-autoresearch-skills/lib/catalog.js')
const tools = await load('dsh-autoresearch-gates/lib/tools.js')
const qaRunner = await load('dsh-autoresearch-qa/lib/runner.js')
const qaZip = await load('dsh-autoresearch-qa/lib/zip.js')
const workflow = await load('dsh-autoresearch/lib/workflow.js')
const sessionTasks = await load('dsh-autoresearch/lib/session-tasks.js')
const redlines = await load('dsh-autoresearch/lib/redlines.js')
const ui = await load('dsh-autoresearch-ui/index.js')
const plugin = await load('dsh-autoresearch/index.js')

let passed = 0
let failed = 0
const cases = []
function test(name, fn) { cases.push({ name, fn }) }

// ── 数值与归一化 ────────────────────────────────────────────────────────────

test('sampleStd 与教程 n−1 公式一致', () => {
  const values = [0.157842, 0.159233, 0.158650, 0.164539, 0.159531]
  const sigma = gates.sampleStd(values)
  assert.ok(Math.abs(sigma - 0.002640) < 5e-7, `σ=${sigma}`)
})

test('normalize maximize 与 minimize 方向正确且不裁剪', () => {
  assert.equal(gates.normalize(0.55, 0.55, 0.80, 'maximize'), 0)
  assert.equal(gates.normalize(0.80, 0.55, 0.80, 'maximize'), 1)
  assert.ok(gates.normalize(0.90, 0.55, 0.80, 'maximize') > 1, '超过 U 允许 >1')
  assert.ok(gates.normalize(0.50, 0.55, 0.80, 'maximize') < 0, '低于 B 允许 <0')
  assert.equal(gates.normalize(0.55, 0.55, 0.30, 'minimize'), 0)
  assert.equal(gates.normalize(0.30, 0.55, 0.30, 'minimize'), 1)
})

test('G-SELECT：纯调参优化面判 REJECT', () => {
  const result = gates.gateSelection({
    title: 'T', repo: 'owner/name', license: 'MIT',
    optimizationSurface: { methodLevel: false }, duplicateChecked: true,
    communityBaseline: 60, reportedBaseline: 58, deltaPercent: 34,
    metricType: 'physical', benchmarkCount: 3, ablationCount: 2,
  })
  assert.equal(result.verdict, 'REJECT')
  assert.ok(result.checks.some((item) => item.id === 'G0.4' && item.status === 'FAIL'))
})

test('G-SELECT：baseline 口径差 >15 判 REJECT', () => {
  const result = gates.gateSelection({
    title: 'T', repo: 'owner/name', license: 'MIT',
    optimizationSurface: { methodLevel: true }, duplicateChecked: true,
    communityBaseline: 81.8, reportedBaseline: 58.0, deltaPercent: 34,
    metricType: 'physical', benchmarkCount: 3, ablationCount: 2,
  })
  assert.equal(result.verdict, 'REJECT')
  assert.ok(result.checks.some((item) => item.id === 'G0.9' && item.status === 'FAIL'))
})

test('G-SELECT：未知项判 NEEDS_EVIDENCE 而非通过', () => {
  const result = gates.gateSelection({
    title: 'T', repo: 'owner/name', license: 'UNKNOWN',
    optimizationSurface: { methodLevel: true }, duplicateChecked: true,
    communityBaseline: 60, reportedBaseline: 58, deltaPercent: 34,
    metricType: 'physical', benchmarkCount: 3, ablationCount: 2,
  })
  assert.equal(result.verdict, 'NEEDS_EVIDENCE')
})

test('G-SELECT：llm-judge 指标判 UNKNOWN（U 不可构造）', () => {
  const result = gates.gateSelection({
    title: 'T', repo: 'owner/name', license: 'MIT',
    optimizationSurface: { methodLevel: true }, duplicateChecked: true,
    communityBaseline: 60, reportedBaseline: 58, deltaPercent: 34,
    metricType: 'llm-judge', benchmarkCount: 3, ablationCount: 2,
  })
  assert.equal(result.verdict, 'NEEDS_EVIDENCE')
  assert.ok(result.checks.some((item) => item.id === 'G0.6' && item.status === 'UNKNOWN'))
})

// ── G0.10：裸百分比对负值有界指标失真（缺陷报告 2026-10-16）─────────────────
//
// auto2604 实战：主指标为连续控制回合回报（负值有界，越接近 0 越好）。
//   B=−249.25  R=−231.55  U=−219.70
//   Δ=+17.70（7.10% of |B|）、R_norm=0.599 ∈ [0.15,0.8]、Δ=26.7σ_B
// 旧实现只看裸百分比 7.1% < 10 ⇒ UNKNOWN ⇒ 永久阻塞 intake。
// 但 R_norm 与 3σ 判据（协议自身口径）都判「空间充足」。

const auto2604Payload = (extra = {}) => ({
  title: 'Time-Aware World Model', repo: 'anh-nn01/Time-Aware-World-Model',
  license: 'MIT', optimizationSurface: { methodLevel: true }, duplicateChecked: true,
  metricType: 'physical', benchmarkCount: 12, ablationCount: 1,
  communityBaseline: -249.25, reportedBaseline: -249.252, deltaPercent: 7.1,
  ...extra,
})

test('G0.10：负值有界指标提供 B/R/U 时按归一化口径判 PASS（不再误判）', () => {
  const result = gates.gateSelection(auto2604Payload({
    baseline: -249.25, reference: -231.55, upper: -219.70,
    direction: 'maximize', sigmaMultiple: 26.7,
  }))
  const g010 = result.checks.find((item) => item.id === 'G0.10')
  assert.equal(g010.status, 'PASS', `G0.10 应为 PASS，实际 ${g010.status}：${g010.detail}`)
  assert.ok(/R_norm=0\.5990/.test(g010.detail), `应报出 R_norm=0.5990，实际：${g010.detail}`)
  assert.equal(result.verdict, 'RECOMMEND', '该题三门全过，不应被 G0.10 阻塞')
})

test('G0.10：平移不变性 —— 优化空间未变则结论必须相同', () => {
  // 对同一任务做纯平移 B→B+C（与优化空间无关的重参数化）：
  // Δ 与 U−B 均不变 ⇒ R_norm 严格不变。旧实现因分母是 |B|，
  // 结论会随 C 从 UNKNOWN 翻转为 PASS —— 本次修复必须消除这个翻转。
  const verdicts = [0, 50, 100, 150, 200].map((C) => gates.gateSelection(auto2604Payload({
    baseline: -249.25 + C, reference: -231.55 + C, upper: -219.70 + C,
    direction: 'maximize', sigmaMultiple: 26.7,
  })).checks.find((item) => item.id === 'G0.10').status)
  assert.equal(new Set(verdicts).size, 1,
    `平移后 G0.10 结论应恒一致，实际：${JSON.stringify(verdicts)}`)
  assert.equal(verdicts[0], 'PASS')
})

test('G0.10：方向配错（U 未越过 B）不在此处重复报错', () => {
  // 该矛盾由 G-FEASIBILITY 的 G1.5 负责；本节判 FAIL 会重复归因。
  const result = gates.gateSelection(auto2604Payload({
    baseline: -249.25, reference: -231.55, upper: -260.0, direction: 'maximize',
  }))
  const g010 = result.checks.find((item) => item.id === 'G0.10')
  assert.notEqual(g010.status, 'FAIL', 'G0.10 不应因方向矛盾判 FAIL（那是 G1.5 的职责）')
})

test('G0.10：确无 B/R/U 时回退百分比，且如实标注为粗判', () => {
  const low = gates.gateSelection(auto2604Payload()).checks.find((item) => item.id === 'G0.10')
  assert.equal(low.status, 'UNKNOWN')
  assert.ok(/粗判/.test(low.detail), `回退口径必须标注为粗判，实际：${low.detail}`)
  assert.ok(/负值有界/.test(low.fix ?? ''), '修复建议应点明负值有界指标的风险')

  // ≥10% 的回退也不得宣称「空间充足」——只说明是粗判通过。
  const high = gates.gateSelection(auto2604Payload({ deltaPercent: 34 }))
    .checks.find((item) => item.id === 'G0.10')
  assert.equal(high.status, 'PASS')
  assert.ok(/粗判/.test(high.detail), `回退口径的 PASS 也应标注粗判，实际：${high.detail}`)
})

test('G0.10：仅提供 sigmaMultiple 时按 σ 判据（量级无关）', () => {
  const pass = gates.gateSelection(auto2604Payload({ sigmaMultiple: 26.7 }))
    .checks.find((item) => item.id === 'G0.10')
  assert.equal(pass.status, 'PASS')
  const fail = gates.gateSelection(auto2604Payload({ sigmaMultiple: 1.2 }))
    .checks.find((item) => item.id === 'G0.10')
  assert.equal(fail.status, 'UNKNOWN')
})

test('G0.10：既有正基线行为不变（δ=34% ≥ 10% 仍 PASS）', () => {
  const result = gates.gateSelection({
    title: 'T', repo: 'owner/name', license: 'MIT',
    optimizationSurface: { methodLevel: true }, duplicateChecked: true,
    communityBaseline: 60, reportedBaseline: 58, deltaPercent: 34,
    metricType: 'physical', benchmarkCount: 3, ablationCount: 2,
  })
  assert.equal(result.checks.find((item) => item.id === 'G0.10').status, 'PASS')
})

test('G-FEASIBILITY：R_norm 出界判 REJECT', () => {
  const result = gates.gateFeasibility({
    baselineValues: [1.0, 1.01, 0.99], referenceValues: [1.005, 1.006, 1.004],
    upper: 2.0, direction: 'maximize', referenceRecomputed: true,
  })
  assert.equal(result.verdict, 'REJECT')
  assert.ok(result.checks.some((item) => item.id === 'G1.6' && item.status === 'FAIL'))
})

test('G-FEASIBILITY：Δ < 3σ_B 判 REJECT', () => {
  const result = gates.gateFeasibility({
    baselineValues: [1.0, 1.02, 0.98], referenceValues: [1.001, 1.021, 0.981],
    upper: 1.10, direction: 'maximize', referenceRecomputed: true,
  })
  assert.equal(result.verdict, 'REJECT')
  assert.ok(result.checks.some((item) => item.id === 'G1.7' && item.status === 'FAIL'))
})

test('G-FEASIBILITY：3σ–5σ 判 NEEDS_EVIDENCE（建议复核）', () => {
  const result = gates.gateFeasibility({
    baselineValues: [1.000, 1.002, 0.998],
    referenceValues: [1.008, 1.010, 1.006],
    upper: 1.02, direction: 'maximize', referenceRecomputed: true,
  })
  const sigmaCheck = result.checks.find((item) => item.id === 'G1.7')
  assert.equal(sigmaCheck.status, 'UNKNOWN', `detail=${sigmaCheck.detail}`)
  assert.equal(result.verdict, 'NEEDS_EVIDENCE', JSON.stringify(result.checks.filter((c) => c.status !== 'PASS')))
})

test('G-FEASIBILITY：5σ 以上判 RECOMMEND', () => {
  const result = gates.gateFeasibility({
    baselineValues: [1.000, 1.010, 0.990, 1.005, 0.995],
    referenceValues: [1.080, 1.085, 1.078, 1.082, 1.079],
    upper: 1.20, direction: 'maximize', referenceRecomputed: true,
  })
  assert.equal(result.verdict, 'RECOMMEND', JSON.stringify(result.checks.filter((c) => c.status !== 'PASS')))
})

test('G-FEASIBILITY：U 等于 B 判 REJECT（分母为 0）', () => {
  const result = gates.gateFeasibility({
    baselineValues: [1, 1, 1], referenceValues: [1.1, 1.1, 1.1],
    upper: 1, direction: 'maximize', referenceRecomputed: true,
  })
  assert.equal(result.verdict, 'REJECT')
  assert.ok(result.checks.some((item) => item.id === 'G1.5' && item.status === 'FAIL'))
})

test('G-FEASIBILITY：minimize 方向正确判定', () => {
  const result = gates.gateFeasibility({
    baselineValues: [0.160, 0.161, 0.159],
    referenceValues: [0.145, 0.146, 0.144],
    upper: 0.10, direction: 'minimize', referenceRecomputed: true,
  })
  assert.equal(result.verdict, 'RECOMMEND', JSON.stringify(result.checks.filter((c) => c.status !== 'PASS')))
})

test('G-FEASIBILITY：缺实测值判 NEEDS_EVIDENCE', () => {
  const result = gates.gateFeasibility({ upper: 1.0, direction: 'maximize' })
  assert.equal(result.verdict, 'NEEDS_EVIDENCE')
})

// ── G-CONTRACT：与 Python 权威（harbor_task_contract.py static_checks）对齐 ──
//
// 这几项之前全用 `environment.network_mode` —— 那正是缺陷本身：权威读的是
// `[agent]` 与 `[verifier]`，JS 却读 `environment.*`，于是常见误写
// `[agent] network_mode = "none"` 在 JS 侧判 RECOMMEND 而 Harbor 原生会拒。
// 测试跟着实现一起写错，所以 22 项全绿也发现不了。现在按权威的字段与严重度写。

/** 合法 task.toml 的形状（权威四类必查全过）。 */
const validContract = () => ({
  schema_version: '1.3',
  artifacts: ['/workspace/solution'],
  // time_limit_seconds 与资源字段是 QA15 的判据（教程 v0.3.8 L266）：
  // 完整单轮 ≤7200s、≤8 张 H20/L20、≤64 核。
  task: { name: 'group/name', time_limit_seconds: 7200 },
  agent: { network_mode: 'no-network' },
  environment: { build_timeout_sec: 3600, cpus: 16, gpus: 1, gpu_types: ['H20'] },
  verifier: { network_mode: 'no-network', environment_mode: 'separate' },
})

test('G-CONTRACT：合法配置通过', () => {
  const result = gates.gateTaskContract(validContract())
  assert.equal(result.verdict, 'RECOMMEND', JSON.stringify(result.checks.filter((c) => c.status !== 'PASS')))
})

test('G-CONTRACT：[agent].network_mode=none 判 FAIL（权威所在段落）', () => {
  // 这是最危险的漏网形态：Harbor 原生拒绝，而旧 JS 因为读错段落判 RECOMMEND。
  const cfg = validContract()
  cfg.agent.network_mode = 'none'
  assert.equal(gates.gateTaskContract(cfg).verdict, 'REJECT')
})

test('G-CONTRACT：[verifier].network_mode 非法判 FAIL', () => {
  const cfg = validContract()
  cfg.verifier.network_mode = 'isolated'
  assert.equal(gates.gateTaskContract(cfg).verdict, 'REJECT')
})

test('G-CONTRACT：network_mode 缺省不算失败（权威直接 continue）', () => {
  const cfg = validContract()
  delete cfg.agent.network_mode
  delete cfg.verifier.network_mode
  assert.equal(gates.gateTaskContract(cfg).verdict, 'RECOMMEND')
})

test('G-CONTRACT：environment.network_mode 写了也不生效，且不得判 FAIL', () => {
  // 权威不读这个位置。如实报 UNKNOWN（说明写了没用），而不是判失败 ——
  // 否则用户会以为配置被拒，实际是位置不对。
  const cfg = validContract()
  cfg.environment.network_mode = 'no-network'
  const result = gates.gateTaskContract(cfg)
  // 信息性提示不得阻塞：UNKNOWN 与 FAIL 在 advanceState 眼里一样拦，
  // 而"写在 Harbor 不读的位置"只是无效、无害。信息保留在 detail 里。
  assert.equal(result.verdict, 'RECOMMEND')
  const info = result.checks.find((c) => c.id === 'G2.2:environment')
  assert.equal(info.status, 'PASS')
  assert.ok(/不在\*\*Harbor 契约的检查范围|不在.*Harbor/.test(info.detail), info.detail)
})

test('G-CONTRACT：environment_mode 非 separate 是 WARN 不是 FAIL（权威如此）', () => {
  const cfg = validContract()
  cfg.verifier.environment_mode = 'shared'
  // 权威 static_checks 把它放进 warn，JS 不得升级为硬失败。
  assert.equal(gates.gateTaskContract(cfg).verdict, 'NEEDS_EVIDENCE')
})

test('G-CONTRACT：environment_mode 缺失/非法仍是 FAIL', () => {
  const missing = validContract()
  delete missing.verifier.environment_mode
  assert.equal(gates.gateTaskContract(missing).verdict, 'REJECT')
  const illegal = validContract()
  illegal.verifier.environment_mode = 'isolated'
  assert.equal(gates.gateTaskContract(illegal).verdict, 'REJECT')
})

test('G-CONTRACT：build_timeout 低于 3600 是 WARN 不是 FAIL', () => {
  const cfg = validContract()
  cfg.environment.build_timeout_sec = 600
  assert.equal(gates.gateTaskContract(cfg).verdict, 'NEEDS_EVIDENCE')
})

test('G-CONTRACT：build_timeout 非数值仍是 FAIL', () => {
  const cfg = validContract()
  cfg.environment.build_timeout_sec = 'soon'
  assert.equal(gates.gateTaskContract(cfg).verdict, 'REJECT')
})

test('G-CONTRACT：artifacts 缺 /workspace/solution 是 WARN 不是 FAIL', () => {
  const cfg = validContract()
  cfg.artifacts = ['/workspace']
  assert.equal(gates.gateTaskContract(cfg).verdict, 'NEEDS_EVIDENCE')
})

test('G-CONTRACT：[task].name 缺失是 FAIL', () => {
  const cfg = validContract()
  delete cfg.task.name
  assert.equal(gates.gateTaskContract(cfg).verdict, 'REJECT')
})

test('G-DOCKERFILE：八章节标题允许带编号前缀', () => {
  // 真实题面普遍写成 `## 1. Goal`，早期只匹配 `^## Goal$`，于是把一份
  // 八章节齐全的 instruction.md 判成「缺少全部八章节」（实测 AutoRe0566）。
  const sections = ['Goal', 'Task Setting', 'Objective and Metrics', 'Allowed Scope',
    'Hard Boundaries', 'Submission Instructions', 'Workflow & Iteration', 'Completion Criteria']
  for (const [label, heading] of [
    ['裸标题（脚手架模板）', (s) => `## ${s}`],
    ['数字加点', (s) => `## ${sections.indexOf(s) + 1}. ${s}`],
    ['中文顿号', (s) => `## ${sections.indexOf(s) + 1}、${s}`],
  ]) {
    const md = sections.map((s, i) => heading(s, i)).join('\n\n')
    const result = gates.gateDockerPathContract({
      environmentDockerfile: 'FROM x\nCOPY starter/ /s/\n',
      testsDockerfile: 'FROM x\nCOPY . /t\n',
      instructionMd: md,
    })
    const g36 = result.checks.find((c) => c.id === 'G3.6')
    assert.equal(g36.status, 'PASS', `${label} 应通过，实际：${g36.detail}`)
  }
  // 反向：真缺章节仍须 FAIL（放宽不能放到形同虚设）。
  const partial = gates.gateDockerPathContract({
    environmentDockerfile: 'FROM x\nCOPY starter/ /s/\n',
    testsDockerfile: 'FROM x\nCOPY . /t\n',
    instructionMd: '## 1. Goal\n\n## 2. Task Setting\n',
  })
  assert.equal(partial.checks.find((c) => c.id === 'G3.6').status, 'FAIL')
})

test('红线 1：torch.no_grad 下的评测循环不是泄露', () => {
  // `with torch.no_grad(): for x, y in test_loader:` 是教科书式评测代码。
  // 早期 evalCtxRe 不含 no_grad，且只看本行不看窗口，于是把指标累加器初始化
  // （`test_l2 = 0`）判成「训练路径读评测标签」—— 合法的参考实现被硬拒。
  const evalLoop = [
    'optimizer.step()',
    '',
    'test_l2 = 0',
    'with torch.no_grad():',
    '    for x, y in test_loader:',
    '        test_l2 += lploss(model(x), y).item()',
  ].join('\n')
  const findings = redlines.scanDataLeakage(evalLoop, 'eval.py')
  assert.equal(findings.filter((f) => f.level === 'leak').length, 0, '评测循环不应判泄露')
  assert.equal(findings.filter((f) => f.level === 'suspect').length, 0, '评测循环不应留待确认噪音')
})

test('红线 1：真泄露仍须被抓到（放宽后不能失效）', () => {
  // 消融：修复误报的同时，两种真实泄露形态必须仍然判 leak。
  const viaGroundTruth = [
    'gt = load_ground_truth()',
    'for epoch in range(10):',
    '    loss = criterion(model(x), gt)',
    '    loss.backward()',
    '    optimizer.step()',
  ].join('\n')
  const viaUnpack = [
    'for epoch in range(10):',
    '    for x, y in val_loader:',
    '        loss = criterion(model(x), y)',
    '        loss.backward()',
    '        optimizer.step()',
  ].join('\n')
  for (const [label, text] of [['load_ground_truth', viaGroundTruth], ['训练里遍历 val_loader', viaUnpack]]) {
    const leaks = redlines.scanDataLeakage(text, 'train.py').filter((f) => f.level === 'leak')
    assert.ok(leaks.length > 0, `${label} 应判泄露，实际 0 处`)
  }
})

test('红线 1：suspect 不得靠兜底分支产出噪音', () => {
  // 训练与测试的 DataLoader 天然相邻，窗口必然同时覆盖两者。
  // 早期最后一级是 `else level = 'suspect'` 兜底，于是形状断言、计时、print
  // 这些完全无关的行全被标成待确认 —— G3.9 的 UNKNOWN 与 FAIL 一样拦阶段推进，
  // 噪音于是变成硬阻塞（实测 21 个源文件产出 20 条）。
  const adjacent = [
    'train_loader = DataLoader(TensorDataset(train_a, train_u))',
    'test_loader = DataLoader(TensorDataset(test_a, test_u))',
    't2 = default_timer()',
    'print("done", t2)',
  ].join('\n')
  const findings = redlines.scanDataLeakage(adjacent, 'x.py')
  assert.equal(findings.filter((f) => f.level === 'suspect').length, 0,
    `无关行不应产出 suspect：${JSON.stringify(findings.filter((f) => f.level === 'suspect'))}`)
})

test('G-DOCKERFILE：越界 COPY 与泄露私有材料判 FAIL', () => {
  const result = gates.gateDockerPathContract({
    environmentDockerfile: 'FROM x\nCOPY ../tests/ /t/\nCOPY starter/ /s/\n',
    testsDockerfile: 'FROM x\nCOPY . /tests\n',
  })
  assert.equal(result.verdict, 'REJECT')
  assert.ok(result.checks.some((item) => item.id === 'G3.1' && item.status === 'FAIL'))
  assert.ok(result.checks.some((item) => item.id === 'G3.2' && item.status === 'FAIL'))
})

test('G-DOCKERFILE：多阶段 COPY --from 的绝对路径不得判越界', () => {
  // 多阶段构建里 `COPY --from=builder /out/app /app` 的源按构造就是绝对路径，
  // 它来自另一个构建阶段而不是宿主上下文。旧实现只看 source 不看 flags，
  // 把标准多阶段 Dockerfile 一律判硬失败。
  const result = gates.gateDockerPathContract({
    environmentDockerfile: 'FROM a AS builder\nRUN make\nFROM b\nCOPY --from=builder /out/app /app\nCOPY starter/ /s/\n',
    testsDockerfile: 'FROM x\nCOPY . /tests\n',
  })
  const g31 = result.checks.find((item) => item.id === 'G3.1')
  assert.equal(g31.status, 'PASS', `--from 绝对路径应通过，实际：${g31.detail}`)
})

test('G-DOCKERFILE：--from 之外的绝对路径仍判越界', () => {
  // 修复不能顺手放过真正的逃逸：没有 --from 时绝对路径依然是宿主路径逃逸。
  const result = gates.gateDockerPathContract({
    environmentDockerfile: 'FROM x\nCOPY /etc/passwd /app/\n',
    testsDockerfile: 'FROM x\nCOPY . /tests\n',
  })
  assert.ok(result.checks.some((item) => item.id === 'G3.1' && item.status === 'FAIL'))
})

test('isEscapingEntry：--from 阶段内仍禁止 .. 逃逸', () => {
  // 阶段来源不等于可以乱走：`COPY --from=b /a/../../x /y` 仍应判越界。
  assert.equal(gates.isEscapingEntry({ source: '/a/../../x', flags: ['--from=b'] }), true)
  assert.equal(gates.isEscapingEntry({ source: '/out/app', flags: ['--from=builder'] }), false)
  // 不带 flags 时退回原语义（绝对路径越界）。
  assert.equal(gates.isEscapingEntry({ source: '/out/app', flags: [] }), true)
})

test('G-DOCKERFILE：instruction.md 缺章节判 FAIL', () => {
  const result = gates.gateDockerPathContract({
    environmentDockerfile: 'FROM x\nCOPY starter/ /s/\n',
    testsDockerfile: 'FROM x\nCOPY . /tests\n',
    instructionMd: '# T\n\n## Goal\nx\n\n## Allowed Scope\ny\n',
  })
  assert.equal(result.verdict, 'REJECT')
  assert.ok(result.checks.some((item) => item.id === 'G3.6' && item.status === 'FAIL'))
})

test('G-DOCKERFILE：题面出现 arXiv 线索判 UNKNOWN', () => {
  const sections = ['Goal', 'Task Setting', 'Objective and Metrics', 'Allowed Scope',
    'Hard Boundaries', 'Submission Instructions', 'Workflow & Iteration', 'Completion Criteria']
  const body = sections.map((section) => `## ${section}\n内容`).join('\n\n')
  const result = gates.gateDockerPathContract({
    environmentDockerfile: 'FROM x\nCOPY starter/ /s/\n',
    testsDockerfile: 'FROM x\nCOPY . /tests\n',
    instructionMd: `# T\n\n参见 arXiv:2601.00001\n\n${body}\n`,
  })
  assert.equal(result.verdict, 'NEEDS_EVIDENCE')
  assert.ok(result.checks.some((item) => item.id === 'G3.7' && item.status === 'UNKNOWN'))
})

test('G-TRAJECTORY：八字段合规通过', () => {
  const rounds = [
    { round: 1, policy_name: 'a', method_summary: 'x', status: 'ok', score: 0.23, failure_reason: null, retained_best: true, time: '2026-09-10 16:20:32' },
    { round: 2, policy_name: 'b', method_summary: 'y', status: 'error', score: null, failure_reason: 'OOM', retained_best: false, time: '2026-09-10 16:27:32' },
  ]
  const result = gates.gateTrajectory({
    codexTrajectory: { rounds }, seedTrajectory: { rounds },
    runSummary: {
      agent_execution: [
        { runtime: 'Codex', model: 'GPT-5.6 Sol', duration_hours: 10.4 },
        { runtime: 'Codex', model: 'Seed 2.1 Turbo', duration_hours: 10.2 },
      ],
      fast_iteration_exception: { used: false },
    },
  })
  assert.equal(result.verdict, 'RECOMMEND', JSON.stringify(result.checks.filter((c) => c.status !== 'PASS')))
})

test('G-TRAJECTORY：字段缺失与时长不足判 FAIL', () => {
  const result = gates.gateTrajectory({
    codexTrajectory: { rounds: [{ round: 1, policy_name: 'a' }] },
    seedTrajectory: { rounds: [] },
    runSummary: {
      agent_execution: [
        { runtime: 'Codex', model: 'GPT-5.6 Sol', duration_hours: 5 },
        { runtime: 'Codex', model: 'Seed 2.1 Turbo', duration_hours: 10.2 },
      ],
      fast_iteration_exception: { used: false },
    },
  })
  assert.equal(result.verdict, 'REJECT')
})

test('G-TRAJECTORY：未出分但未写原因判 FAIL', () => {
  const rounds = [{ round: 1, policy_name: 'a', method_summary: 'x', status: 'ok', score: null, failure_reason: null, retained_best: false, time: '2026-09-10 16:20:32' }]
  const result = gates.gateTrajectory({
    codexTrajectory: { rounds }, seedTrajectory: { rounds },
    runSummary: {
      agent_execution: [
        { runtime: 'Codex', model: 'GPT-5.6 Sol', duration_hours: 10.4 },
        { runtime: 'Codex', model: 'Seed 2.1 Turbo', duration_hours: 10.2 },
      ],
      fast_iteration_exception: { used: false },
    },
  })
  assert.equal(result.verdict, 'REJECT')
})

test('G-TRAJECTORY：含未声明字段判 FAIL', () => {
  const rounds = [{ round: 1, policy_name: 'a', method_summary: 'x', status: 'ok', score: 1, failure_reason: null, retained_best: true, time: '2026-09-10 16:20:32', run_id: 'x' }]
  const result = gates.gateTrajectory({
    codexTrajectory: { rounds }, seedTrajectory: { rounds },
    runSummary: {
      agent_execution: [
        { runtime: 'Codex', model: 'GPT-5.6 Sol', duration_hours: 10.4 },
        { runtime: 'Codex', model: 'Seed 2.1 Turbo', duration_hours: 10.2 },
      ],
      fast_iteration_exception: { used: false },
    },
  })
  assert.equal(result.verdict, 'REJECT')
})

test('G-TRAJECTORY：7 小时例外证据齐备时通过', () => {
  const rounds = [
    { round: 1, policy_name: 'a', method_summary: 'x', status: 'ok', score: 1, failure_reason: null, retained_best: true, time: '2026-09-10 16:20:32' },
    { round: 2, policy_name: 'b', method_summary: 'y', status: 'ok', score: 2, failure_reason: null, retained_best: true, time: '2026-09-10 16:30:32' },
    { round: 3, policy_name: 'c', method_summary: 'z', status: 'ok', score: 3, failure_reason: null, retained_best: true, time: '2026-09-10 16:40:32' },
  ]
  const result = gates.gateTrajectory({
    codexTrajectory: { rounds }, seedTrajectory: { rounds },
    runSummary: {
      agent_execution: [
        // effective_rounds / typical_round_minutes 是 0.3.8 例外条件 5 的量化要求
        { runtime: 'Codex', model: 'GPT-5.6 Sol', duration_hours: 7.5, effective_rounds: 4, typical_round_minutes: 12 },
        { runtime: 'Codex', model: 'Seed 2.1 Turbo', duration_hours: 7.2, effective_rounds: 3, typical_round_minutes: 15 },
      ],
      // 例外条件 4：best_method 已在干净快照重跑出分
      validation: { best_method_rerun_passed: true },
      fast_iteration_exception: {
        used: true, non_training: true, short_iterations: true, rollable_proved: true,
        evidence: '本题不涉及训练，典型单轮 8 分钟；两条轨迹各完成 ≥3 轮方法闭环。',
      },
    },
  })
  assert.equal(result.verdict, 'RECOMMEND', JSON.stringify(result.checks.filter((c) => c.status !== 'PASS')))
})

test('G-TRAJECTORY：7 小时例外缺证据判 FAIL', () => {
  const rounds = [{ round: 1, policy_name: 'a', method_summary: 'x', status: 'ok', score: 1, failure_reason: null, retained_best: true, time: '2026-09-10 16:20:32' }]
  const result = gates.gateTrajectory({
    codexTrajectory: { rounds }, seedTrajectory: { rounds },
    runSummary: {
      agent_execution: [
        { runtime: 'Codex', model: 'GPT-5.6 Sol', duration_hours: 7.5 },
        { runtime: 'Codex', model: 'Seed 2.1 Turbo', duration_hours: 7.2 },
      ],
      fast_iteration_exception: { used: true, non_training: true, short_iterations: true, rollable_proved: false, evidence: '' },
    },
  })
  assert.equal(result.verdict, 'REJECT')
})

test('G-NOP-RESULT：四件套同源且出分通过', () => {
  const result = gates.gateNopResult({
    config: { agent: { name: 'nop' } },
    result: {
      finished_at: '2026-10-01T00:00:00Z', exception_info: null,
      verifier_environment_mode: 'separate', agent_info: { name: 'nop' },
      verifier_result: { rewards: 0 },
    },
    reward: 0, logPresent: true, sameTrial: true,
  })
  assert.equal(result.verdict, 'RECOMMEND', JSON.stringify(result.checks.filter((c) => c.status !== 'PASS')))
})

test('G-NOP-RESULT：reward 非数值判 FAIL', () => {
  const result = gates.gateNopResult({
    config: { agent: { name: 'nop' } },
    result: {
      finished_at: 'x', exception_info: null, verifier_environment_mode: 'separate',
      agent_info: { name: 'nop' }, verifier_result: { rewards: 'NOT_PRODUCED' },
    },
    reward: 'NOT_PRODUCED', logPresent: true, sameTrial: true,
  })
  assert.equal(result.verdict, 'REJECT')
})

test('G-NOP-RESULT：Agent 非 nop 判 FAIL', () => {
  const result = gates.gateNopResult({
    config: { agent: { name: 'codex' } },
    result: {
      finished_at: 'x', exception_info: null, verifier_environment_mode: 'separate',
      agent_info: { name: 'codex' }, verifier_result: { rewards: 0 },
    },
    reward: 0, logPresent: true, sameTrial: true,
  })
  assert.equal(result.verdict, 'REJECT')
  assert.ok(result.checks.some((item) => item.id === 'G6.7' && item.status === 'FAIL'))
})

test('G-NOP-RESULT：证据不同源判 FAIL', () => {
  const result = gates.gateNopResult({
    config: { agent: { name: 'nop' } },
    result: {
      finished_at: 'x', exception_info: null, verifier_environment_mode: 'separate',
      agent_info: { name: 'nop' }, verifier_result: { rewards: 0 },
    },
    reward: 0, logPresent: true, sameTrial: false,
  })
  assert.equal(result.verdict, 'REJECT')
})

test('G-REPLAY-CONTRACT：集成只存 models[0] 判 FAIL', () => {
  const result = gates.gateReplayContract({
    ensembleHints: ['n_ensemble', 'ensemble_predict'],
    singleSave: ['torch.save({"state_dict": models[0]'],
    predictionDtype: 'int64',
  })
  assert.equal(result.verdict, 'REJECT')
})

test('G-REPLAY-CONTRACT：dtype 非 int64 判 FAIL', () => {
  const result = gates.gateReplayContract({ ensembleHints: [], singleSave: [], predictionDtype: 'int32' })
  assert.equal(result.verdict, 'REJECT')
})

test('G-SINGLE-SOURCE：两套锚点并存判 FAIL', () => {
  const result = gates.gateSingleSource({ anchorDeclarations: ['a', 'b'], staleDeclarations: [] })
  assert.equal(result.verdict, 'REJECT')
})

test('G-SINGLE-SOURCE：单一真源通过', () => {
  const result = gates.gateSingleSource({ anchorDeclarations: ['only'], staleDeclarations: [] })
  assert.equal(result.verdict, 'RECOMMEND')
})

test('G-SINGLE-SOURCE：同一事实重复声明且值一致 → 不判冲突', () => {
  // 教程的 schema 里 expert_annotation.score_contract.metric 与
  // optimization_evidence/comparison_summary.json 都写口径 —— 两处值相同。
  // 早期实现只数声明个数，于是**任何同时遵守教程两处要求的题包都必然 REJECT**
  // （实测 AutoRe 题包 balanced_accuracy 两处一致仍被拒），逼作者删教程要求的
  // 字段。规则 19 要防的是「互相矛盾的声明」，不是「同一事实被提及两次」。
  const sameValue = gates.gateSingleSource({
    anchorDeclarations: ['comparison_summary.metric=balanced_accuracy',
      'expert_annotation.metric=balanced_accuracy'],
    staleDeclarations: [],
  })
  assert.equal(sameValue.verdict, 'RECOMMEND', '值一致的重复声明不得判 REJECT')

  // 只有值真的不同（同一事实两份矛盾声明）才 FAIL。
  const conflict = gates.gateSingleSource({
    anchorDeclarations: ['comparison_summary.metric=balanced_accuracy',
      'expert_annotation.metric=accuracy'],
    staleDeclarations: [],
  })
  assert.equal(conflict.verdict, 'REJECT', '值矛盾必须判 REJECT')
})

test('G-SINGLE-SOURCE：结构化声明按「键→值」判冲突', () => {
  const d = (key, value, source) => ({ key, value, source })
  // metric 与 direction 是两个不同事实，各自值一致 → 通过。
  assert.equal(gates.gateSingleSource({
    anchorDeclarations: [
      d('metric', 'balanced_accuracy', 'comparison_summary.metric.name'),
      d('direction', 'maximize', 'comparison_summary.metric.direction'),
      d('metric', 'balanced_accuracy', 'expert_annotation.score_contract.metric'),
      d('direction', 'maximize', 'expert_annotation.score_contract.direction'),
    ],
    staleDeclarations: [],
  }).verdict, 'RECOMMEND', '多键各自值一致不得判冲突')
  // direction 被改了一处（改了 B 锚点却没改另一处）→ 必须拦。
  assert.equal(gates.gateSingleSource({
    anchorDeclarations: [d('direction', 'maximize', 'a'), d('direction', 'minimize', 'b')],
    staleDeclarations: [],
  }).verdict, 'REJECT', '同一键不同值必须拦')
})

test('G-SINGLE-SOURCE：证据不足时不得当通过', () => {
  // 无键声明（旧格式）无法归并到同一事实：如实降为待确认，不当 PASS。
  const mixed = gates.gateSingleSource({ anchorDeclarations: ['a.metric=x', 'bogus'], staleDeclarations: [] })
  assert.equal(mixed.verdict, 'NEEDS_EVIDENCE')
  assert.equal(gates.gateSingleSource({ anchorDeclarations: [], staleDeclarations: [] }).verdict,
    'NEEDS_EVIDENCE')
})

test('G-PACK-VERIFY：哈希不一致判 FAIL', () => {
  const result = gates.gatePackVerify({
    sourceHashes: { 'a.py': 'x', 'b.py': 'y' },
    packedHashes: { 'a.py': 'x', 'b.py': 'z' },
    forbiddenEntries: [],
  })
  assert.equal(result.verdict, 'REJECT')
})

test('G-PACK-VERIFY：缺文件与缓存残留判 FAIL', () => {
  const result = gates.gatePackVerify({
    sourceHashes: { 'a.py': 'x', 'b.py': 'y' },
    packedHashes: { 'a.py': 'x' },
    forbiddenEntries: ['__pycache__/a.cpython-312.pyc'],
  })
  assert.equal(result.verdict, 'REJECT')
  assert.ok(result.checks.some((item) => item.id === 'G14.1' && item.status === 'FAIL'))
  assert.ok(result.checks.some((item) => item.id === 'G14.4' && item.status === 'FAIL'))
})

/** QA15 已并入发布期打包门，凡跑 G-PACK-VERIFY 的用例都要带 task.toml。 */
const QA15_TOML = { task: { time_limit_seconds: 7200 }, environment: { cpus: 16, gpus: 1, gpu_types: ['H20'] } }

test('G-PACK-VERIFY：哈希一致且交付期事实齐备时通过', () => {
  // 只给哈希不够：0.3.8 的打包门还要核对自验声明、best_method 内容、Git 状态、
  // 以及"不得夹带审核结论"。缺这些事实时门禁给 UNKNOWN（无法认证），不是假通过。
  const result = gates.gatePackVerify({
    sourceHashes: { 'a.py': 'x' }, packedHashes: { 'a.py': 'x' }, forbiddenEntries: [],
    runSummary: { validation: { baseline_passed: true, reference_passed: true, optimization_evidence_complete: true, best_method_rerun_passed: true } },
    bestMethodFiles: ['method.py'],
    gitState: { isRepo: false },
    annotation: { task_id: 'x' },
    expertDoc: '只陈述专家自验事实。',
    taskToml: { task: { time_limit_seconds: 7200 }, environment: { cpus: 16, gpus: 1, gpu_types: ['H20'] } },
  })
  assert.equal(result.verdict, 'RECOMMEND', JSON.stringify(result.checks.filter((c) => c.status !== 'PASS')))
})

test('G-PACK-VERIFY：只给哈希时判需补证据（不得假通过）', () => {
  const result = gates.gatePackVerify({
    sourceHashes: { 'a.py': 'x' }, packedHashes: { 'a.py': 'x' }, forbiddenEntries: [],
  })
  assert.equal(result.verdict, 'NEEDS_EVIDENCE')
})

test('verdictOf：FAIL 优先于 UNKNOWN（不做总分补偿）', () => {
  assert.equal(gates.verdictOf([{ status: 'PASS' }, { status: 'UNKNOWN' }, { status: 'FAIL' }]), 'REJECT')
  assert.equal(gates.verdictOf([{ status: 'PASS' }, { status: 'UNKNOWN' }]), 'NEEDS_EVIDENCE')
  assert.equal(gates.verdictOf([{ status: 'PASS' }]), 'RECOMMEND')
})

test('VERDICT_EXIT_CODE 与 SOP 三态一致', () => {
  assert.equal(gates.VERDICT_EXIT_CODE.RECOMMEND, 0)
  assert.equal(gates.VERDICT_EXIT_CODE.REJECT, 1)
  assert.equal(gates.VERDICT_EXIT_CODE.NEEDS_EVIDENCE, 2)
})

test('评分标定常量与教程一致', () => {
  assert.equal(gates.R_LO, 0.15)
  assert.equal(gates.R_HI, 0.8)
  assert.equal(gates.SIGMA_MULT_REQUIRED, 3.0)
  assert.equal(gates.SIGMA_MULT_STRONG, 5.0)
  assert.equal(gates.MIN_EFFECTIVE_HOURS, 10)
  assert.equal(gates.EXCEPTION_EFFECTIVE_HOURS, 7)
  assert.equal(gates.CONTAINER_STABILITY_HOURS, 12)
  assert.equal(gates.PER_ROUND_BUDGET_HOURS, 2)
})

// ── 状态机 ──────────────────────────────────────────────────────────────────

test('阶段推进：门禁未过时拒绝推进', () => {
  const initial = state.emptyState('t')
  assert.throws(() => state.advanceState(initial, 'authoring'), /门禁未通过/)
})

test('阶段推进：门禁通过后允许逐级推进，禁止跳级与回退', () => {
  let current = state.emptyState('t')
  current = state.recordGateResult(current, { gate: 'G-SELECT', verdict: 'RECOMMEND', milestone: 'M1', checks: [] })
  const advanced = state.advanceState(current, 'authoring')
  assert.equal(advanced.changed, true)
  assert.equal(advanced.state.phase, 'authoring')
  assert.throws(() => state.advanceState(advanced.state, 'release'), /不允许跳级/)
  assert.throws(() => state.advanceState(advanced.state, 'intake'), /不允许回退/)
})

test('阶段推进：NEEDS_EVIDENCE 同样阻断', () => {
  let current = state.emptyState('t')
  current = state.recordGateResult(current, { gate: 'G-SELECT', verdict: 'NEEDS_EVIDENCE', milestone: 'M1', checks: [] })
  assert.throws(() => state.advanceState(current, 'authoring'), /NEEDS_EVIDENCE/)
})

test('summarize 报告失败门禁与可推进性', () => {
  let current = state.emptyState('t')
  current = state.recordGateResult(current, { gate: 'G-SELECT', verdict: 'REJECT', milestone: 'M1', checks: [] })
  const summary = state.summarize(current)
  assert.equal(summary.canAdvance, false)
  assert.equal(summary.failingGates.length, 1)
  assert.equal(summary.nextPhase, 'authoring')
})

test('状态读写：原子写入并保持版本一致', async () => {
  const taskRoot = await mkdtemp(join(tmpdir(), 'autoresearch-state-'))
  try {
    const initial = await state.readState(taskRoot, 'task-1')
    assert.equal(initial.taskId, 'task-1')
    assert.equal(initial.phase, 'intake')
    const saved = await state.writeState(taskRoot, { ...initial, taskId: 'task-2' })
    assert.equal(saved.taskId, 'task-2')
    const reloaded = await state.readState(taskRoot)
    assert.equal(reloaded.taskId, 'task-2')
    const raw = await readFile(join(taskRoot, state.STATE_FILE), 'utf8')
    assert.ok(raw.includes('"version": 1'))
  } finally {
    await rm(taskRoot, { recursive: true, force: true })
  }
})

test('状态文件版本不匹配时明确报错', async () => {
  const taskRoot = await mkdtemp(join(tmpdir(), 'autoresearch-state-'))
  try {
    await writeFile(join(taskRoot, state.STATE_FILE), JSON.stringify({ version: 99 }), 'utf8')
    await assert.rejects(() => state.readState(taskRoot), /版本/)
  } finally {
    await rm(taskRoot, { recursive: true, force: true })
  }
})

test('四阶段定义完整且门禁引用有效', () => {
  assert.equal(phases.PHASES.length, 4)
  assert.deepEqual(phases.PHASES.map((phase) => phase.id), ['intake', 'authoring', 'iteration', 'release'])
  for (const phase of phases.PHASES) {
    for (const gateId of phase.gates) {
      assert.ok(gates.GATES[gateId] !== undefined, `${phase.id} 引用未知门禁 ${gateId}`)
    }
  }
})

test('阶段顺序与教程四章一致', () => {
  assert.match(phases.PHASES[0].chapter, /第 1 章/)
  assert.match(phases.PHASES[1].chapter, /第 2 章/)
  assert.match(phases.PHASES[2].chapter, /第 3 章/)
  assert.match(phases.PHASES[3].chapter, /第 4 章/)
})

test('废弃旧结构清单非空且为相对路径', () => {
  assert.ok(phases.DEPRECATED_PATHS.length >= 5)
  for (const path of phases.DEPRECATED_PATHS) {
    assert.ok(!path.startsWith('/'), `${path} 应为相对路径`)
  }
  assert.ok(phases.DEPRECATED_PATHS.some((path) => path.includes('trusted')))
  assert.ok(phases.DEPRECATED_PATHS.some((path) => path.includes('best_policy')))
})

test('变体判据覆盖教程要求', () => {
  assert.deepEqual(phases.VARIANT_RULES.mustChange, ['模型架构', '优化目标', '起始代码', '限定搜索方向'])
  assert.ok(phases.VARIANT_RULES.mustRerun.includes('Baseline'))
  assert.ok(phases.VARIANT_RULES.notVariant.includes('只改随机 seed'))
})

test('三种出题模式齐备', () => {
  assert.deepEqual(Object.keys(phases.TASK_MODES), ['S1', 'S2', 'S3'])
})

test('领取后检查为五项', () => {
  assert.equal(phases.INTAKE_CHECKS.length, 5)
})

// ── 脚手架 ──────────────────────────────────────────────────────────────────

test('脚手架生成三类顶层目录且题面含八章节', async () => {
  const taskRoot = await mkdtemp(join(tmpdir(), 'autoresearch-scaffold-'))
  try {
    const first = await scaffold.scaffoldTaskPackage(taskRoot, { title: '自检题', taskName: 'grp/selftest' })
    assert.ok(first.created.length > 20, `新建文件数 ${first.created.length}`)

    const instruction = await readFile(join(taskRoot, 'workspace/harbor_task/instruction.md'), 'utf8')
    for (const section of ['Goal', 'Task Setting', 'Objective and Metrics', 'Allowed Scope',
      'Hard Boundaries', 'Submission Instructions', 'Workflow & Iteration', 'Completion Criteria']) {
      assert.ok(instruction.includes(`## ${section}`), `题面缺少 ${section}`)
    }

    const toml = await readFile(join(taskRoot, 'workspace/harbor_task/task.toml'), 'utf8')
    assert.ok(toml.includes('artifacts = ["/workspace/solution"]'))
    assert.ok(toml.includes('environment_mode = "separate"'))
    assert.ok(toml.includes('build_timeout_sec = 3600'))

    const { parseTomlSubset } = await load('dsh-autoresearch/lib/toml.js')
    assert.equal(gates.gateTaskContract(parseTomlSubset(toml)).verdict, 'RECOMMEND')

    await writeFile(join(taskRoot, 'workspace/harbor_task/instruction.md'), '# 已改\n', 'utf8')
    const second = await scaffold.scaffoldTaskPackage(taskRoot, { title: '自检题' })
    assert.equal(second.created.length, 0)
    assert.equal(await readFile(join(taskRoot, 'workspace/harbor_task/instruction.md'), 'utf8'), '# 已改\n')
  } finally {
    await rm(taskRoot, { recursive: true, force: true })
  }
})

test('脚手架不预填任何结果数字', async () => {
  const taskRoot = await mkdtemp(join(tmpdir(), 'autoresearch-scaffold-'))
  try {
    await scaffold.scaffoldTaskPackage(taskRoot, { title: 'T' })
    const comparison = JSON.parse(await readFile(join(taskRoot, 'optimization_evidence/comparison_summary.json'), 'utf8'))
    assert.equal(comparison.status, 'NOT_RUN')
    assert.equal(comparison.statistics.baseline_mean, null)
    assert.equal(comparison.significance_rule.passed, false)
    const codex = JSON.parse(await readFile(join(taskRoot, 'expert_evidence/trajectory_codex.json'), 'utf8'))
    assert.deepEqual(codex.rounds, [])
    const summary = JSON.parse(await readFile(join(taskRoot, 'expert_evidence/run_summary.json'), 'utf8'))
    assert.equal(summary.agent_execution[0].duration_hours, null)
    assert.equal(summary.validation.baseline_passed, false)
  } finally {
    await rm(taskRoot, { recursive: true, force: true })
  }
})

test('脚手架生成的 tests/test.sh 清理预写结果并原子写 reward', async () => {
  const taskRoot = await mkdtemp(join(tmpdir(), 'autoresearch-scaffold-'))
  try {
    await scaffold.scaffoldTaskPackage(taskRoot, { title: 'T' })
    const testSh = await readFile(join(taskRoot, 'workspace/harbor_task/tests/test.sh'), 'utf8')
    assert.ok(testSh.includes('rm -f "${OUT}/reward.json"'), '须清理 Agent 预写结果')
    assert.ok(testSh.includes('os.replace(temporary, output)'), '须原子写入')
    assert.ok(testSh.includes('PYTHONSAFEPATH=1'), '须防 cwd 劫持')
    assert.ok(testSh.includes('math.isfinite'), '须校验有限数值')
  } finally {
    await rm(taskRoot, { recursive: true, force: true })
  }
})

test('交付物核对能识别缺失、空文件与类型错误', async () => {
  const taskRoot = await mkdtemp(join(tmpdir(), 'autoresearch-audit-'))
  try {
    await mkdir(join(taskRoot, 'workspace/harbor_task'), { recursive: true })
    await writeFile(join(taskRoot, 'workspace/harbor_task/instruction.md'), '', 'utf8')
    const results = await state.checkPhaseDeliverables(taskRoot, 'authoring')
    const byPath = Object.fromEntries(results.map((item) => [item.path, item.status]))
    assert.equal(byPath['workspace/harbor_task/instruction.md'], 'EMPTY')
    assert.equal(byPath['workspace/harbor_task/task.toml'], 'MISSING')
  } finally {
    await rm(taskRoot, { recursive: true, force: true })
  }
})

test('越界路径被拒绝', () => {
  assert.throws(() => state.assertInsideTaskRoot('/task', '/etc/passwd'), /越出任务根/)
  assert.equal(state.assertInsideTaskRoot('/task', '/task/a/b'), 'a/b')
})

// ── 技能目录 ────────────────────────────────────────────────────────────────

test('技能目录枚举到 8 个技能且教程附件版本优先', async () => {
  const listed = await catalog.listSkills()
  const names = listed.skills.map((skill) => skill.name)
  for (const expected of ['autoresearch-task-qa', 'autoresearch-baseline-quality',
    'autoresearch-paper-discovery', 'autoresearch-optimization-surface',
    'autoresearch-task-authoring', 'autoresearch-run-isolation',
    'autoresearch-feishu-three-table', 'autoresearch-conversation-handoff']) {
    assert.ok(names.includes(expected), `缺少技能 ${expected}`)
  }
  assert.equal(names.length, 8, `去重后应有 8 个技能，实际 ${names.length}`)
  const qa = listed.skills.find((skill) => skill.name === 'autoresearch-task-qa')
  assert.equal(qa.source, 'tutorial-v3', '教程附件版本应优先')
  assert.ok(qa.description.length > 20, 'description 应解析成功')
  assert.ok(listed.shadowed.length >= 2, '同名遮蔽项应被记录而非丢弃')
})

test('技能正文可读取且带资源清单', async () => {
  const skill = await catalog.readSkill('autoresearch-task-qa')
  assert.ok(skill !== undefined)
  assert.ok(skill.content.length > 500, `正文 ${skill.content?.length} 字符`)
  assert.ok(skill.resources.length > 0, '应有资源文件')
  assert.ok(skill.resources.some((resource) => resource.path.includes('scripts/')), '应含脚本资源')
})

test('技能路由元数据齐备（8 个技能全覆盖）', () => {
  for (const name of Object.keys(catalog.SKILL_ROUTING)) {
    const routing = catalog.SKILL_ROUTING[name]
    assert.ok(routing.whenToUse, `${name} 缺 whenToUse`)
    assert.ok(routing.produces, `${name} 缺 produces`)
    assert.ok(routing.stops, `${name} 缺 stops`)
  }
  assert.equal(Object.keys(catalog.SKILL_ROUTING).length, 8)
})

test('SOP 技能可读取且资源完整', async () => {
  const sop = await catalog.readSopSkill()
  assert.ok(sop !== undefined)
  assert.ok(sop.content.includes('五道不可跳级里程碑'))
  assert.ok(sop.content.includes('M1') && sop.content.includes('M5'))
  const resources = await catalog.listSopResources()
  const paths = resources.map((resource) => resource.path)
  assert.ok(paths.includes('references/field-lessons.md'))
  assert.ok(paths.includes('references/failure-patterns.md'))
  assert.ok(paths.includes('references/sandbox-isolation.md'))
  assert.ok(paths.includes('references/gpu-budget.md'))
  assert.ok(paths.includes('tools/milestone_gate.py'))
  assert.ok(paths.includes('tools/nop_preflight.py'))
  assert.ok(paths.includes('assets/checklist.md'))
})

test('技能目录解析 frontmatter 正确', () => {
  const { data } = catalog.parseFrontmatter('---\nname: demo-skill\ndescription: 说明文字\nmetadata:\n  short-description: 短说明\n---\n\n正文\n')
  assert.equal(data.name, 'demo-skill')
  assert.equal(data.description, '说明文字')
  assert.equal(data.metadata['short-description'], '短说明')
})

// ── 门禁工具包装 ────────────────────────────────────────────────────────────

test('工具登记表全部指向真实脚本', async () => {
  const { available, missing } = await tools.listTools()
  assert.equal(missing.length, 0, `缺失脚本：${missing.map((item) => item.script).join(', ')}`)
  assert.ok(available.length >= 11, `可用工具 ${available.length} 个`)
})

test('每个登记工具都有 buildArgv 分支', async () => {
  // 工具 id 的 enum 由 TOOL_REGISTRY 生成，argv 组装却是另一个手工 switch。
  // 漂移时模型会被提供一个必然失败的选项 —— privacy-scan 与 verify-skill-archive
  // 就这样失效过（选中即抛「未知工具」）。
  const missing = tools.findToolsWithoutArgvBranch()
  assert.equal(missing.length, 0, `缺 buildArgv 分支：${missing.join(', ')}`)
})

test('dockerfiles 传字符串时必须报错而不是按字符拆开', () => {
  // additionalProperties 让字符串成为合法输入；不挡掉的话 for...of 会拆成单字符，
  // Python 收到 15 个位置参数，报错完全指不到真因。
  let threw = false
  try {
    tools.buildArgv('dockerfile-preflight', { dockerfiles: 'env/Dockerfile' })
  } catch (error) {
    threw = /必须是数组/.test(error.message)
  }
  assert.ok(threw, 'dockerfiles 为字符串时应抛「必须是数组」')
  const ok = tools.buildArgv('dockerfile-preflight', { dockerfiles: ['a/Dockerfile', 'b/Dockerfile'] })
  assert.deepEqual(ok, ['a/Dockerfile', 'b/Dockerfile'])
})

test('退出码 0 不总是 PASS —— 由工具自己声明', async () => {
  const { interpretExit } = await import(
    new URL('../packages/dsh-autoresearch-gates/index.js', import.meta.url).href)
  // 发布门证据的生产者：默认 --fail-on never，退出 0 只表示「跑完了」。
  // 把它当 PASS，等于在一次都没强制门禁的运行上盖通过章。
  for (const id of ['qa-implementation-review', 'qa-audit', 'numeric-backsolve']) {
    const verdict = interpretExit(tools.TOOL_REGISTRY[id], 0)
    assert.notEqual(verdict.verdict, 'PASS',
      `${id} 声明了 exitZeroIsPass:false，退出 0 不得判 PASS`)
    assert.equal(verdict.verdict, 'NEEDS_EVIDENCE', `${id} 退出 0 应为 NEEDS_EVIDENCE`)
  }
  // 真通过的工具不受影响。
  for (const id of ['milestone-gate', 'privacy-scan']) {
    assert.equal(interpretExit(tools.TOOL_REGISTRY[id], 0).verdict, 'PASS', `${id} 退出 0 应为 PASS`)
  }
})

test('退出码 2 区分「参数错误」与「需人工确认」', async () => {
  const { interpretExit } = await import(
    new URL('../packages/dsh-autoresearch-gates/index.js', import.meta.url).href)
  // 调用方式错了不是「证据不足」；混为一谈会让模型去补证据，而实际该改参数。
  assert.equal(interpretExit(tools.TOOL_REGISTRY['privacy-scan'], 2).verdict, 'UNKNOWN')
  assert.equal(interpretExit(tools.TOOL_REGISTRY['milestone-gate'], 2).verdict, 'NEEDS_EVIDENCE')
  // 未登记的退出码一律 UNKNOWN，不猜。
  assert.equal(interpretExit(tools.TOOL_REGISTRY['milestone-gate'], 7).verdict, 'UNKNOWN')
})

test('工具登记表覆盖 SOP 全部关键工具', () => {
  const ids = Object.keys(tools.TOOL_REGISTRY)
  for (const expected of ['milestone-gate', 'paper-screen', 'feasibility-gate',
    'harbor-task-contract', 'dockerfile-preflight', 'replay-contract-gate',
    'sandbox-probe-gate', 'candidate-surface-audit', 'numeric-backsolve', 'nop-preflight',
    'qa-audit', 'qa-implementation-review']) {
    assert.ok(ids.includes(expected), `缺少工具登记 ${expected}`)
  }
})

test('参数组装映射到正确命令行开关', () => {
  assert.deepEqual(
    tools.buildArgv('milestone-gate', {
      milestone: 'M2', b: '0.1340', r: '0.1300', u: 0.031,
      referenceRecomputed: 'yes', receipts: ['pilot.json'],
    }),
    ['--milestone', 'M2', '--b', '0.1340', '--r', '0.1300',
      '--u', '0.031', '--reference-recomputed', 'yes', '--receipts', 'pilot.json'],
  )
  assert.deepEqual(
    tools.buildArgv('feasibility-gate', { fromProbe: true, b: '1', r: '2', u: '0.5' }),
    ['--from-probe', '--b', '1', '--r', '2', '--u', '0.5'],
  )
  assert.deepEqual(tools.buildArgv('dockerfile-preflight', { dockerfiles: ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(
    tools.buildArgv('harbor-task-contract', { task: './harbor_task', json: true }),
    ['--task', './harbor_task', '--json'],
  )
  assert.deepEqual(
    tools.buildArgv('paper-screen', { title: 'T', repo: 'o/n', metricType: 'physical', reportsSigma: true }),
    ['--title', 'T', '--repo', 'o/n', '--reports-sigma', '--metric-type', 'physical'],
  )
})

test('缺 Docker 时 Docker 类工具如实报不可运行', async () => {
  const meta = await tools.resolveTool('nop-preflight')
  const verdict = tools.checkPrerequisites(meta, {
    pythonAvailable: true, docker: { available: false, detail: '未安装' },
  })
  assert.equal(verdict.runnable, false)
  assert.match(verdict.reason, /Docker/)
})

test('缺 Python 时全部工具如实报不可运行', async () => {
  const meta = await tools.resolveTool('milestone-gate')
  const verdict = tools.checkPrerequisites(meta, { pythonAvailable: false, docker: { available: false } })
  assert.equal(verdict.runnable, false)
  assert.match(verdict.reason, /Python/)
})

test('需 root 的工具在非 root 环境标为部分可用', async () => {
  const meta = await tools.resolveTool('sandbox-probe-gate')
  const verdict = tools.checkPrerequisites(meta, { pythonAvailable: true, docker: { available: true } })
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
  if (!isRoot) {
    assert.equal(verdict.runnable, 'partial')
    assert.match(verdict.reason, /root/)
  }
})

test('纯 Python 工具在无 Docker 环境仍可运行', async () => {
  const meta = await tools.resolveTool('milestone-gate')
  const verdict = tools.checkPrerequisites(meta, { pythonAvailable: true, docker: { available: false } })
  assert.equal(verdict.runnable, true)
})

test('退出码语义三态齐备', () => {
  assert.equal(tools.EXIT_SEMANTICS[0], 'RECOMMEND / PASS / 通过')
  assert.equal(tools.EXIT_SEMANTICS[1], 'REJECT / FAIL / 硬失败')
  assert.equal(tools.EXIT_SEMANTICS[2], 'NEEDS_EVIDENCE / MANUAL / 需人工确认')
})

// ── 双路质检编排 ────────────────────────────────────────────────────────────

test('双路配置校验：两路身份必须不同', () => {
  assert.deepEqual(qaRunner.validateLanes([
    { provider: 'anthropic', model: 'claude-fable-5' },
    { provider: 'openai', model: 'gpt-5' },
  ]), [])
  const same = qaRunner.validateLanes([
    { provider: 'anthropic', model: 'claude-fable-5' },
    { provider: 'anthropic', model: 'claude-fable-5' },
  ])
  assert.equal(same.length, 1)
  assert.match(same[0], /必须不同/)
})

test('双路配置校验：缺字段与路数错误都能识别', () => {
  const missing = qaRunner.validateLanes([{ provider: 'x' }, {}])
  assert.equal(missing.length, 3)
  assert.match(missing.join(' '), /缺少 model/)
  assert.match(qaRunner.validateLanes([{ provider: 'x', model: 'y' }])[0], /恰好配置两路/)
  assert.match(qaRunner.validateLanes([])[0], /恰好配置两路/)
})

test('每路 patch 同时声明模型路由与凭据来源', () => {
  const patch = qaRunner.laneModelPatch({
    provider: 'anthropic', model: 'claude-haiku-4-5', credentialEnv: 'ANTHROPIC_API_KEY',
  })
  assert.ok(patch.includes('- id: agent-default-model'))
  assert.ok(patch.includes('provider: "anthropic"'))
  assert.ok(patch.includes('model: "claude-haiku-4-5"'))
  assert.ok(patch.includes('- id: llm-pi-ai'))
  assert.ok(patch.includes('apiKeyEnv: "ANTHROPIC_API_KEY"'))
})

test('未声明凭据时不覆盖 llm-pi-ai（避免空 profile 报缺凭据）', () => {
  const patch = qaRunner.laneModelPatch({ provider: 'openai', model: 'gpt-5' })
  assert.ok(!patch.includes('llm-pi-ai'))
  assert.ok(patch.includes('model: "gpt-5"'))
})

test('每路独立 DSH_HOME，凭据按环境变量注入', () => {
  const environment = qaRunner.laneEnvironment({ PATH: '/usr/bin' }, {
    provider: 'anthropic', credentialEnv: 'ANTHROPIC_API_KEY', apiKey: 'sk-test',
  }, '/work/lane-1')
  assert.equal(environment.ANTHROPIC_API_KEY, 'sk-test')
  assert.ok(environment.DSH_HOME.includes('lane-1'))
  assert.equal(environment.PATH, '/usr/bin')
})

test('提示词含来源绑定、输出目录与禁止跨路读取', () => {
  const prompt = qaRunner.buildLanePrompt({
    artifactPath: '/x/submission.zip', artifactSha256: 'a'.repeat(64),
    laneIndex: 2, outDir: '/x/lane-2/qa-report', skillName: 'autoresearch-task-qa',
    taskRoot: '/x/task', reviewScript: '/x/implementation_review.py',
    provider: 'openai', model: 'gpt-5', version: '1', sessionId: 'sess-2',
  })
  assert.ok(prompt.includes('/x/submission.zip'))
  assert.ok(prompt.includes('a'.repeat(64)))
  assert.ok(prompt.includes('/x/lane-2/qa-report'))
  assert.ok(prompt.includes('--release-self-check'))
  assert.ok(prompt.includes('--clean-context'))
  assert.ok(prompt.includes('--reviewer-provider "openai"'))
  assert.ok(prompt.includes('--session-id "sess-2"'))
  assert.ok(prompt.includes('不要读取另一路'))
  assert.ok(prompt.includes('只读审查'))
})

test('确定性 ZIP：相同输入两次打包哈希一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-zip-'))
  try {
    await mkdir(join(root, 'a'), { recursive: true })
    await writeFile(join(root, 'a', 'x.txt'), 'hello', 'utf8')
    await writeFile(join(root, 'y.txt'), 'world', 'utf8')
    const first = await qaZip.packDirectory(root, join(root, '..', `${Date.now()}-1.zip`))
    const second = await qaZip.packDirectory(root, join(root, '..', `${Date.now()}-2.zip`))
    assert.equal(first.sha256, second.sha256)
    assert.equal(first.entryCount, 2)
    await rm(join(root, '..', `${first.zipPath.split(/[\/]/).pop()}`), { force: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ZIP 打包排除缓存与临时文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-zip-'))
  const outDir = await mkdtemp(join(tmpdir(), 'autoresearch-zipout-'))
  try {
    await mkdir(join(root, '__pycache__'), { recursive: true })
    await writeFile(join(root, '__pycache__', 'a.pyc'), 'x', 'utf8')
    await writeFile(join(root, 'run.log'), 'x', 'utf8')
    await writeFile(join(root, 'keep.py'), 'print(1)', 'utf8')
    const result = await qaZip.packDirectory(root, join(outDir, 'out.zip'))
    assert.equal(result.entryCount, 1)
    assert.ok(result.skipped.some((entry) => entry.path === '__pycache__'))
    assert.ok(result.skipped.some((entry) => entry.path === 'run.log'))
    const names = qaZip.listZipEntries(await readFile(result.zipPath))
    assert.deepEqual(names, ['keep.py'])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outDir, { recursive: true, force: true })
  }
})

test('空目录拒绝打包', async () => {
  const root = await mkdtemp(join(tmpdir(), 'autoresearch-zip-'))
  const outDir = await mkdtemp(join(tmpdir(), 'autoresearch-zipout-'))
  try {
    await assert.rejects(() => qaZip.packDirectory(root, join(outDir, 'out.zip')), /拒绝生成空包/)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outDir, { recursive: true, force: true })
  }
})

test('发布门复核：PASS 与 NOT_READY 都能识别', () => {
  assert.deepEqual(qaRunner.auditConsensus({
    status: 'PASS', validationErrors: [], unresolvedDisagreements: [],
  }), [])
  const problems = qaRunner.auditConsensus({
    status: 'NOT_READY',
    validationErrors: ['reviewers must use two different provider/model/version identities'],
    unresolvedDisagreements: [{ check: 'qa:QA01', report_1: 'pass', report_2: 'fail' }],
  })
  assert.equal(problems.length, 3)
  assert.match(problems.join(' '), /非 PASS/)
  assert.match(problems.join(' '), /未解决分歧/)
  assert.match(qaRunner.auditConsensus(null)[0], /缺少聚合结果/)
})

test('共识要求常量与上游脚本一致', () => {
  assert.equal(qaRunner.REQUIRED_SKILL.name, 'autoresearch-qa-skills')
  assert.equal(qaRunner.REQUIRED_SKILL.version, '0.3.4')
  assert.deepEqual(qaRunner.IDENTITY_FIELDS, ['provider', 'model', 'version', 'session_id'])
})

// ── 工作流模式 ──────────────────────────────────────────────────────────

test('工作流模式初始为未激活', () => {
  const mode = workflow.emptyMode()
  assert.equal(mode.active, false)
  assert.equal(mode.wanted, null)
  assert.equal(mode.runningCommandId, null)
})

test('工作流模式可配置驱动激活', () => {
  // 双路质检、远端长跑不可能交互输入命令，但同样需要门禁纪律。
  assert.equal(workflow.emptyMode(true).active, true)
})

test('模式状态折叠命令事件（不用自定义事件类型）', () => {
  // 关键约束：自定义事件类型会让整个会话日志无法被读取路径解释，
  // 而 Session.append 无法设置 ignorable 信封标记。因此折叠已知的
  // command/run 与 command/done —— 与 plan-mode 同一做法。
  let mode = workflow.emptyMode()
  mode = workflow.foldMode(mode, {
    type: 'command/run',
    data: { name: 'autoresearch', commandId: 'c1', args: '' },
  })
  assert.equal(mode.wanted, true, '命令执行期间记下目标状态')
  assert.equal(mode.runningCommandId, 'c1')
  assert.equal(mode.active, false, '命令未完成前不改变 active')

  mode = workflow.foldMode(mode, { type: 'command/done', data: { commandId: 'c1' } })
  assert.equal(mode.active, true, '命令完成后落到目标状态')
  assert.equal(mode.runningCommandId, null)
})

test('退出命令同样折叠为未激活', () => {
  let mode = workflow.emptyMode(true)
  mode = workflow.foldMode(mode, {
    type: 'command/run',
    data: { name: 'autoresearch', commandId: 'c2', args: 'off' },
  })
  assert.equal(mode.wanted, false)
  mode = workflow.foldMode(mode, { type: 'command/done', data: { commandId: 'c2' } })
  assert.equal(mode.active, false)
})

test('折叠忽略其它命令与无关事件', () => {
  const initial = workflow.emptyMode()
  assert.deepEqual(workflow.foldMode(initial, { type: 'command/run', data: { name: 'plan' } }), initial)
  assert.deepEqual(workflow.foldMode(initial, { type: 'turn/start', data: {} }), initial)
  assert.deepEqual(workflow.foldMode(initial, { type: 'command/done', data: { commandId: 'other' } }), initial)
})

test('折叠可重放：同一事件序列得同一状态', () => {
  const events = [
    { type: 'command/run', data: { name: 'autoresearch', commandId: 'c3', args: '' } },
    { type: 'command/done', data: { commandId: 'c3' } },
  ]
  const once = events.reduce((state, event) => workflow.foldMode(state, event), workflow.emptyMode())
  const twice = events.reduce((state, event) => workflow.foldMode(state, event), workflow.emptyMode())
  assert.deepEqual(once, twice)
  assert.equal(once.active, true)
})

test('模式策略：激活时含纪律，未激活时为空串', () => {
  const policy = workflow.renderModePolicy(true)
  assert.ok(policy.includes('<autoresearch_mode>'))
  assert.ok(policy.includes('不得推进阶段'))
  assert.ok(policy.includes('每轮迭代必须留八字段记录'))
  // 章节不依赖阶段：配置驱动激活时没有命令事件，依赖它会让章节恒空
  // （一次真实会话抓包发现的）。阶段信息由每步注入的指令承担。
  assert.equal(policy.includes('本步应做的事'), false,
    '静态策略不应包含动态指令，避免两处声明同一事实')
  assert.equal(workflow.renderModePolicy(false), '')
  assert.equal(workflow.renderModePolicy(undefined), '')
})

test('第 1 阶段指令：指出未运行的门禁与缺失交付物', () => {
  const directive = workflow.renderStepDirective({
    phaseId: 'intake',
    gateResults: {},
    missingRequired: [{ path: 'task_identity.json', note: 'Task ID' }],
  })
  assert.ok(directive.text.includes('<autoresearch_step phase="intake"'))
  assert.ok(directive.text.includes('G-SELECT'))
  assert.ok(directive.text.includes('尚未运行'))
  assert.ok(directive.text.includes('task_identity.json'))
  assert.equal(directive.text.includes('模式纪律'), false, '纪律由静态策略负责，指令不重复')
  assert.ok(directive.fingerprint.startsWith('intake' + String.fromCharCode(124)))
})

test('有失败门禁时，指令指向最早失败项', () => {
  const directive = workflow.renderStepDirective({
    phaseId: 'authoring',
    gateResults: {
      'G-FEASIBILITY': { verdict: 'REJECT' },
      'G-CONTRACT': { verdict: 'RECOMMEND' },
    },
    missingRequired: [],
  })
  assert.equal(directive.blocking[0].gateId, 'G-FEASIBILITY')
  assert.ok(directive.text.includes('REJECT'))
  assert.ok(directive.text.includes('只修当前最早失败项'))
})

test('本阶段门禁全通过时，指令建议推进', () => {
  const directive = workflow.renderStepDirective({
    phaseId: 'intake',
    gateResults: { 'G-SELECT': { verdict: 'RECOMMEND' } },
    missingRequired: [],
  })
  assert.ok(directive.text.includes('已全部通过'))
  assert.ok(directive.text.includes('可以推进到阶段 authoring'))
  assert.equal(directive.blocking.length, 0)
})

test('最后阶段后指令指向交付整理', () => {
  const directive = workflow.renderStepDirective({
    phaseId: 'release',
    gateResults: {
      'G-REPLAY-CONTRACT': { verdict: 'RECOMMEND' },
      'G-SINGLE-SOURCE': { verdict: 'RECOMMEND' },
      'G-PACK-VERIFY': { verdict: 'RECOMMEND' },
    },
    missingRequired: [],
  })
  assert.ok(directive.text.includes('已是最后阶段'))
  assert.ok(directive.text.includes('三类交付目录'))
})

test('未知阶段如实报错，不猜测', () => {
  const directive = workflow.renderStepDirective({
    phaseId: 'nonexistent', gateResults: {}, missingRequired: [],
  })
  assert.ok(directive.text.includes('无法识别'))
  assert.ok(directive.fingerprint.startsWith('unknown:'))
})

test('两种未通过状态都算阻塞', () => {
  const needsEvidence = workflow.renderStepDirective({
    phaseId: 'intake',
    gateResults: { 'G-SELECT': { verdict: 'NEEDS_EVIDENCE' } },
    missingRequired: [],
  })
  assert.equal(needsEvidence.blocking.length, 1)
  assert.equal(needsEvidence.blocking[0].verdict, 'NEEDS_EVIDENCE')

  // authoring 有四道门禁：两道未运行也必须计入阻塞。
  const mixed = workflow.renderStepDirective({
    phaseId: 'authoring',
    gateResults: {
      'G-FEASIBILITY': { verdict: 'NEEDS_EVIDENCE' },
      'G-CONTRACT': { verdict: 'REJECT' },
    },
    missingRequired: [],
  })
  assert.equal(mixed.blocking.length, 4, '未运行的门禁同样阻塞')
})

test('提醒抑制：指纹相同不重复注入', () => {
  assert.equal(workflow.shouldNudge(true, null, 'fp-1'), true, '首次应提醒')
  assert.equal(workflow.shouldNudge(true, 'fp-1', 'fp-1'), false, '相同应抑制')
  assert.equal(workflow.shouldNudge(true, 'fp-1', 'fp-2'), true, '变化应提醒')
  assert.equal(workflow.shouldNudge(false, null, 'fp-3'), false, '未激活不提醒')
})

test('指纹包含阶段、门禁结论与缺失数量', () => {
  const a = workflow.renderStepDirective({ phaseId: 'intake', gateResults: {}, missingRequired: [] })
  const b = workflow.renderStepDirective({
    phaseId: 'intake', gateResults: { 'G-SELECT': { verdict: 'RECOMMEND' } }, missingRequired: [],
  })
  assert.notEqual(a.fingerprint, b.fingerprint, '门禁结论变化必须改变指纹')
  const c = workflow.renderStepDirective({
    phaseId: 'intake', gateResults: {}, missingRequired: [{ path: 'x' }],
  })
  assert.notEqual(a.fingerprint, c.fingerprint, '缺失数量变化必须改变指纹')
})

test('模式摘要报告状态', () => {
  assert.equal(workflow.summarizeMode(workflow.emptyMode()).active, false)
  const active = workflow.summarizeMode(workflow.emptyMode(true))
  assert.equal(active.active, true)
  assert.ok(active.text.includes('每步开始前注入'))
})

test('模式不写入任何自定义会话事件类型', async () => {
  // 这是事故防线：写自定义事件会让整个会话日志不可读。
  // 断言模块里不出现 append( 调用 —— 状态完全由命令事件折叠得出。
  const source = await readFile(
    new URL('../packages/dsh-autoresearch/lib/mode.js', import.meta.url), 'utf8')
  assert.equal(/session\.append\(/.test(source), false,
    '模式模块不得调用 session.append：自定义事件会让日志不可读')
  const workflowSource = await readFile(
    new URL('../packages/dsh-autoresearch/lib/workflow.js', import.meta.url), 'utf8')
  assert.equal(/'autoresearch\/(step|mode)'/.test(workflowSource), false,
    '不得声明自定义事件类型常量')
})

// ── 身份层（dsh-ars-brand）────────────────────────────────────────────────────

test('身份层：补丁禁用官方品牌占位行并插入自己', async () => {
  const patch = await readFile(
    new URL('../packages/dsh-ars-brand/cordis.patch.yml', import.meta.url), 'utf8')
  // 命中既有行、只给 disabled —— 若误写成 insert，就变成「新增一行」而不是「替换占位」。
  assert.ok(/- id: ui-brand-official\s*\n\s*disabled: true/.test(patch),
    '必须按 id 命中 ui-brand-official 并置 disabled: true')
  assert.ok(/name: dsh-ars-brand/.test(patch), '必须插入 dsh-ars-brand 行')
})

test('身份层：安装器把 dsh-ars-brand 排在 bundles 末尾', async () => {
  const source = await readFile(
    new URL('../scripts/install-profile.mjs', import.meta.url), 'utf8')
  const list = source.match(/const PACKAGES = \[([\s\S]*?)\]/)
  assert.ok(list !== null, '找不到 PACKAGES 列表')
  const names = [...list[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  // 顺序即语义：profile 的 patch 层后者覆盖前者，身份层必须最后才能覆盖
  // dsh-web-app 声明的品牌占位行。排错位置时不会有任何报错，只会静默不生效。
  assert.equal(names[names.length - 1], 'dsh-ars-brand',
    `身份层必须是最后一个 bundle，实际末尾是 ${names[names.length - 1]}`)
  // 安装器还要能把已被手工改乱的位置归位，否则旧 profile 修不好。
  assert.ok(/filter\(\(name\) => name !== LAST\)/.test(source),
    '安装器必须显式把身份层归位到末尾，而不是只靠「追加缺失项」')
})

test('身份层：客户端注册的品牌槽位齐全', async () => {
  const source = await readFile(
    new URL('../packages/dsh-ars-brand/client.js', import.meta.url), 'utf8')
  for (const slot of ['sidebar.brand.mark', 'sidebar.brand.name',
    'conversation.hero.brand.mark', 'settings.section']) {
    assert.ok(source.includes(`'${slot}'`), `缺少槽位注册：${slot}`)
  }
  // 官方 practices 明令：插件不得 require 任何 Harness Client 包。
  assert.equal(/require\(['"]@deepseek-ai\//.test(source), false,
    '身份层不得 require 任何 @deepseek-ai/* 客户端包')
  // 工厂必须无副作用：样式与注册都要在 apply 内完成。
  const factoryBody = source.slice(source.indexOf('factory:'), source.indexOf('function apply'))
  assert.equal(/document\.(head|body)/.test(factoryBody), false,
    '工厂体内不得触碰 DOM（须在 apply 的 ctx.effect 内）')
})

test('身份层：桌面壳注入闪屏覆盖样式', async () => {
  const source = await readFile(
    new URL('../src/main/index.js', import.meta.url), 'utf8')
  // 闪屏的 "HARNESS" 是构建产物里的字面量，没有槽位可注册，只能渲染层覆盖。
  assert.ok(/insertCSS/.test(source), '桌面壳必须注入闪屏覆盖样式')
  // 类名带内容哈希，全名匹配会在上游重建后失效，必须用前缀匹配。
  assert.ok(/class\^="_wordmark_"\]/.test(source),
    '闪屏选择器必须用类名前缀匹配（类名含内容哈希）')
  // 作用域必须限定在启动闪屏根节点内，否则可能影响主界面。
  assert.ok(/\[data-dshBoot\]/.test(source),
    '闪屏覆盖必须限定在 [data-dshBoot] 作用域内')
})

// ── 损坏文件不得静默重置（数据销毁防线）────────────────────────────────────

test('readJsonDoc：文件不存在返回 null，不抛错', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ars-doc-'))
  try {
    assert.equal(await sessionTasks.readJsonDoc(join(home, 'missing.json')), null)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('readJsonDoc：损坏时隔离原文件并抛错（不得当空文档）', async () => {
  // 这是事故防线：调用方随后会写回整个文件，返回空文档等于把用户数据抹掉。
  // 实测形态：绑定文件里一个坏字节 → 下次绑定把所有会话的任务绑定清空。
  const home = await mkdtemp(join(tmpdir(), 'ars-doc-'))
  try {
    const path = join(home, 'broken.json')
    await writeFile(path, '{ 这不是合法 JSON', 'utf8')
    let threw = false
    try { await sessionTasks.readJsonDoc(path) } catch { threw = true }
    assert.ok(threw, '损坏的 JSON 必须抛错，不能返回空文档')
    // 原文件必须仍在（改名保留），且原路径已腾空以便重建。
    const entries = await readdir(home)
    assert.equal(entries.length, 1, `隔离后应只剩备份文件，实际：${entries.join(', ')}`)
    assert.ok(entries[0].startsWith('broken.json.corrupt-'), `备份文件名不对：${entries[0]}`)
    const kept = await readFile(join(home, entries[0]), 'utf8')
    assert.ok(kept.includes('这不是合法 JSON'), '备份内容必须与原文一致（不能丢数据）')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('readJsonDoc：结构不符同样隔离并抛错', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ars-doc-'))
  try {
    const path = join(home, 'wrong.json')
    await writeFile(path, JSON.stringify({ bindings: 'not-an-object' }), 'utf8')
    let threw = false
    try {
      await sessionTasks.readJsonDoc(path, {
        isValid: (value) => value !== null && typeof value === 'object'
          && value.bindings !== null && typeof value.bindings === 'object',
      })
    } catch { threw = true }
    assert.ok(threw, '结构不符必须抛错')
    const entries = await readdir(home)
    assert.equal(entries.length, 1, '结构不符也应隔离保留原文件')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('registerTaskInWorkbench：登记表损坏时抛错而不是清空登记', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ars-wb-'))
  try {
    const registry = join(home, 'autoresearch-workbench.json')
    await writeFile(registry, 'not json at all', 'utf8')
    let threw = false
    try { await sessionTasks.registerTaskInWorkbench(home, 'D:/x/task') } catch { threw = true }
    assert.ok(threw, '损坏时必须抛错')
    // 关键：原登记表不能被覆盖成「只有新任务」。
    const entries = await readdir(home)
    const backup = entries.find((name) => name.startsWith('autoresearch-workbench.json.corrupt-'))
    assert.ok(backup !== undefined, `应保留备份，实际目录：${entries.join(', ')}`)
    assert.equal(await readFile(join(home, backup), 'utf8'), 'not json at all')
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('registerTaskInWorkbench：首次登记正常建立登记表', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ars-wb-'))
  try {
    const first = await sessionTasks.registerTaskInWorkbench(home, 'D:/x/task-a')
    assert.deepEqual(first.taskRoots, ['D:/x/task-a'])
    // 幂等：重复登记不产生重复项。
    const again = await sessionTasks.registerTaskInWorkbench(home, 'D:/x/task-a')
    assert.equal(again.added, false)
    const second = await sessionTasks.registerTaskInWorkbench(home, 'D:/x/task-b')
    assert.deepEqual(second.taskRoots, ['D:/x/task-a', 'D:/x/task-b'])
  } finally { await rm(home, { recursive: true, force: true }) }
})

// ── 工作台摘要：必须认真实标注文件的字段写法 ─────────────────────────────────

test('工作台：minimize 指标下「最佳分」取最小而不是最大', async () => {
  // 实测缺陷：硬写 Math.max，于是 AutoRe0566（StatErr，minimize）三轮
  // 8.9 → 8.4 → 7.9，工作台把**最差**的首轮报成最佳。
  const home = await mkdtemp(join(tmpdir(), 'ars-digest-'))
  try {
    await mkdir(join(home, 'expert_evidence'), { recursive: true })
    await writeFile(join(home, 'expert_evidence', 'expert_annotation.json'),
      JSON.stringify({ metric_name: 'StatErr', metric_direction: 'minimize（原始指标）；归一化后 maximize' }), 'utf8')
    await writeFile(join(home, 'expert_evidence', 'trajectory_codex.json'),
      JSON.stringify({ rounds: [8.9, 8.4, 7.9].map((score, i) => ({ round: i + 1, score })) }), 'utf8')
    const digest = await ui.trajectoryDigest(home)
    assert.equal(digest.codex.direction, 'minimize')
    assert.equal(digest.codex.best, 7.9, `minimize 下最佳应为 7.9，实际 ${digest.codex.best}`)
    assert.equal(digest.codex.latest, 7.9)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('工作台：maximize 指标下「最佳分」取最大', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ars-digest-'))
  try {
    await mkdir(join(home, 'expert_evidence'), { recursive: true })
    await writeFile(join(home, 'expert_evidence', 'expert_annotation.json'),
      JSON.stringify({ metric_direction: 'maximize' }), 'utf8')
    await writeFile(join(home, 'expert_evidence', 'trajectory_codex.json'),
      JSON.stringify({ rounds: [31.2, 46.8, 48.3].map((score, i) => ({ round: i + 1, score })) }), 'utf8')
    const digest = await ui.trajectoryDigest(home)
    assert.equal(digest.codex.best, 48.3)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('工作台：校准摘要认「扁平式」专家标注（anchors / metric_direction / 顶层统计量）', async () => {
  // 实测缺陷：只认 score_contract + statistics 嵌套式，于是专家手写的真实标注
  // 在工作台上整块显示为空 —— 数据都在，只是字段名对不上。
  const home = await mkdtemp(join(tmpdir(), 'ars-digest-'))
  try {
    await mkdir(join(home, 'expert_evidence'), { recursive: true })
    await mkdir(join(home, 'optimization_evidence'), { recursive: true })
    await writeFile(join(home, 'expert_evidence', 'expert_annotation.json'), JSON.stringify({
      metric_name: 'StatErr',
      metric_direction: 'minimize（原始指标）',
      anchors: { B_mean: null, U: null, calibration_status: 'NOT_RUN' },
    }), 'utf8')
    await writeFile(join(home, 'optimization_evidence', 'comparison_summary.json'), JSON.stringify({
      status: 'NOT_RUN', U: 0.03656967585449946, n_baseline_expected: 3, B_mean: null,
    }), 'utf8')
    const cal = await ui.calibrationDigest(home)
    assert.equal(cal.metric, 'StatErr')
    assert.equal(cal.direction, 'minimize（原始指标）')
    assert.equal(cal.upper, 0.03656967585449946)
    assert.equal(cal.pairedRuns, 3)
    assert.equal(cal.calibrationStatus, 'NOT_RUN')
    // B/R 未跑时必须如实留空，不能编造。
    assert.equal(cal.baseline, null)
    assert.equal(cal.reference, null)
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('工作台：校准摘要仍认「嵌套式」写法（两种都要支持）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ars-digest-'))
  try {
    await mkdir(join(home, 'expert_evidence'), { recursive: true })
    await mkdir(join(home, 'optimization_evidence'), { recursive: true })
    await writeFile(join(home, 'expert_evidence', 'expert_annotation.json'), JSON.stringify({
      score_contract: {
        metric: 'score', direction: 'maximize',
        baseline: { raw_value: 31.2 }, reference: { raw_value: 46.8 }, upper_bound: { raw_value: 71 },
      },
    }), 'utf8')
    await writeFile(join(home, 'optimization_evidence', 'comparison_summary.json'),
      JSON.stringify({ statistics: { baseline_mean: 31.2, reference_mean: 46.8, paired_run_count: 3, baseline_sigma_multiple: 10 } }), 'utf8')
    const cal = await ui.calibrationDigest(home)
    assert.equal(cal.metric, 'score')
    assert.equal(cal.baseline, 31.2)
    assert.equal(cal.reference, 46.8)
    assert.equal(cal.upper, 71)
    assert.equal(cal.sigmaMultiple, 10)
  } finally { await rm(home, { recursive: true, force: true }) }
})

// ── 与教程 v0.3.8 对齐 ──────────────────────────────────────────────────────

test('G-DOCKERFILE：省略 tests/Dockerfile 是「复用 Solver 镜像」，不得判缺证据', () => {
  // 教程 v0.3.8（L169/L512）明确允许复用 Solver 镜像、此时无需 tests/Dockerfile。
  // 早期判 G3.3 UNKNOWN，而 UNKNOWN 与 FAIL 一样拦阶段推进 —— 一种被认可的交付
  // 方式被当成了缺证据。
  const md = ['Goal', 'Task Setting', 'Objective and Metrics', 'Allowed Scope',
    'Hard Boundaries', 'Submission Instructions', 'Workflow & Iteration', 'Completion Criteria']
    .map((s) => `## ${s}`).join('\n')
  const result = gates.gateDockerPathContract({
    environmentDockerfile: 'FROM x\nCOPY starter/ /s/\nCOPY public_eval/ /pe/\n',
    testsDockerfile: undefined,
    instructionMd: md,
    sourceFiles: [{ path: 'workspace/reference/x.py', text: 'for a, b in train_loader:\n    loss.backward()\n' }],
  })
  assert.equal(result.verdict, 'RECOMMEND', JSON.stringify(result.checks.filter((c) => c.status !== 'PASS')))
  for (const id of ['G3.3', 'G3.4', 'G3.5']) {
    assert.equal(result.checks.find((c) => c.id === id).status, 'PASS', `${id} 应判 PASS（不适用）`)
  }
  // 反向：提供了 tests/Dockerfile 时越界 COPY 仍须 FAIL（放宽不能失效）。
  const bad = gates.gateDockerPathContract({
    environmentDockerfile: 'FROM x\nCOPY starter/ /s/\n',
    testsDockerfile: 'FROM x\nCOPY ../secret /tests/\n',
    instructionMd: md,
    sourceFiles: [{ path: 'workspace/reference/x.py', text: 'for a, b in train_loader:\n    loss.backward()\n' }],
  })
  assert.equal(bad.checks.find((c) => c.id === 'G3.3').status, 'FAIL')
})

test('阶段 2：tests/Dockerfile 不是必需交付物（0.3.8 允许复用镜像）', () => {
  const phase2 = phases.PHASES.find((p) => p.id === 'authoring')
  const entry = phase2.deliverables.find((d) => d.path === 'workspace/harbor_task/tests/Dockerfile')
  assert.ok(entry !== undefined, '阶段 2 应仍声明该路径（用于提示）')
  assert.equal(entry.required, false, 'tests/Dockerfile 不应是必需项')
  // 但 test.sh / grader.py 仍是必需 —— 评分入口与可信评分器不可省。
  for (const path of ['workspace/harbor_task/tests/test.sh', 'workspace/harbor_task/tests/grader.py']) {
    assert.equal(phase2.deliverables.find((d) => d.path === path).required, true, `${path} 应为必需`)
  }
})

test('脚手架 run_summary 模板含 QA21 题包指纹字段（task_binding）', async () => {
  // 0.3.8（L850-853 / QA21）要求 run_summary.json 记录 hash_profile 与
  // task_content_sha256。模板此前缺这一整块，专家照模板填就永远缺字段。
  const source = await readFile(
    new URL('../packages/dsh-autoresearch/lib/scaffold.js', import.meta.url), 'utf8')
  const block = source.match(/const RUN_SUMMARY_TEMPLATE = `([\s\S]*?)`/)
  assert.ok(block !== null, '找不到 RUN_SUMMARY_TEMPLATE')
  const template = JSON.parse(block[1])
  assert.ok(template.task_binding !== undefined, '模板缺 task_binding')
  assert.equal(template.task_binding.hash_profile, 'harbor-task-inputs-v1')
  assert.ok('task_content_sha256' in template.task_binding, 'task_binding 缺 task_content_sha256')
  // 其余 0.3.8 字段也应在（防止回退时被删掉）。
  for (const key of ['agent_execution', 'fast_iteration_exception', 'validation']) {
    assert.ok(template[key] !== undefined, `模板缺 ${key}`)
  }
  assert.ok('effective_rounds' in template.agent_execution[0], 'agent_execution 缺 effective_rounds')
  assert.ok('typical_round_minutes' in template.agent_execution[0], 'agent_execution 缺 typical_round_minutes')
})

// ── 教程 v0.3.8：QA15 资源上限 / 例外条件 / 交付期自验 ──────────────────────

/** 0.3.8 风格的合法 task.toml 对象（G2.1–G2.6 全过）。 */
const contract038 = (over = {}) => ({
  artifacts: ['/workspace/solution'],
  task: { name: 'group/name', time_limit_seconds: 7200 },
  agent: { network_mode: 'no-network' },
  verifier: { network_mode: 'no-network', environment_mode: 'separate' },
  environment: { build_timeout_sec: 3600, cpus: 16, gpus: 1, gpu_types: ['H20'] },
  schema_version: '1.0',
  ...over,
})

test('QA15：合规资源全 PASS；超核/CPU题带卡型 FAIL；非内场卡型 UNKNOWN', () => {
  // QA15 由**发布期**打包门调用（教程把资源估算列为提交期质检项），
  // 不放在阶段 2 的契约门 —— 否则"还没填资源字段"会阻塞构建。
  const status = (payload, id) => gates.gateResourceLimits(payload).checks.find((c) => c.id === id).status
  assert.ok(gates.gateResourceLimits(contract038()).checks.every((c) => c.status === 'PASS'))
  // 两个 sandbox 的 CPU 相加才是单轮需求：64+32 = 96 > 64
  const overCpu = contract038({
    environment: { build_timeout_sec: 3600, cpus: 64, gpus: 1, gpu_types: ['H20'] },
    verifier: { network_mode: 'no-network', environment_mode: 'separate', environment: { cpus: 32 } },
  })
  assert.equal(status(overCpu, 'G15.2'), 'FAIL')
  // CPU 题（gpus 合计 0）不得声明 gpu_types
  const cpuWithType = contract038({
    environment: { build_timeout_sec: 3600, cpus: 16, gpus: 0, gpu_types: ['H20'] },
  })
  assert.equal(status(cpuWithType, 'G15.4'), 'FAIL')
  // 非内场卡型 → 需人工复核（不是硬拒，教程允许「先调整再复核」）
  const a800 = contract038({ environment: { build_timeout_sec: 3600, cpus: 16, gpus: 1, gpu_types: ['A800'] } })
  assert.equal(status(a800, 'G15.4'), 'UNKNOWN')
  // 卡型按**型号 token** 匹配：真实任务写厂商全名（`NVIDIA L20`），精确比对会误杀合法卡
  for (const allowed of ['L20', 'l20', 'NVIDIA L20', 'NVIDIA L20 48GB', 'H20']) {
    const okType = contract038({ environment: { build_timeout_sec: 3600, cpus: 16, gpus: 1, gpu_types: [allowed] } })
    assert.equal(status(okType, 'G15.4'), 'PASS', `${allowed} 应判合法`)
  }
  for (const denied of ['NVIDIA A800 80GB PCIe', 'A100', 'V100']) {
    const bad = contract038({ environment: { build_timeout_sec: 3600, cpus: 16, gpus: 1, gpu_types: [denied] } })
    assert.equal(status(bad, 'G15.4'), 'UNKNOWN', `${denied} 应判需复核`)
  }
})

test('QA15：单轮出分预算超 7200s 判需复核，不硬拒', () => {
  // 教程 L600 允许「记录原因和判据并提交平台复核」，所以是 UNKNOWN 而不是 FAIL。
  const over = contract038({ task: { name: 'group/name', time_limit_seconds: 14400 } })
  const check = gates.gateResourceLimits(over).checks.find((c) => c.id === 'G15.1')
  assert.equal(check.status, 'UNKNOWN')
  assert.ok(/平台复核/.test(check.fix), check.fix)
  // ≤7200 则 PASS
  assert.equal(gates.gateResourceLimits(contract038()).checks.find((c) => c.id === 'G15.1').status, 'PASS')
})

/** 造 n 轮合法轨迹。 */
const trajOf = (n) => ({
  rounds: Array.from({ length: n }, (_, i) => ({
    round: i + 1, policy_name: `p${i}`, method_summary: '本轮改动与结论',
    status: 'ok', score: 1, failure_reason: null, retained_best: true,
    time: '2026-10-13 01:00:00',
  })),
})
const runsOf = (hours, rounds, minutes) => [
  { runtime: 'Codex', model: 'A', duration_hours: hours, effective_rounds: rounds, typical_round_minutes: minutes },
  { runtime: 'Codex', model: 'B', duration_hours: hours, effective_rounds: rounds, typical_round_minutes: minutes },
]
const EXCEPTION = {
  used: true, non_training: true, short_iterations: true,
  rollable_proved: true, evidence: '不涉及训练，典型单轮 12 分钟',
}

test('7 小时例外：不只看四个 flag，还要看轮数/节奏/重跑', () => {
  const base = {
    codexTrajectory: trajOf(3), seedTrajectory: trajOf(3),
    runSummary: {
      agent_execution: runsOf(8, 3, 12),
      fast_iteration_exception: EXCEPTION,
      validation: { best_method_rerun_passed: true },
    },
  }
  assert.equal(gates.gateTrajectory(base).verdict, 'RECOMMEND')
  // 条件 2：每条轨迹 ≥3 轮闭环 —— 勾了 flag 但只跑 1 轮不算
  const thin = { ...base, codexTrajectory: trajOf(1), seedTrajectory: trajOf(1) }
  assert.equal(gates.gateTrajectory(thin).checks.find((c) => c.id === 'G11:exception:rounds').status, 'FAIL')
  // 条件 5：写明有效轮数与典型单轮耗时
  const noPace = {
    ...base,
    runSummary: { ...base.runSummary, agent_execution: runsOf(8, 3, undefined) },
  }
  assert.equal(gates.gateTrajectory(noPace).checks.find((c) => c.id === 'G11:exception:pace').status, 'FAIL')
  // 条件 4：best_method 已在干净快照重跑出分
  const noRerun = {
    ...base,
    runSummary: { ...base.runSummary, validation: { best_method_rerun_passed: false } },
  }
  assert.equal(gates.gateTrajectory(noRerun).checks.find((c) => c.id === 'G11:exception:rerun').status, 'FAIL')
  // 未用例外时不强制这三条（10h 路线不需要例外证据）
  const notUsed = {
    codexTrajectory: trajOf(3), seedTrajectory: trajOf(3),
    runSummary: { agent_execution: runsOf(11, 9, 42), fast_iteration_exception: { used: false } },
  }
  assert.equal(gates.gateTrajectory(notUsed).verdict, 'RECOMMEND')
})

test('交付期自验：validation 四项任一为 false 即 REJECT', () => {
  const hashes = { 'a.toml': 'x'.repeat(64) }
  const base = {
    sourceHashes: hashes, packedHashes: hashes,
    bestMethodFiles: ['method.py'], gitState: { isRepo: false },
    annotation: { task_id: 'x' }, expertDoc: '只陈述自验事实。',
    taskToml: { task: { time_limit_seconds: 7200 }, environment: { cpus: 16, gpus: 1, gpu_types: ['H20'] } },
  }
  const pass = { ...base, runSummary: { validation: { baseline_passed: true, reference_passed: true, optimization_evidence_complete: true, best_method_rerun_passed: true } } }
  assert.equal(gates.gatePackVerify(pass).verdict, 'RECOMMEND')
  const fail = { ...base, runSummary: { validation: { baseline_passed: true, reference_passed: false, optimization_evidence_complete: true, best_method_rerun_passed: true } } }
  assert.equal(gates.gatePackVerify(fail).checks.find((c) => c.id === 'G14.5').status, 'FAIL')
  // 缺 validation 段 → UNKNOWN（不是 FAIL：可能只是没填）
  const missing = { ...base, runSummary: {} }
  assert.equal(gates.gatePackVerify(missing).checks.find((c) => c.id === 'G14.5').status, 'UNKNOWN')
})

test('best_method 内容：空目录与混入 Reference/密钥都判 FAIL', () => {
  const hashes = { 'a.toml': 'x'.repeat(64) }
  const base = {
    sourceHashes: hashes, packedHashes: hashes, gitState: { isRepo: false },
    annotation: { task_id: 'x' }, expertDoc: 'ok',
    taskToml: { task: { time_limit_seconds: 7200 }, environment: { cpus: 16, gpus: 1, gpu_types: ['H20'] } },
    runSummary: { validation: { baseline_passed: true, reference_passed: true, optimization_evidence_complete: true, best_method_rerun_passed: true } },
  }
  assert.equal(gates.gatePackVerify({ ...base, bestMethodFiles: [] }).checks.find((c) => c.id === 'G14.6').status, 'FAIL')
  for (const bad of [['method.py', 'reference/fast.py'], ['method.py', 'deploy.key'], ['hidden/x.npz']]) {
    assert.equal(gates.gatePackVerify({ ...base, bestMethodFiles: bad }).checks.find((c) => c.id === 'G14.6').status, 'FAIL',
      `应拦下：${bad.join(', ')}`)
  }
  assert.equal(gates.gatePackVerify({ ...base, bestMethodFiles: ['method.py', 'solve.sh'] }).checks.find((c) => c.id === 'G14.6').status, 'PASS')
})

test('Git 清理：非仓库不适用；有 remote/tag 判需复核', () => {
  const hashes = { 'a.toml': 'x'.repeat(64) }
  const base = {
    sourceHashes: hashes, packedHashes: hashes, bestMethodFiles: ['method.py'],
    annotation: { task_id: 'x' }, expertDoc: 'ok',
    taskToml: { task: { time_limit_seconds: 7200 }, environment: { cpus: 16, gpus: 1, gpu_types: ['H20'] } },
    runSummary: { validation: { baseline_passed: true, reference_passed: true, optimization_evidence_complete: true, best_method_rerun_passed: true } },
  }
  assert.equal(gates.gatePackVerify({ ...base, gitState: { isRepo: false } }).checks.find((c) => c.id === 'G14.7').status, 'PASS')
  const dirty = gates.gatePackVerify({ ...base, gitState: { isRepo: true, remotes: ['origin'], tags: ['v1'] } })
  assert.equal(dirty.checks.find((c) => c.id === 'G14.7').status, 'UNKNOWN')
  assert.equal(dirty.verdict, 'NEEDS_EVIDENCE')
})

test('专家不得夹带审核结论（annotation 与说明文档）', () => {
  const hashes = { 'a.toml': 'x'.repeat(64) }
  const base = {
    sourceHashes: hashes, packedHashes: hashes, bestMethodFiles: ['method.py'], gitState: { isRepo: false },
    runSummary: { validation: { baseline_passed: true, reference_passed: true, optimization_evidence_complete: true, best_method_rerun_passed: true } },
  }
  assert.equal(gates.gatePackVerify({ ...base, annotation: { task_id: 'x', approved: true }, expertDoc: 'ok' })
    .checks.find((c) => c.id === 'G14.8').status, 'FAIL')
  assert.equal(gates.gatePackVerify({ ...base, annotation: { task_id: 'x' }, expertDoc: '本题已通过审核。' })
    .checks.find((c) => c.id === 'G14.9').status, 'FAIL')
  assert.equal(gates.gatePackVerify({ ...base, annotation: { task_id: 'x' }, expertDoc: '官方 Hidden 结果: 0.8' })
    .checks.find((c) => c.id === 'G14.9').status, 'FAIL')
})

test('G-NOP-RESULT：fromTask 递归找证据，不依赖固定目录名', async () => {
  // 教程 v0.3.8 L29 只要求把四类证据「放入 expert_evidence/」，未规定子目录名。
  // 早期脚手架固定造 nop_selfcheck/，把一种约定当成了要求。
  const home = await mkdtemp(join(tmpdir(), 'ars-nop-'))
  try {
    // 故意放在非约定路径下，且分散两层
    await mkdir(join(home, 'expert_evidence', 'trial-20261013'), { recursive: true })
    await writeFile(join(home, 'expert_evidence', 'trial-20261013', 'config.json'), '{"agent":{"name":"nop"}}', 'utf8')
    await writeFile(join(home, 'expert_evidence', 'result.json'), '{"finished_at":"2026-10-13 03:00:00"}', 'utf8')
    await writeFile(join(home, 'expert_evidence', 'trial-20261013', 'reward.json'), '{"reward":0}', 'utf8')
    await writeFile(join(home, 'expert_evidence', 'trial.log'), 'stdout...', 'utf8')
    const payload = await plugin.collectFromTask(home, 'G-NOP-RESULT')
    assert.ok(payload.config !== undefined, '应找到 config.json')
    assert.ok(payload.result !== undefined, '应找到 result.json')
    assert.equal(payload.reward?.reward, 0, 'reward.json 应被解析为对象')
    assert.equal(payload.logPresent, true, '应找到运行日志')
    assert.equal(payload.sameTrial, true)
    // 门禁据此判定：config 有 nop、separate、reward 有限 → 需补 result 字段仍能给出结论
    const result = gates.gateNopResult({
      config: payload.config,
      result: { ...payload.result, verifier_environment_mode: 'separate', agent_info: { name: 'nop' }, verifier_result: { rewards: 0 } },
      reward: payload.reward,
      logPresent: payload.logPresent,
      sameTrial: payload.sameTrial,
    })
    assert.equal(result.verdict, 'RECOMMEND', JSON.stringify(result.checks.filter((c) => c.status !== 'PASS')))
  } finally { await rm(home, { recursive: true, force: true }) }
})

test('阶段 4：nop_selfcheck 不是必需交付物（目录名不固定）', () => {
  const phase4 = phases.PHASES.find((p) => p.id === 'release')
  const entry = phase4.deliverables.find((d) => d.path === 'expert_evidence/nop_selfcheck')
  assert.ok(entry !== undefined, '应仍声明该路径作为推荐位置')
  assert.equal(entry.required, false, 'nop_selfcheck 不应是必需项')
})

// ── 执行 ────────────────────────────────────────────────────────────────────

for (const { name, fn } of cases) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

console.log(`\n自检结果：${passed} 通过，${failed} 失败，共 ${cases.length} 项`)
process.exit(failed === 0 ? 0 : 1)
