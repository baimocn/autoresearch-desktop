/**
 * 工具清单 —— 把随包分发的 Python 门禁工具登记为可枚举、可执行的描述。
 *
 * 设计约束（来自教程与 SOP 的诚实性要求）：
 *   · 只登记真实存在的脚本，不虚构工具；
 *   · 每个工具声明退出码语义，调用方据此判定而不是猜；
 *   · 需要 Docker / root / GPU 的工具标注前置条件，缺前置时如实返回不可用，
 *     不回落宿主执行、不伪造通过。
 *
 * @module dsh-autoresearch-gates/tools
 */

import { stat, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ASSETS_ROOT = join(HERE, '..', 'assets')

/** 三态退出码语义（SOP 统一约定）。 */
export const EXIT_SEMANTICS = Object.freeze({
  0: 'RECOMMEND / PASS / 通过',
  1: 'REJECT / FAIL / 硬失败',
  2: 'NEEDS_EVIDENCE / MANUAL / 需人工确认',
})

/**
 * 工具登记表。`root` 相对 assets/；`argv` 描述参数如何从工具入参拼装。
 */
export const TOOL_REGISTRY = Object.freeze({
  'milestone-gate': {
    id: 'milestone-gate',
    script: 'sop/tools/milestone_gate.py',
    title: '五道不可跳级里程碑门禁（M1–M5）',
    description: 'M1/M2 做真实数据判定，M3–M5 核对证据引用是否齐全。任一未过不得进入下一阶段。',
    milestones: ['M1', 'M2', 'M3', 'M4', 'M5'],
    requires: ['python3'],
    exitSemantics: EXIT_SEMANTICS,
    note: 'M3–M5 只核对证据引用；发布门的完整语义须两份独立 QA 同源不同会话。',
  },
  'paper-screen': {
    id: 'paper-screen',
    script: 'sop/tools/paper_screen.py',
    title: '选题期零成本静态筛查',
    description: '六类死因过滤器 + 玩具四判据 + 2001 同构标准。项目实测 93% 的题死在这一步。',
    milestones: ['M1'],
    requires: ['python3', 'network'],
    exitSemantics: EXIT_SEMANTICS,
    note: 'rc=1 存在 FAIL（弃题或换切入点）；rc=2 仍有 MANUAL。',
  },
  'feasibility-gate': {
    id: 'feasibility-gate',
    script: 'sop/tools/feasibility_gate.py',
    title: '可行性闸门（判定门是否闭合）',
    description: '门① R_norm ∈ [0.15, 0.8] 与门② Δ ≥ 3σ_B 是否存在可行交集。零 GPU。',
    milestones: ['M2'],
    requires: ['python3'],
    exitSemantics: {
      0: '可行，进入正式 B/R',
      1: '不可行（结构性），止损换题',
      2: '信息不足，需先做探针',
    },
    note: '只有 --from-paper 与 --from-probe 都返回可行，才允许投入全 seed 正式协议。',
  },
  'harbor-task-contract': {
    id: 'harbor-task-contract',
    script: 'sop/tools/harbor_task_contract.py',
    title: 'task.toml 原生契约预检',
    description: '四项必查：task.name 必填、network_mode 合法值、environment_mode=separate、显式 build_timeout_sec。',
    milestones: ['M3'],
    requires: ['python3'],
    exitSemantics: EXIT_SEMANTICS,
    note: '能解析 ≠ 原生接受；须用目标 Harbor 版本的 TaskConfig 真加载。',
  },
  'dockerfile-preflight': {
    id: 'dockerfile-preflight',
    script: 'sop/tools/dockerfile_preflight.py',
    title: 'Dockerfile 构建前静态预检',
    description: '行尾双反斜杠、基础镜像 Python 版本与依赖闭包匹配、--no-deps 债务提醒。',
    milestones: ['M3'],
    requires: ['python3'],
    exitSemantics: EXIT_SEMANTICS,
    note: '静态检查器看不见 Dockerfile 指令语义、apt 源真实内容与 pip 依赖图；不能替代真机构建。',
  },
  'replay-contract-gate': {
    id: 'replay-contract-gate',
    script: 'sop/tools/replay_contract_gate.py',
    title: '可复算契约预检',
    description: '集成方法的 model.pt 是否指回全部成员；pred_test.npy 是否为 NPY + int64。',
    milestones: ['M5'],
    requires: ['python3'],
    exitSemantics: EXIT_SEMANTICS,
    note: '打包前执行；只 torch.save(models[0]) 的写法在可信复算下必然失分。',
  },
  'sandbox-probe-gate': {
    id: 'sandbox-probe-gate',
    script: 'sop/tools/sandbox_probe_gate.py',
    title: '隔离沙盒实测自检',
    description: 'A 静态判据 + B chroot 运行时探测（11 条自检清单）。',
    milestones: ['M3'],
    requires: ['python3', 'root'],
    exitSemantics: EXIT_SEMANTICS,
    note: '沙盒建立失败判基础设施故障（不是候选失败），绝不回落宿主执行。边界是 chroot+seccomp+降权，非内核级强隔离。',
  },
  'candidate-surface-audit': {
    id: 'candidate-surface-audit',
    script: 'sop/tools/candidate_surface_audit.py',
    title: '候选改动空间枚举-勾选审计',
    description: '宣布「某类方法全部失败」前必须枚举-勾选；检测未声明候选与虚报候选。',
    milestones: ['M4'],
    requires: ['python3'],
    exitSemantics: {
      0: '覆盖完整',
      1: '存在未声明候选（或开了 --check-phantom 且有虚报）',
      2: '信息不足',
    },
    note: '无声明时只做枚举并返回 insufficient。',
  },
  'numeric-backsolve': {
    id: 'numeric-backsolve',
    script: 'sop/tools/numeric_backsolve.py',
    title: '跨规模参数数值反推',
    description: '拿官方在已有规模的取值与数据统计量对比，反推真实意图，而不是按文档字面重算。',
    milestones: ['M2'],
    requires: ['python3'],
    exitSemantics: { 0: '纯咨询，无判定失败路径' },
    note: '输出 3 个候选；候选扫描 ≤4 个且每个能说明对应哪种读法。',
  },
  'nop-preflight': {
    id: 'nop-preflight',
    script: 'sop/tools/nop_preflight.py',
    title: '原生 NOP 环境前置预检',
    description: '五项前提：GPU 直通、nvidia runtime 注册、buildx、compose v2、宿主容量 vs 题面声明。',
    milestones: ['M3'],
    requires: ['python3', 'docker'],
    exitSemantics: {
      0: '全部前提就绪',
      1: '存在硬前提不满足（不要启动 Trial）',
      2: '探测不完整（需人工确认）',
    },
    note: '退出码非 0 不得开跑。加速（镜像源）走试验层，不改交付字节。',
  },
  // ── 发布门质检工具：必须解析到「上游 0.3.4」这份，不是教程附件 0.3.2 ──────
  //
  // 理由（实测，非推测）：教程附件版（0.3.2）的 implementation_review.py
  // **没有** --release-self-check / --reviewer-provider / --session-id /
  // --clean-context，也没有 --fail-on incomplete。发布门要的正是这些：
  // qa_consensus.py 会校验 qa_run.clean_context===true、reviewer.* 非空、
  // source.kind==="zip"，缺一项即 NOT_READY。
  //
  // 所以「用哪一份」由**职责**决定，不由「哪一份更新」决定：
  //   · 发布门证据（本处）      → upstream-0.3.4（有能力产出溯源块）
  //   · 教专家按教程判（catalog）→ tutorial 0.3.2（权威口径）
  // 两者是不同职责，不是重复副本。详见 docs/first-principles-dynamic.md §一。
  //
  // `script` 用逻辑名，由 resolveTool 按 UPSTREAM_SOURCES 顺序解析成实路径，
  // 不在本文件写死目录布局（低耦合：gates 不假设 skills 包的结构）。
  'qa-audit': {
    id: 'qa-audit',
    script: 'audit_task.py',
    resolveFrom: 'upstream-0.3.4',
    title: '只读交付审计（上游 0.3.4）',
    description: '静态、不执行的交付审计器：收集 inventory 与数值观察，输出 report.json/md/txt。',
    milestones: ['M5'],
    requires: ['python3'],
    exitSemantics: { 0: '收集完成（未完成初稿）', 1: '参数或输入错误', 2: '参数或输入错误' },
    note: '初次 inventory 与 report 是未完成初稿；不能把关键词命中当语义结论。',
  },
  'qa-implementation-review': {
    id: 'qa-implementation-review',
    script: 'implementation_review.py',
    resolveFrom: 'upstream-0.3.4',
    title: '实现层复核报告（上游 0.3.4，支持 --release-self-check）',
    description: '证据收集 + 已复核的 implementation 报告；QA16/QA18/QA21 由脚本校验，并可用 --release-self-check 产出发布门要求的溯源块。',
    milestones: ['M5'],
    requires: ['python3'],
    exitSemantics: {
      0: '默认 --fail-on never，退出 0 不代表 PASS',
      1: 'PASS 之外的终态',
      2: '参数错误',
    },
    note: '默认 --fail-on never；退出 0 不代表 PASS，必须读报告里的结论字段。' +
      '发布门路径需追加 --release-self-check 与 reviewer/session/clean-context 参数。',
  },
})

/**
 * 上游来源清单 —— 全仓唯一的「哪一份资产在哪」声明。
 *
 * ## 为什么要有这个模块（内聚 / 低耦合）
 *
 * 改造前，`qa` 包用 `join(projectRoot, 'packages', 'dsh-autoresearch-gates',
 * 'assets', 'qa-0.3.4')` 拼路径 —— 即 **qa 硬编码了 gates 的内部目录布局**。
 * gates 一改结构，qa 就静默失效。这不是包，是共享目录的两个视图。
 *
 * 现在所有包都只经此表查询，不拼路径：
 *   · 目录布局变化 → 只改这一处
 *   · 新增上游版本 → 只在此登记
 *
 * ## 每项声明「能力」，而不是只声明「路径」
 *
 * `capabilities` 是**可判定的**事实（由上游脚本的 --help 实测得出），
 * 不是注释。发布门据此选版本，而不是靠谁记得哪份更新。
 */
export const UPSTREAM_SOURCES = Object.freeze({
  'tutorial-v3': {
    id: 'tutorial-v3',
    // 教程 V3 附件：权威**判据口径**。专家签字的是这套。
    // 实测布局：<pkg>/assets/skills-0.3.2/autoresearch-task-qa/scripts/<file>
    root: 'assets/skills-0.3.2/autoresearch-task-qa/scripts',
    package: 'dsh-autoresearch-skills',
    label: '教程 V3 附件（autoresearch-qa-skills-0.3.2）',
    // 实测：这一份的 implementation_review.py 不支持发布门参数。
    capabilities: {
      'release-self-check': false,
      'reviewer-identity': false,
      'clean-context': false,
      'fail-on-incomplete': false,
    },
  },
  'upstream-0.3.4': {
    id: 'upstream-0.3.4',
    // 上游最新实现：产出**发布门证据**所需的能力在这里。
    // 按优先级依次探测，第一个存在的目录生效。
    // 实测两份布局都是**扁平**的（脚本直接在目录下，无 scripts/ 子层）。
    roots: [
      'assets/qa-0.3.4',
      'assets/skills-upstream-0.3.4/autoresearch-task-qa/scripts',
    ],
    package: 'dsh-autoresearch-gates',
    fallbackPackage: 'dsh-autoresearch-skills',
    label: 'autoresearch-skills 上游 0.3.4',
    capabilities: {
      'release-self-check': true,
      'reviewer-identity': true,
      'clean-context': true,
      'fail-on-incomplete': true,
    },
  },
})

/** 上游资产根目录：本包 assets/ 或指定包。 */
export const PROJECT_ROOT = join(HERE, '..', '..', '..')

/**
 * 把逻辑脚本名解析为绝对路径。
 *
 * @param logical 相对来源根的脚本名，如 `implementation_review.py`；
 *                本包自有资产用 `sop/tools/milestone_gate.py` 形式
 * @param sourceId 若给定，只在该来源的候选根目录下找
 * @returns 绝对路径；找不到返回 null（调用方如实报不可用，不回落猜测）
 */
export async function resolveUpstreamAsset(logical, sourceId) {
  const candidates = []
  if (sourceId === undefined) {
    candidates.push(join(ASSETS_ROOT, logical))
  } else {
    const source = UPSTREAM_SOURCES[sourceId]
    if (source === undefined) return null
    const roots = source.roots ?? [source.root]
    for (const root of roots) {
      // 优先在声明包内找，再在其 fallback 包内找。
      for (const pkg of [source.package, source.fallbackPackage]) {
        if (typeof pkg !== 'string') continue
        candidates.push(join(PROJECT_ROOT, 'packages', pkg, root, logical))
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch { /* 继续下一个候选 */ }
  }
  return null
}

/** 检查脚本是否真实存在。 */
export async function resolveTool(toolId) {
  const meta = TOOL_REGISTRY[toolId]
  if (meta === undefined) return undefined
  const absolute = await resolveUpstreamAsset(meta.script, meta.resolveFrom)
  if (absolute === null) return undefined
  try {
    const info = await stat(absolute)
    return info.isFile() ? { ...meta, path: absolute, bytes: info.size } : undefined
  } catch {
    return undefined
  }
}

/** 列出全部工具及其可用性。 */
export async function listTools() {
  const available = []
  const missing = []
  for (const toolId of Object.keys(TOOL_REGISTRY)) {
    const resolved = await resolveTool(toolId)
    if (resolved === undefined) missing.push(TOOL_REGISTRY[toolId])
    else available.push(resolved)
  }
  return { available, missing }
}

/** 探测运行时前置条件：python3 版本与 docker 可用性。 */
export async function probeRuntime() {
  const { spawn } = await import('node:child_process')
  const run = (command, args) => new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ ok: false, detail: '命令不可执行' })
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ ok: false, detail: error.message }))
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }))
  })

  const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']
  let python = null
  for (const candidate of candidates) {
    const result = await run(candidate, ['--version'])
    if (result.ok) { python = { command: candidate, version: result.stdout || result.stderr }; break }
  }

  const docker = await run('docker', ['--version'])
  const compose = docker.ok ? await run('docker', ['compose', 'version']) : { ok: false }
  const buildx = docker.ok ? await run('docker', ['buildx', 'version']) : { ok: false }

  return {
    python: python ?? { command: null, version: null, available: false },
    pythonAvailable: python !== null,
    docker: {
      available: docker.ok,
      version: docker.ok ? (docker.stdout || docker.stderr) : null,
      detail: docker.ok ? null : (docker.stderr || docker.detail || 'docker 不可用'),
    },
    dockerCompose: { available: compose.ok, version: compose.ok ? compose.stdout.split('\n')[0] : null },
    dockerBuildx: { available: buildx.ok, version: buildx.ok ? buildx.stdout.split('\n')[0] : null },
    platform: process.platform,
  }
}

