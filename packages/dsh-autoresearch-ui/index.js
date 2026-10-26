/**
 * dsh-autoresearch-ui —— AutoResearch 工作台插件（宿主半边）。
 *
 * 两层视图：
 *   · 任务组合（/tasks）—— 跨任务的卡片数据：阶段、门禁健康度、缺失交付物、
 *     远端未完成任务、双轨轨迹、B/R/U 校准摘要。
 *   · 任务详情（/overview、/gate、…）—— 单任务的深入视图；全部接受
 *     `?task=<绝对路径>` 参数切换任务根，缺省仍指向进程配置根。
 *
 * 安全边界：本插件只读任务文件；会改世界的操作（投递实验、快照恢复、
 * 推进阶段、跑门禁）留在对话里由模型按 SOP 纪律调用工具。唯二的写动作是
 * 工作台任务清单的登记/移除（改的只是 DSH_HOME 下的清单文件）与远端任务
 * 重探测（幂等只读远端状态 + 更新本地账本缓存）。
 *
 * @module dsh-autoresearch-ui
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, dirname, relative, isAbsolute, resolve } from 'node:path'
import { PHASES, TASK_MODES, INTAKE_CHECKS, VARIANT_RULES } from 'dsh-autoresearch/lib/phases.js'
import { GATES, TRAJECTORY_FIELDS, R_LO, R_HI, SIGMA_MULT_REQUIRED } from 'dsh-autoresearch/lib/gates.js'
import { readState, checkPhaseDeliverables, summarize } from 'dsh-autoresearch/lib/state.js'
import {
  isTaskRoot, TASK_ROOT_MARKERS, readJsonDoc,
} from 'dsh-autoresearch/lib/session-tasks.js'
import { readLanesFile, writeLanesFile, resolveSavedLanes } from 'dsh-autoresearch-qa/lib/lanes.js'
import { readTaskMetricDirection } from 'dsh-autoresearch-gates/lib/tools.js'
import {
  summarizeRounds, calibrationConstantsOf, detectCalibrationScore, dualTrackStatus,
} from 'dsh-autoresearch/lib/trajectory.js'
import { probeJob, DEFAULT_POLICY } from 'dsh-autoresearch-remote/lib/session.js'
import { readLedger, writeLedger, recordProbe } from 'dsh-autoresearch-remote/lib/ledger.js'
import {
  listProviders, readDefaultModel, profilePatchPath, mergeProviders, setDefaultModel,
  removeProvider,
} from 'dsh-autoresearch-api/lib/profile-patch.js'
import {
  validateApiDeclaration, normalizeDeclaration, probeEndpoint,
  writeCredentialRefs, readCredentialRefs, SUPPORTED_PROTOCOLS,
} from 'dsh-autoresearch-api/lib/providers.js'
import {
  readBalance, listInstances, listImages, readSnapshot,
  GPU_SPECS, powerOn, powerOff,
} from 'dsh-autoresearch-autodl/lib/client.js'
import {
  readLeases, expiredLeases, estimateCost, reapExpiredLeases, reconcileLeases,
} from 'dsh-autoresearch-autodl/lib/automation.js'
import {
  leaseFilePath, normalizeAutodlConfig, resolveAutodlToken,
} from 'dsh-autoresearch-autodl/lib/config.js'
import {
  authStatus, listTables, listRecords, sendMessage,
} from 'dsh-autoresearch-lark/lib/cli.js'
import {
  provisionBase, syncTaskPackage, TABLE_SCHEMAS,
} from 'dsh-autoresearch-lark/lib/sync.js'
import { larkConfigPaths, normalizeLarkConfig } from 'dsh-autoresearch-lark/lib/config.js'

export const name = 'autoresearch-ui'

export const inject = ['connection']

/** 默认配置；见 dsh-autoresearch 中关于不导出 schemastery Config 的说明。 */
const DEFAULT_CONFIG = Object.freeze({
  /** 任务根目录；相对路径以进程工作目录为基准。 */
  taskRoot: '.',
  /** 单次列目录返回的最大条目数。 */
  maxListEntries: 400,
  /** 单次批量重探测的最大任务数（SSH 连接风暴防护）。 */
  maxProbeBatch: 8,
})

const API_PREFIX = '/api/autoresearch'

/**
 * 飞书三表解析：显式配置的表 id 优先，否则按表名在 Base 里查。
 *
 * 与 lark 包工具入口的 `loadTables` 同一规则 —— 两处实现如果漂移，
 * 会出现「工具同步成功、面板读不到」这种最难排查的错位。
 */
async function resolveLarkTables(config) {
  if (config.tables?.tasks?.id) return config.tables
  if (!config.baseToken) return null
  const listed = await listTables({ baseToken: config.baseToken }, { timeoutMs: config.timeoutMs })
  const find = (name) => listed.tables.find((t) => t.name === name)?.id ?? null
  return {
    tasks: { id: find('任务') },
    gates: { id: find('门禁') },
    trajectories: { id: find('轨迹') },
  }
}

/** 从题包根读出三表行（与 lark 包工具入口同一读取口径）。 */
async function buildLarkRows(taskRoot) {
  const rows = { task: null, gates: [], trajectories: [] }
  if (typeof taskRoot !== 'string' || taskRoot === '') return rows
  const readJson = async (p) => {
    try { return JSON.parse(await readFile(p, 'utf8')) } catch { return undefined }
  }
  const state = await readJson(join(taskRoot, 'autoresearch-state.json'))
  const taskId = state?.taskId ?? taskRoot.split(/[\\/]/).pop()
  if (state) {
    const blocking = (state.checks ?? []).filter((c) => c.status === 'FAIL').map((c) => c.id)
    rows.task = {
      任务ID: taskId,
      任务名: state.taskName ?? null,
      阶段: state.phase ?? null,
      状态: blocking.length > 0 ? '阻塞' : (state.phase === 'done' ? '已完成' : '进行中'),
      阻塞门禁: blocking.join(',') || null,
      指标名: state.metric?.name ?? null,
      方向: state.metric?.direction ?? null,
      '算力成本(元)': state.autodl?.costYuan ?? null,
      备注: state.note ?? null,
    }
    for (const check of state.checks ?? []) {
      rows.gates.push({
        任务ID: taskId,
        门禁: check.id,
        结论: check.status === 'FAIL' ? 'REJECT' : (check.status === 'UNKNOWN' ? 'NEEDS_EVIDENCE' : 'RECOMMEND'),
        首条问题: check.detail ?? null,
      })
    }
  }
  const runSummary = await readJson(join(taskRoot, 'expert_evidence', 'run_summary.json'))
  for (const track of runSummary?.agent_execution ?? []) {
    rows.trajectories.push({
      任务ID: taskId,
      轨道: track.track === 'trajectory_seed' ? 'seed' : 'codex',
      轮数: track.trajectory_rounds ?? track.effective_rounds ?? null,
      出分轮数: track.scored_rounds ?? null,
      失败轮数: track.failed_rounds ?? null,
      最佳分: track.best_score ?? null,
      '有效时长(h)': track.duration_hours ?? null,
      状态: track.threshold_pass === true ? '达标' : '未达标',
    })
  }
  return rows
}

/** 视图允许浏览的目录白名单（相对任务根）。 */
const VIEWABLE_ROOTS = [
  'workspace/harbor_task',
  'workspace/reference',
  'expert_evidence',
  'optimization_evidence',
]

const TEXT_EXTENSIONS = new Set([
  '.md', '.json', '.jsonl', '.toml', '.yml', '.yaml', '.txt', '.sh', '.py', '.js', '.mjs', '.ts', '.cfg', '.ini', '.log',
])

const MAX_TEXT_BYTES = 512 * 1024

