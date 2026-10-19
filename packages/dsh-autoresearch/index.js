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
import { readdir } from 'node:fs/promises'
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
  resolveDshHome, resolveTaskRoot, registerTaskInWorkbench, bindSessionTask, readJsonDoc,
  locateTaskRootById, knownTaskParents,
} from './lib/session-tasks.js'
import { inspectPwshCommand } from './lib/windows-guard.js'

/** 需要 agent 运行时来构造注入消息。 */
// inject 是**激活条件**：声明的服务缺失时整个插件不激活。
// 因此只列真正用到的 —— `agents` 曾经列在这里但全包无人使用，
// 白白多一条「这个 profile 没装 agents 服务就不激活」的约束。
export const inject = ['tools', 'systemPrompt', 'sessionProjections']

export const name = 'autoresearch'

/** 需要工具、系统提示、会话投影与工作目录服务。 *//**
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

/**
 * 红线扫描纳入的源码后缀。
 *
 * 不扫全部文件：reference/ 下通常还有数据集、权重、日志，全读进来会
 * 非常慢且对红线判定毫无帮助。红线只关心会被执行的代码。
 */
const SOURCE_EXTENSIONS = Object.freeze([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.sh', '.bash', '.yaml', '.yml',
  '.json', '.toml', '.cfg', '.ini', '.ipynb', '.dockerfile', '.txt', '.md',
])

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

  /**
   * 按 Task ID 定位任务根时的搜索根清单。
   *
   * 顺序有讲究：配置根（可能正是 cwd/launch-root）只作最后一站，
   * 因为「工作台默认启动目录」恰恰是路径漂移的落点，不该优先命中。
   *   · config.taskSearchRoots —— 显式配置，最高优先
   *   · 已知任务所在目录的父目录 —— 同批任务通常并排存放
   *   · 进程工作目录
   */
  const locateRootsFor = async (home, cfg) => {
    const roots = []
    if (Array.isArray(cfg.taskSearchRoots)) roots.push(...cfg.taskSearchRoots)
    for (const known of await knownTaskParents(home)) roots.push(known)
    roots.push(resolveRoot())
    return roots.filter((item) => typeof item === 'string' && item.trim() !== '')
  }

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
      let idSearchMiss = null
      // 任务根解析（顺序即优先级）：
      //   1. 显式 task 路径
      //   2. 会话绑定
      //   3. **按 taskId 定位同名目录** —— 修复路径漂移的关键一步
      //   4. 配置根（process.cwd()）
      // 第 3 步之前不存在：taskId 只写进状态，不参与寻址，导致传了
      // taskId 也仍落到 launch-root，题包写进工作台默认启动目录。
      let taskRoot
      let idLocated = null
      if (typeof args.task === 'string' && args.task.trim() !== '') {
        taskRoot = await resolveRootFor(exec, args.task)
      } else {
        const bound = await resolveRootFor(exec, undefined)
        const boundIsConfigRoot = bound === resolveRoot()
        // 只在「没有更具体的绑定」时才按 id 定位，避免覆盖用户显式绑定的任务。
        if (boundIsConfigRoot && typeof args.taskId === 'string' && args.taskId.trim() !== '') {
          const located = await locateTaskRootById(args.taskId, await locateRootsFor(dshHome, config))
          if (located.found !== null) {
            taskRoot = located.found
            idLocated = located.found
          } else {
            taskRoot = bound
            idSearchMiss = located.searched
          }
        } else {
          taskRoot = bound
        }
      }
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
        rootResolution: idLocated !== null
          ? `按 taskId 定位到既有任务根：${idLocated}`
          : (idSearchMiss !== null
            ? `未找到 taskId 同名目录，回退到配置根 ${taskRoot}（已搜索：${idSearchMiss.join('；')}）`
            : `使用配置根/会话绑定：${taskRoot}`),
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
      /**
       * G-PACK-VERIFY 的交付 ZIP。
       *
       * 没有这个参数时，G14.1–G14.3 的判据输入**结构上无法提供** ——
       * `sourceHashes`/`packedHashes` 只能靠调用方构造，而工具 schema 里
       * 没有能传它们的入口，于是三项恒判 PASS（空集 PASS）。
       */
      artifact: {
        type: 'string',
        description: '提交 ZIP 路径（相对任务根或绝对）。G-PACK-VERIFY 据此核对打包一致性；'
          + '省略时自动在任务根**一层**内查找唯一的 .zip（不递归，避免误取 _data/ 下的数据集 zip）',
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
        payload = { ...(await collectFromTask(taskRoot, args.gate, { artifact: args.artifact })), ...payload }
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

      // 轨迹文件损坏时必须报错并保留原文件，不能从空结构开始 ——
      // 紧接着就会写回整个文件，那等于把已记录的全部轮次静默抹掉。
      const parsed = await readJsonDoc(absolute, {
        // rounds 缺失（空文件/首轮）可以接受；存在但不是数组即结构损坏。
        isValid: (value) => value !== null && typeof value === 'object'
          && (value.rounds === undefined || Array.isArray(value.rounds)),
      })
      const document = { ...(parsed ?? {}), rounds: parsed?.rounds ?? [] }

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
      const { calibrationConstantsOf, detectCalibrationScore } = await import('./lib/trajectory.js')
      const problems = validateTrajectoryRound(round, round.round - 1)

      // ── 写入侧的语义护栏：score 不该是标定常数 ───────────────────────────
      //
      // 实测 AutoRe1841 有三轮把 `reference_normalized`（R 在评分公式下的位置）
      // 填进了 score —— 那是标定常数，B/R/U 一定就不变，与本轮方法改进了多少
      // 无关。页面于是显示"最佳分 0.793603"，看起来像跑出了成绩。
      //
      // 这里**只告警、不拒写、不改数**：轨迹是专家的原始记录，平台不该
      // 替作者决定什么能记。但必须把它作为 problems 说出来，让作者知道。
      const readJsonAt = async (relative) => {
        try {
          return JSON.parse(await readFileText(resolveTaskPath(taskRoot, relative)))
        } catch { return undefined }
      }
      const constants = calibrationConstantsOf({
        anchors: await readJsonAt('workspace/harbor_task/tests/hidden_assets/anchors.json'),
        comparison: await readJsonAt('optimization_evidence/comparison_summary.json'),
        annotation: await readJsonAt('expert_evidence/expert_annotation.json'),
      })
      const asConstant = detectCalibrationScore(round.score, constants)
      if (asConstant !== null) {
        problems.push(`score=${round.score} 与该题的标定常数 ${asConstant.label} 逐位相同。`
          + 'score 按 SOP 应是「本轮方法的 Public/Dev 原始指标实测值」；'
          + '标定常数（B/R/U 定后不变）不随方法改进而变。'
          + '若本轮没有真实出分，请把 score 记 null 并在 failure_reason 里写明原因。')
      }

      document.rounds.push(round)
      await mkdirFor(absolute)
      await writeFileText(absolute, JSON.stringify(document, null, 2))

      return {
        file,
        round: round.round,
        entry: round,
        problems,
        calibrationWarning: asConstant,
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
export async function collectFromTask(taskRoot, gate, options = {}) {
  const { readFile } = await import('node:fs/promises')
  const readIfPresent = async (relativePath) => {
    try {
      return await readFile(resolveTaskPath(taskRoot, relativePath), 'utf8')
    } catch {
      return undefined
    }
  }
  /**
   * 列出目录下的源码文件（递归，限定常见源码后缀）。
   *
   * 限定后缀的理由：reference/ 下通常还有数据集、权重、日志，全读进来
   * 会非常慢且无意义。红线扫描只关心会被执行的代码。
   * 目录不存在或不可读时返回空数组 —— 调用方据此报"未扫描"，不伪造。
   */
  const listSourceFiles = async (relativeDir, depth = 0) => {
    if (depth > 6) return []
    const absolute = resolveTaskPath(taskRoot, relativeDir)
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch {
      return []
    }
    const out = []
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue
      const rel = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        out.push(...await listSourceFiles(rel, depth + 1))
      } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
        out.push(rel)
      }
    }
    return out
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
    case 'G-DOCKERFILE': {
      // 红线 1 需要「解题者可见的代码」与「参考实现」的源码文本，红线 6 需要两个 Dockerfile。
      // 若不在这里读入源码，红线在真实流程里永远不会跑（只会报"未扫描"），
      // 那等于红线只存在于消融实验里 —— 这是必须避免的"纸面门禁"。
      //
      // 目录清单取 RED_LINE_SOURCE_DIRS（唯一真源，接线测试也从那里取）。
      const sourceFiles = []
      for (const dir of RED_LINE_SOURCE_DIRS) {
        for (const rel of await listSourceFiles(dir)) {
          const text = await readIfPresent(rel)
          if (typeof text === 'string') sourceFiles.push({ path: rel, text })
        }
      }
      return {
        environmentDockerfile: await readIfPresent('workspace/harbor_task/environment/Dockerfile'),
        testsDockerfile: await readIfPresent('workspace/harbor_task/tests/Dockerfile'),
        instructionMd: await readIfPresent('workspace/harbor_task/instruction.md'),
        sourceFiles,
        sourceScope: RED_LINE_SOURCE_DIRS.join(' + '),
      }
    }
    case 'G-TRAJECTORY':
      return {
        codexTrajectory: await readJsonIfPresent('expert_evidence/trajectory_codex.json'),
        seedTrajectory: await readJsonIfPresent('expert_evidence/trajectory_seed.json'),
        runSummary: await readJsonIfPresent('expert_evidence/run_summary.json'),
      }
    case 'G-FEASIBILITY': {
      // 这道门此前**没有 fromTask 分支** —— 传 fromTask:true 时喂进去的是空
      // payload，门禁只会报「缺少 Baseline/Reference/U」三个 UNKNOWN。于是
      // 方向（direction）永远传不到，而它正是决定 Δ 符号的那个字段。
      //
      // 真源：workspace/harbor_task/tests/hidden_assets/anchors.json —— 它是
      // 评分锚点的规范落点（B/R/U/σ_B/direction 都在里面，见教程 V3 §8）。
      // 兼容没有该文件的任务：此时**不补** direction，让它保持未声明，
      // 由门禁如实报 UNKNOWN，而不是替它猜一个方向。
      const anchors = await readJsonIfPresent('workspace/harbor_task/tests/hidden_assets/anchors.json')
      // 注意 readJsonIfPresent 的缺失契约是 **undefined**（不是 null）。
      if (anchors === undefined || anchors === null) return {}
      const baselineValues = Array.isArray(anchors.baseline_values) ? anchors.baseline_values : null
      const referenceValues = Array.isArray(anchors.reference_values) ? anchors.reference_values : null

      // G1.9「evaluator 可从候选产物独立复算主指标」**必须有证据**才能声明为真。
      // 判据：tests/ 下存在把候选 checkpoint 现场加载并重算指标的 grader
      // （真的复算，而不是读一个已经算好的分数文件）。读不到就**不声明**，
      // 让 G1.9 如实落在 UNKNOWN —— 这里曾经无条件写 true，等于凭空盖章。
      const grader = await readIfPresent('workspace/harbor_task/tests/grader.py')
      const graderSrc = typeof grader === 'string' ? grader : ''
      const loadsCheckpoint = /torch\.load|load_state_dict|safetensors/.test(graderSrc)
      const recomputesMetric = /def\s+\w*(balanced_accuracy|accuracy|score|metric)\w*\s*\(/.test(graderSrc)
      const referenceRecomputed = loadsCheckpoint && recomputesMetric

      return {
        ...(baselineValues === null ? {} : { baselineValues }),
        ...(referenceValues === null ? {} : { referenceValues }),
        ...(typeof anchors.upper_bound === 'number' ? { upper: anchors.upper_bound } : {}),
        // direction 只在**确实是两个字面量之一**时才带上。
        ...(anchors.direction === 'minimize' || anchors.direction === 'maximize'
          ? { direction: anchors.direction } : {}),
        ...(referenceRecomputed ? { referenceRecomputed: true } : {}),
      }
    }
    case 'G-SINGLE-SOURCE': {
      // 采集**结构化**声明（键 / 值 / 来源），而不是拼好的字符串。
      //
      // 判定侧要比的是「同一个键有没有不同值」——只传字符串时它只能按
      // 个数判，于是「摘要在两处复述同一口径」会被当成两套并存声明（实测
      // AutoRe 题包：comparison_summary 与 expert_annotation 都写了
      // metric=balanced_accuracy，值完全相同，仍判 REJECT）。
      //
      // 键取**字段名**而非全路径：`comparison_summary.metric` 与
      // `expert_annotation.metric` 归到同一个 `metric` 键下，值不一致才算冲突。
      const comparison = await readJsonIfPresent('optimization_evidence/comparison_summary.json')
      const annotation = await readJsonIfPresent('expert_evidence/expert_annotation.json')
      const declarations = []
      const push = (key, value, source) => {
        if (value === undefined || value === null || value === '') return
        declarations.push({ key, value, source })
      }
      push('metric', comparison?.metric?.name, 'comparison_summary.metric.name')
      push('direction', comparison?.metric?.direction, 'comparison_summary.metric.direction')
      push('metric', annotation?.score_contract?.metric, 'expert_annotation.score_contract.metric')
      push('direction', annotation?.score_contract?.direction, 'expert_annotation.score_contract.direction')
      // direction 可能写成带解释的长串（"minimize（原始指标）；…"），
      // 取开头的第一个字面量再比 —— 与 gates/lib/tools.js 的读取口径一致。
      for (const d of declarations) {
        if (d.key !== 'direction' || typeof d.value !== 'string') continue
        const leading = /^\s*(minimize|maximize)/.exec(d.value)
        if (leading !== null) d.value = leading[1]
      }
      return { anchorDeclarations: declarations, staleDeclarations: [] }
    }
    case 'G-NOP-RESULT': {
      // 教程 v0.3.8 L29 只要求「把同一次 Trial 的 config.json、result.json、
      // reward.txt/json 与运行日志**放入 expert_evidence/**」—— **没有规定子目录名**
      // （早期脚手架固定造 `expert_evidence/nop_selfcheck/`，把一种约定当成了要求）。
      // 因此这里递归查找，按文件名认证据，而不是按目录。
      const found = { config: null, result: null, reward: null, log: null }
      const scan = async (dir, depth = 0) => {
        if (depth > 6) return
        let entries
        try {
          entries = await readdir(resolveTaskPath(taskRoot, dir), { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (entry.name === '__pycache__' || entry.name === 'best_method') continue
          const rel = `${dir}/${entry.name}`
          if (entry.isDirectory()) { await scan(rel, depth + 1); continue }
          const lower = entry.name.toLowerCase()
          if (lower === 'config.json' && found.config === null) found.config = rel
          else if (lower === 'result.json' && found.result === null) found.result = rel
          else if (/^reward\.(txt|json)$/.test(lower) && found.reward === null) found.reward = rel
          else if (/\.log$/.test(lower) && found.log === null) found.log = rel
        }
      }
      await scan('expert_evidence')
      const readEvidence = async (relative) => {
        if (relative === null) return null
        return relative.endsWith('.json')
          ? await readJsonIfPresent(relative)
          : await readIfPresent(relative)
      }
      const config = await readEvidence(found.config)
      const result = await readEvidence(found.result)
      const rewardText = await readEvidence(found.reward)
      let reward = rewardText
      if (typeof rewardText === 'string' && found.reward?.endsWith('.json')) {
        try { reward = JSON.parse(rewardText) } catch { reward = rewardText }
      }
      return {
        config: config ?? undefined,
        result: result ?? undefined,
        reward: reward ?? undefined,
        logPresent: found.log !== null,
        // 四类证据都来自同一目录树 → 视为同一次 Trial（更强的同源性判定需平台侧核对）
        sameTrial: Object.values(found).filter((value) => value !== null).length >= 3,
        evidenceFiles: found,
      }
    }
    case 'G-PACK-VERIFY': {
      // 交付期的三项事实：自验声明、best_method 内容、Git 清理状态。

      // 不 spawn 任何进程 —— Git 状态直接读 .git/config 与 refs，避免门禁依赖 git 可执行文件。
      const runSummary = await readJsonIfPresent('expert_evidence/run_summary.json')

      const bestMethodFiles = []
      const walk = async (dir, depth = 0) => {
        if (depth > 6) return
        let entries
        try {
          entries = await readdir(resolveTaskPath(taskRoot, dir), { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          if (entry.name === '__pycache__') continue
          const rel = `${dir}/${entry.name}`
          if (entry.isDirectory()) await walk(rel, depth + 1)
          else bestMethodFiles.push(rel)
        }
      }
      await walk('expert_evidence/best_method')

      let gitState = null
      const gitConfig = await readIfPresent('.git/config')
      if (gitConfig === undefined) {
        gitState = { isRepo: false }
      } else {
        const remotes = [...gitConfig.matchAll(/^\[remote\s+"([^"]+)"\]/gm)].map((match) => match[1])
        const tags = []
        try {
          for (const name of await readdir(resolveTaskPath(taskRoot, '.git/refs/tags'))) {
            if (!name.startsWith('.')) tags.push(name)
          }
        } catch { /* 无 loose tags */ }
        const packed = await readIfPresent('.git/packed-refs')
        if (typeof packed === 'string') {
          for (const line of packed.split('\n')) {
            const match = /^[0-9a-f]{40}\s+refs\/tags\/(.+)$/.exec(line.trim())
            if (match !== null) tags.push(match[1])
          }
        }
        gitState = { isRepo: true, remotes, tags: [...new Set(tags)] }
      }

      const annotation = await readJsonIfPresent('expert_evidence/expert_annotation.json')
      const expertDoc = await readIfPresent('expert_evidence/专家作业说明文档.md')
      const tomlText = await readIfPresent('workspace/harbor_task/task.toml')
      const taskToml = tomlText === undefined ? null : parseTomlSubset(tomlText)

      // ── 打包一致性三项判据的输入（G14.1–G14.3）──────────────────────────
      //
      // 此前这个分支**不返回** sourceHashes / packedHashes / forbiddenEntries，
      // 而 `gatePackVerify` 的这三个字段默认 `{}`/`{}`/`[]` —— 于是三项恒判 PASS，
      // 报告写着「交付包含全部 **0** 个文件」。空集上的 PASS，判定力为零，
      // 比 FAIL 更危险（FAIL 促使人排查，假绿灯让人以为已验证）。
      //
      // 采集范围与排除项取自任务实际使用的打包脚本 `_m5_pack_submission.py`
      //（DELIVER 三目录 + 缓存/备份排除），细节见 lib/pack-scope.js 的模块说明。
      //
      // 采集失败**不让整个门禁抛错**：那样调用方拿不到任何结论。
      // 改为把失败原因写进 `packError`，由 gatePackVerify 如实报 UNKNOWN。
      let pack = { sourceHashes: {}, packedHashes: {}, forbiddenEntries: [], note: null, packError: null }
      try {
        const { collectSourceHashes, collectPackedHashes, findDeliveryZip } =
          await import('./lib/pack-scope.js')
        const source = await collectSourceHashes(taskRoot)
        const found = await findDeliveryZip(taskRoot, options.artifact)
        if (found.path === null) {
          // 找不到交付 ZIP 时**不猜、不跳过**：三项判据应当报 UNKNOWN。
          pack = {
            sourceHashes: source.files,
            packedHashes: {},
            forbiddenEntries: source.forbidden,
            note: null,
            packError: `未找到交付 ZIP：${found.reason}`,
          }
        } else {
          const packed = await collectPackedHashes(found.path)
          pack = {
            sourceHashes: source.files,
            packedHashes: packed.files,
            forbiddenEntries: [...source.forbidden, ...packed.forbidden],
            note: `交付 ZIP：${found.path}（${packed.entries} 个条目；${found.reason}）`,
            packError: null,
          }
        }
      } catch (error) {
        pack.packError = `采集打包判据输入失败：${error?.message ?? error}`
      }

      return {
        runSummary, bestMethodFiles, gitState, annotation, expertDoc, taskToml,
        sourceHashes: pack.sourceHashes,
        packedHashes: pack.packedHashes,
        forbiddenEntries: pack.forbiddenEntries,
        packNote: pack.note,
        packError: pack.packError,
      }
    }
    default:
      return {}
  }
}

/**
 * 红线 1（答案泄露）要扫描的源码目录 —— 脚手架**真实创建**的那些。
 *
 * 为什么单独提出来并导出：这份清单曾经写错（`workspace/starter` 与
 * `workspace/harbor_task/reference` 两个都不存在），于是 starter 代码从来没被
 * 扫过 —— 而 starter 正是交到解题者手上的那份代码，泄露重灾区。更糟的是接线
 * 测试复刻了同样的错目录，所以它也跟着漏。
 *
 * 现在它是唯一真源：生产路径与接线测试都从这里取，测试不可能再"自己编一套"。
 * 依据见 lib/scaffold.js 创建的目录与 lib/phases.js 声明的交付物。
 */
export const RED_LINE_SOURCE_DIRS = Object.freeze([
  // 参考实现：解题者不可见，但一旦被 starter 引用就是泄露
  'workspace/reference',
  // 解题者可见的三份材料 —— 泄露在这里最直接
  'workspace/harbor_task/environment/starter',
  'workspace/harbor_task/environment/public_eval',
  'workspace/harbor_task/environment/public_assets',
  // 可信评测材料
  'workspace/harbor_task/environment/trusted',
])

/** 供其它模块复用的导出。 */
export { parseTomlSubset }
export {
  PHASES, TASK_MODES, INTAKE_CHECKS, VARIANT_RULES, DEPRECATED_PATHS,
  GATES, VERDICT, TRAJECTORY_FIELDS, R_LO, R_HI, SIGMA_MULT_REQUIRED,
}
