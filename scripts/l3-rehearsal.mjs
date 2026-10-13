#!/usr/bin/env node
/**
 * L3 演练：用**真实上游更新**跑完整接受流程。
 *
 * ## 第一性原理
 *
 * L1（记录）和 L2（检测）已在上一轮交付并验证。L3 要回答的问题只有一个：
 *
 *   **当上游真的变了，我们的机制能不能发现它，并且让人做出正确判断？**
 *
 * 这个脚本不模拟变化 —— 它从真实的 GitHub 上游拉取文件，与本地 vendored
 * 副本逐字节比对。真实上游 = `bosprimigenious/autoresearch-skills`。
 *
 * ## 为什么必须用真实上游
 *
 * 用自己造的变化来"演练"，证明的只是"我能检测到我自己改的东西"。
 * 真实上游会带来三类本地想不到的差异：新增文件、内容改写、版本号不动
 * 但字节变了（同名版本漂移）。第三类是最危险的，因为版本号看起来没变。
 *
 * 用法：
 *   node scripts/l3-rehearsal.mjs            跑演练
 *   node scripts/l3-rehearsal.mjs --json     机器可读
 */

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const STAGE = join(ROOT, '.tmp-l3')
const UPSTREAM_REPO = 'bosprimigenious/autoresearch-skills'

const asJson = process.argv.includes('--json')

/** 跑 gh api，返回解析后的 JSON；失败返回 null（不伪造）。 */
function ghJson(path) {
  const result = spawnSync('gh', ['api', path], { encoding: 'utf8', shell: false })
  if (result.status !== 0) return null
  try {
    return JSON.parse(result.stdout)
  } catch {
    return null
  }
}

/** 取一个文件的字节；失败返回 null。 */
function ghBytes(path) {
  const meta = ghJson(`repos/${UPSTREAM_REPO}/contents/${path}`)
  if (meta === null || typeof meta.content !== 'string') return null
  const b64 = meta.content.replace(/\s/g, '')
  if (b64 === '') return null
  return Buffer.from(b64, 'base64')
}

/** 上游 task-qa 脚本目录（本地 vendored 的对应位置）。 */
const UPSTREAM_SCRIPT_DIR = 'skills/autoresearch-task-qa/scripts'
const LOCAL_SCRIPT_DIR = 'packages/dsh-autoresearch-gates/assets/qa-0.3.4'

/** 纳入比对的脚本（运行时会用到的那些，不含 test_*）。 */
const COMPARED = [
  'implementation_review.py',
  'audit_task.py',
  'qa_consensus.py',
  'content_gates.py',
  'harbor_review.py',
  'docker_paths.py',
  'submission_format.py',
  'audit_collection.py',
  'aggregate_qa_reports.py',
]

const findings = { identical: [], changed: [], missingLocally: [], extraLocally: [], errors: [] }

if (!asJson) {
  console.log('=== L3 演练：真实上游 vs 本地 vendored ===')
  console.log(`上游仓库：${UPSTREAM_REPO}`)
  console.log(`上游脚本：${UPSTREAM_SCRIPT_DIR}`)
  console.log(`本地对应：${LOCAL_SCRIPT_DIR}`)
  console.log()
}

// ── 第一步：确认上游可达（不可达必须如实报，不能当成"无变化"） ──────────────
const upstreamVersion = ghBytes('VERSION')
if (upstreamVersion === null) {
  console.log('上游 VERSION 拉取失败 —— 无法完成演练。')
  console.log('注意：拉取失败 ≠ 上游无变化。这是 UNKNOWN，不是 IN_SYNC。')
  process.exit(2)
}
const upstreamVersionText = upstreamVersion.toString('utf8').trim()

const localVersionPath = join(ROOT, 'packages', 'dsh-autoresearch-skills', 'assets', 'skills-upstream-0.3.4', 'VERSION')
let localVersionText = '(缺失)'
try {
  localVersionText = (await readFile(localVersionPath, 'utf8')).trim()
} catch { /* 保持缺失标记 */ }

if (!asJson) {
  console.log(`上游 VERSION：${upstreamVersionText}`)
  console.log(`本地 VERSION：${localVersionText}`)
  console.log()
}

// ── 第二步：取上游目录清单，找出本地根本没有的文件 ────────────────────────
const upstreamDir = ghJson(`repos/${UPSTREAM_REPO}/contents/${UPSTREAM_SCRIPT_DIR}`)
if (upstreamDir === null) {
  console.log(`上游目录列表拉取失败：${UPSTREAM_SCRIPT_DIR}`)
  process.exit(2)
}
const upstreamNames = upstreamDir.map((e) => e.name).filter((n) => n.endsWith('.py'))
const upstreamNonTest = upstreamNames.filter((n) => !n.startsWith('test_'))

// ── 第三步：逐字节比对 ────────────────────────────────────────────────────
await mkdir(STAGE, { recursive: true })

