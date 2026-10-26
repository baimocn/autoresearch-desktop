/**
 * AutoDL 自动化调度：成本护栏 + 实例生命周期。
 *
 * ## 为什么「全自动」还需要这一层
 *
 * 用户明确要求全自动（允许自动创建 / 开关机），但 AutoDL 按量计费：
 * 忘关实例就一直扣钱。实测账户余额 30.84 元，一个 PRO6000 实例跑几小时就没了。
 * 所以自动化的核心**不是能开，而是能保证会关**。
 *
 * 三道护栏，缺一不可：
 *
 * 1. **预估上限**（`maxHourlyYuan` / `maxTotalYuan`）：开之前先算「按当前速率
 *    跑满时限要花多少」，超预算直接拒绝，不询问。问一次是可以被误点的，
 *    算一次不行就是不行。
 * 2. **租约**（lease）：每个自动创建的实例都写一条租约（createdAt + 到期时间）。
 *    租约落盘（JSON），进程重启后仍能据此回收 —— 只放在内存里的记录，
 *    崩溃后就变成「谁也不知道这台实例为什么在跑」。
 * 3. **回收**（reap）：任何时刻都能列出「已超期」的实例并自动关机/释放。
 *    这是唯一能让「忘了」不产生费用的机制。
 *
 * ## 为什么不复用 remote 包的账本
 *
 * `dsh-autoresearch-remote/lib/ledger.js` 记的是 **SSH 作业**（提交/探测/快照），
 * 生命周期由远端脚本自己管。AutoDL 的实例生命周期由**云厂商 API** 管，
 * 两者不是同一个东西；硬塞进同一个账本会让「作业失败」和「实例还在跑」混在一起。
 *
 * @module dsh-autoresearch-autodl/lib/automation
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, isAbsolute, resolve } from 'node:path'
import {
  AutoDLError, createInstance, listInstances, readSnapshot, readInstanceStatus,
  powerOn, powerOff, releaseInstance, yuan, ENDPOINTS,
} from './client.js'

/** 调度账本默认落点（相对任务根）；放在 .dsh-home 之外会进 git，故由上层指定绝对路径。 */
export const DEFAULT_LEASE_FILE = '.autodl-leases.json'

/** 租约状态机。`released` 只表示已发起释放，不代表服务端已消失。 */
export const LEASE_STATUS = Object.freeze({
  creating: 'creating',
  running: 'running',
  stopped: 'stopped',
  released: 'released',
  failed: 'failed',
})

/** 读账本；不存在视为空。损坏时**报错而不是当空** —— 丢掉租约等于丢钱。 */
export async function readLeases(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, leases: [] }
    throw error
  }
  try {
    const parsed = JSON.parse(text)
    return {
      version: parsed?.version ?? 1,
      leases: Array.isArray(parsed?.leases) ? parsed.leases : [],
    }
  } catch (error) {
    throw new AutoDLError(`租约账本损坏，拒绝按空账本继续（否则会丢实例）：${file} ${error.message}`)
  }
}

