/**
 * G-PACK-VERIFY 打包一致性判据的回归测试（缺陷 DSH-AR-2026-1016-01）。
 *
 * ## 为什么入库
 *
 * 这三项判据此前是**恒真 PASS**：`gatePackVerify` 的
 * `sourceHashes`/`packedHashes`/`forbiddenEntries` 默认 `{}`/`{}`/`[]`，
 * `collectFromTask` 的 G-PACK-VERIFY 分支不返回它们，工具 schema 里也没有
 * 传 ZIP 的参数。三重缺失叠加 ⇒ 空集 ⇒ missing/extra/mismatched 全为空 ⇒
 * 三项一起 PASS，报告写着「交付包含全部 **0** 个文件」。
 *
 * 实测最小复现：**空任务根**（甚至不存在的路径）也全 PASS。
 *
 * 危害比 FAIL 大：FAIL 促使人排查，假绿灯让人以为已验证。本仓真实发生过
 * `*.preM5` 备份泄漏进交付 ZIP 的事故，而这道门（含 G14.4）全程未报警。
 *
 * 覆盖报告 §5.4 的 T1–T5，并额外钉住「空集必须 UNKNOWN」这条最关键的行为。
 *
 * 用法：node scripts/selftest-pack-verify.mjs
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { gatePackVerify } from '../packages/dsh-autoresearch/lib/gates.js'
import {
  collectSourceHashes, collectPackedHashes, forbiddenReason, findDeliveryZip,
} from '../packages/dsh-autoresearch/lib/pack-scope.js'
import { collectFromTask } from '../packages/dsh-autoresearch/index.js'

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${detail}`}`)
}
function expect(name, expected, actual, note) {
  const same = Object.is(expected, actual) || deepEqual(expected, actual)
  record(name, same, same
    ? (note === undefined ? JSON.stringify(actual) : `${JSON.stringify(actual)}  ${note}`)
    : `期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`)
}

/**
 * 顺序无关的深比较。
 *
 * 不能直接用 `JSON.stringify(a) === JSON.stringify(b)` 比对象：
 * 它对**键序敏感**，而 `{a,b}` 与 `{b,a}` 在语义上相等 —— 实测拿它比
 * 两份哈希映射（键序不同、值全同）会假红，把人引向「哈希不一致」的错误方向。
 */
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false
  return ka.every((k) => deepEqual(a[k], b[k]))
}
const statusOf = (result, id) => result.checks.find((item) => item.id === id)?.status ?? '(缺失)'

// ── 1. 最关键的一条：空集不得判 PASS ──────────────────────────────────────

console.log('=== 1) 空集必须 UNKNOWN（此前恒真 PASS）===')
{
  const empty = gatePackVerify({})
  for (const id of ['G14.1', 'G14.2', 'G14.3', 'G14.4']) {
    expect(`  空入参：${id} → UNKNOWN（不是 PASS）`, 'UNKNOWN', statusOf(empty, id))
  }
  record('  空入参的整体结论不是 RECOMMEND', empty.verdict !== 'RECOMMEND', empty.verdict)

  // 最小复现：空任务根走完整 fromTask 路径也必须是 UNKNOWN。
  const emptyRoot = mkdtempSync(join(tmpdir(), 'pack-empty-'))
  try {
    const payload = await collectFromTask(emptyRoot, 'G-PACK-VERIFY', {})
    const viaFromTask = gatePackVerify(payload)
    for (const id of ['G14.1', 'G14.2', 'G14.3']) {
      expect(`  空任务根 fromTask：${id} → UNKNOWN`, 'UNKNOWN', statusOf(viaFromTask, id))
    }
    record('  空任务根：明确报出「没找到交付 ZIP」',
      String(payload.packError ?? '').includes('未找到交付 ZIP'),
      String(payload.packError ?? '(无)').slice(0, 60))
    record('  采集失败作为独立判据 G14.0 报出（不与交付物问题混淆）',
      statusOf(viaFromTask, 'G14.0') === 'UNKNOWN')
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true })
  }

  // 只有源哈希、没有包哈希（ZIP 缺失）时，G14.1/G14.3 也应 UNKNOWN。
  const half = gatePackVerify({ sourceHashes: { 'a.py': 'x' } })
  expect('  只有源哈希：G14.1 → UNKNOWN', 'UNKNOWN', statusOf(half, 'G14.1'))
  expect('  只有源哈希：G14.3 → UNKNOWN', 'UNKNOWN', statusOf(half, 'G14.3'))
  expect('  只有源哈希：G14.2 → UNKNOWN（没有可比对基准）', 'UNKNOWN', statusOf(half, 'G14.2'))
}

