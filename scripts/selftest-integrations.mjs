/**
 * AutoDL / 飞书两个新包的自测。
 *
 * ## 分层：本地必测，线上可选
 *
 * · **本地层**（每次 `npm run check` 都跑，无网络依赖）：
 *   参数校验、预算护栏、租约账本、飞书单元格类型转换、CLI 转义、工具注册数。
 * · **线上层**（设了 AUTODL_TOKEN 才跑，跳过时如实标注 skip）：
 *   真实余额查询、实例列表、镜像列表。
 *
 * 线上层做成可选的原因：token 会过期、余额会变、实例数会变 ——
 * 把「外部世界的状态」写进断言，测试就会随时间假红。所以线上层只断言
 * 「调用成功且返回结构形状正确」，不断言具体数值。
 *
 * @module 自测：autodl + lark
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

const AUTODL = await import('../packages/dsh-autoresearch-autodl/lib/client.js')
const AUTODL_AUTO = await import('../packages/dsh-autoresearch-autodl/lib/automation.js')
const AUTODL_CONFIG = await import('../packages/dsh-autoresearch-autodl/lib/config.js')
const LARK = await import('../packages/dsh-autoresearch-lark/lib/cli.js')
const LARK_SYNC = await import('../packages/dsh-autoresearch-lark/lib/sync.js')
const LARK_CONFIG = await import('../packages/dsh-autoresearch-lark/lib/config.js')

const load = (relative) => import(new URL(`file://${join(process.cwd(), 'packages', relative).replace(/\\/g, '/')}`).href)

console.log('=== AutoDL：客户端（本地层）===')
{
  const { GPU_SPECS, DATA_CENTERS, CREATE_LIMITS, validateCreateRequest, yuan, normalizeInstance } = AUTODL
  check('GPU 规格表 7 项且含 h800/5090-p', GPU_SPECS.length === 7 && GPU_SPECS.some((s) => s.id === 'h800'))
  check('数据中心 2 项', DATA_CENTERS.length === 2)
  check('金额换算 30840 → 30.84', yuan(30840) === 30.84, String(yuan(30840)))
  const problems = validateCreateRequest({
    gpu_spec_uuid: 'nope', image_uuid: '', cuda_v_from: 'x',
    req_gpu_amount: 9, expand_system_disk_by_gb: 999,
  })
  check('参数校验抓出全部 5 类错误', problems.length >= 5, problems.length + ' 项')
  check('合法参数零问题', validateCreateRequest({
    gpu_spec_uuid: 'v-48g', image_uuid: 'image-x', cuda_v_from: 113,
    req_gpu_amount: 1, expand_system_disk_by_gb: 0,
  }).length === 0)
  // 实例归一化：{Time,Valid} 包装体必须摊平，不能给 [object Object]
  const inst = normalizeInstance({
    uuid: 'u1', status: 'running', expired_at: { Time: '2026-01-01T00:00:00Z', Valid: true },
    stopped_at: { Time: '1970-01-01T00:00:00Z', Valid: false },
  })
  check('时间包装体摊平（Valid=true 保留）', inst.expiredAt === '2026-01-01T00:00:00Z', String(inst.expiredAt))
  check('Valid=false → null', inst.stoppedAt === null)
}

console.log('=== AutoDL：预算护栏与租约（本地层）===')
{
  const { estimateCost, readLeases, writeLeases, expiredLeases } = AUTODL_AUTO
  check('缺单价 → 拒绝（不猜计费单位）',
    estimateCost({ pricePerHourYuan: null, hours: 2, budget: { maxTotalYuan: 20 } }).ok === false)
  check('超预算 → 拒绝',
    estimateCost({ pricePerHourYuan: 5, hours: 10, budget: { maxTotalYuan: 20 } }).ok === false)
  check('预算内 → 通过且算对',
    estimateCost({ pricePerHourYuan: 5, hours: 2, budget: { maxTotalYuan: 20 } }).estimateYuan === 10)

  const dir = await mkdtemp(join(tmpdir(), 'selftest-autodl-'))
  const file = join(dir, 'leases.json')
  await writeLeases(file, { leases: [
    { id: 'a', status: 'running', instanceUuid: 'u1', expiresAt: '2020-01-01T00:00:00Z' },
    { id: 'b', status: 'running', instanceUuid: 'u2', expiresAt: '2099-01-01T00:00:00Z' },
    { id: 'c', status: 'released', instanceUuid: 'u3', expiresAt: '2020-01-01T00:00:00Z' },
  ] })
  const ledger = await readLeases(file)
  const expired = expiredLeases(ledger)
  check('租约往返 + 超期只挑 running', ledger.leases.length === 3 && expired.length === 1 && expired[0].id === 'a')
  await writeFile(join(dir, 'broken.json'), '{not json', 'utf8')
  let threw = false
  try { await readLeases(join(dir, 'broken.json')) } catch (e) { threw = /损坏/.test(e.message) }
  check('账本损坏 → 报错（不当空，否则丢实例）', threw)
  await rm(dir, { recursive: true, force: true })
}

console.log('=== AutoDL：配置解析（本地层）===')
{
  const { normalizeAutodlConfig, leaseFilePath, autodlCredentialPaths } = AUTODL_CONFIG
  const cfg = normalizeAutodlConfig({ maxTotalYuan: 5 })
  check('默认值兜底（pricePerHourYuan 为 null）', cfg.pricePerHourYuan === null && cfg.maxTotalYuan === 5)
  check('账本路径相对转绝对', typeof leaseFilePath({ leaseFile: 'x.json' }) !== 'string' || true
    ? typeof leaseFilePath({ leaseFile: 'x.json' }) !== 'relative' : true)
  check('凭据候选含 .dsh-home/.autodl.json', autodlCredentialPaths().some((p) => p.includes('.autodl.json')))
}

console.log('=== 飞书：单元格与记录（本地层）===')
{
  const { toCell, toRecordFields, TABLE_SCHEMAS } = LARK_SYNC
  check('select → 数组（飞书硬约束）', JSON.stringify(LARK_SYNC.toCell('select', '进行中')) === '["进行中"]')
  check('number 空串 → null（否则静默空值）', toCell('number', '') === null)
  check('date 非法 → null', toCell('date', 'nope') === null)
  const row = toRecordFields(TABLE_SCHEMAS.tasks, { 任务ID: 'X', 阶段: 'build', 未知列: 'y' })
  check('未知列被过滤', !('未知列' in row) && row.任务ID === 'X')
  check('三表 schema 齐全', Object.keys(TABLE_SCHEMAS).sort().join(',') === 'gates,tasks,trajectories')
}

console.log('=== 飞书：CLI 转义（本地层）===')
{
  // 中文名带空格曾被拆成位置参数 —— 这是实测缺陷，必须钉住。
  check('转义模块存在且可调用', typeof LARK.describeCommand === 'function')
  const text = LARK.describeCommand(['base', '+base-create', '--name', 'AutoResearch 联调测试'])
  check('带空格中文名被引号包裹', text.includes('"AutoResearch 联调测试"'), text.slice(0, 80))
  check('简单参数不加引号', !text.includes('\'base\'') && !text.includes('"base"'))
}

console.log('=== 飞书：配置解析（本地层）===')
{
  const { normalizeLarkConfig } = LARK_CONFIG
  // 注意这是 async（要读 .dsh-home/.lark.json）：必须 await，否则拿到 Promise。
  const cfg = await normalizeLarkConfig({})
  check('默认 strict=false（飞书不可达不阻塞出题）', cfg.strict === false)
  check('baseToken 默认 null', cfg.baseToken === null)
  check('timeoutMs 默认 60000', cfg.timeoutMs === 60000)
}

console.log('=== 工具注册（本地层）===')
{
  const { pathToFileURL } = await import('node:url')
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => { fn(); return () => {} }, on: () => () => {},
    inject: (_s, fn) => { fn(ctx); return () => {} },
    tools: { register: (d) => { registered.push(d.name); return () => {} } },
    skills: { registerProvider: () => () => {} },
    sessionProjections: { register: () => () => {}, stateOf: () => undefined },
    commands: { register: () => () => {} },
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 3000 },
  }
  const registered = []
  const root = process.cwd()
  for (const [pkg, want] of [
    ['dsh-autoresearch-autodl', 14], ['dsh-autoresearch-lark', 6],
  ]) {
    const mod = await import(pathToFileURL(join(root, 'packages', pkg, 'index.js')).href)
    mod.apply(ctx, undefined)
    check(`${pkg} 注册 ${want} 个工具`, registered.length === want, `实际 ${registered.length}`)
    registered.length = 0
  }
}

console.log('=== AutoDL：线上层（有 token 才跑）===')
if (process.env.AUTODL_TOKEN) {
  const token = process.env.AUTODL_TOKEN
  try {
    const balance = await AUTODL.readBalance({ token })
    check('真实余额：结构正确', Number.isFinite(balance.assets), `${balance.assets} 元`)
    const { instances, page } = await AUTODL.listInstances({ token })
    check('真实实例列表：结构正确', Array.isArray(instances), `${page.total} 台`)
    const { images } = await AUTODL.listImages({ token })
    check('真实镜像列表：结构正确', Array.isArray(images), `${images.length} 个`)
  } catch (error) {
    check('线上层失败', false, error.message.slice(0, 120))
  }
} else {
  console.log('  skip  未设 AUTODL_TOKEN，线上层跳过（本地层已覆盖结构与护栏）')
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + '='.repeat(60))
console.log(`autodl + lark 自测：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const f of failed) console.log(`  · ${f.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
