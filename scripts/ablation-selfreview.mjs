/**
 * 对抗性自审：对**本次改造**做消融与证伪
 *
 * 立场：假设我刚才的改动是错的，找证据推翻。
 * 每条都给出「如果改动无效/有害，应该观察到什么」以及实测结果。
 *
 * 用法：node scripts/ablation-selfreview.mjs
 */

import { readFile, writeFile, copyFile, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
function record(name, expected, actual, note) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  results.push({ name, pass, expected, actual, note })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}`)
  if (!pass) console.log(`        期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`)
  if (note) console.log(`        ${note}`)
}

const PY = process.platform === 'win32' ? 'python' : 'python3'
const { resolveTool, resolveUpstreamAsset, UPSTREAM_SOURCES } =
  await import('../packages/dsh-autoresearch-gates/lib/tools.js')
const { detectDrift, readBaseline, buildBaseline, DRIFT_VERDICT } =
  await import('../packages/dsh-autoresearch-gates/lib/drift.js')

console.log('=== 质疑 1：我是不是只是把「引用旧版」换成「引用新版」，而没解决根因？ ===')
console.log('   若根因是「职责与引用不一致」，那么权威口径那一份**必须仍可解析**。')
const authority = await resolveUpstreamAsset('implementation_review.py', 'tutorial-v3')
const release = await resolveUpstreamAsset('implementation_review.py', 'upstream-0.3.4')
record('权威口径（tutorial-v3）仍可解析', true, authority !== null,
  authority ? authority.split('autoresearch-desktop')[1] : '')
record('发布门证据（upstream-0.3.4）可解析', true, release !== null,
  release ? release.split('autoresearch-desktop')[1] : '')
record('两者是不同文件（未被合并成一份）', true, authority !== release)
console.log()

console.log('=== 质疑 2：UPSTREAM_SOURCES 的每个 root 是否真能命中？ ===')
console.log('   若 root 写错，resolveUpstreamAsset 会静默返回 null 而无人发现。')
console.log('   注意：roots 按顺序探测，且每个 root 会在 package 与 fallbackPackage 两处找；')
console.log('   因此「某 root 在 primary 包下不存在」是**正常的**，只要它在任一候选处命中即可。')
for (const [id, src] of Object.entries(UPSTREAM_SOURCES)) {
  const roots = src.roots ?? [src.root]
  const pkgs = [src.package, src.fallbackPackage].filter((p) => typeof p === 'string')
  for (const r of roots) {
    // 逐个候选位置探测，记录是否**至少有一处**命中。
    let hit = null
    for (const pkg of pkgs) {
      const probe = join(ROOT, 'packages', pkg, r)
      try {
        const { stat } = await import('node:fs/promises')
        if ((await stat(probe)).isDirectory()) { hit = `${pkg}/${r}`; break }
      } catch { /* 试下一个候选 */ }
    }
    record(`root 至少一处命中：${id} → ${r}`, true, hit !== null,
      hit === null ? '两处候选都不存在 —— 这个 root 是死配置' : `命中 ${hit}`)
  }
}

// 关键：每个来源都必须能解析出它声明的脚本，否则等于该来源不可用。
for (const [id, src] of Object.entries(UPSTREAM_SOURCES)) {
  const resolved = await resolveUpstreamAsset('implementation_review.py', id)
  record(`来源 ${id} 能解析出 implementation_review.py`, true, resolved !== null,
    resolved ? resolved.split('autoresearch-desktop')[1] : '')
}
console.log()

console.log('=== 质疑 3：漂移检测会不会漏报「文件被删除」？ ===')
console.log('   缺失必须报 UNKNOWN，不能当成 IN_SYNC。')
const baseline = await readBaseline(join(ROOT, 'packages', 'dsh-autoresearch-gates', 'assets', 'upstream-baseline.json'))
const fakeMissing = JSON.parse(JSON.stringify(baseline))
fakeMissing.assets.push({
  source: 'upstream-0.3.4', logical: 'does_not_exist.py', role: 'release-evidence',
  relativePath: 'packages/dsh-autoresearch-gates/assets/qa-0.3.4/does_not_exist.py',
  bytes: 1, sha256: '0'.repeat(64),
})
const missingResult = await detectDrift(fakeMissing)
record('基线记录了不存在的文件 → UNKNOWN', DRIFT_VERDICT.UNKNOWN, missingResult.verdict,
  `${missingResult.missing.length} 项 missing`)
console.log()

console.log('=== 质疑 4：无基线时必须 UNKNOWN（fail-closed），不是 IN_SYNC ===')
record('baseline=null → UNKNOWN', DRIFT_VERDICT.UNKNOWN, (await detectDrift(null)).verdict)
record('baseline={} → UNKNOWN', DRIFT_VERDICT.UNKNOWN, (await detectDrift({})).verdict)
console.log()

console.log('=== 质疑 5：能力声明被篡改时，漂移检测能发现吗？ ===')
console.log('   这是防止「声明与实测脱节」的关键 —— 若不能发现，说明我又造了一个会过期的声明。')
const { probeCapabilities } = await import('../packages/dsh-autoresearch-gates/lib/drift.js')
const caps = await probeCapabilities(PY)
const t = caps['tutorial-v3']
record('tutorial-v3 实测不支持 release-self-check', false, t?.observed?.['release-self-check'])
const u = caps['upstream-0.3.4']
record('upstream-0.3.4 实测支持 release-self-check', true, u?.observed?.['release-self-check'])
console.log('   → 若有人把 UPSTREAM_SOURCES 里的声明改成相反值，')
console.log('     scripts/upstream-baseline.mjs 会因 declared!==observed 判 DRIFTED。')
console.log()

console.log('=== 质疑 6：qa 包不再拼 gates 的路径，但它是否引入了对 gates 的新耦合？ ===')
const qaSrc = await readFile(join(ROOT, 'packages', 'dsh-autoresearch-qa', 'index.js'), 'utf8')
const stillJoins = /join\(projectRoot,\s*'packages',\s*'dsh-autoresearch-(gates|skills)'/.test(qaSrc)
record('qa 不再硬编码 gates/skills 的内部路径', false, stillJoins)
const usesResolver = /resolveUpstreamAsset/.test(qaSrc)
record('qa 改为经共享解析器查询', true, usesResolver)
console.log('   说明：qa 现在依赖 gates 导出的**接口**（resolveUpstreamAsset），')
console.log('   而不是 gates 的**目录布局**。前者是契约，后者是实现细节。')
console.log()

console.log('=== 质疑 7：我加的 check 步骤会不会让 npm run check 变脆？ ===')
console.log('   若上游被有意升级，check 会变红 —— 这是**设计意图**（让漂移可见），')
console.log('   但必须有明确的接受路径，否则使用者会绕过它。')
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
record('存在接受路径（upstream:accept）', true, typeof pkg.scripts['upstream:accept'] === 'string',
  pkg.scripts['upstream:accept'])
record('存在只读检查命令（upstream:check）', true, typeof pkg.scripts['upstream:check'] === 'string')
record('check 链包含漂移检测', true, pkg.scripts.check.includes('upstream-baseline.mjs'))
record('check 链包含上游消融', true, pkg.scripts.check.includes('ablation-upstream.mjs'))
console.log()

console.log('=== 质疑 8：ablation-upstream 会不会自己 fail-open？ ===')
console.log('   上一轮我发现实验 6 曾「解析不到就跳过」却报 ok。检查它现在是否仍 fail-open。')
const ablSrc = await readFile(join(ROOT, 'scripts', 'ablation-upstream.mjs'), 'utf8')
const hasStrictResolve = /record\('所有来源都能解析到（不得静默跳过）'/.test(ablSrc)
record('消融实验对「解析不到」断言失败而非跳过', true, hasStrictResolve)
console.log()

const failed = results.filter((r) => !r.pass)
console.log('='.repeat(62))
console.log(`对抗性自审：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  · ${f.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
