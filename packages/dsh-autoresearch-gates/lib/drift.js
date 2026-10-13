/**
 * 上游漂移检测 —— 让「引用了哪个版本」永远可回答。
 *
 * ## 第一性原理
 *
 * 一个交付物的结论，依赖于它当时所用上游工具的**某个具体版本**。
 * 那个版本会变。风险不是「会变」，而是「变了没人知道」。
 *
 * 所以本模块只做一件事：**比对，不改动**。
 *
 *   L1 记录：UPSTREAM_BASELINE 里存 path → {sha256, upstreamVersion}
 *   L2 检测：当前文件的实际哈希 vs 基线哈希
 *
 * L3（自动修改）刻意不做 —— 见 docs/first-principles-dynamic.md §三。
 * 理由：改错判据的代价远高于晚一轮发现漂移；而 `docs/upstream-defects.md`
 * 已记录 D1 这样一个真实上游缺陷，「自动同步」会把它直接搬进来。
 *
 * ## 三态，不做总分补偿
 *
 *   IN_SYNC   全部与基线一致
 *   DRIFTED   有文件内容变了（可能是有意升级，也可能是被动漂移）
 *   UNKNOWN   基线缺失或无法读取 —— **不得当成 IN_SYNC**
 *
 * @module dsh-autoresearch-gates/drift
 */

import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative } from 'node:path'
import { UPSTREAM_SOURCES, PROJECT_ROOT, resolveUpstreamAsset } from './tools.js'

export const DRIFT_VERDICT = Object.freeze({
  IN_SYNC: 'IN_SYNC',
  DRIFTED: 'DRIFTED',
  UNKNOWN: 'UNKNOWN',
})

/**
 * 需要纳入漂移监控的上游资产（逻辑名 + 来源）。
 *
 * 只列**被运行时引用**的那些：监控没人用的文件是浪费，
 * 而漏掉被引用的文件则等于没做。
 */
export const MONITORED_ASSETS = Object.freeze([
  // ── 发布门证据链（必须支持 --release-self-check 的那份，即 upstream-0.3.4）──
  //
  // 角色区分（依据实测 --help，见 scripts/ablation-upstream.mjs）：
  //   · implementation_review.py —— **发布门溯源块的产出者**。
  //     `--review`、`--release-self-check`、reviewer/session/clean-context 全套都有。
  //   · audit_task.py —— **静态审计器**（inventory + 数值观察）。
  //     0.3.4 里它同样支持 --review 与 --release-self-check，
  //     但职责是"收集"，不是"产出结论"，故 role 标为 audit 而非 release-evidence。
  //
  // 注：SOP 技能正文称"来源附件的 audit_task.py 不支持 --review" ——
  // 实测该说法对应的是 **0.3.2** 那一份（其 --release-self-check=False）。
  // 0.3.4 两份都支持。此处以实测为准。
  { source: 'upstream-0.3.4', logical: 'implementation_review.py', role: 'release-evidence' },
  { source: 'upstream-0.3.4', logical: 'audit_task.py', role: 'audit' },
  { source: 'upstream-0.3.4', logical: 'qa_consensus.py', role: 'release-aggregation' },
  { source: 'upstream-0.3.4', logical: 'content_gates.py', role: 'content-gate' },
  { source: 'upstream-0.3.4', logical: 'harbor_review.py', role: 'harbor' },
  { source: 'upstream-0.3.4', logical: 'docker_paths.py', role: 'docker-contract' },
  // ── 上游仓库级工具（upstream-tools-0.3.4）──
  //
  // 这两个由 L3 演练采纳（见 docs/l3-rehearsal.md §三）：
  // privacy_scan.py 在本仓公开内容上实测报出 45 项，其中内网协作 URL
  // 与内网 IPv4 两类是人工检查漏掉的。既然它已进入检查链，
  // 就必须纳入漂移监控 —— 否则上游改了它的判据而我们静默沿用旧版。
  { source: 'upstream-tools-0.3.4', logical: 'privacy_scan.py', role: 'privacy-gate' },
  { source: 'upstream-tools-0.3.4', logical: 'verify_skill_archive.py', role: 'archive-contract' },
  // ── 权威判据口径（教程 V3 附件 0.3.2）──
  { source: 'tutorial-v3', logical: 'implementation_review.py', role: 'authority' },
  { source: 'tutorial-v3', logical: 'audit_task.py', role: 'authority' },
  // ── SOP 工具（本包 assets/sop/…）──
  { source: undefined, logical: 'sop/tools/feasibility_gate.py', role: 'sop' },
  { source: undefined, logical: 'sop/tools/milestone_gate.py', role: 'sop' },
  { source: undefined, logical: 'sop/tools/paper_screen.py', role: 'sop' },
  { source: undefined, logical: 'sop/tools/dockerfile_preflight.py', role: 'sop' },
  { source: undefined, logical: 'sop/tools/harbor_task_contract.py', role: 'sop' },
  { source: undefined, logical: 'sop/tools/nop_preflight.py', role: 'sop' },
  { source: undefined, logical: 'sop/tools/replay_contract_gate.py', role: 'sop' },
])

