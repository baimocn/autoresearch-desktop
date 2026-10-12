/**
 * 远端任务的本地账本 —— 控制端只记「这个任务叫什么、在哪、该看什么」。
 *
 * 关键设计：**账本是缓存，不是真相。** 真相在远端的状态文件与标记文件里。
 * 因此控制端重建、换机器、丢账本都不影响续接：重新探测即可恢复视图。
 * 这条对应 SOP「缺证据不推进」与「绝不静默成功」：本地不猜测远端状态。
 *
 * @module dsh-autoresearch-remote/ledger
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export const LEDGER_VERSION = 1

export class LedgerError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LedgerError'
  }
}

/** 空账本。 */
export function emptyLedger() {
  return {
    version: LEDGER_VERSION,
    updatedAt: new Date().toISOString(),
    /** 远端目标：id → { host, user, port, remoteRoot, label } */
    targets: {},
    /** 任务：jobId → { targetId, kind, workDir, submittedAt, lastProbe } */
    jobs: {},
    /** 快照：capturedAt → { localArchive, sha256, bytes, remotePaths } */
    snapshots: [],
  }
}

export async function readLedger(taskRoot) {
  const file = join(taskRoot, '.autoresearch-remote', 'ledger.json')
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    if (parsed?.version !== LEDGER_VERSION) {
      throw new LedgerError(`账本版本 ${parsed?.version} 与当前 ${LEDGER_VERSION} 不匹配`)
    }
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyLedger()
    throw error
  }
}

/** 原子写入账本。 */
export async function writeLedger(taskRoot, ledger) {
  const file = join(taskRoot, '.autoresearch-remote', 'ledger.json')
  await mkdir(dirname(file), { recursive: true })
  const next = { ...ledger, updatedAt: new Date().toISOString() }
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8')
  await rename(temporary, file)
  return next
}

/** 登记或更新一个远端目标。 */
export function registerTarget(ledger, id, target) {
  if (typeof id !== 'string' || id.trim() === '') throw new LedgerError('目标 id 必须是非空字符串')
  if (typeof target?.host !== 'string' || target.host.trim() === '') throw new LedgerError('目标必须有 host')
  return {
    ...ledger,
    targets: {
      ...ledger.targets,
      [id]: {
        host: target.host,
        user: target.user ?? null,
        port: target.port ?? null,
        identityFile: target.identityFile ?? null,
        remoteRoot: target.remoteRoot ?? '.autoresearch-remote',
        label: target.label ?? id,
        updatedAt: new Date().toISOString(),
      },
    },
  }
}

/** 登记任务。 */
export function registerJob(ledger, jobId, job) {
  if (typeof jobId !== 'string' || jobId.trim() === '') throw new LedgerError('jobId 必须是非空字符串')
  if (ledger.targets[job.targetId] === undefined) {
    throw new LedgerError(`未登记的目标：${job.targetId}；先用目标登记工具添加`)
  }
  return {
    ...ledger,
    jobs: {
      ...ledger.jobs,
      [jobId]: {
        targetId: job.targetId,
        kind: job.kind ?? 'generic',
        workDir: job.workDir,
        remoteScript: job.remoteScript ?? null,
        scriptSha256: job.scriptSha256 ?? null,
        submittedAt: new Date().toISOString(),
        lastProbe: null,
      },
    },
  }
}

/** 记录一次探测结果。 */
export function recordProbe(ledger, jobId, probe) {
  const existing = ledger.jobs[jobId]
  if (existing === undefined) return ledger
  return {
    ...ledger,
    jobs: {
      ...ledger.jobs,
      [jobId]: {
        ...existing,
        lastProbe: {
          at: new Date().toISOString(),
          phase: probe.phase,
          reachable: probe.reachable,
          logTail: probe.logTail ?? null,
        },
      },
    },
  }
}

/** 记录一次快照。 */
export function recordSnapshot(ledger, snapshot) {
  return {
    ...ledger,
    snapshots: [
      ...ledger.snapshots,
      {
        capturedAt: snapshot.capturedAt,
        localArchive: snapshot.localArchive,
        sha256: snapshot.sha256,
        bytes: snapshot.bytes,
        remotePaths: snapshot.remotePaths,
      },
    ],
  }
}

/**
 * 由账本推导持久化体检结论。
 * 只报告事实：哪些任务未完成、哪些长时间未探测、是否有恢复证据。
 */
export function summarizePersistence(ledger, options = {}) {
  const now = options.now ?? Date.now()
  const staleMs = options.staleMs ?? 60 * 60 * 1000
  const jobs = Object.entries(ledger.jobs).map(([jobId, job]) => {
    const lastProbeAt = job.lastProbe?.at ?? null
    const sinceProbeMs = lastProbeAt === null ? null : now - Date.parse(lastProbeAt)
    return {
      jobId,
      targetId: job.targetId,
      kind: job.kind,
      phase: job.lastProbe?.phase ?? 'never-probed',
      submittedAt: job.submittedAt,
      lastProbeAt,
      stale: sinceProbeMs !== null && sinceProbeMs > staleMs,
      sinceProbeMs,
    }
  })

  const unfinished = jobs.filter((job) => job.phase === 'running' || job.phase === 'stalled' || job.phase === 'pending')
  const unknown = jobs.filter((job) => job.phase === 'unknown' || job.phase === 'never-probed')

  return {
    targetCount: Object.keys(ledger.targets).length,
    jobCount: jobs.length,
    jobs,
    unfinished,
    unknown,
    snapshotCount: ledger.snapshots.length,
    restoredEvidence: ledger.snapshots.length > 0,
    /** 恢复证据是否足以支撑 M4 的 snapshot_restore_probe。 */
    restoreProbeReady: ledger.snapshots.length > 0,
  }
}