/** 写账本（原子替换：先写临时文件再 rename）。 */
export async function writeLeases(file, ledger) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify({ version: 1, leases: ledger.leases ?? [] }, null, 2)}\n`, 'utf8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, file)
}

/**
 * 估算跑满时限的费用（元）。
 *
 * 价格来自 snapshot 的 `payg_price`。文档没有写明该字段的**计费时长单位**，
 * 所以这里不接受「每小时价格」的假设：调用方必须显式给出
 * `pricePerHourYuan`（由上层按自己对账单价的理解填），否则不做预算判定。
 * 宁可说「算不出来，需要人工确认」，也不拿一个编出来的单位去放行。
 *
 * @returns {{ok: boolean, estimateYuan: number|null, reason: string}}
 */
export function estimateCost({ pricePerHourYuan, hours, budget }) {
  const price = Number(pricePerHourYuan)
  const duration = Number(hours)
  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, estimateYuan: null, reason: '缺少可用的单价：pricePerHourYuan 未提供或非正数，无法做预算判定' }
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    return { ok: false, estimateYuan: null, reason: '缺少可用的时长：hours 未提供或非正数' }
  }
  const estimateYuan = Math.round(price * duration * 100) / 100
  const limit = Number(budget?.maxTotalYuan)
  if (Number.isFinite(limit) && estimateYuan > limit) {
    return {
      ok: false, estimateYuan,
      reason: `预估 ${estimateYuan} 元超过单次上限 ${limit} 元（${price} 元/时 × ${duration} 小时）`,
    }
  }
  return { ok: true, estimateYuan, reason: `预估 ${estimateYuan} 元，在上限内` }
}

/**
 * 全自动开一台实例并登记租约。
 *
 * 流程刻意是「先写租约 → 再创建 → 回填 uuid」：
 * 反过来的话，创建成功、写租约前崩溃，那台实例就**永远不在账本里**，
 * 再也不会被回收。账本里留一条 `creating` 且无 uuid 的记录虽然难看，
 * 但它是可被 `reconcileLeases()` 追回来的唯一线索。
 */
export async function provisionInstance({
  request, leaseFile, token, hours, budget, fetchImpl, now = () => new Date(),
}) {
  const file = isAbsolute(leaseFile) ? leaseFile : resolve(process.cwd(), leaseFile)
  const ledger = await readLeases(file)
  const startedAt = now()

  // 预算判定放在最前：不通过就一行代码都不动云端。
  const cost = estimateCost({ pricePerHourYuan: budget?.pricePerHourYuan, hours, budget })
  if (!cost.ok) throw new AutoDLError(`拒绝创建：${cost.reason}`, { endpoint: ENDPOINTS.instanceCreate.path })

  const lease = {
    id: `lease-${startedAt.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    status: LEASE_STATUS.creating,
    label: request?.instance_name ?? null,
    gpuSpecUuid: request?.gpu_spec_uuid ?? null,
    gpuAmount: request?.req_gpu_amount ?? null,
    instanceUuid: null,
    createdAt: startedAt.toISOString(),
    // 到期时间 = 创建时刻 + 计划时长；回收以它为准，不看服务端有没有定时关机。
    expiresAt: new Date(startedAt.getTime() + Number(hours) * 3600_000).toISOString(),
    estimatedYuan: cost.estimateYuan,
    note: cost.reason,
  }
  ledger.leases.push(lease)
  await writeLeases(file, ledger)

  try {
    const instanceUuid = await createInstance(request, { token, fetchImpl })
    lease.instanceUuid = instanceUuid
    lease.status = LEASE_STATUS.running
    await writeLeases(file, ledger)
    return { lease, instanceUuid, estimate: cost }
  } catch (error) {
    lease.status = LEASE_STATUS.failed
    lease.error = error?.message ?? String(error)
    await writeLeases(file, ledger)
    throw error
  }
}

/**
 * 核对账本与服务端的差异。
 *
 * 三个真实会发生的漂移：
 *   · 账本有、云端没有（实例被用户手动删了）→ 标 released，不再尝试回收
 *   · 云端有、账本没有（在控制台手动开了）→ **列出来但不自动接管**：
 *     它不是本平台创建的，擅自关掉会打断别人的工作
 *   · 账本 creating 但已拿到 uuid（上次在两步之间崩了）→ 补成 running
 */
export async function reconcileLeases({ leaseFile, token, fetchImpl }) {
  const file = isAbsolute(leaseFile) ? leaseFile : resolve(process.cwd(), leaseFile)
  const ledger = await readLeases(file)
  const { instances } = await listInstances({ token, fetchImpl, pageSize: 100 })
  const cloudUuids = new Set(instances.map((i) => i.uuid).filter(Boolean))

  const adrift = { missingInCloud: [], unmanaged: [], healed: [] }
  for (const lease of ledger.leases) {
    if (lease.instanceUuid && !cloudUuids.has(lease.instanceUuid)
        && (lease.status === LEASE_STATUS.running || lease.status === LEASE_STATUS.stopped)) {
      lease.status = LEASE_STATUS.released
      lease.note = `${lease.note ?? ''} | 云端已不存在，标记 released`.trim()
      adrift.missingInCloud.push(lease.id)
    }
    if (lease.status === LEASE_STATUS.creating && lease.instanceUuid) {
      lease.status = LEASE_STATUS.running
      adrift.healed.push(lease.id)
    }
  }
  const managed = new Set(ledger.leases.map((l) => l.instanceUuid).filter(Boolean))
  for (const inst of instances) {
    if (inst.uuid && !managed.has(inst.uuid)) {
      adrift.unmanaged.push({
        uuid: inst.uuid, name: inst.name, status: inst.status,
        gpuSpecUuid: inst.gpuSpecUuid, gpuAmount: inst.gpuAmount,
      })
    }
  }
  await writeLeases(file, ledger)
  return { ledger, adrift }
}