// ── 2. 报告 §5.4 的 T1–T5 ──────────────────────────────────────────────────

console.log('\n=== 2) 报告 §5.4 的 T1–T5 ===')
{
  // T1：源树 3 文件，ZIP 只含 2 个 → G14.1 FAIL
  const t1 = gatePackVerify({
    sourceHashes: { 'a.py': 'h1', 'b.py': 'h2', 'c.py': 'h3' },
    packedHashes: { 'a.py': 'h1', 'b.py': 'h2' },
  })
  expect('T1 少一个文件 → G14.1 FAIL', 'FAIL', statusOf(t1, 'G14.1'))
  record('T1 报出缺的是哪一个', String(t1.checks.find((c) => c.id === 'G14.1').detail).includes('c.py'))

  // T2：ZIP 含源树没有的第 4 个文件 → G14.2 FAIL
  const t2 = gatePackVerify({
    sourceHashes: { 'a.py': 'h1' },
    packedHashes: { 'a.py': 'h1', 'sneak.py': 'h9' },
  })
  expect('T2 多一个文件 → G14.2 FAIL', 'FAIL', statusOf(t2, 'G14.2'))
  record('T2 报出多的是哪一个', String(t2.checks.find((c) => c.id === 'G14.2').detail).includes('sneak.py'))

  // T3：同名但内容不同 → G14.3 FAIL
  const t3 = gatePackVerify({
    sourceHashes: { 'a.py': 'hash-A' },
    packedHashes: { 'a.py': 'hash-B' },
  })
  expect('T3 内容不同 → G14.3 FAIL', 'FAIL', statusOf(t3, 'G14.3'))

  // T4：ZIP 不存在（包哈希为空）→ G14.1/G14.3 UNKNOWN
  const t4 = gatePackVerify({ sourceHashes: { 'a.py': 'h1' } })
  expect('T4 无包 → G14.1 UNKNOWN', 'UNKNOWN', statusOf(t4, 'G14.1'))
  expect('T4 无包 → G14.3 UNKNOWN', 'UNKNOWN', statusOf(t4, 'G14.3'))

  // T5：源树含 __pycache__/x.pyc → G14.4 FAIL
  const t5 = gatePackVerify({
    sourceHashes: { 'a.py': 'h1' },
    packedHashes: { 'a.py': 'h1' },
    forbiddenEntries: ['workspace/__pycache__/x.pyc'],
  })
  expect('T5 含缓存残留 → G14.4 FAIL', 'FAIL', statusOf(t5, 'G14.4'))

  // 全一致时才是真 PASS（不能因为修 T1-T5 就把正常路径也判红）
  const clean = gatePackVerify({
    sourceHashes: { 'a.py': 'h1', 'b.py': 'h2' },
    packedHashes: { 'a.py': 'h1', 'b.py': 'h2' },
    forbiddenEntries: [],
  })
  for (const id of ['G14.1', 'G14.2', 'G14.3', 'G14.4']) {
    expect(`  全一致：${id} → PASS`, 'PASS', statusOf(clean, id))
  }
  record('  全一致的 PASS 文案报出真实文件数（不是「0 个文件」）',
    String(clean.checks.find((c) => c.id === 'G14.1').detail).includes('2 个文件'),
    clean.checks.find((c) => c.id === 'G14.1').detail)
}

// ── 3. 禁止项识别（含真实事故指纹）────────────────────────────────────────