function jsonResponse(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status)
}

/** 解析默认任务根。 */
function makeRootResolver(config) {
  return () => {
    const raw = config.taskRoot
    if (raw === '.' || raw === '' || raw === undefined) return process.cwd()
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
  }
}

/** DSH_HOME：与桌面壳、安装脚本、引擎绑定文件同一规则。 */
function dshHomeOf() {
  const fromEnvironment = process.env.DSH_HOME
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') {
    return isAbsolute(fromEnvironment) ? fromEnvironment : resolve(process.cwd(), fromEnvironment)
  }
  return join(process.cwd(), '.dsh-home')
}

// ── 工作台任务清单 ──────────────────────────────────────────────────────────

const registryPath = () => join(dshHomeOf(), 'autoresearch-workbench.json')

async function readRegistry(defaultRoot) {
  // 损坏时隔离并抛错（由路由转成显式 JSON 错误），不从默认根重来 ——
  // 本函数的结果会被 writeRegistry 整体写回，静默重来等于把用户登记过的
  // 任务列表全抹掉。与会话绑定共用同一份 readJsonDoc。
  const parsed = await readJsonDoc(registryPath(), {
    isValid: (value) => value !== null && typeof value === 'object' && Array.isArray(value.taskRoots),
  })
  const roots = [...new Set((parsed?.taskRoots ?? [])
    .filter((item) => typeof item === 'string' && item !== ''))]
  if (defaultRoot !== undefined && !roots.includes(defaultRoot)) roots.unshift(defaultRoot)
  return roots
}

/**
 * 读登记表，把损坏转成显式 JSON 错误。
 *
 * 不能让异常逃逸：webserver 会把路由抛出的异常一律吞成 400 空响应，
 * 错误信息连同原因一起消失（用户只看到「请求失败」）。
 *
 * @returns { roots } 或 { error } —— 调用点必须先检查 error。
 */
async function readRegistryOrError(defaultRoot) {
  try {
    return { roots: await readRegistry(defaultRoot) }
  } catch (error) {
    return { error: errorResponse(error.message, 500) }
  }
}

/** 原子写（临时文件 + 改名）：避免写一半被读到，留下半个 JSON。 */
async function writeRegistry(roots) {
  const { writeFile, rename } = await import('node:fs/promises')
  const path = registryPath()
  const temporary = `${path}.tmp`
  const payload = JSON.stringify({ version: 1, taskRoots: roots }, null, 2)
  await writeFile(temporary, `${payload}\n`, 'utf8')
  await rename(temporary, path)
}

/**
 * 把请求里的 ?task= 解析成已验证的任务根；无参数时用默认根。
 * 参数无效时返回 null —— 调用点必须显式回 JSON 错误：webserver 会把路由
 * 抛出的异常一律吞成 400 空响应，抛错等于让错误信息消失。
 */
async function resolveTaskRoot(request, defaultRoot) {
  const requested = new URL(request.url).searchParams.get('task')
  if (requested === null || requested.trim() === '') return defaultRoot
  const candidate = isAbsolute(requested) ? resolve(requested) : resolve(process.cwd(), requested)
  return (await isTaskRoot(candidate)) ? candidate : null
}

/** 调用点共用的失败响应。 */
const taskRootErrorResponse = () => errorResponse(
  `task 参数不是任务根（目录需含 ${TASK_ROOT_MARKERS.join(' 或 ')}）`, 400)

// ── 任务卡片数据 ────────────────────────────────────────────────────────────