for (const name of COMPARED) {
  const upstream = ghBytes(`${UPSTREAM_SCRIPT_DIR}/${name}`)
  const localPath = join(ROOT, LOCAL_SCRIPT_DIR, name)

  if (upstream === null) {
    findings.errors.push({ name, reason: '上游拉取失败' })
    continue
  }

  let local = null
  try {
    local = await readFile(localPath)
  } catch {
    findings.missingLocally.push({
      name,
      upstreamBytes: upstream.length,
      upstreamSha256: createHash('sha256').update(upstream).digest('hex'),
    })
    continue
  }

  const uh = createHash('sha256').update(upstream).digest('hex')
  const lh = createHash('sha256').update(local).digest('hex')

  if (uh === lh) {
    findings.identical.push({ name, sha256: uh, bytes: upstream.length })
  } else {
    // 内容不同时，进一步判断是哪一类差异：能力变了还是只改了注释。
    await writeFile(join(STAGE, `upstream-${name}`), upstream)
    await writeFile(join(STAGE, `local-${name}`), local)

    const upstreamText = upstream.toString('utf8')
    const localText = local.toString('utf8')

    // 逐行比对，统计差异规模。
    const uLines = upstreamText.split(/\r?\n/)
    const lLines = localText.split(/\r?\n/)
    const uSet = new Set(uLines)
    const lSet = new Set(lLines)
    const onlyUpstream = uLines.filter((l) => l.trim() !== '' && !lSet.has(l))
    const onlyLocal = lLines.filter((l) => l.trim() !== '' && !uSet.has(l))

    // 能力面：发布门是否还受支持。
    const flag = '--release-self-check'
    const upstreamHasFlag = upstreamText.includes(flag)
    const localHasFlag = localText.includes(flag)

    findings.changed.push({
      name,
      upstreamBytes: upstream.length,
      localBytes: local.length,
      upstreamSha256: uh,
      localSha256: lh,
      bytesDelta: upstream.length - local.length,
      linesOnlyUpstream: onlyUpstream.length,
      linesOnlyLocal: onlyLocal.length,
      capabilityImpact: upstreamHasFlag === localHasFlag
        ? '无（发布门参数两边都有）'
        : `有（上游 ${upstreamHasFlag ? '有' : '无'} / 本地 ${localHasFlag ? '有' : '无'}）`,
      sampleUpstreamOnly: onlyUpstream.slice(0, 6),
      diffPath: `.tmp-l3/upstream-${name}`,
    })
  }
}

// 本地有、上游没有的（说明本地是超集，或上游删过文件）。
for (const name of COMPARED) {
  if (!upstreamNonTest.includes(name)) findings.extraLocally.push({ name })
}

// 上游有、我们没纳入比对的（新增能力）。
const notCompared = upstreamNonTest.filter((n) => !COMPARED.includes(n))
findings.upstreamOnly = notCompared

// ── 输出 ─────────────────────────────────────────────────────────────────
if (asJson) {
  console.log(JSON.stringify({
    upstreamRepo: UPSTREAM_REPO,
    upstreamVersion: upstreamVersionText,
    localVersion: localVersionText,
    findings,
  }, null, 2))
} else {
  console.log('=== 比对结果 ===')
  console.log(`一致：${findings.identical.length} 个`)
  for (const f of findings.identical) console.log(`  ok   ${f.name}`)
  console.log()
  console.log(`内容不同：${findings.changed.length} 个`)
  for (const f of findings.changed) {
    console.log(`  DIFF ${f.name}  (上游 ${f.upstreamBytes} / 本地 ${f.localBytes}，${f.bytesDelta >= 0 ? '+' : ''}${f.bytesDelta} 字节)`)
    console.log(`       上游独有行 ${f.linesOnlyUpstream}，本地独有行 ${f.linesOnlyLocal}`)
    console.log(`       能力影响：${f.capabilityImpact}`)
  }
  if (findings.changed.length > 0) {
    console.log()
    console.log(`  差异文件已落到 ${relative(ROOT, STAGE).split('\\').join('/')}/（upstream-* 与 local-*）`)
  }
  console.log()
  if (findings.upstreamOnly.length > 0) {
    console.log(`上游有但我们未纳入比对：${findings.upstreamOnly.length} 个`)
    for (const n of findings.upstreamOnly) console.log(`  new  ${n}`)
    console.log('  （这些是候选新增能力，需要评估是否纳入）')
    console.log()
  }
  if (findings.missingLocally.length > 0) {
    console.log(`本地缺失：${findings.missingLocally.length} 个`)
    for (const f of findings.missingLocally) console.log(`  MISS ${f.name}`)
    console.log()
  }
  if (findings.errors.length > 0) {
    console.log(`拉取失败（UNKNOWN，不得当成一致）：${findings.errors.length} 个`)
    for (const f of findings.errors) console.log(`  ERR  ${f.name} — ${f.reason}`)
  }
}

// 退出码：有实质差异 → 1；全一致 → 0；有拉取失败 → 2（UNKNOWN）
const hasUnknown = findings.errors.length > 0
const hasDiff = findings.changed.length > 0 || findings.missingLocally.length > 0 || findings.upstreamOnly.length > 0
process.exit(hasUnknown ? 2 : (hasDiff ? 1 : 0))