console.log('\n=== 3) 禁止项识别 ===')
expect('  __pycache__ 目录', true, forbiddenReason('workspace/__pycache__/x.pyc') !== null)
expect('  .pyc 后缀', true, forbiddenReason('a/b.pyc') !== null)
expect('  .DS_Store', true, forbiddenReason('expert_evidence/.DS_Store') !== null)
expect('  Thumbs.db', true, forbiddenReason('x/Thumbs.db') !== null)
expect('  .pytest_cache', true, forbiddenReason('.pytest_cache/v/cache') !== null)
// 真实事故指纹：*.preM5 备份曾泄漏进交付包
expect('  *.preM5 备份残留（真实事故）', true, forbiddenReason('environment/starter/train.py.preM5') !== null)
expect('  *.bak 同类风险', true, forbiddenReason('a/config.yaml.bak') !== null)
expect('  *.orig 同类风险', true, forbiddenReason('a/x.py.orig') !== null)
expect('  ~ 结尾的编辑器临时文件', true, forbiddenReason('a/x.py~') !== null)
// 正常文件不得误报
expect('  正常源码不误报', null, forbiddenReason('workspace/harbor_task/environment/train.py'))
expect('  含 preM5 但非后缀的词不误报', null, forbiddenReason('notes/preM5-plan.md'))
expect('  目录名含 pycache 前缀不误报', null, forbiddenReason('a/__pycache__x/f.py'))

// ── 4. ZIP 查找只在一层内（不误取数据集 zip）──────────────────────────────