async function readJsonSafe(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 主指标方向 —— 决定「最佳分」取最大还是最小。
 *
 * 委托给 gates 包的 `readTaskMetricDirection`（唯一真源）：这条读取路径
 * 有过两次字段形状错误，都记录在那里 ——
 *   · 早期读 UI 假设的 `score_contract.direction`，而真实标注用
 *     `metric_direction`；夹具与真实文件形状不同，于是**测试全绿而面板空白**。
 *   · 修好后又读 `comparison.metric.direction`，但真实文件是
 *     `comparison.metric`（字符串）+ `comparison.direction`（顶层），
 *     于是 AutoRe1841 的方向仍读成 null，minimize 题的最佳分照样取错。
 * 两次都是「本地另写一份解析」，所以这里不再自己解析。
 */
export async function metricDirectionOf(taskRoot) {
  const found = await readTaskMetricDirection(taskRoot)
  return found?.direction ?? null
}

/**
 * 双轨轨迹的「最新分 / 最佳分 / 最近分数序列」+ 双轨是否真的开跑。
 *
 * 计数与最佳分走 `lib/trajectory.js`（唯一真源）—— 那里说明了为什么要区分
 * 「未出分」与「失败」，以及为什么最佳分必须按指标方向取。
 */
export async function trajectoryDigest(taskRoot) {
  const direction = await metricDirectionOf(taskRoot)
  const digest = {}
  for (const track of ['codex', 'seed']) {
    const document = await readJsonSafe(join(taskRoot, 'expert_evidence', `trajectory_${track}.json`))
    const rounds = Array.isArray(document?.rounds) ? document.rounds : []
    const summary = summarizeRounds(rounds, direction)
    digest[track] = {
      rounds: summary.total,
      scored: summary.scored,
      noScore: summary.noScore,
      failed: summary.failed,
      latest: summary.latestScore,
      best: summary.bestScore,
      direction,
      recent: rounds.slice(-24).map((round) => (typeof round.score === 'number' ? round.score : null)),
    }
  }
  return digest
}

/** 双轨是否真的开跑（`run_summary.json` 的时长证据）—— 任务卡与详情页共用。 */
export async function dualTrackOf(taskRoot) {
  return dualTrackStatus(
    await readJsonSafe(join(taskRoot, 'expert_evidence', 'run_summary.json')))
}

/**
 * B/R/U 校准摘要。
 *
 * 必须同时认**两种真实存在的写法**：
 *   · 嵌套式：`expert_annotation.score_contract.{metric,direction,baseline.raw_value,...}`
 *     + `comparison_summary.statistics.{baseline_mean,...}`（脚手架与本项目自产）
 *   · 扁平式：`expert_annotation.metric_name / metric_direction / anchors.{B_mean,U}`
 *     + `comparison_summary.{U,B_mean,R_mean,sigma_B,Delta}`（专家手写标注，实测 AutoRe0566）
 * 早期只认前者，于是专家手写的真实标注在工作台上**整块显示为空** —— 数据都在，
 * 只是字段名对不上。
 */
export async function calibrationDigest(taskRoot) {
  const annotation = await readJsonSafe(join(taskRoot, 'expert_evidence', 'expert_annotation.json'))
  const comparison = await readJsonSafe(join(taskRoot, 'optimization_evidence', 'comparison_summary.json'))
  const contract = annotation?.score_contract ?? null
  const stats = comparison?.statistics ?? null
  const anchors = annotation?.anchors ?? null
  const first = (...values) => values.find((value) => value !== undefined && value !== null) ?? null
  return {
    metric: first(contract?.metric, annotation?.metric_name, comparison?.metric?.name),
    direction: first(contract?.direction, annotation?.metric_direction, comparison?.metric?.direction),
    baseline: first(contract?.baseline?.raw_value, stats?.baseline_mean, anchors?.B_mean, comparison?.B_mean),
    reference: first(contract?.reference?.raw_value, stats?.reference_mean, comparison?.R_mean),
    upper: first(contract?.upper_bound?.raw_value, anchors?.U, comparison?.U),
    // 统计量：嵌套式在 statistics 下，扁平式直接在顶层。
    pairedRuns: first(stats?.paired_run_count, comparison?.n_baseline_expected),
    sigmaMultiple: first(stats?.baseline_sigma_multiple, comparison?.sigma_B),
    // 如实暴露「还没跑」：anchors.calibration_status 与 status 都是真实状态标记。
    calibrationStatus: first(anchors?.calibration_status, comparison?.status),
  }
}

/** 远端账本摘要（本任务的）。 */
async function remoteDigest(taskRoot) {
  const book = await readJsonSafe(join(taskRoot, '.autoresearch-remote', 'ledger.json'))
  if (book === null) return { registered: false, targets: 0, jobs: 0, unfinished: [] }
  const jobs = Object.entries(book.jobs ?? {})
  return {
    registered: true,
    targets: Object.keys(book.targets ?? {}).length,
    jobs: jobs.length,
    unfinished: jobs
      .filter(([, job]) => !['complete', 'failed'].includes(job.lastProbe?.phase ?? 'never-probed'))
      .map(([jobId, job]) => ({ jobId, kind: job.kind ?? 'generic', phase: job.lastProbe?.phase ?? 'never-probed' })),
  }
}

/** 组装一张任务卡片。任何一段读不出来都如实降级，不让整张卡失败。 */
async function buildTaskCard(taskRoot) {
  const card = { path: taskRoot, name: taskRoot.split(/[\\/]/).filter(Boolean).pop() ?? taskRoot }
  // 不是任务根就如实标记：readState 对缺失文件返回空态，不加这个标记会把
  // 「目录还没初始化」伪装成「阶段 1 刚起步」。
  if (!(await isTaskRoot(taskRoot))) {
    card.notTaskRoot = true
    card.error = `该目录缺少 ${TASK_ROOT_MARKERS.join(' 或 ')}，不是任务根（可能是进程默认根，尚未运行 autoresearch_init）。`
    return card
  }
  try {
    const state = await readState(taskRoot)
    const missing = []
    try {
      const results = await checkPhaseDeliverables(taskRoot, state.phase)
      for (const item of results) {
        if (item.required && item.status !== 'PRESENT') missing.push(item.path)
      }
    } catch { /* 核对失败如实留空 */ }
    const gates = Object.entries(state.gateResults).map(([gate, value]) => ({ gate, verdict: value.verdict }))
    const phase = PHASES.find((entry) => entry.id === state.phase) ?? null
    const blockingGates = (phase?.gates ?? [])
      .map((gateId) => ({ gate: gateId, verdict: state.gateResults[gateId]?.verdict ?? null }))
      .filter((entry) => entry.verdict !== 'RECOMMEND')

    let stateModified = null
    try {
      stateModified = (await stat(join(taskRoot, 'autoresearch-state.json'))).mtime.toISOString()
    } catch { /* 状态文件可能尚未生成 */ }

    card.identity = state.identity ?? null
    card.phase = { id: state.phase, title: phase?.title ?? null, order: phase?.order ?? null }
    card.gates = { total: phase?.gates?.length ?? 0, recommend: (phase?.gates ?? []).length - blockingGates.length, blocking: blockingGates }
    card.missingRequiredCount = missing.length
    card.remote = await remoteDigest(taskRoot)
    card.trajectory = await trajectoryDigest(taskRoot)
    card.dualTrack = await dualTrackOf(taskRoot)
    card.calibration = await calibrationDigest(taskRoot)
    card.dualQaVerdict = (await readJsonSafe(join(taskRoot, 'expert_evidence', 'dual-qa', 'run-manifest.json')))?.verdict ?? null
    card.stateModified = stateModified
  } catch (error) {
    card.error = error instanceof Error ? error.message : String(error)
  }
  return card
}

/**
 * 把请求路径解析为任务根内的真实路径。
 * 拒绝任何越出白名单根目录或任务根的路径 —— 视图只读且不越界。
 */
function resolveViewPath(taskRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw Object.assign(new Error('缺少 path 参数'), { status: 400 })
  }
  const normalized = relativePath.split('\\').join('/').replace(/^\/+/, '')
  const insideAllowed = VIEWABLE_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))
  if (!insideAllowed) {
    throw Object.assign(new Error(`路径不在可浏览范围内：${normalized}`), { status: 403 })
  }
  const absolute = resolve(taskRoot, normalized)
  const rel = relative(taskRoot, absolute).split('\\').join('/')
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw Object.assign(new Error('路径越出任务根'), { status: 403 })
  }
  return { absolute, relative: rel }
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const resolveRoot = makeRootResolver(config)

  // ── 路由：任务组合（工作台首页数据） ───────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/tasks`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const defaultRoot = resolveRoot()

      if (request.method === 'POST') {
        let body
        try {
          body = await request.json()
        } catch {
          return errorResponse('请求体不是合法 JSON', 400)
        }
        const registry = await readRegistryOrError(defaultRoot)
        if (registry.error !== undefined) return registry.error
        const roots = registry.roots
        const action = body?.action
        if (action === 'add') {
          const candidate = typeof body.path === 'string' && isAbsolute(body.path)
            ? resolve(body.path)
            : (typeof body.path === 'string' ? resolve(process.cwd(), body.path) : null)
          if (candidate === null) return errorResponse('缺少 path 参数', 400)
          if (!(await isTaskRoot(candidate))) {
            return errorResponse(`"${candidate}" 不是任务根（缺少 ${TASK_ROOT_MARKERS.join(' 或 ')}）`, 400)
          }
          if (!roots.includes(candidate)) roots.push(candidate)
          await writeRegistry([...new Set(roots)])
          return jsonResponse({ added: candidate, taskRoots: roots })
        }
        if (action === 'remove') {
          const candidate = typeof body.path === 'string' ? resolve(body.path) : null
          if (candidate === null) return errorResponse('缺少 path 参数', 400)
          const next = roots.filter((root) => root !== candidate)
          await writeRegistry(next)
          return jsonResponse({ removed: candidate, taskRoots: next })
        }
        return errorResponse(`未知 action：${String(action)}`, 400)
      }

      // GET：?scan=<目录> 时只列候选不读详情；否则返回全部注册任务的卡片。
      const parameters = new URL(request.url).searchParams
      const scanDir = parameters.get('scan')
      if (scanDir !== null && scanDir.trim() !== '') {
        const absolute = isAbsolute(scanDir) ? resolve(scanDir) : resolve(process.cwd(), scanDir)
        let entries
        try {
          entries = await readdir(absolute, { withFileTypes: true })
        } catch (error) {
          return errorResponse(`无法读取目录：${error.message}`, 400)
        }
        const candidates = []
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const child = join(absolute, entry.name)
          if (await isTaskRoot(child)) candidates.push(child)
        }
        return jsonResponse({ scanRoot: absolute, candidates: candidates.sort() })
      }

      const registry = await readRegistryOrError(defaultRoot)
      if (registry.error !== undefined) return registry.error
      const roots = registry.roots
      const cards = []
      for (const root of roots) cards.push(await buildTaskCard(root))
      return jsonResponse({
        defaultTaskRoot: defaultRoot,
        registryPath: registryPath(),
        cards,
      })
    },
  }), 'autoresearch-ui: tasks route')

  // ── 路由：总览 ────────────────────────────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/overview`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const taskRoot = await resolveTaskRoot(request, resolveRoot())
      if (taskRoot === null) return taskRootErrorResponse()
      const state = await readState(taskRoot)

      const phases = []
      for (const phase of PHASES) {
        const deliverables = await checkPhaseDeliverables(taskRoot, phase.id)
        const missingRequired = deliverables.filter((item) => item.required && item.status !== 'PRESENT')
        phases.push({
          id: phase.id,
          order: phase.order,
          chapter: phase.chapter,
          title: phase.title,
          goal: phase.goal,
          gates: phase.gates.map((gateId) => ({
            gate: gateId,
            title: GATES[gateId]?.title ?? gateId,
            milestone: GATES[gateId]?.milestone ?? null,
            verdict: state.gateResults[gateId]?.verdict ?? null,
            at: state.gateResults[gateId]?.at ?? null,
          })),
          deliverables,
          exitCriteria: phase.exitCriteria,
          presentCount: deliverables.filter((item) => item.status === 'PRESENT').length,
          totalCount: deliverables.length,
          missingRequired: missingRequired.map((item) => ({ path: item.path, status: item.status, note: item.note })),
          status: state.phase === phase.id
            ? 'current'
            : (state.history.some((entry) => entry.to === phase.id) ? 'passed' : 'pending'),
        })
      }

      return jsonResponse({
        taskRoot,
        summary: summarize(state),
        identity: state.identity,
        phases,
        gateCatalog: Object.entries(GATES).map(([gate, meta]) => ({
          gate, title: meta.title, milestone: meta.milestone, blocking: meta.blocking,
        })),
        calibration: {
          referenceRange: [R_LO, R_HI],
          requiredSigmaMultiple: SIGMA_MULT_REQUIRED,
          trajectoryFields: TRAJECTORY_FIELDS,
        },
        modes: Object.values(TASK_MODES).map((mode) => ({ id: mode.id, name: mode.name, input: mode.input })),
        intakeChecks: INTAKE_CHECKS,
        variantRules: VARIANT_RULES,
        deprecatedPaths: (await import('dsh-autoresearch/lib/phases.js')).DEPRECATED_PATHS,
      })
    },
  }), 'autoresearch-ui: overview route')

  // ── 路由：门禁详情 ────────────────────────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/gate`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const parameters = new URL(request.url).searchParams
      const gate = parameters.get('gate')
      if (gate === null || gate === '') return errorResponse('缺少 gate 参数', 400)
      const taskRoot = await resolveTaskRoot(request, resolveRoot())
      if (taskRoot === null) return taskRootErrorResponse()
      const state = await readState(taskRoot)
      const recorded = state.gateResults[gate]
      if (recorded === undefined) {
        return jsonResponse({ gate, verdict: null, checks: [], note: '该门禁尚未运行' })
      }
      return jsonResponse({
        gate,
        title: GATES[gate]?.title ?? gate,
        milestone: recorded.milestone ?? GATES[gate]?.milestone ?? null,
        verdict: recorded.verdict,
        at: recorded.at,
        checks: recorded.checks ?? [],
      })
    },
  }), 'autoresearch-ui: gate route')

  // ── 路由：证据浏览 ────────────────────────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/browse`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const parameters = new URL(request.url).searchParams
      const taskRoot = await resolveTaskRoot(request, resolveRoot())
      if (taskRoot === null) return taskRootErrorResponse()
      const requestedPath = parameters.get('path') ?? ''
      let target
      try {
        target = requestedPath === ''
          ? { absolute: taskRoot, relative: '' }
          : resolveViewPath(taskRoot, requestedPath)
      } catch (error) {
        return errorResponse(error.message, error.status ?? 400)
      }

      let info
      try {
        info = await stat(target.absolute)
      } catch {
        return errorResponse(`路径不存在：${target.relative}`, 404)
      }

      if (info.isDirectory()) {
        let entries
        try {
          entries = await readdir(target.absolute, { withFileTypes: true })
        } catch (error) {
          return errorResponse(`无法读取目录：${error.message}`, 500)
        }
        const items = []
        for (const entry of entries.slice(0, config.maxListEntries)) {
          if (entry.name === '__pycache__' || entry.name === '.git') continue
          const childRelative = target.relative === '' ? entry.name : `${target.relative}/${entry.name}`
          let size = null
          let modified = null
          try {
            const childInfo = await stat(join(target.absolute, entry.name))
            size = childInfo.size
            modified = childInfo.mtime.toISOString()
          } catch { /* 无法读取时保留 null，不猜测 */ }
          items.push({
            name: entry.name,
            path: childRelative,
            kind: entry.isDirectory() ? 'dir' : 'file',
            size,
            modified,
            viewable: entry.isDirectory()
              || TEXT_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.'))),
          })
        }
        items.sort((left, right) => (left.kind === right.kind
          ? left.name.localeCompare(right.name)
          : (left.kind === 'dir' ? -1 : 1)))
        return jsonResponse({
          path: target.relative,
          kind: 'dir',
          entries: items,
          truncated: entries.length > config.maxListEntries,
          roots: VIEWABLE_ROOTS,
        })
      }

      if (info.size > MAX_TEXT_BYTES) {
        return jsonResponse({
          path: target.relative,
          kind: 'file',
          size: info.size,
          tooLarge: true,
          note: `文件 ${info.size} 字节，超过视图上限 ${MAX_TEXT_BYTES}；请在本地打开。`,
        })
      }
      const extension = target.relative.slice(target.relative.lastIndexOf('.'))
      if (!TEXT_EXTENSIONS.has(extension)) {
        return jsonResponse({
          path: target.relative,
          kind: 'file',
          size: info.size,
          binary: true,
          note: `非文本扩展名 ${extension}，视图不渲染。`,
        })
      }
      const content = await readFile(target.absolute, 'utf8')
      return jsonResponse({
        path: target.relative,
        kind: 'file',
        size: info.size,
        modified: info.mtime.toISOString(),
        content,
      })
    },
  }), 'autoresearch-ui: browse route')

  // ── 路由：轨迹 ────────────────────────────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/trajectory`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const parameters = new URL(request.url).searchParams
      const track = parameters.get('track') ?? 'codex'
      if (track !== 'codex' && track !== 'seed') return errorResponse('track 只能是 codex 或 seed', 400)
      const taskRoot = await resolveTaskRoot(request, resolveRoot())
      if (taskRoot === null) return taskRootErrorResponse()
      const file = join(taskRoot, 'expert_evidence', `trajectory_${track}.json`)
      let document
      try {
        document = JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return jsonResponse({
            track,
            fields: TRAJECTORY_FIELDS,
            rounds: [],
            stats: null,
            calibrationFlags: {},
            dualTrack: dualTrackStatus(
              await readJsonSafe(join(taskRoot, 'expert_evidence', 'run_summary.json'))),
            note: '轨迹文件尚未创建',
          })
        }
        return errorResponse(`轨迹文件不是合法 JSON：${error.message}`, 500)
      }
      const rounds = Array.isArray(document.rounds) ? document.rounds : []

      // ── 判据统一走 lib/trajectory.js（唯一真源）──────────────────────────
      //
      // 这里此前有三处各写一遍、各错各的：
      //   · bestScore 用 Math.max，不看指标方向 —— minimize 题会把最差一轮报成最佳；
      //   · failed 用 `status !== 'ok'`，把 blocked_no_compute / *_no_run 这类
      //     **诚实标注**的状态一律染成「失败」，实测 AutoRe1852 显示 13/13 全失败；
      //   · 没有区分「标定常数」与「本轮得分」，于是把 reference_normalized
      //     填进 score 的轮次看起来像"已有最佳分"。
      const direction = await metricDirectionOf(taskRoot)
      const summary = summarizeRounds(rounds, direction)

      // 标定常数：识别 score 里其实是 R 归一化值的轮次（只陈述事实，不改数）。
      const constants = calibrationConstantsOf({
        anchors: await readJsonSafe(join(taskRoot, 'workspace', 'harbor_task', 'tests', 'hidden_assets', 'anchors.json')),
        comparison: await readJsonSafe(join(taskRoot, 'optimization_evidence', 'comparison_summary.json')),
        annotation: await readJsonSafe(join(taskRoot, 'expert_evidence', 'expert_annotation.json')),
      })
      const calibrationFlags = {}
      for (const round of rounds) {
        const hit = detectCalibrationScore(round?.score, constants)
        if (hit !== null) calibrationFlags[round.round] = hit.label
      }
      // 所有「出分」轮次其实都是标定常数 ⇒ 该轨**从未产出真实得分**。
      // 必须显式标出：否则「最佳分 0.793603」会被读成"这轨跑出成绩了"。
      // 实测 AutoRe1841 的 3 个出分轮次全是同一个 reference_normalized。
      const scoredRounds = rounds.filter((round) => Number.isFinite(round?.score))
      const calibrationOnly = scoredRounds.length > 0
        && scoredRounds.every((round) => calibrationFlags[round.round] !== undefined)

      // 双轨是否真的开跑 —— 轨迹文件存在 ≠ 双轨跑过（出题过程也会记轮次）。
      const dualTrack = dualTrackStatus(
        await readJsonSafe(join(taskRoot, 'expert_evidence', 'run_summary.json')))

      return jsonResponse({
        track,
        fields: TRAJECTORY_FIELDS,
        rounds,
        stats: {
          total: summary.total,
          scored: summary.scored,
          // 保留 failed 字段名（前端已用），但语义改为「明确失败」；
          // 诚实状态归入 noScore，并把原始 status 分布原样透出。
          failed: summary.failed,
          noScore: summary.noScore,
          bestCount: summary.bestCount,
          latestScore: summary.latestScore,
          bestScore: summary.bestScore,
          direction: summary.direction,
          statusKinds: summary.statusKinds,
        },
        calibrationFlags,
        calibrationOnly,
        dualTrack,
      })
    },
  }), 'autoresearch-ui: trajectory route')

  // ── 路由：双路质检结果 ────────────────────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/dual-qa`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const taskRoot = await resolveTaskRoot(request, resolveRoot())
      if (taskRoot === null) return taskRootErrorResponse()
      const workRoot = join(taskRoot, 'expert_evidence', 'dual-qa')
      const manifestPath = join(workRoot, 'run-manifest.json')
      let manifest
      try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return jsonResponse({
            ran: false,
            workRoot,
            note: '尚未运行双路质检。用 autoresearch_qa_dual 启动。',
          })
        }
        return errorResponse(`运行清单不是合法 JSON：${error.message}`, 500)
      }

      const consensusPath = join(workRoot, 'qa-consensus.json')
      let consensus = null
      try {
        consensus = JSON.parse(await readFile(consensusPath, 'utf8'))
      } catch { /* 聚合结果可能尚未产出，保持 null 而不是伪造 */ }

      // 逐路读回报告结论，便于界面直接显示而不必再点进文件。
      const lanes = []
      for (const lane of manifest.lanes ?? []) {
        let decision = null
        let sourceSha = null
        let cleanContext = null
        if (typeof lane.reportPath === 'string') {
          try {
            const report = JSON.parse(await readFile(lane.reportPath, 'utf8'))
            decision = report.summary?.decision ?? null
            sourceSha = report.source?.sha256 ?? null
            cleanContext = report.qa_run?.clean_context ?? null
          } catch { /* 报告不可读时保持 null */ }
        }
        lanes.push({ ...lane, decision, sourceSha, cleanContext })
      }

      const problems = []
      if (consensus === null) problems.push('未产出聚合结果')
      else {
        if (consensus.status !== 'PASS') problems.push(`聚合结论为 ${consensus.status}`)
        for (const error of consensus.validation_errors ?? []) problems.push(error)
        for (const item of consensus.unresolved_disagreements ?? []) {
          problems.push(`未解决分歧：${item.check}（${item.report_1} vs ${item.report_2}）`)
        }
      }

      return jsonResponse({
        ran: true,
        workRoot,
        ranAt: manifest.ranAt ?? null,
        artifactSha256: manifest.artifactSha256 ?? null,
        skill: manifest.skill ?? null,
        verdict: manifest.verdict ?? null,
        lanes,
        consensus,
        problems,
        releaseGateSatisfied: manifest.verdict === 'PASS' && problems.length === 0,
      })
    },
  }), 'autoresearch-ui: dual-qa route')

  // ── 路由：远端执行与持久化 ────────────────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/remote`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const parameters = new URL(request.url).searchParams

      // ?all=1：跨任务聚合 —— 每个注册任务各自的账本与快照。
      if (parameters.get('all') === '1') {
        const defaultRoot = resolveRoot()
        const registry = await readRegistryOrError(defaultRoot)
        if (registry.error !== undefined) return registry.error
        const roots = registry.roots
        const tasks = []
        for (const root of roots) {
          const book = await readJsonSafe(join(root, '.autoresearch-remote', 'ledger.json'))
          if (book === null) continue
          tasks.push({
            taskRoot: root,
            name: root.split(/[\\/]/).filter(Boolean).pop(),
            targets: Object.entries(book.targets ?? {}).map(([id, target]) => ({
              id, host: target.host, user: target.user, port: target.port, remoteRoot: target.remoteRoot, label: target.label,
            })),
            jobs: Object.entries(book.jobs ?? {}).map(([jobId, job]) => ({
              jobId,
              targetId: job.targetId,
              kind: job.kind ?? 'generic',
              submittedAt: job.submittedAt,
              phase: job.lastProbe?.phase ?? 'never-probed',
              lastProbeAt: job.lastProbe?.at ?? null,
              logTail: job.lastProbe?.logTail ?? null,
            })),
          })
        }
        return jsonResponse({ aggregated: true, tasks, note: '聚合视图显示的是各任务上次探测的缓存结果；探测以任务详情页为准。' })
      }

      const taskRoot = await resolveTaskRoot(request, resolveRoot())
      if (taskRoot === null) return taskRootErrorResponse()
      const file = join(taskRoot, '.autoresearch-remote', 'ledger.json')
      let book
      try {
        book = JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') {
          return jsonResponse({
            registered: false,
            note: '尚未登记远端目标。用 autoresearch_remote_target 添加，再用 autoresearch_remote_submit 投递任务。',
          })
        }
        return errorResponse(`账本不是合法 JSON：${error.message}`, 500)
      }

      // 快照目录实况：账本记录之外再核对文件是否真在本地。
      const snapshotDir = join(taskRoot, 'expert_evidence', 'remote-snapshots')
      const snapshots = []
      try {
        const entries = await readdir(snapshotDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.tar.gz')) continue
          const info = await stat(join(snapshotDir, entry.name))
          snapshots.push({ name: entry.name, bytes: info.size, modified: info.mtime.toISOString() })
        }
      } catch { /* 目录不存在时如实留空 */ }

      const jobs = Object.entries(book.jobs ?? {}).map(([jobId, job]) => ({
        jobId,
        targetId: job.targetId,
        kind: job.kind ?? 'generic',
        workDir: job.workDir,
        submittedAt: job.submittedAt,
        phase: job.lastProbe?.phase ?? 'never-probed',
        lastProbeAt: job.lastProbe?.at ?? null,
        logTail: job.lastProbe?.logTail ?? null,
        scriptSha256: job.scriptSha256 ?? null,
      }))

      const unfinished = jobs.filter((job) => !['complete', 'failed'].includes(job.phase))
      return jsonResponse({
        registered: true,
        taskRoot,
        ledgerUpdatedAt: book.updatedAt ?? null,
        targets: Object.entries(book.targets ?? {}).map(([id, target]) => ({
          id,
          host: target.host,
          user: target.user,
          port: target.port,
          remoteRoot: target.remoteRoot,
          label: target.label,
        })),
        jobs,
        unfinished,
        snapshots,
        restoreEvidenceReady: snapshots.length > 0,
        note: '账本是缓存不是真相：任务状态以远端文件为准，界面显示的是上次探测结果。',
      })
    },
  }), 'autoresearch-ui: remote route')

  // ── 路由：远端任务重探测（幂等动作） ──────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/remote/probe`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      let body
      try {
        body = await request.json()
      } catch {
        return errorResponse('请求体不是合法 JSON', 400)
      }
      const taskRoot = typeof body?.task === 'string' && body.task.trim() !== ''
        ? (isAbsolute(body.task) ? resolve(body.task) : resolve(process.cwd(), body.task))
        : resolveRoot()
      if (!(await isTaskRoot(taskRoot))) {
        return errorResponse(`"${taskRoot}" 不是任务根`, 400)
      }

      const ledger = await readLedger(taskRoot)
      const jobEntries = Object.entries(ledger.jobs ?? {})
      if (jobEntries.length === 0) {
        return jsonResponse({ probed: [], note: '本任务没有投递过远端任务。' })
      }

      const wanted = body?.all === true
        ? jobEntries.filter(([, job]) => !['complete', 'failed'].includes(job.lastProbe?.phase ?? 'never-probed')).map(([id]) => id)
        : (Array.isArray(body?.jobs) ? body.jobs : [])
      const selected = wanted
        .filter((jobId) => ledger.jobs[jobId] !== undefined)
        .slice(0, config.maxProbeBatch)

      const probed = []
      for (const jobId of selected) {
        const job = ledger.jobs[jobId]
        const target = ledger.targets[job.targetId]
        if (target === undefined) {
          probed.push({ jobId, phase: 'unknown', error: `目标 ${job.targetId} 未登记`, retryable: false })
          continue
        }
        try {
          const probe = await probeJob(target, target.remoteRoot ?? '.autoresearch-remote', jobId, { policy: DEFAULT_POLICY })
          if (probe.reachable) {
            await writeLedger(taskRoot, recordProbe(ledger, jobId, probe))
            probed.push({ jobId, phase: probe.phase, state: probe.state, logTail: probe.logTail ?? null })
          } else {
            probed.push({ jobId, phase: 'unknown', error: probe.error ?? '连接失败', retryable: probe.retryable === true })
          }
        } catch (error) {
          probed.push({ jobId, phase: 'unknown', error: error instanceof Error ? error.message : String(error), retryable: true })
        }
      }

      return jsonResponse({
        probed,
        truncated: wanted.length > selected.length,
        note: '探测逐台 SSH 串行执行；连接失败返回 unknown 而不猜测状态。',
      })
    },
  }), 'autoresearch-ui: remote probe route')

  // ── 路由：自定义 API 配置 ────────────────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/api`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      // 读 profile 用户层：与内置设置页同一份，因此界面显示的正是实际生效的配置。
      // 写入只动 DSH_HOME 下的 profile patch 与凭据文档，不触碰任务目录。
      const home = dshHomeOf()
      const profiles = ['autoresearch', 'headless']
      const patchPaths = profiles.map((profile) => profilePatchPath(home, profile))

      if (request.method === 'POST') {
        let body
        try {
          body = await request.json()
        } catch {
          return errorResponse('请求体不是合法 JSON', 400)
        }
        const action = body?.action

        // 登记路由：校验 → 探测 → 写凭据 → 写 profile（autoresearch + headless，
        // 双路质检的 lane 用 headless）。写序与 autoresearch_api_add 相同：
        // 先凭据后 profile，不留「配了路由但没有密钥」的中间态。
        if (action === 'add') {
          const problems = validateApiDeclaration(body)
          if (problems.length > 0) return errorResponse(problems.join('；'), 400)
          const normalized = normalizeDeclaration(body)

          // 合并语义：未提供字段保留现有（见 mergeProviders 注释）。探测与
          // 密钥回显都要按「生效后的」配置来 —— 编辑已有路由时调用方可能
          // 不带 baseURL/keyEnv，此时沿用该路由现值，而不是报缺字段。
          const existingProviders = await listProviders(patchPaths[0]).catch(() => ({}))
          const prior = existingProviders[normalized.route] ?? {}
          const effectiveBaseURL = normalized.baseURL ?? prior.baseURL
          const effectiveKeyEnv = (typeof normalized.keyEnv === 'string' && normalized.keyEnv !== '')
            ? normalized.keyEnv
            : (prior.apiKeyEnv ?? normalized.keyEnv)
          // 用原始 body.api（用户真正提交的），不用 normalized.api ——
          // normalizeDeclaration 会填默认协议，拿它判断会永远覆盖成默认值。
          const effectiveApi = (typeof body.api === 'string' && body.api !== '') ? body.api : (prior.api ?? 'openai-completions')

          let probe = null
          if (effectiveBaseURL !== undefined) {
            const refs = await readCredentialRefs(join(home, '.credentials.yaml')).catch(() => ({}))
            probe = await probeEndpoint(
              { ...normalized, api: effectiveApi, baseURL: effectiveBaseURL, keyEnv: effectiveKeyEnv },
              { apiKey: body.apiKey ?? refs[effectiveKeyEnv] },
            ).catch((error) => ({ reachable: false, reason: error.message }))
          }

          // 「明文保存密钥」是本机的显式设计：密钥写进 .credentials.yaml（0600）。
          // 单机使用场景下这是有意选择，文件路径在响应里回显给界面展示。
          let credentialsPath = null
          if (typeof body.apiKey === 'string' && body.apiKey !== '') {
            const written = await writeCredentialRefs(join(home, '.credentials.yaml'), { [effectiveKeyEnv]: body.apiKey })
            credentialsPath = written.path ?? join(home, '.credentials.yaml')
          }

          // 显式构造声明：normalizeDeclaration 会给 api/keyEnv/displayName 填默认值，
          // 直接展开会把「用户没提供」误判成「用户提供了默认值」，覆盖现存配置。
          // 这里只传用户真正给出的字段，其余交给 mergeProviders 的保留现有语义。
          const declaration = {
            route: normalized.route,
            api: effectiveApi,
            ...(normalized.baseURL === undefined ? {} : { baseURL: normalized.baseURL }),
            keyEnv: effectiveKeyEnv,
            models: normalized.models,
            ...(typeof body.displayName === 'string' && body.displayName.trim() !== ''
              ? { displayName: body.displayName.trim() }
              : {}),
            ...(body.headers === undefined ? {} : { headers: body.headers }),
            ...(body.reasoning === undefined ? {} : { reasoning: body.reasoning }),
            ...(body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs }),
          }
          for (const patchPath of patchPaths) {
            const result = await mergeProviders(patchPath, [declaration]).catch((error) => ({ error }))
            if (result.error !== undefined) return errorResponse(`写入 ${patchPath} 失败：${result.error.message}`, 500)
          }

          const after = await listProviders(patchPaths[0]).catch(() => ({}))
          const effectiveModels = (after[normalized.route]?.models ?? []).map((model) => model.id ?? String(model))

          if (body.setDefault === true && effectiveModels.length > 0) {
            for (const patchPath of patchPaths) {
              await setDefaultModel(patchPath, normalized.route, effectiveModels[0])
            }
          }

          return jsonResponse({
            added: normalized.route,
            probe: probe && {
              reachable: probe.reachable === true,
              status: probe.status ?? null,
              reason: probe.reason ?? probe.interpretation ?? null,
            },
            keyWritten: typeof body.apiKey === 'string' && body.apiKey !== '',
            credentialsPath,
            effectiveModels,
            profiles,
            note: '重启 harness 后主会话生效；双路质检 lane 每次现读，无需重启。',
          })
        }

        // 删除路由：profile patch 移除声明；凭据 refs 里的键保留（可能被
        // 其它路由共用），由用户决定是否清理。
        if (action === 'remove') {
          if (typeof body.route !== 'string' || body.route.trim() === '') {
            return errorResponse('缺少 route 参数', 400)
          }
          const removed = []
          for (const patchPath of patchPaths) {
            const result = await removeProvider(patchPath, body.route).catch((error) => ({ error }))
            if (result.error !== undefined) return errorResponse(`写入 ${patchPath} 失败：${result.error.message}`, 500)
            if (result.changed) removed.push(patchPath)
          }
          return jsonResponse({ removed: body.route, changed: removed.length > 0, profiles })
        }

        // 设默认模型。
        if (action === 'default') {
          if (typeof body.provider !== 'string' || typeof body.model !== 'string'
            || body.provider.trim() === '' || body.model.trim() === '') {
            return errorResponse('需要 provider 与 model 参数', 400)
          }
          for (const patchPath of patchPaths) {
            await setDefaultModel(patchPath, body.provider, body.model)
          }
          return jsonResponse({ default: `${body.provider} / ${body.model}`, profiles })
        }

        // 探测端点可达性：用已存路由的声明 + 凭据文档里的密钥。
        if (action === 'probe') {
          if (typeof body.route !== 'string' || body.route.trim() === '') {
            return errorResponse('缺少 route 参数', 400)
          }
          const providers = await listProviders(patchPaths[0]).catch(() => ({}))
          const stored = providers[body.route]
          if (stored === undefined) return errorResponse(`路由 "${body.route}" 未登记`, 404)
          const refs = await readCredentialRefs(join(home, '.credentials.yaml')).catch(() => ({}))
          const probe = await probeEndpoint(
            { route: body.route, api: stored.api, baseURL: stored.baseURL, keyEnv: stored.apiKeyEnv, models: stored.models ?? [] },
            { apiKey: refs[stored.apiKeyEnv] },
          ).catch((error) => ({ reachable: false, reason: error.message }))
          return jsonResponse({
            route: body.route,
            reachable: probe.reachable === true,
            status: probe.status ?? null,
            reason: probe.reason ?? probe.interpretation ?? null,
          })
        }

        return errorResponse(`未知 action：${String(action)}`, 400)
      }

      const patchPath = patchPaths[0]

      // 用 API 插件的读取器解析，避免在这里再写一份缩进解析（会分叉）。
      const providers = await listProviders(patchPath).catch(() => ({}))
      const routes = Object.entries(providers).map(([route, profile]) => ({
        route,
        displayName: profile.displayName ?? route,
        api: profile.api ?? null,
        baseURL: profile.baseURL ?? null,
        keyEnv: profile.apiKeyEnv ?? null,
        models: (profile.models ?? []).map((model) => model.id ?? String(model)),
      }))

      // 凭据是否存在：只看有无值，绝不回显密钥本体。
      // 用 API 插件的读取器解析（与写入端同一份逻辑），不在这里另写正则 ——
      // 曾用模板串拼正则，\s 被解释成字面 's'，密钥明明在文档里界面却显示「无值」。
      const credentialRefs = await readCredentialRefs(join(home, '.credentials.yaml')).catch(() => ({}))
      const keyPresence = {}
      for (const route of routes) {
        if (route.keyEnv === null) continue
        keyPresence[route.keyEnv] = credentialRefs[route.keyEnv] !== undefined
      }

      const defaultModel = await readDefaultModel(patchPath).catch(() => null)

      return jsonResponse({
        configured: routes.length > 0,
        routes: routes.map((route) => ({
          ...route,
          keyPresent: route.keyEnv === null ? null : (keyPresence[route.keyEnv] === true),
        })),
        defaultModel,
        protocols: SUPPORTED_PROTOCOLS,
        profilePatchPath: patchPath,
        credentialsPath: join(home, '.credentials.yaml'),
        profiles,
        note: '密钥以明文保存在本机凭据文档（0600）；页面不回显密钥本体，需要查看或修改时直接打开该文件。',
      })
    },
  }), 'autoresearch-ui: api route')

  // ── 路由：双路质检配置（两路路由引用） ────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/qa/lanes`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const home = dshHomeOf()
      const providers = await listProviders(profilePatchPath(home, 'autoresearch')).catch(() => ({}))
      const refs = await readCredentialRefs(join(home, '.credentials.yaml')).catch(() => ({}))

      if (request.method === 'POST') {
        let body
        try {
          body = await request.json()
        } catch {
          return errorResponse('请求体不是合法 JSON', 400)
        }
        const lanes = body?.lanes
        if (!Array.isArray(lanes) || lanes.length !== 2) {
          return errorResponse('需要恰好两路配置', 400)
        }
        const cleaned = lanes.map((lane) => ({
          route: typeof lane?.route === 'string' ? lane.route.trim() : '',
          model: typeof lane?.model === 'string' ? lane.model.trim() : '',
          ...(typeof lane?.version === 'string' && lane.version.trim() !== '' ? { version: lane.version.trim() } : {}),
          ...(typeof lane?.reasoningEffort === 'string' && lane.reasoningEffort.trim() !== ''
            ? { reasoningEffort: lane.reasoningEffort.trim() }
            : {}),
        }))
        await writeLanesFile(home, cleaned)
        const check = resolveSavedLanes({ lanes: cleaned, providers, refs })
        return jsonResponse({ saved: true, lanes: cleaned, issues: check.issues })
      }

      const saved = await readLanesFile(home)
      const check = saved.lanes.length > 0 ? resolveSavedLanes({ lanes: saved.lanes, providers, refs }) : { issues: [] }

      // 可用选项：路由表（含模型表与密钥状态）+ 保存的两路 + 校验问题。
      const routes = Object.entries(providers).map(([route, provider]) => ({
        route,
        api: provider.api ?? null,
        baseURL: provider.baseURL ?? null,
        keyEnv: provider.apiKeyEnv ?? null,
        keyPresent: typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv !== ''
          ? refs[provider.apiKeyEnv] !== undefined
          : null,
        models: (provider.models ?? []).map((model) => model.id ?? String(model)),
      }))

      return jsonResponse({
        configured: saved.lanes.length === 2,
        lanes: saved.lanes,
        updatedAt: saved.updatedAt,
        routes,
        issues: check.issues,
        lanesFile: join(home, 'autoresearch-qa-lanes.json'),
        note: '两路各引用一个已声明路由与模型；密钥仍只存在于凭据文档，配置里只有引用。发布门要求两路身份（路由/模型）不同。',
      })
    },
  }), 'autoresearch-ui: qa lanes route')

  // ── 路由：工作流模式状态 ─────────────────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/mode`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const taskRoot = await resolveTaskRoot(request, resolveRoot())
      if (taskRoot === null) return taskRootErrorResponse()
      const state = await readState(taskRoot)
      const phase = PHASES.find((entry) => entry.id === state.phase)
      const missing = []
      try {
        const results = await checkPhaseDeliverables(taskRoot, state.phase)
        for (const item of results) {
          if (item.required && item.status !== 'PRESENT') {
            missing.push({ path: item.path, status: item.status, note: item.note })
          }
        }
      } catch { /* 核对失败时如实留空，不猜测 */ }

      const gates = (phase?.gates ?? []).map((gateId) => ({
        gate: gateId,
        title: GATES[gateId]?.title ?? gateId,
        milestone: GATES[gateId]?.milestone ?? null,
        verdict: state.gateResults[gateId]?.verdict ?? null,
      }))
      const blocking = gates.filter((entry) => entry.verdict !== 'RECOMMEND')

      return jsonResponse({
        taskRoot,
        phase: {
          id: state.phase,
          order: phase?.order ?? null,
          title: phase?.title ?? null,
          chapter: phase?.chapter ?? null,
          goal: phase?.goal ?? null,
        },
        gates,
        blocking,
        missingRepository: missing,
        // 进入方式与当前该做什么，供界面直接显示。
        enterCommand: '/autoresearch',
        bindCommand: '/autoresearch-task <任务根路径>',
        exitCommand: '/autoresearch-off',
        nextAction: blocking.length > 0
          ? `处理门禁 ${blocking[0].gate}（${blocking[0].verdict ?? '未运行'}）`
          : (missing.length > 0
            ? `补齐 ${missing.length} 项缺失交付物`
            : '本阶段门禁已通过，可推进阶段'),
      })
    },
  }), 'autoresearch-ui: mode route')

  // ── 路由：AutoDL 算力面板 ─────────────────────────────────────────────────
  //
  // 直接调 autodl 包的 lib（不走工具层）：UI 是只读优先的视图，工具层的
  // confirm/护栏语义属于对话流程；这里只暴露查询与「显式带 confirm」的写操作，
  // 让面板能看到成本、实例与租约，而不会因为点一下就开机花钱。
  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/autodl`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const config = normalizeAutodlConfig()
      const token = await resolveAutodlToken(config)
      if (token === null) {
        return jsonResponse({
          configured: false,
          hint: '未配置 AutoDL token。设环境变量 AUTODL_TOKEN，或写 .dsh-home/.autodl.json 的 {"token":"..."}',
        })
      }
      const options = { token, timeoutMs: config.timeoutMs }

      if (request.method === 'GET') {
        const parameters = new URL(request.url).searchParams
        const view = parameters.get('view') ?? 'overview'
        try {
          if (view === 'instances') return jsonResponse(await listInstances({ ...options, pageSize: 100 }))
          if (view === 'images') return jsonResponse(await listImages({ ...options, pageSize: 50 }))
          if (view === 'snapshot') {
            const uuid = parameters.get('uuid') ?? ''
            if (uuid === '') return errorResponse('缺少 uuid 参数', 400)
            const snapshot = await readSnapshot(uuid, options)
            // SSH 密码不回显 —— 只说明「已提供」，要复制请去 AutoDL 控制台。
            const { rootPassword, ...rest } = snapshot
            return jsonResponse({ ...rest, sshPasswordProvided: typeof rootPassword === 'string' && rootPassword !== '' })
          }
          const [balance, instances, leases] = await Promise.all([
            readBalance(options),
            listInstances({ ...options, pageSize: 100 }),
            readLeases(leaseFilePath(config)),
          ])
          return jsonResponse({
            configured: true,
            balance,
            instances,
            leases: {
              active: leases.leases.filter((l) => l.status === 'running' || l.status === 'stopped'),
              expired: expiredLeases(leases),
              total: leases.leases.length,
            },
            guards: {
              maxTotalYuan: config.maxTotalYuan,
              pricePerHourYuan: config.pricePerHourYuan,
              reapMode: config.reapMode,
            },
            specs: GPU_SPECS,
          })
        } catch (error) {
          return jsonResponse({ configured: true, error: error.message, code: error.code ?? null }, 502)
        }
      }

      // POST：写操作。每个动作都自带护栏；创建/释放走对话工具（需显式 confirm）。
      let body
      try {
        body = await request.json()
      } catch {
        return errorResponse('请求体不是合法 JSON', 400)
      }
      const action = body?.action
      try {
        if (action === 'estimate') {
          return jsonResponse(estimateCost({
            pricePerHourYuan: body?.price_per_hour_yuan ?? config.pricePerHourYuan,
            hours: body?.hours, budget: { maxTotalYuan: body?.max_total_yuan ?? config.maxTotalYuan },
          }))
        }
        if (action === 'reap') {
          return jsonResponse(await reapExpiredLeases({
            leaseFile: leaseFilePath(config), token: options.token,
            mode: body?.mode ?? config.reapMode, dryRun: body?.dry_run === true,
          }))
        }
        if (action === 'reconcile') {
          return jsonResponse(await reconcileLeases({ leaseFile: leaseFilePath(config), token: options.token }))
        }
        if (action === 'power') {
          if (body?.direction === 'on') {
            return jsonResponse(await powerOn(body.instance_uuid, {}, options))
          }
          return jsonResponse(await powerOff(body.instance_uuid, options))
        }
        return errorResponse(`未知 action：${String(action)}（创建/释放走对话工具，需显式确认）`, 400)
      } catch (error) {
        return jsonResponse({ error: error.message }, 502)
      }
    },
  }), 'autoresearch-ui: autodl route')

  // ── 路由：飞书集成面板 ────────────────────────────────────────────────────
  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/lark`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const config = await normalizeLarkConfig()
      const auth = await authStatus({ timeoutMs: config.timeoutMs })

      if (request.method === 'GET') {
        const parameters = new URL(request.url).searchParams
        if (parameters.get('view') === 'records') {
          const tableId = parameters.get('table_id') ?? ''
          if (tableId === '' || !config.baseToken) {
            return jsonResponse({ configured: Boolean(config.baseToken), auth, records: [] })
          }
          try {
            return jsonResponse(await listRecords({
              baseToken: config.baseToken, tableId, limit: Number(parameters.get('limit') ?? 20),
            }, { timeoutMs: config.timeoutMs }))
          } catch (error) {
            return jsonResponse({ error: error.message }, 502)
          }
        }
        let tables = null
        if (config.baseToken) {
          try {
            tables = (await listTables({ baseToken: config.baseToken }, { timeoutMs: config.timeoutMs })).tables
          } catch (error) {
            tables = [{ name: `读取失败：${error.message}` }]
          }
        }
        return jsonResponse({
          configured: Boolean(config.baseToken),
          auth,
          baseToken: config.baseToken,
          tables,
          chatId: config.chatId,
          schemas: TABLE_SCHEMAS,
        })
      }

      let body
      try {
        body = await request.json()
      } catch {
        return errorResponse('请求体不是合法 JSON', 400)
      }
      const action = body?.action
      try {
        if (action === 'provision') {
          return jsonResponse(await provisionBase({
            name: body?.name ?? 'AutoResearch 平台', dryRun: body?.dry_run === true,
          }, { timeoutMs: config.timeoutMs }))
        }
        if (action === 'sync') {
          const tables = await resolveLarkTables(config)
          const rows = await buildLarkRows(String(body?.task_root ?? ''))
          if (!rows.task && rows.gates.length === 0 && rows.trajectories.length === 0) {
            return jsonResponse({ synced: false, reason: '无可同步内容（缺 autoresearch-state.json / run_summary.json）' })
          }
          return jsonResponse(await syncTaskPackage({
            baseToken: config.baseToken, tables,
            task: rows.task ?? { 任务ID: String(body?.task_root ?? '').split(/[\\/]/).pop() },
            gates: rows.gates, trajectories: rows.trajectories,
            dryRun: body?.dry_run === true,
          }, { timeoutMs: config.timeoutMs }))
        }
        if (action === 'notify') {
          const chatId = body?.chat_id ?? config.chatId
          if (!chatId) return errorResponse('未配置飞书群 chat_id', 400)
          return jsonResponse(await sendMessage({
            chatId, text: body?.text, markdown: body?.markdown,
            dryRun: body?.dry_run === true,
          }, { timeoutMs: config.timeoutMs }))
        }
        return errorResponse(`未知 action：${String(action)}`, 400)
      } catch (error) {
        return jsonResponse({ error: error.message }, 502)
      }
    },
  }), 'autoresearch-ui: lark route')

  ctx.logger?.info?.('autoresearch-ui: routes registered')
}
