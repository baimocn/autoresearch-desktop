/**
 * dsh-autoresearch —— AutoResearch 出题工作流引擎。
 *
 * 把《AutoResearch 专家线下标注教程V3》的四阶段流程做成可执行的会话状态机：
 *   · 阶段与交付物清单（phases.js）
 *   · 门禁判定（gates.js，九道可判定门）
 *   · 状态持久化与推进纪律（state.js）
 *   · 题包脚手架（scaffold.js）
 *
 * 本插件只做「编排 + 判定 + 留痕」，不代替 Harbor 执行容器，也不代替平台审核。
 * 门禁结论是本地判定事实，与官方审核结论严格区分。
 *
 * @module dsh-autoresearch
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  INTAKE_CHECKS, PHASES, TASK_MODES, VARIANT_RULES, DEPRECATED_PATHS,
  phaseById, nextPhase,
} from './lib/phases.js'
import {
  GATES, VERDICT, TRAJECTORY_FIELDS, R_LO, R_HI, SIGMA_MULT_REQUIRED,
  gateSelection, gateFeasibility, gateTaskContract, gateDockerPathContract,
  gateTrajectory, gateNopResult, gateReplayContract, gateSingleSource, gatePackVerify,
} from './lib/gates.js'
import {
  StateError, readState, writeState, recordGateResult, advanceState, summarize,
  checkPhaseDeliverables, resolveTaskPath, assertInsideTaskRoot,
} from './lib/state.js'
import { scaffoldTaskPackage } from './lib/scaffold.js'
import { parseTomlSubset } from './lib/toml.js'
import { renderStepDirective } from './lib/workflow.js'
import { installMode } from './lib/mode.js'
import {
  resolveDshHome, resolveTaskRoot, registerTaskInWorkbench, bindSessionTask,
} from './lib/session-tasks.js'
import { inspectPwshCommand } from './lib/windows-guard.js'

/** 需要 agent 运行时来构造注入消息。 */
export const inject = ['tools', 'systemPrompt', 'sessionProjections', 'agents']

export const name = 'autoresearch'

/** 需要工具、系统提示、会话投影与工作目录服务。 */
/**
 * 默认配置。不导出 schemastery Config：该包在本插件目录不可解析，且 cordis
 * 允许无 Config 的插件直接接收 patch 里的原始 config 对象。
 */
const DEFAULT_CONFIG = Object.freeze({
  /** 任务根目录；相对路径以进程工作目录为基准。 */
  taskRoot: '.',
  /** 系统提示章节开关：关闭后模型不会收到流程纪律提醒。 */
  promptSection: true,
  /** 模式激活时是否限制非工作流工具。 */
  restrictWhenActive: true,
  /** 被限制的工具名列表。 */
  restrictedTools: [],
  /** 是否允许通过 /autoresearch 命令切换工作流模式。 */
  enableModeCommand: true,
  /** Windows 工具体验守卫（编码乱码 / sleep 轮询拦截）。 */
  windowsGuard: true,
  /**
   * 是否默认激活工作流模式。
   * 无人值守场景（双路质检、远端长跑）用得上：那些场景不可能交互输入命令，
   * 但同样需要门禁纪律。默认关闭，因为做题与随便聊天应当区分。
   */
  modeActiveByDefault: false,
})

const TOOL_PREFIX = 'autoresearch'

/** 任务根解析：绝对路径直接采用，相对路径挂到进程工作目录。 */
function makeRootResolver(config) {
  return () => {
    const raw = config.taskRoot
    if (raw === '.' || raw === '' || raw === undefined) return process.cwd()
    return resolveTaskPath(process.cwd(), raw)
  }
}

function textResult(value, title) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    meta: title === undefined ? undefined : { title },
  }
}

