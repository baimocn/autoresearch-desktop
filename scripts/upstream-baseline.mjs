#!/usr/bin/env node
/**
 * 上游基线工具 —— 生成或校验 upstream-baseline.json
 *
 * 用法：
 *   node scripts/upstream-baseline.mjs            # 只校验（CI / npm run check 用）
 *   node scripts/upstream-baseline.mjs --write    # 有意升级上游后重新记录基线
 *   node scripts/upstream-baseline.mjs --json     # 机器可读输出
 *
 * 退出码（与随包门禁同一套三态约定）：
 *   0 = IN_SYNC
 *   1 = DRIFTED（有未登记的内容变化）
 *   2 = UNKNOWN（基线缺失/不可读 —— 不得当成通过）
 *
 * 重要：本工具**只读**（除 --write）。它不自动同步上游 ——
 * 「自动同步」会把上游缺陷（如 docs/upstream-defects.md D1）直接搬进来。
 */

import { writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildBaseline, detectDrift, readBaseline, probeCapabilities, findCompiledArtifacts,
  BASELINE_FILE, DRIFT_VERDICT,
} from '../packages/dsh-autoresearch-gates/lib/drift.js'
import { UPSTREAM_SOURCES } from '../packages/dsh-autoresearch-gates/lib/tools.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_PATH = join(ROOT, 'packages', 'dsh-autoresearch-gates', 'assets', BASELINE_FILE)

const argv = process.argv.slice(2)
const write = argv.includes('--write')
const asJson = argv.includes('--json')

const EXIT = { [DRIFT_VERDICT.IN_SYNC]: 0, [DRIFT_VERDICT.REJECTED ?? 'REJECT']: 1, [DRIFT_VERDICT.DRIFTED]: 1, [DRIFT_VERDICT.UNKNOWN]: 2 }

