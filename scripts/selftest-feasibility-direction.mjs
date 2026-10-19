/**
 * feasibility_gate.py 的回归测试 —— 方向参数（minimize/maximize）。
 *
 * ## 为什么必须把这个测试入库
 *
 * 全仓库此前**零测试**覆盖这个脚本，后果是实测过的：
 *
 *   · 脚本把 minimize 口径写死（`R_norm=(B−R)/(B−U)`、`Δ=B−R`、`B≤U` 硬失败）。
 *     对 maximize 指标（准确率/召回率/balanced accuracy 等越高越好），
 *     U 是可达上限，`U>B` 必然成立 —— 于是脚本把**真实改善** `R>B`
 *     报成「U 必须严格小于 B」的结构性失败，符号全反的假阳性。
 *   · `lib/tools.js` 的 `buildArgv` 没有 `--direction` 参数分支，
 *     即使脚本支持了也透传不过去。
 *
 * 更糟的是**权威方向搞反了**：`lib/gates.js` 的 `gateFeasibility` 一直按
 * `direction` 正确判读，而 `lib/tools.js` 却把这个脚本标为 `authority: 'python'`。
 * 权威工具错、校验工具对，且没有任何测试能发现。
 *
 * ## 向后兼容是硬条件
 *
 * 本测试的基线**不写死在脚本里**，而是从 `git show HEAD:<path>` 取原始版本
 * 与当前版本**逐字节比对 stdout 与退出码**。理由：如果基线是手工抄进测试的
 * 字符串，那么「代码变了、基线也被人跟着改」就会静默通过 —— 那就成了自我
 * 实现的预言。git HEAD 是唯一可信的「改动前」真源（已核对它与本次修复前
 * 的 .orig 备份逐字节相同）。
 *
 * 用法：node scripts/selftest-feasibility-direction.mjs
 * 退出码：0 = 全部通过；1 = 有失败
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const REL = 'packages/dsh-autoresearch-gates/assets/sop/tools/feasibility_gate.py'
const NEW = join(ROOT, REL)

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${detail}`}`)
}

/**
 * 值等价断言。
 *
 * 刻意与 `record` 分开：`record` 的第二个参数是**布尔**，把「期望值」直接
 * 传进去会得到「期望值非空即通过」的假绿（0 / null / undefined 恰好是假值
 * 才会失败）—— 本测试的第一版就这么错过，6 项里有 3 项是蒙对的。
 * 凡是比对具体值的断言一律走 expect()，不再手写布尔。
 */
function expect(name, expected, actual, note) {
  const same = Object.is(expected, actual)
    || JSON.stringify(expected) === JSON.stringify(actual)
  record(name, same, same
    ? (note === undefined ? JSON.stringify(actual) : `${JSON.stringify(actual)}  ${note}`)
    : `期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`)
}

/** 用 python 跑脚本，返回 { code, stdout }。stdout 原样（含换行）用于逐字节比对。 */
function runPy(script, argv) {
  const result = spawnSync('python', [script, ...argv], {
    encoding: 'buffer',
    cwd: ROOT,
    maxBuffer: 8 * 1024 * 1024,
  })
  return {
    code: result.status,
    stdout: Buffer.from(result.stdout ?? Buffer.alloc(0)),
    stderr: Buffer.from(result.stderr ?? Buffer.alloc(0)),
    spawnError: result.error?.message ?? null,
  }
}

/** 逐字节比较两个运行结果。 */
function sameRun(a, b) {
  return a.code === b.code
    && Buffer.compare(a.stdout, b.stdout) === 0
    && Buffer.compare(a.stderr, b.stderr) === 0
}

// ── 0. 拿到 git HEAD 的原版脚本 ─────────────────────────────────────────────

console.log('=== 0) 取出 git HEAD 的原版脚本作为兼容性基线 ===')
const showResult = spawnSync('git', ['show', `HEAD:${REL}`], {
  encoding: 'buffer',
  cwd: ROOT,
  maxBuffer: 8 * 1024 * 1024,
})
if (showResult.status !== 0) {
  console.log('  FAIL 无法从 git 取出原版脚本；本测试的兼容性基线依赖 git HEAD。')
  console.log(`       ${String(showResult.stderr ?? '').slice(0, 200)}`)
  process.exit(1)
}
const origDir = mkdtempSync(join(tmpdir(), 'feas-orig-'))
const ORIG = join(origDir, 'feasibility_gate.orig.py')
writeFileSync(ORIG, showResult.stdout)
record('原版脚本已取出（git HEAD）',
  /def main\(\)/.test(showResult.stdout.toString('utf8')),
  `${showResult.stdout.length} 字节`)