export const BASELINE_FILE = 'upstream-baseline.json'

/** 计算文件 SHA-256。 */
export async function hashFile(path) {
  const buffer = await readFile(path)
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * 由当前磁盘状态生成基线快照。
 *
 * 这是 L1。基线一旦写入即视为「已确认」；后续变化都会与它比对。
 * 升级上游时**有意**重写基线，从而把「被动漂移」与「主动升级」区分开。
 */
export async function buildBaseline() {
  const assets = []
  const missing = []
  for (const entry of MONITORED_ASSETS) {
    const path = await resolveUpstreamAsset(entry.logical, entry.source)
    if (path === null) {
      missing.push({ ...entry, reason: '解析不到文件' })
      continue
    }
    const info = await stat(path)
    assets.push({
      source: entry.source ?? 'own-assets',
      logical: entry.logical,
      role: entry.role,
      relativePath: relative(PROJECT_ROOT, path).split('\\').join('/'),
      bytes: info.size,
      sha256: await hashFile(path),
    })
  }
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    note: 'L1 记录层：有意升级上游后应重新生成本基线，使被动漂移可被区分。',
    assets,
    missing,
  }
}

/**
 * 比对当前状态与基线。只读，不修改任何文件。
 *
 * @returns {{verdict: string, drifted: object[], missing: object[], unchanged: number}}
 */
export async function detectDrift(baseline) {
  if (baseline === null || baseline === undefined || !Array.isArray(baseline.assets)) {
    // 没有基线 ≠ 一致。这是 UNKNOWN，不是 IN_SYNC。
    return {
      verdict: DRIFT_VERDICT.UNKNOWN,
      drifted: [],
      missing: [{ reason: `基线缺失或格式非法（期望 ${BASELINE_FILE}）` }],
      unchanged: 0,
      detail: '无基线可比对：先运行 buildBaseline 并提交结果，否则漂移不可见。',
    }
  }

  const drifted = []
  const missing = [...(baseline.missing ?? [])]
  let unchanged = 0

  for (const recorded of baseline.assets) {
    const path = join(PROJECT_ROOT, recorded.relativePath)
    let info
    try {
      info = await stat(path)
    } catch {
      missing.push({ ...recorded, reason: '基线记录的文件已消失' })
      continue
    }
    const current = await hashFile(path)
    if (current !== recorded.sha256) {
      drifted.push({
        logical: recorded.logical,
        source: recorded.source,
        role: recorded.role,
        relativePath: recorded.relativePath,
        baselineSha256: recorded.sha256,
        currentSha256: current,
        bytesDelta: info.size - recorded.bytes,
      })
    } else {
      unchanged += 1
    }
  }

  // 新增的受监控资产（基线里没有，现在能解析到）也算变化。
  for (const entry of MONITORED_ASSETS) {
    const known = baseline.assets.some((a) => a.logical === entry.logical && a.source === (entry.source ?? 'own-assets'))
    if (known) continue
    const path = await resolveUpstreamAsset(entry.logical, entry.source)
    if (path !== null) {
      drifted.push({
        logical: entry.logical,
        source: entry.source ?? 'own-assets',
        role: entry.role,
        relativePath: relative(PROJECT_ROOT, path).split('\\').join('/'),
        note: '基线中未登记，但当前可解析到（新增资产）',
      })
    }
  }

  const verdict = missing.length > 0
    ? DRIFT_VERDICT.UNKNOWN
    : (drifted.length > 0 ? DRIFT_VERDICT.DRIFTED : DRIFT_VERDICT.IN_SYNC)

  return { verdict, drifted, missing, unchanged }
}

/**
 * 扫描「不应存在的编译缓存」。
 *
 * ## 为什么这是一个独立的检查
 *
 * `.pyc` 的 magic 与解释器匹配、PEP 552 头有效时**会被优先加载**。
 * 本仓实测过一次：仅运行 `python <script> --help` 就会在
 * `skills-0.3.2/autoresearch-task-qa/scripts/` 下生成 `__pycache__/`。
 * 若它被随包分发，运行的可能不是源码 —— 而这件事**没有任何外在迹象**。
 *
 * 因此把它做成可判定的：列出来就算违规，不依赖谁知道这个坑。
 *
 * @param roots 要扫描的根目录
 * @returns {{path: string, bytes: number}[]} 违规的 .pyc 文件
 */