/** 已超期且仍需回收的租约。 */
export function expiredLeases(ledger, { now = new Date() } = {}) {
  return (ledger?.leases ?? []).filter((lease) => {
    if (lease.status !== LEASE_STATUS.running && lease.status !== LEASE_STATUS.stopped) return false
    if (!lease.expiresAt) return false
    return new Date(lease.expiresAt).getTime() <= now.getTime()
  })
}

/**
 * 回收超期实例。
 *
 * @param {{mode?: 'stop'|'release'}} options
 *   `stop` 只关机（保留磁盘，可再次开机）；`release` 关机后释放（**数据不可恢复**）。
 *   默认 `stop` —— 全自动释放会连带删掉别人的中间产物，代价不可逆。
 */
export async function reapExpiredLeases({
  leaseFile, token, fetchImpl, mode = 'stop', now = new Date(), dryRun = false,
}) {
  const file = isAbsolute(leaseFile) ? leaseFile : resolve(process.cwd(), leaseFile)
  const ledger = await readLeases(file)
  const expired = expiredLeases(ledger, { now })
  const actions = []

  for (const lease of expired) {
    const action = { leaseId: lease.id, instanceUuid: lease.instanceUuid, mode, ok: false, detail: null }
    if (!lease.instanceUuid) {
      action.detail = '租约无实例 uuid（创建阶段就失败了），只需清理账本'
      if (!dryRun) {
        lease.status = LEASE_STATUS.failed
        actions.push(action)
      } else actions.push(action)
      continue
    }
    if (dryRun) {
      action.ok = true
      action.detail = `预演：将对 ${lease.instanceUuid} 执行 ${mode}`
      actions.push(action)
      continue
    }
    try {
      const status = await readInstanceStatus(lease.instanceUuid, { token, fetchImpl })
      if (mode === 'release') {
        // release 内部会先校验状态，未关机时抛错 —— 这里先关机再释放。
        if (!['shutdown', 'stopped', 'power_off'].includes(String(status))) {
          await powerOff(lease.instanceUuid, { token, fetchImpl })
        }
        await releaseInstance(lease.instanceUuid, { token, fetchImpl })
        lease.status = LEASE_STATUS.released
        action.ok = true
        action.detail = `已释放（原状态 ${status ?? '未知'}）`
      } else {
        if (['shutdown', 'stopped', 'power_off'].includes(String(status))) {
          action.ok = true
          action.detail = `已是停止状态（${status}），无需关机`
        } else {
          await powerOff(lease.instanceUuid, { token, fetchImpl })
          action.ok = true
          action.detail = `已关机（原状态 ${status ?? '未知'}）`
        }
        lease.status = LEASE_STATUS.stopped
      }
      lease.reapedAt = now.toISOString()
    } catch (error) {
      action.detail = `回收失败：${error?.message ?? String(error)}`
      lease.lastReapError = action.detail
    }
    actions.push(action)
  }

  if (!dryRun) await writeLeases(file, ledger)
  return { expired: expired.length, actions, ledger }
}

/**
 * 一台实例的实时成本面板数据。
 *
 * 成本按「已运行秒数 × 单价」算；单价仍要求上层显式给出（理由同 estimateCost）。
 */
export async function instanceCostReport({ instanceUuid, token, fetchImpl, pricePerHourYuan, now = new Date() }) {
  const snapshot = await readSnapshot(instanceUuid, { token, fetchImpl })
  const status = await readInstanceStatus(instanceUuid, { token, fetchImpl })
  const startedAt = snapshot?.usage?.valid_at ?? null
  const elapsedHours = startedAt
    ? Math.max(0, (now.getTime() - new Date(startedAt).getTime()) / 3600_000)
    : null
  const price = Number(pricePerHourYuan)
  return {
    instanceUuid, status, snapshot,
    elapsedHours: elapsedHours === null ? null : Math.round(elapsedHours * 100) / 100,
    estimateYuan: (elapsedHours !== null && Number.isFinite(price) && price > 0)
      ? Math.round(elapsedHours * price * 100) / 100
      : null,
    priceSource: snapshot?.paygPrice ?? null,
  }
}