// ── 1. 向后兼容：9 个 minimize 用例必须与旧版逐字节一致 ────────────────────
//
// **注意本节的断言是「字节一致」，不是「判定正确」。**
// 上游脚本带一个已记录的缺陷 D1（docs/upstream-defects.md）：门① 的可达 B 区间
// 端点被颠倒成 `[hi, lo]`，于是 minimize 下门① **恒判失败**。所以下面几个
// 输入形状上「本该通过」的用例，实际退出码是 1 —— 那是 D1，不是我改坏的。
// 保留它们正是为了钉住「我的改动没有触碰 minimize 路径的任何一位」。
//
// 覆盖题目点名的六类：多 seed / 多 seed 不足 / 单 seed（σ 未知）/
// B≤U 硬失败 / 无 U / --from-paper，另加三个边界。

console.log('\n=== 1) 向后兼容（硬条件）：与 git HEAD 原版逐字节比对 ===')
console.log('   断言是「字节一致」，不是「判定正确」—— 上游缺陷 D1 会让门① 恒失败。')
const COMPAT_CASES = [
  ['多 seed（D1 下仍判不可行）', ['--from-probe', '--b', '0.134,0.152,0.147', '--r', '0.106,0.081,0.204', '--u', '0.031']],
  ['多 seed 不足', ['--from-probe', '--b', '0.134,0.152,0.147', '--r', '0.130,0.145,0.140', '--u', '0.031']],
  ['单 seed（σ_B 未知）', ['--from-probe', '--b', '0.1340', '--r', '0.1300', '--u', '0.0310']],
  ['B≤U 硬失败', ['--from-probe', '--b', '0.010,0.011,0.009', '--r', '0.005', '--u', '0.031']],
  ['无 U（门①未知）', ['--from-probe', '--b', '0.134,0.152,0.147', '--r', '0.106,0.081,0.204']],
  ['--from-paper 纸面预解', ['--from-paper', '--b', '0.60', '--r', '0.65', '--u-hint', '0.5']],
  // 额外：B 低于区间下限 / 高于上限，覆盖门①内部分支
  ['B 低于区间下限', ['--from-probe', '--b', '0.100,0.101,0.099', '--r', '0.106,0.081,0.204', '--u', '0.031']],
  ['B 高于区间上限', ['--from-probe', '--b', '0.400,0.402,0.399', '--r', '0.106,0.081,0.204', '--u', '0.031']],
  ['自定义 sigma-mult', ['--from-probe', '--b', '0.134,0.152,0.147', '--r', '0.106,0.081,0.204', '--u', '0.031', '--sigma-mult', '5.0']],
]

for (const [label, argv] of COMPAT_CASES) {
  const before = runPy(ORIG, argv)
  const after = runPy(NEW, argv)
  const identical = sameRun(before, after)
  record(`${label}：stdout/退出码逐字节一致`, identical,
    identical
      ? `退出码=${after.code}，${after.stdout.length} 字节`
      : `旧=${before.code}/${before.stdout.length}B 新=${after.code}/${after.stdout.length}B`)
  if (!identical) {
    const a = before.stdout.toString('utf8').split('\n')
    const b = after.stdout.toString('utf8').split('\n')
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      if (a[i] !== b[i]) {
        console.log(`        首个差异在第 ${i + 1} 行：`)
        console.log(`          旧: ${JSON.stringify(a[i])}`)
        console.log(`          新: ${JSON.stringify(b[i])}`)
        break
      }
    }
  }
}

// ── 2. maximize 分支正确 ────────────────────────────────────────────────────

