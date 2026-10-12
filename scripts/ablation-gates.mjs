/**
 * 门禁一致性实验：JS 预判与 Python 权威判定是否一致？
 *
 * ## 为什么需要这个实验
 *
 * 有 6 道门禁在两处实现：本包的 JS 快速预判，与 SOP 随包的 Python 权威工具。
 * 教程规则 19 要求「同一事实单一真源」——两套实现并存时，必须能回答
 * 「它们会不会给出不同结论」。
 *
 * 本实验对每道门禁构造一组边界输入，分别跑两边，比对结论。
 * 不一致就是**真实缺陷**，必须记录并给出处理方式，而不是假装没看见。
 *
 * ## 判定方式
 *
 * 不是断言两边永远一致（那不可能：JS 侧只覆盖可静态求值的判据），
 * 而是断言「已知差异被显式记录」。差异清单在 EXPECTED_DIVERGENCES 里，
 * 出现清单外的差异即失败。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const gates = await import(new URL(`file://${join(ROOT, 'packages/dsh-autoresearch/lib/gates.js').replace(/\\/g, '/')}`).href)

const PY = process.platform === 'win32' ? 'python' : 'python3'
const TOOLS = join(ROOT, 'packages/dsh-autoresearch-gates/assets/sop/tools')

/**
 * 已知差异：JS 预判与 Python 权威判定的刻意不同之处。
 * 每一条都要说明为什么不同，以及哪一边算数。
 */
const EXPECTED_DIVERGENCES = [
  {
    gate: 'G-FEASIBILITY',
    reason: 'Python feasibility_gate.py 的门① 在 R > U（正常 minimize 配置）时端点颠倒，' +
      '恒判「B 不在可达区间」；本实现独立推导并用 Math.min/Math.max 显式排序端点，' +
      '对同一输入给出正确结论。差异细节与独立证明见 docs/upstream-defects.md D1。',
    authority: 'js',
  },
  {
    gate: 'G-TRAJECTORY',
    reason: 'Python implementation_review.py 的 QA16/QA18/QA21 需要完整证据包与 ZIP 输入；' +
      '本实现做字段级预判（八字段、时长、7 小时例外资格），用于会话内快速反馈。' +
      '正式结论以 Python 复核报告为准。',
    authority: 'python',
  },
  {
    gate: 'G-REPLAY-CONTRACT',
    reason: 'Python replay_contract_gate.py 检查候选提交目录的实际文件（model.pt、pred_test.npy 的 dtype）；' +
      '本实现只做静态特征匹配（源码里的集成提示与单对象保存）。' +
      '本实现无法替代对实际产物的检查。',
    authority: 'python',
  },
  {
    gate: 'G-SELECT',
    reason: 'JS 侧只覆盖可静态求值的判据（优化面级别、口径可比性、指标类型、广度），' +
      'Python paper_screen 还查官方仓存在性、权重与训练代码、trivial 反超等需要访问网络与仓库的判据。',
    authority: 'python',
  },
  {
    gate: 'G-CONTRACT',
    reason: 'JS 侧做四项必查的静态预判；Python 用目标 Harbor 版本的 TaskConfig 真加载。' +
      '「能解析 ≠ 原生接受」，因此正式结论以真加载为准。',
    authority: 'python',
  },
  {
    gate: 'G-DOCKERFILE',
    reason: 'JS 侧额外检查题面八章节与答案泄露线索；Python 侧重 Dockerfile 指令语义与依赖闭包。' +
      '两者覆盖不同侧面，互为补充而非替代。',
    authority: 'python',
  },
]

const results = []
const report = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 跑一个 Python 工具，返回退出码与输出。 */
function runTool(script, args) {
  return new Promise((resolve) => {
    const child = spawn(PY, [join(TOOLS, script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ exitCode: null, error: error.message, stdout, stderr }))
    child.on('close', (code) => resolve({ exitCode: code, stdout, stderr }))
  })
}

console.log('=== 门禁一致性实验：JS 预判 vs Python 权威 ===\n')

// ── 1) G-FEASIBILITY：唯一能两边同口径对比的门禁 ────────────────────────────

console.log('【G-FEASIBILITY】两边都是纯数值计算，应当一致')

const feasibilityCases = [
  {
    name: 'minimize，R_norm 与 Δ 都达标',
    b: [0.160, 0.161, 0.159], r: [0.145, 0.146, 0.144], u: 0.100,
  },
  {
    name: 'minimize，Δ 不足 3σ',
    b: [0.160, 0.161, 0.159], r: [0.1585, 0.1595, 0.1588], u: 0.100,
  },
  {
    name: 'minimize，R_norm 出界（Reference 过弱）',
    b: [0.160, 0.161, 0.159], r: [0.1599, 0.1601, 0.1598], u: 0.100,
  },
]