export async function findCompiledArtifacts(roots) {
  const { readdir } = await import('node:fs/promises')
  const found = []
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        await walk(full)
        continue
      }
      if (entry.name.endsWith('.pyc') || entry.name.endsWith('.pyo')) {
        try {
          const info = await stat(full)
          found.push({ path: relative(PROJECT_ROOT, full).split('\\').join('/'), bytes: info.size })
        } catch { /* 竞态删除，忽略 */ }
      }
    }
  }
  for (const root of roots) await walk(join(PROJECT_ROOT, root))
  return found
}

/** 读取基线文件；不存在返回 null（调用方据此判 UNKNOWN）。 */
export async function readBaseline(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 能力自证：实测每个来源**实际支持**哪些发布门参数。
 *
 * 为什么不用声明：`capabilities` 是人写的，会过期。
 * 本函数直接跑 `--help` 看真实能力 —— 这才是可判定的。
 * 这正是本次缺陷（tools.js 引用 0.3.2 却要传发布门参数）能被自动发现的原因。
 */
export async function probeCapabilities(pythonCommand = 'python') {
  const { spawn } = await import('node:child_process')
  const probeOne = (path) => new Promise((resolve) => {
    let child
    try {
      child = spawn(pythonCommand, [path, '--help'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // 关键：禁止写字节码缓存。
        //
        // 不加这个，探测本身就会在 assets/ 下生成 __pycache__，
        // 使「编译缓存污染」检查**每次运行都必然报红** ——
        // 一个自己制造违规的检查等于没有检查（本轮实测踩到）。
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      })
    } catch (error) {
      resolve({ ok: false, text: String(error.message) })
      return
    }
    let text = ''
    child.stdout.on('data', (chunk) => { text += chunk })
    child.stderr.on('data', (chunk) => { text += chunk })
    child.on('error', () => resolve({ ok: false, text }))
    child.on('close', () => resolve({ ok: true, text }))
  })

  // 每个来源的脚本名不同（0.3.2 在 scripts/ 子层，0.3.4 是扁平的），
  // 因此按来源声明其脚本相对位置，不靠猜。
  const REVIEW_SCRIPT = {
    'tutorial-v3': 'implementation_review.py',
    'upstream-0.3.4': 'implementation_review.py',
  }

  const results = {}
  for (const [sourceId, source] of Object.entries(UPSTREAM_SOURCES)) {
    const logical = REVIEW_SCRIPT[sourceId]
    // 该来源不提供发布门复核脚本（如仓库级工具来源）——这是**已知的适用性事实**，
    // 不是「解析失败」。必须与真正的解析失败区分开，否则会给无关来源
    // 长期挂一条假的 UNKNOWN。用 notApplicable 明确标注。
    if (logical === undefined) {
      results[sourceId] = { resolved: false, notApplicable: true, note: `${sourceId} 不提供发布门复核脚本` }
      continue
    }
    const path = await resolveUpstreamAsset(logical, sourceId)
    if (path === null) {
      // 解析不到必须是**可判定的事实**，不是静默跳过。
      results[sourceId] = { resolved: false, error: `解析不到 ${logical}（来源 ${sourceId}）` }
      continue
    }
    const { ok, text } = await probeOne(path)
    if (!ok) {
      results[sourceId] = { resolved: false, error: `无法执行 ${path}` }
      continue
    }
    results[sourceId] = {
      resolved: true,
      relativePath: relative(PROJECT_ROOT, path).split('\\').join('/'),
      observed: {
        'release-self-check': text.includes('--release-self-check'),
        'reviewer-identity': text.includes('--reviewer-provider'),
        'clean-context': text.includes('--clean-context'),
        'fail-on-incomplete': /--fail-on[^\n]*incomplete/.test(text),
      },
    }
  }

  // 单列「发布门溯源块产出者」的能力 —— 这是发布门能不能通过的关键，
  // 与上面按来源的汇总分开报，避免被一个"某处支持"的结论掩盖。
  const reviewPath = await resolveUpstreamAsset('implementation_review.py', 'upstream-0.3.4')
  if (reviewPath !== null) {
    const { ok, text } = await probeOne(reviewPath)
    if (ok) {
      results['__release_evidence__'] = {
        resolved: true,
        relativePath: relative(PROJECT_ROOT, reviewPath).split('\\').join('/'),
        observed: {
          'release-self-check': text.includes('--release-self-check'),
          'reviewer-identity': text.includes('--reviewer-provider'),
          'reviewer-model': text.includes('--reviewer-model'),
          'reviewer-version': text.includes('--reviewer-version'),
          'session-id': text.includes('--session-id'),
          'clean-context': text.includes('--clean-context'),
          'out-dir': text.includes('--out-dir'),
          'policy': text.includes('--policy'),
        },
      }
    }
  }
  return results
}