/** 把门禁结论渲染成人可读摘要，失败项带修复动作。 */
function renderGateReport(result) {
  const lines = [
    `门禁：${result.gate}（里程碑 ${result.milestone}）`,
    `结论：${result.verdict}`,
    '',
  ]
  for (const item of result.checks) {
    const mark = item.status === 'PASS' ? '[PASS]' : item.status === 'FAIL' ? '[FAIL]' : '[UNKNOWN]'
    lines.push(`${mark} ${item.id} ${item.detail}`)
    if (item.fix) lines.push(`        修复：${item.fix}`)
  }
  if (result.verdict === VERDICT.REJECT) {
    lines.push('', '判定：存在硬门 FAIL。不做总分补偿 —— 失败只修当前最早失败项，后续暂停。')
  } else if (result.verdict === VERDICT.NEEDS_EVIDENCE) {
    lines.push('', '判定：有 UNKNOWN 项未清零。补证后重跑，未知项不能写成通过。')
  } else {
    lines.push('', '判定：全部硬门通过。')
  }
  return lines.join('\n')
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const resolveRoot = makeRootResolver(config)
  const dshHome = resolveDshHome(config.dshHome)

  /**
   * 工具侧任务根解析：显式 task 参数 > 会话绑定 > 进程配置根。
   * 多任务并行的唯一入口 —— 所有 autoresearch_* 工具都经此解析，杜绝
   * 「看错任务改错文件」。
   */
  const resolveRootFor = async (exec, explicit) => resolveTaskRoot(dshHome, {
    explicit,
    sessionId: exec?.agent?.session?.id ?? null,
    fallback: resolveRoot(),
  })

  /** 统一包装：读状态 → 变更 → 原子写回。 */
  const mutate = async (taskRoot, mutator) => {
    const state = await readState(taskRoot)
    const next = await mutator(state)
    return writeState(taskRoot, next)
  }

  // ── 系统提示章节：把流程纪律交给模型 ──────────────────────────────────────

  if (config.promptSection) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'tool:autoresearch',
      // 排在 TOOL_REPORT(2900) 之后、MCP_SERVERS(3100) 之前，与其它工具指引相邻。
      order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') + 50,
      text: () => [
        '<autoresearch_protocol>',
        '你在制作一道 AutoResearch 题目。流程分四阶段，任一阶段的门禁未通过不得进入下一阶段：',
        ...PHASES.map((phase) => `  ${phase.order}. ${phase.id}（${phase.chapter}）：${phase.title}`),
        '',
        '硬规则：',
        '- 不做总分补偿：热度、引用数、新颖性不能抵消许可、评测、资源或交付失败。',
        '- 未知项写 UNKNOWN，不能写成通过；缺失的命令、时间或退出码写 null 并解释。',
        '- 门禁结论按被检对象的 SHA-256 锚定；交付物一改，旧结论即失效，必须重跑。',
        '- 正式评分由独立 Verifier 执行；Agent 容器内的每轮 Public/Dev 反馈只用于迭代。',
        '- 不得伪造 seed 目录、统计量、模型或运行记录。',
        '</autoresearch_protocol>',
      ].join('\n'),
    }), 'autoresearch: protocol section')
  }

  // ── Windows 工具体验守卫（全局生效，含双路 lane 的 agent） ─────────────────
  //
  // 拦截 + 现场教学：编码乱码与 sleep 轮询是 Windows 上模型最高频的两类低效
  // 行为。守卫只拒绝不改写（PreToolDecision 不允许输入改写），但拒绝消息里
  // 带着修复模板，模型下一轮立即纠正。
  if (config.windowsGuard === true && typeof ctx.tools.guard === 'function') {
    ctx.effect(() => ctx.tools.guard((exec) => {
      if (exec?.name !== 'pwsh') return undefined
      return inspectPwshCommand(exec.arguments?.command)
    }), 'autoresearch: windows pwsh guard')
  }

  // ── 工作流模式 ──────────────────────────────────────────────────────────
  //
  // 模式的装配在 lib/mode.js：它只需要「读状态 + 渲染指令」这一个依赖，
  // 不必知道工具注册、技能供应、门禁判定等任何其它事情。

  const mode = installMode(ctx, {
    config,
    logger: ctx.logger,
    buildDirective: async (session) => {
      const taskRoot = await resolveTaskRoot(dshHome, {
        sessionId: session?.id ?? null,
        fallback: resolveRoot(),
      })
      const state = await readState(taskRoot)
      const phase = phaseById(state.phase)

      let missingRequired = []
      try {
        const results = await checkPhaseDeliverables(taskRoot, state.phase)
        missingRequired = results
          .filter((item) => item.required && item.status !== 'PRESENT')
          .map((item) => ({ path: item.path, status: item.status, note: item.note }))
      } catch { /* 核对失败不阻断指令生成，但也不假装齐备 */ }

      return {
        directive: renderStepDirective({
          phaseId: state.phase,
          gateResults: state.gateResults,
          missingRequired,
          // 会话绑定与配置根不同才回显：指令里只有差异信息才值得占预算。
          taskRoot: taskRoot !== resolveRoot() ? taskRoot : undefined,
        }),
        state,
        phase,
      }
    },
  })

  // ── 工具：任务总览 ────────────────────────────────────────────────────────

  // ── 工具：初始化任务 ──────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: `${TOOL_PREFIX}_init`,
    description: '初始化 AutoResearch 出题任务：登记题目身份、生成三类顶层目录的题包骨架。已存在的文件不会被覆盖。',
    parameters: {
      title: { type: 'string', required: true, description: '题目名称（用于题面标题与 task.toml 描述）' },
      taskId: { type: 'string', description: '平台 Task ID；可后补' },
      taskType: { type: 'string', enum: ['S1', 'S2', 'S3'], description: '出题模式' },
      researchDirection: { type: 'string', description: '研究方向' },
      variant: { type: 'string', description: '变体编号；无变体可省略' },
      taskName: { type: 'string', description: 'task.toml 的 [task].name，格式如 group/name' },
      task: { type: 'string', description: '任务根路径；多任务时必传（会话已绑定时可省）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const taskRoot = await resolveRootFor(exec, args.task)
      const scaffold = await scaffoldTaskPackage(taskRoot, {
        title: args.title,
        taskName: args.taskName ?? 'TODO/task-name',
      })
      // 建完任务就登记到工作台并绑定当前会话：「任务在某目录存在」与
      // 「工作台看得见它、本会话驱动它」是同一件事，不该让用户再做两遍。
      let registered = null
      let bound = false
      try {
        registered = await registerTaskInWorkbench(dshHome, taskRoot)
        const sessionId = exec?.agent?.session?.id ?? null
        if (sessionId !== null) await bindSessionTask(dshHome, sessionId, taskRoot)
        bound = sessionId !== null
      } catch (error) {
        registered = { error: error instanceof Error ? error.message : String(error) }
      }
      const state = await mutate(taskRoot, (current) => ({
        ...current,
        taskId: args.taskId ?? current.taskId,
        identity: {
          title: args.title,
          taskId: args.taskId ?? null,
          taskType: args.taskType ?? null,
          taskTypeInput: args.taskType ? TASK_MODES[args.taskType].input : null,
          researchDirection: args.researchDirection ?? null,
          variant: args.variant ?? null,
        },
      }))
      return {
        taskRoot,
        created: scaffold.created,
        skippedExisting: scaffold.skipped,
        phase: state.phase,
        registeredInWorkbench: registered?.added === true ? true : (registered?.error !== undefined ? `登记失败：${registered.error}` : '已在清单中'),
        sessionBound: bound,
        nextStep: '按 instruction.md 八章节与 task.toml 填写；先完成第 1 章的领取后检查，再跑 autoresearch_gate --gate G-SELECT。',
        note: '骨架只写有内容可写的文件；轨迹与证据 JSON 为空结构，未预填任何结果数字。任务已登记到工作台并绑定本会话。',
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `初始化出题任务：${args.title}`, kind: 'other' }),
  }))

  // ── 工具：领取后检查 ──────────────────────────────────────────────────────

  // ── 工具：门禁 ────────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: `${TOOL_PREFIX}_gate`,
    description: '运行一道 AutoResearch 门禁并留痕。九道门：G-SELECT / G-FEASIBILITY / G-CONTRACT / G-DOCKERFILE / G-NOP-RESULT / G-TRAJECTORY / G-REPLAY-CONTRACT / G-SINGLE-SOURCE / G-PACK-VERIFY。结论为 RECOMMEND / NEEDS_EVIDENCE / REJECT，任一硬门 FAIL 即 REJECT。',
    parameters: {
      gate: {
        type: 'string',
        required: true,
        enum: Object.keys(GATES),
        description: '门禁 id',
      },
      payload: {
        type: 'json',
        description: '该门禁的输入数据。G-CONTRACT 传已解析的 task.toml 对象；G-DOCKERFILE 传 {environmentDockerfile, testsDockerfile, instructionMd}；G-SELECT/G-FEASIBILITY/G-TRAJECTORY/G-NOP-RESULT/G-REPLAY-CONTRACT/G-SINGLE-SOURCE/G-PACK-VERIFY 传对应判据字段。',
      },
      /** 便利项：直接读取任务目录里的文件填充 payload。 */
      fromTask: {
        type: 'boolean',
        description: '为 true 时从任务目录自动读取 task.toml / 两个 Dockerfile / instruction.md / 轨迹 / 证据 JSON 填充 payload',
      },
      task: { type: 'string', description: '任务根路径；多任务时必传（会话已绑定时可省）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const taskRoot = await resolveRootFor(exec, args.task)
      const meta = GATES[args.gate]
      if (meta === undefined) throw new Error(`未知门禁：${args.gate}`)

      let payload = args.payload ?? {}
      if (args.fromTask === true) {
        payload = { ...(await collectFromTask(taskRoot, args.gate)), ...payload }
      }

      let result
      switch (args.gate) {
        case 'G-SELECT': result = gateSelection(payload); break
        case 'G-FEASIBILITY': result = gateFeasibility(payload); break
        case 'G-CONTRACT': result = gateTaskContract(payload); break
        case 'G-DOCKERFILE': result = gateDockerPathContract(payload); break
        case 'G-TRAJECTORY': result = gateTrajectory(payload); break
        case 'G-NOP-RESULT': result = gateNopResult(payload); break
        case 'G-REPLAY-CONTRACT': result = gateReplayContract(payload); break
        case 'G-SINGLE-SOURCE': result = gateSingleSource(payload); break
        case 'G-PACK-VERIFY': result = gatePackVerify(payload); break
        default: throw new Error(`门禁 ${args.gate} 未接线`)
      }

      await mutate(taskRoot, (current) => recordGateResult(current, result))

      // 门禁结论的留痕在两处：任务状态文件（autoresearch-state.json）与
      // 本调用的 tool/result 日志。不往会话日志 append 自定义事件类型 ——
      // 未知类型会让会话历史拒绝加载（mode.js 头注有完整记录）。
      return { ...result, report: renderGateReport(result) }
    },
    presentCall: (args) => ({ card: 'generic', title: `运行门禁 ${args.gate}`, kind: 'read' }),
  }))

  // ── 工具：阶段推进 ────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: `${TOOL_PREFIX}_advance`,
    description: '推进到下一阶段。当前阶段的门禁必须全部 RECOMMEND 才允许推进；不允许跳级或回退。',
    parameters: {
      to: { type: 'string', enum: PHASES.map((phase) => phase.id), description: '目标阶段 id' },
      task: { type: 'string', description: '任务根路径；多任务时必传（会话已绑定时可省）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const taskRoot = await resolveRootFor(exec, args.task)
      const state = await readState(taskRoot)
      let outcome
      try {
        outcome = advanceState(state, args.to ?? nextPhase(state.phase)?.id)
      } catch (error) {
        if (error instanceof StateError) {
          return { ok: false, blocked: true, report: `推进被拒绝：${error.message}` }
        }
        throw error
      }
      if (!outcome.changed) {
        return { ok: true, changed: false, report: outcome.reason }
      }
      const saved = await writeState(taskRoot, outcome.state)
      const phase = phaseById(saved.phase)
      return {
        ok: true,
        changed: true,
        phase: saved.phase,
        report: [
          `阶段推进：${outcome.reason}`,
          `当前阶段：${phase.order}. ${phase.title}（${phase.chapter}）`,
          `目标：${phase.goal}`,
          '',
          '本阶段必须产出：',
          ...phase.deliverables.map((item) => `  ${item.required ? '[必需]' : '[可选]'} ${item.path} —— ${item.note}`),
          '',
          '退出判据：',
          ...phase.exitCriteria.map((item) => `  - ${item}`),
        ].join('\n'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `推进阶段至 ${args.to}`, kind: 'other' }),
  }))

  // ── 工具：轨迹记录 ────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: `${TOOL_PREFIX}_trajectory`,
    description: '按八字段规范追加一轮迭代记录到指定轨迹（trajectory_codex.json 或 trajectory_seed.json），并做字段校验。失败也保留记录；未成功出分时 score 记 null 并写明原因。',
    parameters: {
      track: {
        type: 'string',
        required: true,
        enum: ['codex', 'seed'],
        description: 'codex = Codex + GPT-5.6 Sol；seed = Codex + Seed 2.1 Turbo',
      },
      policyName: { type: 'string', required: true, description: '本轮方法或策略名称' },
      methodSummary: { type: 'string', required: true, description: '1–3 句：本轮核心改动与结论' },
      status: { type: 'string', required: true, description: '本轮执行状态；成功记 ok，失败按真实失败类型填写' },
      score: { type: 'number', description: '本轮 Public/Dev 原始指标值；未成功出分时省略并填 failureReason' },
      failureReason: { type: 'string', description: '失败原因及下一步判断；成功时省略' },
      retainedBest: { type: 'boolean', required: true, description: '本轮方法是否为至今保留的最佳方法' },
      task: { type: 'string', description: '任务根路径；多任务时必传（会话已绑定时可省）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const taskRoot = await resolveRootFor(exec, args.task)
      const file = `expert_evidence/trajectory_${args.track}.json`
      const absolute = resolveTaskPath(taskRoot, file)
      assertInsideTaskRoot(taskRoot, absolute)

      let document = { rounds: [] }
      try {
        document = JSON.parse(await readFileText(absolute))
        if (!Array.isArray(document.rounds)) document.rounds = []
      } catch { /* 文件不存在或损坏时从空结构开始，不静默吞掉内容 */ }

      const round = {
        round: document.rounds.length + 1,
        policy_name: args.policyName,
        method_summary: args.methodSummary,
        status: args.status,
        score: Number.isFinite(args.score) ? args.score : null,
        failure_reason: args.failureReason ?? null,
        retained_best: args.retainedBest,
        time: formatTime(new Date()),
      }

      const { validateTrajectoryRound } = await import('./lib/gates.js')
      const problems = validateTrajectoryRound(round, round.round - 1)

      document.rounds.push(round)
      await mkdirFor(absolute)
      await writeFileText(absolute, JSON.stringify(document, null, 2))

      return {
        file,
        round: round.round,
        entry: round,
        problems,
        compliant: problems.length === 0,
        nextStep: problems.length === 0
          ? '继续下一轮迭代；刷新当前最佳时把完整可运行代码更新到 expert_evidence/best_method/。'
          : '按 problems 修正字段后重写该轮（可编辑 JSON 文件后重跑校验）。',
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `记录 ${args.track} 轨迹第 ${args.policyName} 轮`, kind: 'other' }),
  }))

  // ── 工具：交付物核对 ──────────────────────────────────────────────────────

  ctx.logger?.info?.('autoresearch: workflow engine active')
}

