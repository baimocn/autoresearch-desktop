/**
 * 出题任务状态机 —— 四阶段推进、门禁结论留痕、交付物存在性核对。
 *
 * 状态落在磁盘上（单一 JSON 文件），因为教程要求「同一事实单一真源」：
 * 阶段、门禁结论与证据路径只有一处生效声明，UI 与工具读同一份。
 *
 * @module dsh-autoresearch/state
 */

import { mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises'
import { dirname, join, isAbsolute, relative } from 'node:path'
import { PHASES, phaseById, nextPhase } from './phases.js'

export const STATE_FILE = 'autoresearch-state.json'
export const STATE_VERSION = 1

/** 状态文件过大时拒绝写入，避免把任务目录写成日志堆积区。 */
export const MAX_STATE_BYTES = 4 * 1024 * 1024

export class StateError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'StateError'
    this.status = status
  }
}

/** 初始状态：停在第一阶段，无任何门禁结论。 */
export function emptyState(taskId) {
  return {
    version: STATE_VERSION,
    taskId: taskId ?? null,
    phase: PHASES[0].id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    /** 阶段推进历史，只追加。 */
    history: [],
    /** 门禁结论，按 gate id 覆盖式保存最近一次。 */
    gateResults: {},
    /** 交付物核对结果，按路径覆盖式保存。 */
    deliverableChecks: {},
    /** 题目身份与边界确认（第 1 章）。 */
    identity: null,
    /** 两条轨迹的运行时台账（有效时长、轮数）。 */
    runs: {},
    /** 被检物冻结清单：path → sha256。 */
    frozenManifest: {},
    /** 有意改动登记：旧值→新值→原因→证据。 */
    intentionalChanges: [],
  }
}

/** 解析任务根：相对路径以任务根为基准，绝对路径直接采用。 */
export function resolveTaskPath(taskRoot, candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new StateError('路径必须为非空字符串')
  }
  return isAbsolute(candidate) ? candidate : join(taskRoot, candidate)
}

/** 越界检查：交付物路径不得逃出任务根。 */
export function assertInsideTaskRoot(taskRoot, absolute) {
  const rel = relative(taskRoot, absolute)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new StateError(`路径越出任务根：${absolute}`, 400)
  }
  return rel.split('\\').join('/')
}

/** 读取状态；文件不存在时返回初始状态而不是报错。 */
export async function readState(taskRoot, taskId) {
  const file = join(taskRoot, STATE_FILE)
  try {
    const raw = await readFile(file, 'utf8')
    if (raw.length > MAX_STATE_BYTES) {
      throw new StateError(`状态文件超过 ${MAX_STATE_BYTES} 字节`, 413)
    }
    const parsed = JSON.parse(raw)
    if (parsed?.version !== STATE_VERSION) {
      throw new StateError(`状态文件版本 ${parsed?.version} 与当前 ${STATE_VERSION} 不匹配`, 409)
    }
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyState(taskId)
    throw error
  }
}

/** 原子写入：先写临时文件再 rename，避免半截状态被读到。 */
export async function writeState(taskRoot, state) {
  const file = join(taskRoot, STATE_FILE)
  await mkdir(dirname(file), { recursive: true })
  const next = { ...state, updatedAt: new Date().toISOString() }
  const serialized = JSON.stringify(next, null, 2)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
    throw new StateError(`状态超过 ${MAX_STATE_BYTES} 字节，拒绝写入`, 413)
  }
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, serialized, 'utf8')
  await rename(temporary, file)
  return next
}

/** 核对单个交付物是否真实存在（目录 / 文件 / 非空文件）。 */
export async function checkDeliverable(taskRoot, deliverable) {
  const absolute = resolveTaskPath(taskRoot, deliverable.path)
  let rel
  try {
    rel = assertInsideTaskRoot(taskRoot, absolute)
  } catch (error) {
    return { path: deliverable.path, kind: deliverable.kind, required: deliverable.required, status: 'OUT_OF_ROOT', detail: error.message, note: deliverable.note }
  }
  try {
    const info = await stat(absolute)
    if (deliverable.kind === 'dir') {
      return info.isDirectory()
        ? { path: rel, kind: deliverable.kind, required: deliverable.required, status: 'PRESENT', detail: '目录存在', note: deliverable.note }
        : { path: rel, kind: deliverable.kind, required: deliverable.required, status: 'WRONG_TYPE', detail: '期望目录但存在同名文件', note: deliverable.note }
    }
    if (!info.isFile()) {
      return { path: rel, kind: deliverable.kind, required: deliverable.required, status: 'WRONG_TYPE', detail: '期望文件但存在同名目录', note: deliverable.note }
    }
    if (info.size === 0) {
      return { path: rel, kind: deliverable.kind, required: deliverable.required, status: 'EMPTY', detail: '文件为 0 字节（空串即失败）', note: deliverable.note }
    }
    return { path: rel, kind: deliverable.kind, required: deliverable.required, status: 'PRESENT', detail: `${info.size} 字节`, note: deliverable.note }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { path: rel, kind: deliverable.kind, required: deliverable.required, status: 'MISSING', detail: '不存在', note: deliverable.note }
    }
    return { path: rel, kind: deliverable.kind, required: deliverable.required, status: 'ERROR', detail: String(error?.message ?? error), note: deliverable.note }
  }
}