if (write) {
  const baseline = await buildBaseline()
  await writeFile(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8')
  if (!asJson) {
    console.log(`已写入基线：${BASELINE_PATH}`)
    console.log(`  收录 ${baseline.assets.length} 项，缺失 ${baseline.missing.length} 项`)
    for (const entry of baseline.assets) {
      console.log(`    [${entry.role}] ${entry.logical}  ${entry.sha256.slice(0, 16)}…`)
    }
    if (baseline.missing.length > 0) {
      console.log('  缺失（这些资产当前解析不到）：')
      for (const m of baseline.missing) console.log(`    ${m.logical} — ${m.reason}`)
    }
  } else {
    console.log(JSON.stringify(baseline, null, 2))
  }
  process.exit(baseline.missing.length > 0 ? 2 : 0)
}

// ── 校验路径 ────────────────────────────────────────────────────────────────
const baseline = await readBaseline(BASELINE_PATH)
const drift = await detectDrift(baseline)
const caps = await probeCapabilities(process.platform === 'win32' ? 'python' : 'python3')

// 能力声明 vs 实测：声明会过期，实测不会。不一致即视为漂移。
const capabilityMismatches = []
for (const [sourceId, observed] of Object.entries(caps)) {
  // `__release_evidence__` 是"发布门溯源块产出者"的专项探测，不对应来源声明。
  if (sourceId === '__release_evidence__') continue
  // 该来源本就不提供发布门复核脚本（如仓库级工具来源）——这是**适用性**事实，
  // 不是能力退化。混进来会让无关来源长期挂一条假的不符项，淹没真信号。
  if (observed.notApplicable === true) continue
  if (!observed.resolved) {
    capabilityMismatches.push({ sourceId, key: '(resolve)', declared: true, observed: false, error: observed.error })
    continue
  }
  for (const [key, actual] of Object.entries(observed.observed)) {
    const declared = UPSTREAM_SOURCES[sourceId]?.capabilities?.[key]
    if (declared !== actual) {
      capabilityMismatches.push({ sourceId, key, declared, observed: actual })
    }
  }
}

// 发布门溯源块：缺任一参数，qa_consensus.py 必然 NOT_READY。
const releaseEvidence = caps.__release_evidence__
const releaseEvidenceMissing = []
if (releaseEvidence?.resolved) {
  for (const [flag, present] of Object.entries(releaseEvidence.observed)) {
    if (!present) releaseEvidenceMissing.push(flag)
  }
} else {
  releaseEvidenceMissing.push('(解析不到 implementation_review.py)')
}

// 编译缓存污染：.pyc 会被优先加载，随包分发即意味着"跑的可能不是源码"。
const compiledArtifacts = await findCompiledArtifacts(['packages'])

const verdict = (capabilityMismatches.length > 0 || compiledArtifacts.length > 0) && drift.verdict === DRIFT_VERDICT.IN_SYNC
  ? DRIFT_VERDICT.DRIFTED
  : drift.verdict

if (asJson) {
  console.log(JSON.stringify({ verdict, drift, capabilityMismatches, compiledArtifacts }, null, 2))
} else {
  console.log('=== 上游漂移检测（只读）===')
  console.log(`基线：${BASELINE_PATH}`)
  console.log(`  收录 ${baseline?.assets?.length ?? 0} 项`)
  console.log()
  console.log(`判定：${verdict}`)
  console.log(`  未变 ${drift.unchanged} 项`)
  if (drift.drifted.length > 0) {
    console.log(`  ${drift.drifted.length} 项内容已变化：`)
    for (const d of drift.drifted) {
      console.log(`    [${d.role}] ${d.relativePath}`)
      if (d.baselineSha256) {
        console.log(`        基线 ${d.baselineSha256.slice(0, 16)}… → 当前 ${d.currentSha256.slice(0, 16)}…（${d.bytesDelta >= 0 ? '+' : ''}${d.bytesDelta} 字节）`)
      } else if (d.note) {
        console.log(`        ${d.note}`)
      }
    }
    console.log()
    console.log('  处理方式（二选一，取决于这是有意升级还是被动漂移）：')
    console.log('    · 有意升级 → 复核后重写基线：node scripts/upstream-baseline.mjs --write')
    console.log('    · 非预期   → 查清来源后回滚，或登记到 docs/upstream-defects.md')
  }
  if (drift.missing.length > 0) {
    console.log(`  ${drift.missing.length} 项无法核对：`)
    for (const m of drift.missing) console.log(`    ${m.logical ?? '(基线)'} — ${m.reason}`)
  }
  if (compiledArtifacts.length > 0) {
    console.log()
    console.log(`  ${compiledArtifacts.length} 个编译缓存（.pyc/.pyo）在 packages/ 下：`)
    for (const a of compiledArtifacts.slice(0, 10)) console.log(`    ${a.path}（${a.bytes} 字节）`)
    if (compiledArtifacts.length > 10) console.log(`    …另有 ${compiledArtifacts.length - 10} 个`)
    console.log('    → .pyc 会被解释器优先加载，随包分发意味着"跑的可能不是源码"。')
    console.log('      处理：删除并确认 .gitignore 已含 __pycache__/ 与 *.pyc。')
  }
  if (capabilityMismatches.length > 0) {
    console.log()
    console.log(`  ${capabilityMismatches.length} 项能力声明与实测不符：`)
    for (const m of capabilityMismatches) {
      console.log(`    ${m.sourceId} / ${m.key}：声明=${m.declared} 实测=${m.observed}${m.error ? `（${m.error}）` : ''}`)
    }
    console.log('    → 说明上游脚本能力变了，发布门可能已失效。先跑 scripts/ablation-upstream.mjs 定位。')
  }
  if (releaseEvidenceMissing.length > 0) {
    console.log()
    console.log('  发布门溯源块所需参数缺失：')
    for (const flag of releaseEvidenceMissing) console.log(`    ${flag}`)
    console.log('    → 缺任一项，qa_consensus.py 会判 NOT_READY，发布门无法满足。')
    console.log('      这正是 tools.js 曾引用 0.3.2 时发生的情况。')
  } else if (releaseEvidence?.resolved) {
    console.log()
    console.log(`  发布门溯源块：${Object.keys(releaseEvidence.observed).length} 项参数全部具备`)
    console.log(`    ${releaseEvidence.relativePath}`)
  }
  if (verdict === DRIFT_VERDICT.UNKNOWN) {
    console.log()
    console.log('  无基线可比对 —— 漂移**不可见**。先生成基线：node scripts/upstream-baseline.mjs --write')
  }
}

process.exit(EXIT[verdict] ?? 2)