console.log('\n=== 2) maximize 分支（缺陷 1 的修复）===')
const MAX_B = ['--from-probe', '--direction', 'maximize', '--b', '41.25,42.01,40.49', '--r', '50.09,51.39,48.57', '--u', '52.296667']
const maxRun = runPy(NEW, MAX_B)
const maxOut = maxRun.stdout.toString('utf8')
record('退出码 0（三门全过）', maxRun.code === 0, `退出码=${maxRun.code}`)
record('Δ 显示 +8.7667（不是 -8.7667）', maxOut.includes('Δ=+8.7667'),
  (maxOut.match(/Δ=\S+/) ?? ['(未找到)'])[0])
record('Δ/σ_B 显示 +11.54', maxOut.includes('+11.54'),
  (maxOut.match(/Δ\/σ_B = \S+/) ?? ['(未找到)'])[0])
record('门①文案用 maximize 公式 (R−B)/(U−B)', maxOut.includes('R_norm = (R−B)/(U−B)'))
record('结论为可行', maxOut.includes('✓ 可行'))
record('打印了方向行（显式传了 --direction）', maxOut.includes('方向：maximize'))

const origMax = runPy(ORIG, MAX_B.filter((x) => x !== '--direction' && x !== 'maximize'))
record('原版对同一数据确实误判（缺陷可复现）', origMax.code === 1 && origMax.stdout.toString('utf8').includes('不可行'),
  `旧版退出码=${origMax.code}`)

// ── 3. 方向配错仍能抓到 ────────────────────────────────────────────────────

console.log('\n=== 3) 方向配错仍能抓到（修复不能把真失败一起放过）===')
const wrongDir = runPy(NEW, ['--from-probe', '--direction', 'maximize', '--b', '41.25,42.01,40.49', '--r', '50.09,51.39,48.57', '--u', '30.0'])
record('maximize 下 U<B → 退出 1', wrongDir.code === 1, `退出码=${wrongDir.code}`)
record('  并说明 U 必须严格大于 B',
  wrongDir.stdout.toString('utf8').includes('U 必须严格大于 B'))

// ── 4. 非法取值被 argparse 拒绝 ────────────────────────────────────────────

console.log('\n=== 4) 非法取值被拒（退出 2，不是 1）===')
const bad = runPy(NEW, ['--direction', 'up', '--b', '1', '--r', '2'])
record('--direction up → 退出 2', bad.code === 2, `退出码=${bad.code}`)
record('  报错点名可选值', bad.stderr.toString('utf8').includes('invalid choice'))

// ── 5. 未传 --direction 时不打印方向行（浮窗比对的前提）────────────────────

console.log('\n=== 5) 未显式传 --direction 时不打印方向行 ===')
const noDir = runPy(NEW, ['--from-probe', '--b', '0.134,0.152,0.147', '--r', '0.106,0.081,0.204', '--u', '0.031'])
record('输出中不含「方向：」行', !noDir.stdout.toString('utf8').includes('方向：'))
const explicitMin = runPy(NEW, ['--direction', 'minimize', '--from-probe', '--b', '0.134,0.152,0.147', '--r', '0.106,0.081,0.204', '--u', '0.031'])
record('显式传 minimize 时打印方向行（行为与 minimize 判定一致）',
  explicitMin.stdout.toString('utf8').includes('方向：minimize') && explicitMin.code === noDir.code,
  `退出码=${explicitMin.code}`)

rmSync(origDir, { recursive: true, force: true })

// ── 6. buildArgv：五种入参只有 maximize 透传 ──────────────────────────────

console.log('\n=== 6) buildArgv 五种入参 ===')
const { buildArgv, readTaskMetricDirection } = await import('../packages/dsh-autoresearch-gates/lib/tools.js')
const BASE = { fromProbe: true, b: [1], r: [2], u: 3 }
const ARGV_CASES = [
  ['未传 direction', { ...BASE }, false],
  ['direction=maximize', { ...BASE, direction: 'maximize' }, true],
  ['direction=minimize', { ...BASE, direction: 'minimize' }, false],
  ['direction=null', { ...BASE, direction: null }, false],
  ['direction=undefined', { ...BASE, direction: undefined }, false],
]
for (const [label, args, expectDirection] of ARGV_CASES) {
  const argv = buildArgv('feasibility-gate', args)
  const has = argv.includes('--direction')
  record(`${label} → ${expectDirection ? '透传' : '不透传'}`, has === expectDirection,
    JSON.stringify(argv.slice(-2)))
}
// 不透传时 argv 必须与「改动前」逐字符相同。
const noDirection = buildArgv('feasibility-gate', { ...BASE })
record('未传 direction 时 argv 与旧版逐字符相同',
  JSON.stringify(noDirection) === JSON.stringify(['--from-probe', '--b', '1', '--r', '2', '--u', '3']),
  JSON.stringify(noDirection))