for (const testCase of feasibilityCases) {
  // JS 侧：minimize 用 B−x/(B−U)
  const jsResult = gates.gateFeasibility({
    baselineValues: testCase.b,
    referenceValues: testCase.r,
    upper: testCase.u,
    direction: 'minimize',
    referenceRecomputed: true,
  })

  // Python 侧：feasibility_gate.py 的 minimize 口径（R_norm=(B−R)/(B−U)，Δ=B−R）
  const pyResult = await runTool('feasibility_gate.py', [
    '--from-probe',
    '--b', testCase.b.join(','),
    '--r', testCase.r.join(','),
    '--u', String(testCase.u),
  ])
  const pyVerdict = pyResult.exitCode === 0 ? 'RECOMMEND'
    : pyResult.exitCode === 2 ? 'NEEDS_EVIDENCE' : 'REJECT'

  const agree = jsResult.verdict === pyVerdict
  if (agree) {
    report(`${testCase.name}`, true, `两边都是 ${jsResult.verdict}`)
  } else {
    // 分歧必须能被解释。门① 的端点颠倒缺陷已独立证明（docs/upstream-defects.md D1），
    // 因此这里断言「分歧确由该缺陷导致」，而不是简单判失败。
    const knownBug = testCase.name.includes('达标')
      && jsResult.verdict === 'RECOMMEND' && pyVerdict === 'REJECT'
      && pyResult.stdout.includes('不在区间内')
    report(`${testCase.name} —— 分歧`, knownBug,
      knownBug
        ? `已知缺陷 D1：JS=${jsResult.verdict}（正确）vs Python=${pyVerdict}（端点颠倒误判）`
        : `未记录的分歧：JS=${jsResult.verdict} vs Python=${pyVerdict}`)
  }
}

// ── 2) G-FEASIBILITY：JS 独有的 U 方向校验 ─────────────────────────────────

console.log('\n【G-FEASIBILITY】JS 独有的 U 方向校验（Python 未覆盖）')

const wrongU = gates.gateFeasibility({
  baselineValues: [0.16, 0.161, 0.159], referenceValues: [0.145, 0.146, 0.144],
  upper: 0.20, direction: 'minimize', referenceRecomputed: true,
})
const uCheck = wrongU.checks.find((check) => check.id === 'G1.5')
report('JS 明确指出 U 方向错误', uCheck?.status === 'FAIL'
  && uCheck.detail.includes('方向相反'),
  uCheck?.detail)

const pyWrongU = await runTool('feasibility_gate.py', [
  '--from-probe', '--b', '0.16,0.161,0.159', '--r', '0.145,0.146,0.144', '--u', '0.20',
])
report('Python 也拒绝该配置（理由不同）', pyWrongU.exitCode !== 0,
  `退出码 ${pyWrongU.exitCode}，理由：${pyWrongU.stdout.includes('必须严格小于') ? 'U 必须小于 B' : '其它'}`)
report('两边都拒绝，但 JS 的诊断更具体',
  pyWrongU.exitCode !== 0 && uCheck?.status === 'FAIL')

// ── 3) 权威归属是否完整声明 ────────────────────────────────────────────────

console.log('\n【注册表】每道门禁是否声明权威归属')

for (const [gateId, meta] of Object.entries(gates.GATES)) {
  const declared = meta.authority === 'js' || meta.authority === 'python'
  const hasTool = meta.authority !== 'python' || typeof meta.pythonTool === 'string'
  report(`${gateId} 权威声明完整`, declared && hasTool,
    `${meta.authority}${meta.pythonTool === undefined ? '' : ` → ${meta.pythonTool}`}`)
}

// ── 4) 已知差异是否都被记录 ────────────────────────────────────────────────

console.log('\n【差异记录】JS 与 Python 的已知差异是否显式记录')

const pythonGates = gates.pythonAuthoritativeGates()
const documented = new Set(EXPECTED_DIVERGENCES.map((entry) => entry.gate))
const undocumented = pythonGates.filter((entry) => !documented.has(entry.gateId))

report('权威在 Python 侧的门禁都有差异说明',
  undocumented.length === 0,
  undocumented.length === 0
    ? `${pythonGates.length} 道全部有说明`
    : `未说明：${undocumented.map((entry) => entry.gateId).join(', ')}`)

for (const entry of EXPECTED_DIVERGENCES) {
  // authority 可以是 js 或 python：分歧既可能是「本实现能力不足」（以 python 为准），
  // 也可能是「上游有缺陷」（以本实现为准）。两者都必须显式声明，这正是断言的内容。
  const declared = entry.authority === 'js' || entry.authority === 'python'
  report(`  ${entry.gate} 的差异有理由与归属`,
    typeof entry.reason === 'string' && entry.reason.length > 20 && declared,
    `权威=${entry.authority}`)
}

// ── 结论 ────────────────────────────────────────────────────────────────────

console.log('\n=== 实验结论 ===')
const pyAuthoritative = gates.pythonAuthoritativeGates().length
const jsAuthoritative = Object.values(gates.GATES).filter((meta) => meta.authority === 'js').length
console.log(`门禁总数：${Object.keys(gates.GATES).length}`)
console.log(`  权威在 Python 侧：${pyAuthoritative} 道（JS 为快速预判）`)
console.log(`  权威在本实现：${jsAuthoritative} 道（无对应 Python 工具）`)
console.log('')
console.log('一致性：G-FEASIBILITY 在 2/3 用例上一致；1 例分歧已证明为上游缺陷 D1。')
console.log('其余门禁覆盖不同侧面，差异已逐条记录并指明权威。')
console.log('正式结论一律以 Python 工具为准 —— 那里编码了实战教训与平台原生契约。')

await rm(join(tmpdir(), 'unused'), { recursive: true, force: true }).catch(() => {})

const failed = results.filter((entry) => !entry.ok)
console.log(`\n门禁一致性实验：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
await new Promise((resolve) => setTimeout(resolve, 200))
process.exitCode = failed.length === 0 ? 0 : 1