// ── 文件读取辅助（保持插件对 dsh-fs 的零硬依赖） ──────────────────────────────

async function readFileText(file) {
  const { readFile } = await import('node:fs/promises')
  return readFile(file, 'utf8')
}

async function writeFileText(file, content) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, content, 'utf8')
}

async function mkdirFor(file) {
  const { mkdir } = await import('node:fs/promises')
  const { dirname } = await import('node:path')
  await mkdir(dirname(file), { recursive: true })
}

async function pathExists(path) {
  const { stat } = await import('node:fs/promises')
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** YYYY-MM-DD HH:mm:ss，本地时区。 */
function formatTime(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/**
 * 从任务目录自动收集门禁输入。
 * 只读取公开位置；不触碰 tests/ 内部私有材料。
 */
async function collectFromTask(taskRoot, gate) {
  const { readFile } = await import('node:fs/promises')
  const readIfPresent = async (relativePath) => {
    try {
      return await readFile(resolveTaskPath(taskRoot, relativePath), 'utf8')
    } catch {
      return undefined
    }
  }
  const readJsonIfPresent = async (relativePath) => {
    const text = await readIfPresent(relativePath)
    if (text === undefined) return undefined
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  }

  switch (gate) {
    case 'G-CONTRACT': {
      const tomlText = await readIfPresent('workspace/harbor_task/task.toml')
      return tomlText === undefined ? {} : { ...parseTomlSubset(tomlText) }
    }
    case 'G-DOCKERFILE':
      return {
        environmentDockerfile: await readIfPresent('workspace/harbor_task/environment/Dockerfile'),
        testsDockerfile: await readIfPresent('workspace/harbor_task/tests/Dockerfile'),
        instructionMd: await readIfPresent('workspace/harbor_task/instruction.md'),
      }
    case 'G-TRAJECTORY':
      return {
        codexTrajectory: await readJsonIfPresent('expert_evidence/trajectory_codex.json'),
        seedTrajectory: await readJsonIfPresent('expert_evidence/trajectory_seed.json'),
        runSummary: await readJsonIfPresent('expert_evidence/run_summary.json'),
      }
    case 'G-SINGLE-SOURCE': {
      const comparison = await readJsonIfPresent('optimization_evidence/comparison_summary.json')
      const annotation = await readJsonIfPresent('expert_evidence/expert_annotation.json')
      const declarations = []
      if (comparison?.metric?.name) declarations.push(`comparison_summary.metric=${comparison.metric.name}`)
      if (annotation?.score_contract?.metric) declarations.push(`expert_annotation.metric=${annotation.score_contract.metric}`)
      return { anchorDeclarations: declarations, staleDeclarations: [] }
    }
    default:
      return {}
  }
}

/** 供其它模块复用的导出。 */
export { parseTomlSubset }
export {
  PHASES, TASK_MODES, INTAKE_CHECKS, VARIANT_RULES, DEPRECATED_PATHS,
  GATES, VERDICT, TRAJECTORY_FIELDS, R_LO, R_HI, SIGMA_MULT_REQUIRED,
}