// ── 7. 方向派生（缺陷 3）：从题目元数据读，读不到返回 null ────────────────
//
// **本节的用例是「层次正确性」测试，不是「字段存在性」测试。**
// 第一版实现只读 `[task].metric_direction`，对 AutoRe0566 派生出 maximize ——
// 而那道题的原始指标是 minimize 的 StatErr，正好相反。原因：`[task].metric`
// 是 `"score"`（归一化分数），题目自己的注释写明那时 direction「固定 maximize」，
// 是个恒真式，不携带原始指标的任何信息。
// 现在要求方向与**原始指标**同层（anchors.json / comparison_summary.metric /
// expert_annotation.metric_name 中的指标名不得是 "score"）。

console.log('\n=== 7) 方向派生（缺陷 3：必须落在「原始指标」这一层）===')
const REAL_TASKS = 'D:/Desktop/论文评测任务'

// 三个真实任务各代表一个层次来源；AutoRe0566 是关键的负向用例 ——
// 它是唯一原始指标为 minimize 的题，且 [task].metric_direction 写 maximize。
const DERIVE_CASES = [
  ['AutoRe1841', 'maximize', 'anchors.json（metric=balanced_accuracy）'],
  ['AutoRe0566', 'minimize', 'expert_annotation（原始 StatErr；[task] 的 maximize 是 score 层）'],
  ['auto2604', 'maximize', 'comparison_summary（metric=MultiRateReturn）'],
]
for (const [task, want, why] of DERIVE_CASES) {
  const got = await readTaskMetricDirection(`${REAL_TASKS}/${task}`)
  expect(`${task} 派生出原始指标方向（${why}）`, want, got?.direction ?? null, got?.source)
}
// score 层的 [task].metric_direction 绝不能被采信。
const scoreDerived = await readTaskMetricDirection(`${REAL_TASKS}/AutoRe0566`)
record('AutoRe0566 未采信 [task] 的 maximize（score 层恒真式）',
  scoreDerived?.source?.includes('expert_annotation') === true, scoreDerived?.source)

expect('不存在的任务根 → null（不猜）', null, await readTaskMetricDirection('D:/definitely-not-here'))
expect('空串 → null', null, await readTaskMetricDirection(''))

// 负向：score 层的 direction 必须被忽略。
const scoreOnlyHome = mkdtempSync(join(tmpdir(), 'feas-score-'))
mkdirSync(join(scoreOnlyHome, 'optimization_evidence'), { recursive: true })
writeFileSync(join(scoreOnlyHome, 'optimization_evidence', 'comparison_summary.json'),
  JSON.stringify({ metric: 'score', direction: 'maximize' }))
expect('metric="score" 时 direction 不可采信（归一化层恒真式）', null,
  await readTaskMetricDirection(scoreOnlyHome))
writeFileSync(join(scoreOnlyHome, 'optimization_evidence', 'comparison_summary.json'),
  JSON.stringify({ metric: 'MultiRateReturn', direction: 'maximize' }))
expect('原始指标名可采信', 'maximize',
  (await readTaskMetricDirection(scoreOnlyHome))?.direction ?? null)

// 脏值与大小写变体不得当成方向。
writeFileSync(join(scoreOnlyHome, 'optimization_evidence', 'comparison_summary.json'),
  JSON.stringify({ metric: 'StatErr', direction: 'Maximize' }))
expect('大小写变体不被接受（只认字面量）', null, await readTaskMetricDirection(scoreOnlyHome))
rmSync(scoreOnlyHome, { recursive: true, force: true })

// anchors.json 优先（层次最明确）。
const anchorHome = mkdtempSync(join(tmpdir(), 'feas-anchor-'))
mkdirSync(join(anchorHome, 'workspace/harbor_task/tests/hidden_assets'), { recursive: true })
mkdirSync(join(anchorHome, 'optimization_evidence'), { recursive: true })
writeFileSync(join(anchorHome, 'workspace/harbor_task/tests/hidden_assets/anchors.json'),
  JSON.stringify({ metric: 'nRMSE', direction: 'minimize' }))
