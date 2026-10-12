/**
 * 消融实验：上游引用与漂移（A1/A2 的因果证明）
 *
 * ## 为什么要做消融，而不是"跑一遍看没报错"
 *
 * 「改完不报错」不能证明改对了 —— 原代码也不报错，它只是**静默地用错了版本**。
 * 消融要回答的是：**移除这个改动，问题是否复现？**
 *
 * 因此每个实验都跑两组：ABLATED（还原成改造前行为）与 FIXED（当前实现），
 * 并断言两组结论**必须相反**。若两组相同，说明改动无效（实验失败）。
 *
 * 用法：node scripts/ablation-upstream.mjs
 * 退出码：0 = 全部实验符合预期；1 = 有实验不符合
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PY = process.platform === 'win32' ? 'python' : 'python3'

const results = []
function record(name, expected, actual, detail) {
  const pass = expected === actual
  results.push({ name, pass, expected, actual, detail })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}`)
  console.log(`        期望 ${expected} / 实际 ${actual}${detail ? ` — ${detail}` : ''}`)
}

/** 跑 python 脚本的 --help，返回输出文本（合并 stdout+stderr）。 */
function runHelp(path) {
  return new Promise((resolve) => {
    const child = spawn(PY, [path, '--help'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 禁止写 .pyc：否则探测本身会污染 assets/，使漂移检查恒红。
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    let text = ''
    child.stdout.on('data', (c) => { text += c })
    child.stderr.on('data', (c) => { text += c })
    child.on('error', () => resolve(null))
    child.on('close', () => resolve(text))
  })
}

/** 跑真实命令，返回退出码与输出。 */
function runScript(path, args) {
  return new Promise((resolve) => {
    const child = spawn(PY, [path, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    let text = ''
    child.stdout.on('data', (c) => { text += c })
    child.stderr.on('data', (c) => { text += c })
    child.on('error', () => resolve({ code: null, text }))
    child.on('close', (code) => resolve({ code, text }))
  })
}

const ABLATED_REVIEW = join(ROOT, 'packages', 'dsh-autoresearch-skills', 'assets',
  'skills-0.3.2', 'autoresearch-task-qa', 'scripts', 'implementation_review.py')
const FIXED_REVIEW = join(ROOT, 'packages', 'dsh-autoresearch-gates', 'assets',
  'qa-0.3.4', 'implementation_review.py')

console.log('=== 前置：确认两份脚本存在且不同 ===')
const { createHash } = await import('node:crypto')
const hash = async (p) => createHash('sha256').update(await readFile(p)).digest('hex')
const hA = await hash(ABLATED_REVIEW)
const hF = await hash(FIXED_REVIEW)
console.log(`  改造前引用（0.3.2）: ${hA.slice(0, 16)}…`)
console.log(`  改造后引用（0.3.4）: ${hF.slice(0, 16)}…`)
record('两份脚本内容不同（否则实验无意义）', true, hA !== hF)
console.log()

// ── 实验 1：发布门参数是否被接受 ────────────────────────────────────────────
console.log('=== 实验 1：发布门参数接受性 ===')
console.log('  (runner.js:119-128 会传这些参数给 implementation_review.py)')
const RELEASE_ARGS = ['--release-self-check', '--reviewer-provider', 'P',
  '--reviewer-model', 'M', '--reviewer-version', '1', '--session-id', 'S', '--clean-context']

const helpA = await runHelp(ABLATED_REVIEW)
const helpF = await runHelp(FIXED_REVIEW)

const supportsA = helpA !== null && helpA.includes('--release-self-check')
const supportsF = helpF !== null && helpF.includes('--release-self-check')

record('ABLATED（0.3.2）支持 --release-self-check', false, supportsA)
record('FIXED（0.3.4）支持 --release-self-check', true, supportsF)
console.log()

// ── 实验 2：端到端命令行为 ──────────────────────────────────────────────────
console.log('=== 实验 2：真实调用（无 positional source，只看参数解析阶段）===')
const resA = await runScript(ABLATED_REVIEW, RELEASE_ARGS)
const resF = await runScript(FIXED_REVIEW, RELEASE_ARGS)

const rejectsA = /unrecognized arguments/i.test(resA.text)
const rejectsF = /unrecognized arguments/i.test(resF.text)

record('ABLATED 拒绝发布门参数（unrecognized）', true, rejectsA)
record('FIXED 不拒绝参数（仅因缺 source 而报错）', false, rejectsF)
console.log()

// ── 实验 3：--fail-on incomplete 档位 ──────────────────────────────────────
console.log('=== 实验 3：--fail-on 是否含 incomplete 档 ===')
const hasIncompleteA = helpA !== null && /--fail-on[^\n]*incomplete/.test(helpA)
const hasIncompleteF = helpF !== null && /--fail-on[^\n]*incomplete/.test(helpF)
record('ABLATED 有 incomplete 档', false, hasIncompleteA)
record('FIXED 有 incomplete 档', true, hasIncompleteF)
console.log()

// ── 实验 4：解析层是否真的改到了 0.3.4 ─────────────────────────────────────
console.log('=== 实验 4：resolveTool 解析结果 ===')
const { resolveTool } = await import('../packages/dsh-autoresearch-gates/lib/tools.js')
const t = await resolveTool('qa-implementation-review')
const resolvedName = basename(dirname(t?.path ?? ''))
record('resolveTool 解析到 qa-0.3.4 目录', 'qa-0.3.4', resolvedName)
console.log()

// ── 实验 5：漂移哨兵 —— 篡改能否被发现 ─────────────────────────────────────
console.log('=== 实验 5：漂移检测能发现"未登记的字节变化"吗 ===')
const { buildBaseline, detectDrift, DRIFT_VERDICT } = await import('../packages/dsh-autoresearch-gates/lib/drift.js')
const baseline = await buildBaseline()
console.log(`  基线收录 ${baseline.assets.length} 项，缺失 ${baseline.missing.length} 项`)
const clean = await detectDrift(baseline)
record('刚生成的基线：判定 IN_SYNC', DRIFT_VERDICT.IN_SYNC, clean.verdict)

// 模拟篡改：改一条记录的哈希，再比对 —— 必须报 DRIFTED
const tampered = JSON.parse(JSON.stringify(baseline))
tampered.assets[0].sha256 = '0'.repeat(64)
const drifted = await detectDrift(tampered)
record('哈希被改动后：判定 DRIFTED', DRIFT_VERDICT.DRIFTED, drifted.verdict,
  `${drifted.drifted.length} 项漂移`)

// 无基线必须 UNKNOWN，不能当 IN_SYNC
const noBaseline = await detectDrift(null)
record('无基线时：判定 UNKNOWN（不得当 IN_SYNC）', DRIFT_VERDICT.UNKNOWN, noBaseline.verdict)
console.log()

// ── 实验 6：能力自证与声明是否一致 ─────────────────────────────────────────
console.log('=== 实验 6：实测能力 vs 声明能力（声明会过期，实测不会）===')
const { probeCapabilities } = await import('../packages/dsh-autoresearch-gates/lib/drift.js')
const { UPSTREAM_SOURCES } = await import('../packages/dsh-autoresearch-gates/lib/tools.js')
const caps = await probeCapabilities(PY)
let mismatch = 0
let unresolvable = 0
for (const [sourceId, observed] of Object.entries(caps)) {
  // `__release_evidence__` 是发布门溯源块的专项探测，不对应来源声明，单独断言。
  if (sourceId === '__release_evidence__') continue
  // 解析不到是**失败**，不是跳过 —— 跳过等于把"没验证"当成"已验证"。
  if (!observed.resolved) {
    unresolvable += 1
    console.log(`  ${sourceId.padEnd(16)} 解析失败：${observed.error}`)
    continue
  }
  const declared = UPSTREAM_SOURCES[sourceId].capabilities
  for (const [key, actual] of Object.entries(observed.observed)) {
    const want = declared[key]
    const same = want === actual
    if (!same) mismatch += 1
    console.log(`  ${sourceId.padEnd(16)} ${key.padEnd(20)} 声明=${String(want).padEnd(5)} 实测=${String(actual).padEnd(5)} ${same ? '' : '<< 不一致'}`)
  }
}
record('所有来源都能解析到（不得静默跳过）', 0, unresolvable)
record('所有来源的能力声明与实测一致', 0, mismatch)

// 发布门溯源块：8 项参数缺一即 NOT_READY。
const releaseEvidence = caps.__release_evidence__
const missingFlags = releaseEvidence?.resolved
  ? Object.entries(releaseEvidence.observed).filter(([, v]) => !v).map(([k]) => k)
  : ['(解析不到)']
console.log(`  发布门溯源块产出者：${releaseEvidence?.relativePath ?? '未解析'}`)
record('发布门溯源块所需 8 项参数全部具备', 0, missingFlags.length,
  missingFlags.length ? `缺失 ${missingFlags.join(', ')}` : '')
console.log()

// ── 汇总 ───────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass)
console.log('='.repeat(60))
console.log(`消融实验：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length > 0) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  · ${f.name}（期望 ${f.expected}，实际 ${f.actual}）`)
}
process.exit(failed.length === 0 ? 0 : 1)