console.log('\n=== 4) 交付 ZIP 查找 ===')
{
  const root = mkdtempSync(join(tmpdir(), 'pack-find-'))
  try {
    let found = await findDeliveryZip(root, undefined)
    expect('  根下无 zip → null（不猜）', null, found.path)

    // 子目录里有数据集 zip —— 不得被当成交付包
    mkdirSync(join(root, '_data'), { recursive: true })
    writeFileSync(join(root, '_data', 'EuroSAT_RGB.zip'), 'PK')
    found = await findDeliveryZip(root, undefined)
    expect('  子目录里的数据集 zip 不被误取', null, found.path)
    record('  并说明为何不取', String(found.reason).includes('没有 .zip'), String(found.reason).slice(0, 50))

    // 根下唯一 zip → 采用
    writeFileSync(join(root, 'submission.zip'), 'PK')
    found = await findDeliveryZip(root, undefined)
    expect('  根下唯一 zip → 采用', 'submission.zip', found.path === null ? null : 'submission.zip')

    // 显式 artifact 优先
    found = await findDeliveryZip(root, '_data/EuroSAT_RGB.zip')
    record('  显式 artifact 优先于自动查找', String(found.path).includes('EuroSAT'),
      String(found.path).split(/[\\/]/).slice(-2).join('/'))

    // 多个 zip 时不猜
    writeFileSync(join(root, 'other.zip'), 'PK')
    found = await findDeliveryZip(root, undefined)
    expect('  多个 zip → null（不猜）', null, found.path)
    record('  并列出候选', String(found.reason).includes('other.zip'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── 5. 真实 ZIP 往返：打包→逐字节复算 ─────────────────────────────────────

console.log('\n=== 5) 真实 ZIP：采集与复算一致（自建样本，不依赖用户数据）===')
{
  const root = mkdtempSync(join(tmpdir(), 'pack-real-'))
  try {
    mkdirSync(join(root, 'workspace', 'harbor_task'), { recursive: true })
    mkdirSync(join(root, 'expert_evidence'), { recursive: true })
    writeFileSync(join(root, 'workspace', 'harbor_task', 'task.toml'), '[task]\nname = "a/b"\n')
    writeFileSync(join(root, 'workspace', 'harbor_task', 'train.py'), 'print("hi")\n')
    writeFileSync(join(root, 'expert_evidence', 'README.md'), '# evidence\n')
    // 缓存残留：应进 forbidden 而不是进哈希
    mkdirSync(join(root, 'workspace', '__pycache__'), { recursive: true })
    writeFileSync(join(root, 'workspace', '__pycache__', 'x.pyc'), 'junk')

    const source = await collectSourceHashes(root)
    expect('  源树采集到 3 个正常文件', 3, Object.keys(source.files).length)
    expect('  缓存残留被判为禁止项', 1, source.forbidden.length)
    expect('  禁止项路径正确', true, source.forbidden[0].includes('__pycache__'))

    // 自建 ZIP（store），逐字节写入已知内容。
    // `include` 是**谓词函数**（不是路径数组）——按目录前缀过滤。
    const { packDirectory } = await import('../packages/dsh-autoresearch-qa/lib/zip.js')
    const zipPath = join(root, 'submission.zip')
    const packed = await packDirectory(root, zipPath, {
      include: (relativePath) => relativePath.startsWith('workspace/')
        || relativePath.startsWith('expert_evidence/'),
    })
    record('  打包成功且排除了缓存残留', packed.entryCount === 3, `entryCount=${packed.entryCount}`)

    const back = await collectPackedHashes(zipPath)
    expect('  包内条目数 = 源文件数', 3, Object.keys(back.files).length)
    expect('  逐文件 sha256 完全一致', source.files, back.files)

    const result = gatePackVerify({
      sourceHashes: source.files,
      packedHashes: back.files,
      forbiddenEntries: [...source.forbidden, ...back.forbidden],
    })
    expect('  G14.1 PASS', 'PASS', statusOf(result, 'G14.1'))
    expect('  G14.2 PASS', 'PASS', statusOf(result, 'G14.2'))
    expect('  G14.3 PASS（往返哈希一致）', 'PASS', statusOf(result, 'G14.3'))
    // 样本里 deliberately 造了 __pycache__，所以 G14.4 **应当 FAIL**：
    // 哈希三项只扫「正常文件」，缓存残留由禁止项单独判定 —— 二者互不掩盖。
    expect('  G14.4 FAIL（样本含缓存残留，且已报出）', 'FAIL', statusOf(result, 'G14.4'))
    record('  G14.4 文案点名残留路径',
      String(result.checks.find((c) => c.id === 'G14.4').detail).includes('__pycache__'))
    record('  哈希三项与禁止项互不掩盖（前者仍 PASS）',
      statusOf(result, 'G14.1') === 'PASS' && statusOf(result, 'G14.4') === 'FAIL')

    // 真正干净的一轮：清掉缓存残留后四项应全 PASS。
    rmSync(join(root, 'workspace', '__pycache__'), { recursive: true, force: true })
    const cleanSource = await collectSourceHashes(root)
    const cleanPack = await collectPackedHashes(zipPath)
    expect('  清理后源树无禁止项', 0, cleanSource.forbidden.length)
    const cleanResult = gatePackVerify({
      sourceHashes: cleanSource.files,
      packedHashes: cleanPack.files,
      forbiddenEntries: [...cleanSource.forbidden, ...cleanPack.forbidden],
    })
    for (const id of ['G14.1', 'G14.2', 'G14.3', 'G14.4']) {
      expect(`  清理后 ${id} → PASS`, 'PASS', statusOf(cleanResult, id))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// ── 6. ZIP 损坏时如实报错，不静默当空 ─────────────────────────────────────

console.log('\n=== 6) 异常输入如实报错 ===')
{
  const root = mkdtempSync(join(tmpdir(), 'pack-bad-'))
  try {
    const bad = join(root, 'broken.zip')
    writeFileSync(bad, 'this is not a zip')
    let threw = false
    try { await collectPackedHashes(bad) } catch (error) {
      threw = true
      record('  非 ZIP 文件抛出明确错误', String(error.message).includes('ZIP'), error.message.slice(0, 50))
    }
    record('  没有静默返回空集（那会变成假 PASS）', threw)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log()
console.log('='.repeat(62))
const failed = results.filter((r) => !r.ok)
console.log(`打包一致性回归：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length > 0) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  · ${f.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