/** 核对某阶段全部交付物。 */
export async function checkPhaseDeliverables(taskRoot, phaseId) {
  const phase = phaseById(phaseId)
  if (phase === undefined) throw new StateError(`未知阶段：${phaseId}`, 404)
  const results = []
  for (const deliverable of phase.deliverables) {
    results.push(await checkDeliverable(taskRoot, deliverable))
  }
  return results
}

/**
 * 推进阶段。硬规则（教程「五道不可跳级里程碑」）：
 * 当前阶段的门禁必须全部 RECOMMEND 才允许进入下一阶段。
 */
export function advanceState(state, targetPhaseId) {
  const current = phaseById(state.phase)
  const target = phaseById(targetPhaseId)
  if (current === undefined) throw new StateError(`当前阶段非法：${state.phase}`, 409)
  if (target === undefined) throw new StateError(`目标阶段非法：${targetPhaseId}`, 404)
  if (target.order === current.order) {
    return { state, changed: false, reason: `已处于阶段 ${target.id}` }
  }
  if (target.order < current.order) {
    throw new StateError('不允许回退阶段；如需返修请新建 run 并保留旧 receipt', 409)
  }
  if (target.order > current.order + 1) {
    throw new StateError(`不允许跳级：${current.id} → ${target.id}`, 409)
  }

  const blocking = (current.gates ?? [])
    .map((gateId) => ({ gateId, result: state.gateResults[gateId] }))
    .filter((entry) => entry.result?.verdict !== 'RECOMMEND')

  if (blocking.length > 0) {
    throw new StateError(
      `阶段 ${current.id} 的门禁未通过：${blocking.map((entry) => `${entry.gateId}=${entry.result?.verdict ?? 'NOT_RUN'}`).join(', ')}`,
      409,
    )
  }

  const historyEntry = {
    from: current.id,
    to: target.id,
    at: new Date().toISOString(),
    gates: (current.gates ?? []).map((gateId) => ({ gateId, verdict: state.gateResults[gateId]?.verdict ?? null })),
  }
  return {
    state: { ...state, phase: target.id, history: [...state.history, historyEntry] },
    changed: true,
    reason: `${current.id} → ${target.id}`,
  }
}

/** 记录门禁结论；只保留最近一次并追加到 history。 */
export function recordGateResult(state, result) {
  const at = new Date().toISOString()
  return {
    ...state,
    gateResults: {
      ...state.gateResults,
      [result.gate]: { verdict: result.verdict, at, milestone: result.milestone, checks: result.checks },
    },
    history: [...state.history, { kind: 'gate', gate: result.gate, verdict: result.verdict, at }],
  }
}

/** 汇总当前进度：阶段、门禁、交付物缺口。 */
export function summarize(state) {
  const phase = phaseById(state.phase)
  const gates = Object.entries(state.gateResults).map(([gate, value]) => ({
    gate, verdict: value.verdict, milestone: value.milestone, at: value.at,
  }))
  const failing = gates.filter((entry) => entry.verdict !== 'RECOMMEND')
  return {
    taskId: state.taskId,
    phase: state.phase,
    phaseTitle: phase?.title ?? null,
    phaseChapter: phase?.chapter ?? null,
    phaseOrder: phase?.order ?? null,
    gates,
    failingGates: failing,
    canAdvance: failing.length === 0 && phase?.gates?.length > 0,
    nextPhase: nextPhase(state.phase)?.id ?? null,
    historyLength: state.history.length,
    intentionalChangeCount: state.intentionalChanges.length,
  }
}