/** 组装命令行参数。只做白名单映射，不拼接 shell 字符串。 */
export function buildArgv(toolId, args) {
  const argv = []
  const push = (flag, value) => {
    if (value === undefined || value === null || value === false) return
    argv.push(flag)
    if (value !== true) argv.push(String(value))
  }

  switch (toolId) {
    case 'milestone-gate':
      push('--milestone', args.milestone)
      push('--title', args.title)
      push('--repo', args.repo)
      push('--paper-url', args.paperUrl)
      push('--community-baseline', args.communityBaseline)
      push('--reported-baseline', args.reportedBaseline)
      push('--delta-percent', args.deltaPercent)
      push('--n-benchmarks', args.nBenchmarks)
      push('--n-ablation', args.nAblation)
      push('--metric-type', args.metricType)
      push('--b', args.b)
      push('--r', args.r)
      push('--u', args.u)
      push('--reference-recomputed', args.referenceRecomputed)
      push('--evidence-dir', args.evidenceDir)
      if (Array.isArray(args.receipts)) for (const receipt of args.receipts) argv.push(receipt)
      if (Array.isArray(args.receipts) && args.receipts.length > 0) {
        argv.splice(argv.length - args.receipts.length, 0, '--receipts')
      }
      break

    case 'paper-screen':
      push('--title', args.title)
      push('--repo', args.repo)
      push('--paper-url', args.paperUrl)
      push('--data', args.data)
      push('--community-baseline', args.communityBaseline)
      push('--reported-baseline', args.reportedBaseline)
      push('--delta-percent', args.deltaPercent)
      push('--n-benchmarks', args.nBenchmarks)
      push('--reports-sigma', args.reportsSigma)
      push('--n-ablation', args.nAblation)
      push('--metric-type', args.metricType)
      push('--out', args.out)
      break

    case 'feasibility-gate':
      push('--from-paper', args.fromPaper)
      push('--from-probe', args.fromProbe)
      push('--b', args.b)
      push('--r', args.r)
      push('--u', args.u)
      push('--u-hint', args.uHint)
      push('--sigma-mult', args.sigmaMult)
      break

    case 'harbor-task-contract':
      push('--task', args.task)
      push('--build-timeout-floor', args.buildTimeoutFloor)
      push('--json', args.json)
      break

    case 'dockerfile-preflight':
      for (const file of args.dockerfiles ?? []) argv.push(file)
      break

    case 'replay-contract-gate':
      push('--solution', args.solution)
      push('--source', args.source)
      push('--json', args.json)
      break

    case 'sandbox-probe-gate':
      push('--source', args.source)
      push('--root', args.root)
      push('--json', args.json)
      break

    case 'candidate-surface-audit':
      push('--surface', args.surface)
      push('--pattern', args.pattern)
      push('--declared', args.declared)
      push('--declared-inline', args.declaredInline)
      push('--check-phantom', args.checkPhantom)
      break

    case 'numeric-backsolve':
      push('--official-value', args.officialValue)
      push('--data-stats', args.dataStats)
      push('--scale-field', args.scaleField)
      push('--official-S', args.officialS)
      push('--target-S', args.targetS)
      break

    case 'nop-preflight':
      push('--task', args.task)
      push('--docker-host', args.dockerHost)
      push('--cuda-image', args.cudaImage)
      push('--capacity-only', args.capacityOnly)
      push('--no-gpu', args.noGpu)
      break

    case 'qa-audit':
      push(args.source, true)
      push('--out-dir', args.outDir)
      break

    case 'qa-implementation-review':
      push(args.source, true)
      push('--out-dir', args.outDir)
      push('--policy', args.policy)
      push('--review', args.review)
      push('--fail-on', args.failOn)
      break

    default:
      throw new Error(`未知工具：${toolId}`)
  }

  return argv.filter((value) => value !== undefined && value !== null)
}

/**
 * 该工具在当前环境是否可运行。
 * 缺前置时返回 { runnable: false, reason }，调用方须如实报告不可用。
 */
export function checkPrerequisites(meta, runtime) {
  if (!runtime.pythonAvailable) {
    return { runnable: false, reason: '未检测到 Python 解释器；本工具无法运行' }
  }
  const needs = meta.requires ?? []
  if (needs.includes('docker') && !runtime.docker.available) {
    return { runnable: false, reason: `该工具需要 Docker，但当前环境不可用（${runtime.docker.detail ?? '未知原因'}）` }
  }
  if (needs.includes('root')) {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
    if (!isRoot) {
      return {
        runnable: 'partial',
        reason: '运行时探测需要 root；当前仅能做静态判据部分。沙盒建立失败判基础设施故障，不回落宿主执行。',
      }
    }
  }
  return { runnable: true, reason: null }
}