writeFileSync(join(anchorHome, 'optimization_evidence', 'comparison_summary.json'),
  JSON.stringify({ metric: 'MultiRateReturn', direction: 'maximize' }))
expect('anchors 优先于 comparison_summary', 'minimize',
  (await readTaskMetricDirection(anchorHome))?.direction ?? null)
// anchors 是 score 层时必须落回 comparison_summary。
writeFileSync(join(anchorHome, 'workspace/harbor_task/tests/hidden_assets/anchors.json'),
  JSON.stringify({ metric: 'score', direction: 'maximize' }))
expect('anchors 为 score 层时落到下一来源', 'maximize',
  (await readTaskMetricDirection(anchorHome))?.direction ?? null)
rmSync(anchorHome, { recursive: true, force: true })

// 带解释后缀的长串（expert_annotation 的真实写法）要能取到开头字面量。
const longFormHome = mkdtempSync(join(tmpdir(), 'feas-long-'))
mkdirSync(join(longFormHome, 'expert_evidence'), { recursive: true })
writeFileSync(join(longFormHome, 'expert_evidence', 'expert_annotation.json'),
  JSON.stringify({ metric_name: 'StatErr', metric_direction: 'minimize（原始指标）；[task].metric=score 归一化后 maximize' }))
expect('带解释后缀的长串取开头字面量', 'minimize',
  (await readTaskMetricDirection(longFormHome))?.direction ?? null)
rmSync(longFormHome, { recursive: true, force: true })

// ── 8. collectFromTask 真的能喂满 G-FEASIBILITY ───────────────────────────

console.log('\n=== 8) collectFromTask → G-FEASIBILITY（此前无此分支，方向永远传不到）===')
const { collectFromTask } = await import('../packages/dsh-autoresearch/index.js')
const { gateFeasibility } = await import('../packages/dsh-autoresearch/lib/gates.js')
const payload = await collectFromTask(`${REAL_TASKS}/AutoRe1841`, 'G-FEASIBILITY')
expect('从真实任务收集到 baselineValues', 3, payload.baselineValues?.length ?? 0)
expect('从真实任务收集到 referenceValues', 3, payload.referenceValues?.length ?? 0)
record('收集到 upper', typeof payload.upper === 'number', String(payload.upper))
expect('收集到 direction', 'maximize', payload.direction ?? null)
expect('门禁判定为 RECOMMEND（误判已修）', 'RECOMMEND', gateFeasibility(payload).verdict)
expect('  G1.9 有证据才声明 recomputed（该题 grader 真的复算）', true, payload.referenceRecomputed === true)
expect('没有锚点的任务不编造字段', 0,
  Object.keys(await collectFromTask(`${REAL_TASKS}/auto2604`, 'G-FEASIBILITY')).length)
expect('不存在的任务根返回空对象', 0, Object.keys(await collectFromTask('D:/nope', 'G-FEASIBILITY')).length)

// 负向：grader 存在但不复算 → 不得声明 recomputed。
const noRecomputeHome = mkdtempSync(join(tmpdir(), 'feas-norecomp-'))
mkdirSync(join(noRecomputeHome, 'workspace/harbor_task/tests/hidden_assets'), { recursive: true })
writeFileSync(join(noRecomputeHome, 'workspace/harbor_task/tests/hidden_assets/anchors.json'),
  JSON.stringify({ direction: 'maximize', baseline_values: [1, 2], reference_values: [3, 4], upper_bound: 5 }))
writeFileSync(join(noRecomputeHome, 'workspace/harbor_task/tests/grader.py'),
  'import json\nprint(json.load(open("score.json"))["score"])\n')
const noRecompute = await collectFromTask(noRecomputeHome, 'G-FEASIBILITY')
expect('grader 只读预置分数 → 不声明 independent-recompute',
  undefined, noRecompute.referenceRecomputed)
rmSync(noRecomputeHome, { recursive: true, force: true })

// ── 9. paper_screen.py 死因3：负基线下的增益符号 ──────────────────────────
//
// 缺陷报告 2026-10-16（auto2604）。死因3 的原式是
//   abs_gain = reported_baseline * delta_percent / 100
// 基线为**负值**时（连续控制回合回报，越接近 0 越好）该式得到**负的增益**，
// 于是 gain_from_community 恒 ≤ 0 ⇒ 该题**恒判 FAIL**，与增益大小无关。
// 实测 auto2604：B=−249.25、R=−231.55，真实增益 +17.70，原式算出 −17.70。
//
// 修法是取 |baseline| —— 对**正基线**不改变任何数值，因此 auto1851
// 那类既有判例（论文 baseline 被低估 23.8）不受影响。下面两侧都钉住。

console.log('\n=== 9) paper_screen 死因3：负基线的增益符号 ===')
const PAPER_SCREEN = join(ROOT, 'packages/dsh-autoresearch-gates/assets/sop/tools/paper_screen.py')
const AUTO2604_ARGS = [
  '--title', 'Time-Aware World Model',
  '--repo', 'anh-nn01/Time-Aware-World-Model',
  '--delta-percent', '7.1', '--n-benchmarks', '12', '--n-ablation', '1',
  '--metric-type', 'physical', '--reports-sigma',
  '--community-baseline', '-249.25', '--reported-baseline', '-249.252',
]
const screen = runPy(PAPER_SCREEN, AUTO2604_ARGS)
const screenOut = screen.stdout.toString('utf8')

expect('负基线：论文声称增益为正（+17.7，不再是 −17.7）',
  true, screenOut.includes('论文声称增益 +17.7'), 
  (screenOut.match(/论文声称增益 [+-][\d.]+/) ?? ['(未找到)'])[0])
expect('负基线：扣除被低估部分后仍为正（+17.7）', true,
  screenOut.includes('扣除被低估部分后仅 +17.7'))
expect('负基线：死因3 不再判 FAIL', false, /\[✗\] 死因3/.test(screenOut))
expect('负基线：不再出现「直接弃题建议」', false, screenOut.includes('直接弃题建议'))
expect('负基线：FAIL 计数为 0', true, /FAIL=0/.test(screenOut),
  (screenOut.match(/汇总：FAIL=\d+\s+WARN=\d+\s+MANUAL=\d+\s+PASS=\d+/) ?? ['(未找到)'])[0])
// 2001 增益幅度这条在权威侧本来就是 WARN（不阻塞），本次不改它。
expect('负基线：增益幅度仍如实标 WARN', true, /\[!\] 2001 同构 增益幅度/.test(screenOut))

// 正基线必须逐字节不受影响（auto1851 判例：论文 baseline 被低估）。
const POS_ARGS = [
  '--title', 'T', '--repo', 'a/b',
  '--delta-percent', '34', '--n-benchmarks', '3',
  '--metric-type', 'physical', '--reports-sigma',
  '--community-baseline', '58.0', '--reported-baseline', '81.8',
]
const pos = runPy(PAPER_SCREEN, POS_ARGS)
const posOut = pos.stdout.toString('utf8')
record('正基线：|baseline| 不改变数值（abs_gain 仍 +27.8）', posOut.includes('论文声称增益 +27.8'),
  (posOut.match(/论文声称增益 [+-][\d.]+/) ?? ['(未找到)'])[0])
record('正基线：该判例的既定结论不变（+51.6 → WARN 而非 FAIL）',
  posOut.includes('扣除被低估部分后仅 +51.6') && !/\[✗\] 死因3/.test(posOut),
  (posOut.match(/扣除被低估部分后仅 [+-][\d.]+/) ?? ['(未找到)'])[0])

// 源码层面钉住：算式必须带 abs()，否则负基线会再次翻转符号。
{
  const py = await import('node:fs/promises').then((m) => m.readFile(PAPER_SCREEN, 'utf8'))
  record('源码：死因3 的增益算式使用 abs(baseline)',
    /abs\(\s*args\.reported_baseline\s*\)\s*\*\s*args\.delta_percent/.test(py))
  record('源码：该文件可被 ast 解析（无语法错误）', screen.code !== 2 || screenOut !== '',
    `退出码=${screen.code}`)
}

console.log()
console.log('='.repeat(62))
const failed = results.filter((r) => !r.ok)
console.log(`feasibility 方向回归：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length > 0) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  · ${f.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
