/**
 * 门禁判定 —— 把教程与 SOP 的判据实现为纯函数，便于单测与复用。
 *
 * 三态语义与 SOP `tools/milestone_gate.py` 保持一致：
 *   RECOMMEND(0) / NEEDS_EVIDENCE(2) / REJECT(1)
 * 不做总分补偿：任一硬门 FAIL 即 REJECT。
 *
 * @module dsh-autoresearch/gates
 */

/** 门禁结论三态。 */
export const VERDICT = Object.freeze({
  RECOMMEND: 'RECOMMEND',
  NEEDS_EVIDENCE: 'NEEDS_EVIDENCE',
  REJECT: 'REJECT',
})

export const VERDICT_EXIT_CODE = Object.freeze({
  [VERDICT.RECOMMEND]: 0,
  [VERDICT.NEEDS_EVIDENCE]: 2,
  [VERDICT.REJECT]: 1,
})

/** 单条判据结果。 */
export function check(id, status, detail, fix) {
  return { id, status, detail, fix: fix ?? null }
}

const ok = (id, detail) => check(id, 'PASS', detail)
const fail = (id, detail, fix) => check(id, 'FAIL', detail, fix)
const unknown = (id, detail, fix) => check(id, 'UNKNOWN', detail, fix)

/** 由判据集合汇总三态。 */
export function verdictOf(checks) {
  if (checks.some((item) => item.status === 'FAIL')) return VERDICT.REJECT
  if (checks.some((item) => item.status === 'UNKNOWN')) return VERDICT.NEEDS_EVIDENCE
  return VERDICT.RECOMMEND
}

// ── 教程评分标定常量（正文，不得改动） ───────────────────────────────────────

/** Reference 公开归一化分数必须落在 [R_LO, R_HI]。 */
export const R_LO = 0.15
export const R_HI = 0.8
/** 正向改善至少需要的 Baseline 样本标准差倍数。 */
export const SIGMA_MULT_REQUIRED = 3.0
/** 达到该倍数即为强证据。 */
export const SIGMA_MULT_STRONG = 5.0
/** seed 数量下限：协议未规定时 B/R 各至少 3 次，波动较大时至少 5 次。 */
export const MIN_SEEDS = 3
export const MIN_SEEDS_VOLATILE = 5
/** 有效执行时长下限（小时）与 7 小时例外下限。 */
export const MIN_EFFECTIVE_HOURS = 10
export const EXCEPTION_EFFECTIVE_HOURS = 7
/** 容器稳定性目标（小时），独立于 Agent 有效时长。 */
export const CONTAINER_STABILITY_HOURS = 12
/** 单轮「修改 → 运行 → 得到 Public/Dev 分数」墙钟预算（小时）。 */
export const PER_ROUND_BUDGET_HOURS = 2

// ── 数值工具 ────────────────────────────────────────────────────────────────

export function mean(values) {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** n−1 样本标准差，与教程公式一致。 */
export function sampleStd(values) {
  if (values.length < 2) return null
  const average = mean(values)
  const sum = values.reduce((total, value) => total + (value - average) ** 2, 0)
  return Math.sqrt(sum / (values.length - 1))
}

/**
 * 归一化分数。maximize 用 (x−B)/(U−B)，minimize 用 (B−x)/(B−U)。
 * 连续、单调、不裁剪：允许 <0 与 >1。
 */
export function normalize(value, baseline, upper, direction) {
  if (direction === 'maximize') return (value - baseline) / (upper - baseline)
  if (direction === 'minimize') return (baseline - value) / (baseline - upper)
  throw new Error(`未知的指标方向：${direction}`)
}

/**
 * 计算使 R_norm ∈ [R_LO, R_HI] 可达的 Baseline 均值区间。
 *
 * 推导（maximize）：score = (R − B)/(U − B) ∈ [R_LO, R_HI]，R 固定，
 * 解出 B 的两个端点：B = (R − score·U)/(1 − score)。
 * minimize 时把数轴翻转后形式一致。
 *
 * 返回 null 表示该配置下不存在可达区间（此时应当改 U 或换指标）。
 *
 * 这条判据对应 SOP feasibility_gate.py 的同名检查：它拦住的是
 * 「靠让 Baseline 变差来达标」——那会同时抬高 σ_B，与门② 互斥（L2）。
 */
export function reachableBaselineRange(referenceMean, upper, direction) {
  if (!Number.isFinite(referenceMean) || !Number.isFinite(upper)) return null
  if (upper === referenceMean) return null

  // 统一到 maximize 视角：minimize 时翻转数轴。
  const flip = (value) => (direction === 'minimize' ? -value : value)
  const r = flip(referenceMean)
  const u = flip(upper)

  const solveFor = (score) => {
    const denominator = 1 - score
    if (denominator === 0) return null
    return (r - score * u) / denominator
  }
  const first = solveFor(R_LO)
  const second = solveFor(R_HI)
  if (first === null || second === null) return null

  const lo = Math.min(first, second)
  const hi = Math.max(first, second)
  return direction === 'minimize' ? { lo: -hi, hi: -lo } : { lo, hi }
}

// ── G 门禁实现 ──────────────────────────────────────────────────────────────

/**
 * G-SELECT（M1 selection）：论文身份/许可/方法级优化面/题库状态。
 * 静态判据来自 SOP `paper_screen.py` 的六类死因过滤器。
 */
export function gateSelection(input) {
  const checks = []
  const {
    title, repo, license, optimizationSurface, duplicateChecked,
    communityBaseline, reportedBaseline, deltaPercent, metricType,
    benchmarkCount, ablationCount,
  } = input

  checks.push(title ? ok('G0.1', `论文标题已提供：${title}`) : fail('G0.1', '缺少论文标题', '补齐 title 后重跑'))
  checks.push(
    repo && /^[\w.-]+\/[\w.-]+$/.test(repo)
      ? ok('G0.2', `官方仓库标识合法：${repo}`)
      : fail('G0.2', '官方仓库缺失或格式非 owner/name', '确认官方源码仓存在且非空壳'),
  )
  checks.push(
    license && license !== 'UNKNOWN'
      ? ok('G0.3', `许可边界已确认：${license}`)
      : unknown('G0.3', '许可未确认', '查阅仓库 LICENSE 与数据集许可；未知项不能写成通过'),
  )

  // 方法级优化面：只搜索学习率/轮数/权重的一组数字不合格。
  const surface = optimizationSurface ?? {}
  if (surface.methodLevel === true) {
    checks.push(ok('G0.4', `优化面为方法级：${surface.summary ?? '已声明'}`))
  } else if (surface.methodLevel === false) {
    checks.push(fail('G0.4', '优化面仅为超参数搜索，不属于本批次接收题型',
      '开放真实方法接口（目标形式、采样/更新规则、模型模块或推理策略）并保留评分约束'))
  } else {
    checks.push(unknown('G0.4', '优化面未判定', '交叉核对 instruction、候选解析/guard 与代码调用链'))
  }

  checks.push(
    duplicateChecked === true
      ? ok('G0.5', '题库查重已完成')
      : unknown('G0.5', '题库权威状态未核对', '查重与难度确认；无法访问权威题库时结论必须记为 UNKNOWN'),
  )

  if (metricType === 'llm-judge' || metricType === 'winrate') {
    checks.push(unknown('G0.6', `指标类型为 ${metricType}，U 不可构造`,
      '改用物理量指标，或写明与论文主张的映射并接受平台复核'))
  } else if (metricType === 'physical') {
    checks.push(ok('G0.6', '指标为物理量，U 可构造'))
  } else {
    checks.push(unknown('G0.6', '指标类型未声明', '声明 physical / llm-judge / winrate'))
  }

  if (Number.isFinite(benchmarkCount) && benchmarkCount < 3) {
    checks.push(unknown('G0.7', `主表 benchmark 数 ${benchmarkCount} < 3，广度不足`,
      '补充跨 benchmark 证据或换题'))
  } else if (Number.isFinite(benchmarkCount)) {
    checks.push(ok('G0.7', `主表 benchmark 数 ${benchmarkCount} ≥ 3`))
  } else {
    checks.push(unknown('G0.7', '主表 benchmark 数未提供', '统计论文主表 benchmark 数'))
  }

  if (Number.isFinite(ablationCount) && ablationCount < 1) {
    checks.push(unknown('G0.8', '缺少消融证据', '确认方法组件可分离，补充消融数'))
  } else if (Number.isFinite(ablationCount)) {
    checks.push(ok('G0.8', `消融数 ${ablationCount} ≥ 1`))
  } else {
    checks.push(unknown('G0.8', '消融数未提供', '统计论文消融数量'))
  }

  if (Number.isFinite(communityBaseline) && Number.isFinite(reportedBaseline)) {
    const gap = Math.abs(communityBaseline - reportedBaseline)
    if (gap > 15) {
      checks.push(fail('G0.9', `baseline 口径不可比：社区公认值 ${communityBaseline} 与论文报告值 ${reportedBaseline} 相差 ${gap.toFixed(1)}`,
        '核对是否作者自跑口径；不可比即弃题'))
    } else {
      checks.push(ok('G0.9', `baseline 口径差 ${gap.toFixed(1)} ≤ 15`))
    }
  } else {
    checks.push(unknown('G0.9', 'baseline 口径对照缺失',
      '提供 --community-baseline 与 --reported-baseline 以核对可比性'))
  }

  if (Number.isFinite(deltaPercent) && deltaPercent < 10) {
    checks.push(unknown('G0.10', `声称增益 ${deltaPercent}% < 10%，可能无足够优化空间`,
      '确认是否有更大量级的合法改进方向'))
  } else if (Number.isFinite(deltaPercent)) {
    checks.push(ok('G0.10', `声称增益 ${deltaPercent}% ≥ 10%`))
  } else {
    checks.push(unknown('G0.10', '声称增益未提供', '从论文主图读取增益幅度'))
  }

  return { gate: 'G-SELECT', milestone: 'M1', verdict: verdictOf(checks), checks }
}

/**
 * G-FEASIBILITY（M2 pilot）：判定门是否闭合。
 * 门① R_norm ∈ [0.15, 0.8]；门② Δ ≥ 3σ_B。
 */
export function gateFeasibility(input) {
  const checks = []
  const { baselineValues, referenceValues, upper, direction = 'maximize', referenceRecomputed } = input

  if (!Array.isArray(baselineValues) || baselineValues.length === 0) {
    checks.push(unknown('G1.1', '缺少 Baseline 实测值', '先跑 1 seed × B 探针'))
  }
  if (!Array.isArray(referenceValues) || referenceValues.length === 0) {
    checks.push(unknown('G1.2', '缺少 Reference 实测值', '先跑 1 seed × R 探针'))
  }
  if (!Number.isFinite(upper)) {
    checks.push(unknown('G1.3', '缺少 U（预计可达上限）', '结合已知方法、噪声与资源约束给出 best-effort 估计'))
  }
  if (checks.some((item) => item.status === 'UNKNOWN')) {
    return { gate: 'G-FEASIBILITY', milestone: 'M2', verdict: VERDICT.NEEDS_EVIDENCE, checks }
  }

  const bMean = mean(baselineValues)
  const rMean = mean(referenceValues)
  const sigmaB = sampleStd(baselineValues)

  if (baselineValues.length < MIN_SEEDS) {
    checks.push(unknown('G1.4',
      `Baseline 仅 ${baselineValues.length} 次运行，协议未规定时至少 ${MIN_SEEDS} 次`,
      `补足到至少 ${MIN_SEEDS} 次（波动较大时 ${MIN_SEEDS_VOLATILE} 次）`))
  } else {
    checks.push(ok('G1.4', `Baseline 运行 ${baselineValues.length} 次`))
  }

  if (upper === bMean) {
    checks.push(fail('G1.5', 'U 与 B 相同，归一化分母为 0', '改用 Metric Ceiling 并记录选择依据'))
    return { gate: 'G-FEASIBILITY', milestone: 'M2', verdict: VERDICT.REJECT, checks }
  }

  // U 必须在正确方向上越过 B，否则归一化公式的分母为负、分数方向整体反转。
  // 不先查这一条会把「U 方向配错」误报成「Reference 提升不足」，
  // 让使用者去调题目设计，而真正该改的是 U 的估计。
  const uDirectionWrong = direction === 'maximize' ? upper < bMean : upper > bMean
  if (uDirectionWrong) {
    const expected = direction === 'maximize' ? '大于' : '小于'
    checks.push(fail('G1.5',
      `U=${upper} 必须${expected} B=${bMean}（${direction} 指标），当前方向相反`,
      direction === 'maximize'
        ? 'U 是预计可达上限，应高于 Baseline 均值；检查是否把方向填反或把 U 填成了地板'
        : 'U 是预计可达下限，应低于 Baseline 均值；检查是否把方向填反或把 U 填成了上限'))
    return { gate: 'G-FEASIBILITY', milestone: 'M2', verdict: VERDICT.REJECT, checks }
  }

  const rNorm = normalize(rMean, bMean, upper, direction)

  // R_norm 目标区间的可达性。
  //
  // 归一化分数由 B 与 U 共同决定，而 B 是实测值、改不了。若当前 B 落在一个
  // 使 R_norm 必然出界的区间里，说明标定结构上不可行 —— 该改的是指标、规模
  // 或 U 的依据，而不是「想办法让 Baseline 变差」。
  //
  // 这条判据来自 SOP 的 L2 教训：靠拉低 Baseline 达标会同时抬高 σ_B，
  // 与门② 互斥。缺了它会把「结构性不可行」误报成「Reference 提升不足」，
  // 让使用者去调方法，而问题其实在标定。
  const reachable = reachableBaselineRange(rMean, upper, direction)
  if (reachable !== null) {
    const inRange = bMean >= reachable.lo && bMean <= reachable.hi
    checks.push(inRange
      ? ok('G1.6a',
        `当前 B=${bMean.toFixed(4)} 落在使 R_norm∈[${R_LO}, ${R_HI}] 可达的区间 ` +
        `[${reachable.lo.toFixed(4)}, ${reachable.hi.toFixed(4)}] 内`)
      : fail('G1.6a',
        `当前 B=${bMean.toFixed(4)} 不在使 R_norm∈[${R_LO}, ${R_HI}] 可达的区间 ` +
        `[${reachable.lo.toFixed(4)}, ${reachable.hi.toFixed(4)}] 内`,
        '标定结构上不可行：改指标定义、换切入规模，或重新论证 U 的依据。' +
        '不要靠让 Baseline 变差来达标 —— 那会同时抬高 σ_B，与门② 互斥（SOP L2）'))
  }

  checks.push(
    rNorm >= R_LO && rNorm <= R_HI
      ? ok('G1.6', `Reference 归一化 ${rNorm.toFixed(4)} ∈ [${R_LO}, ${R_HI}]`)
      : fail('G1.6', `Reference 归一化 ${rNorm.toFixed(4)} 落在 [${R_LO}, ${R_HI}] 之外`,
        rNorm < R_LO
          ? 'Reference 提升过弱：确认方法是否真实生效，或调整 U 的估计依据'
          : 'Reference 已饱和：保留题面未直接提示的合法改进空间，或提高 U 并给出依据'),
  )

  const delta = direction === 'maximize' ? rMean - bMean : bMean - rMean
  if (sigmaB === null || sigmaB === 0) {
    checks.push(unknown('G1.7', 'σ_B 不可计算（样本不足或零波动）',
      '增加独立运行次数；确定性评估改用预先声明的容差'))
  } else {
    const multiple = delta / sigmaB
    if (delta <= 0) {
      checks.push(fail('G1.7', `改善方向为负（Δ=${delta.toFixed(6)}）`, 'Reference 未优于 Baseline，修协议或拒题'))
    } else if (multiple < SIGMA_MULT_REQUIRED) {
      checks.push(fail('G1.7', `Δ=${delta.toFixed(6)} 仅 ${multiple.toFixed(2)}σ_B < ${SIGMA_MULT_REQUIRED}σ`,
        '低于门槛不通过：改进方法或调整指标/规模'))
    } else if (multiple < SIGMA_MULT_STRONG) {
      checks.push(unknown('G1.7', `Δ=${delta.toFixed(6)} 达 ${multiple.toFixed(2)}σ_B，可接受但建议复核`,
        `增加重复次数并标注供平台复核（≥${SIGMA_MULT_STRONG}σ_B 为强证据）`))
    } else {
      checks.push(ok('G1.7', `Δ=${delta.toFixed(6)} 达 ${multiple.toFixed(2)}σ_B，强证据`))
    }
  }

  const headroom = direction === 'maximize' ? upper - rMean : rMean - upper
  if (sigmaB !== null && sigmaB > 0 && headroom < SIGMA_MULT_REQUIRED * sigmaB) {
    checks.push(unknown('G1.8',
      `Reference 到 U 的剩余 headroom ${headroom.toFixed(6)} 不足 ${SIGMA_MULT_REQUIRED}σ_B`,
      '原则上应保留不少于 3σ_B 的 headroom；否则调整 U 依据'))
  } else {
    checks.push(ok('G1.8', `Reference 到 U 的剩余 headroom ${headroom.toFixed(6)} 充足`))
  }

  checks.push(
    referenceRecomputed === true
      ? ok('G1.9', 'evaluator 可从候选产物独立复算主指标')
      : unknown('G1.9', '未声明独立复算能力', '上游要求 evaluator 能从候选产物独立复算主指标'),
  )

  return { gate: 'G-FEASIBILITY', milestone: 'M2', verdict: verdictOf(checks), checks }
}

/**
 * G-CONTRACT：task.toml 原生契约预检四项必查（SOP 规则 23）。
 * 传入已解析的 toml 对象；不在此处做文件 IO。
 */
export function gateTaskContract(toml) {
  const checks = []
  const task = toml?.task ?? {}
  const environment = toml?.environment ?? {}
  const verifier = toml?.verifier ?? {}
  const verifierEnvironment = verifier.environment ?? {}
  const VALID_NETWORK = new Set(['no-network', 'public', 'allowlist'])

  checks.push(
    typeof task.name === 'string' && task.name.trim() !== ''
      ? ok('G2.1', `[task].name = ${task.name}`)
      : fail('G2.1', '[task].name 必填且不得为空', '补 [task] name 字段'),
  )

  for (const [label, mode] of [['environment', environment.network_mode], ['verifier.environment', verifierEnvironment.network_mode]]) {
    if (mode === undefined) {
      checks.push(fail(`G2.2:${label}`, `${label}.network_mode 未声明`, `设为 ${[...VALID_NETWORK].join(' / ')} 之一`))
    } else if (!VALID_NETWORK.has(mode)) {
      checks.push(fail(`G2.2:${label}`, `${label}.network_mode = "${mode}" 非原生接受值`,
        `只能是 ${[...VALID_NETWORK].join(' / ')}`))
    } else {
      checks.push(ok(`G2.2:${label}`, `${label}.network_mode = ${mode}`))
    }
  }

  checks.push(
    verifier.environment_mode === 'separate'
      ? ok('G2.3', '[verifier].environment_mode = "separate"')
      : fail('G2.3', `[verifier].environment_mode = ${JSON.stringify(verifier.environment_mode)}`,
        '必须显式设为 "separate"'),
  )

  const buildTimeout = environment.build_timeout_sec
  if (!Number.isFinite(buildTimeout)) {
    checks.push(fail('G2.4', '[environment].build_timeout_sec 未显式声明',
      '默认 600s 装不下含 torch 的镜像；显式设为 ≥3600'))
  } else if (buildTimeout < 3600) {
    checks.push(fail('G2.4', `build_timeout_sec = ${buildTimeout} < 3600`,
      '含重型依赖的镜像首建实测可达 1578s；提高到 ≥3600'))
  } else {
    checks.push(ok('G2.4', `build_timeout_sec = ${buildTimeout} ≥ 3600`))
  }

  const artifacts = toml?.artifacts
  checks.push(
    Array.isArray(artifacts) && artifacts.includes('/workspace/solution')
      ? ok('G2.5', `顶层 artifacts = ${JSON.stringify(artifacts)}`)
      : fail('G2.5', `顶层 artifacts = ${JSON.stringify(artifacts)} 未包含 /workspace/solution`,
        '统一采用顶层 artifacts = ["/workspace/solution"]'),
  )

  checks.push(
    toml?.schema_version !== undefined
      ? ok('G2.6', `schema_version = ${toml.schema_version}`)
      : fail('G2.6', 'schema_version 缺失', '按目标 Harbor 版本声明 schema_version'),
  )

  return { gate: 'G-CONTRACT', milestone: 'M3', verdict: verdictOf(checks), checks }
}

/**
 * G-DOCKERFILE：双镜像路径契约静态预检（教程「Docker 路径契约」表）。
 */
export function gateDockerPathContract(input) {
  const checks = []
  const { environmentDockerfile, testsDockerfile, instructionMd } = input

  if (typeof environmentDockerfile !== 'string' || environmentDockerfile === '') {
    checks.push(unknown('G3.1', 'environment/Dockerfile 内容未提供', '读取 environment/Dockerfile 后重跑'))
  } else {
    const copies = [...environmentDockerfile.matchAll(/^\s*COPY\s+(\S+)/gim)].map((match) => match[1])
    const escaped = copies.filter((source) => source.startsWith('../') || source.startsWith('/'))
    checks.push(
      escaped.length === 0
        ? ok('G3.1', `environment/Dockerfile 的 COPY 源均为 context 内相对路径（${copies.length} 条）`)
        : fail('G3.1', `environment/Dockerfile 出现越界 COPY：${escaped.join(', ')}`,
          'Agent 的源路径必须相对 environment/，禁止 COPY ../'),
    )
    const leaks = copies.filter((source) => /(^|\/)(tests|hidden_assets|reference)(\/|$)/.test(source))
    checks.push(
      leaks.length === 0
        ? ok('G3.2', 'environment/Dockerfile 未复制 tests/、Hidden 或 Reference')
        : fail('G3.2', `environment/Dockerfile 复制了私有内容：${leaks.join(', ')}`,
          '私有 tests/、Hidden、Reference 不得进入 Agent 镜像'),
    )
  }

  if (typeof testsDockerfile !== 'string' || testsDockerfile === '') {
    checks.push(unknown('G3.3', 'tests/Dockerfile 内容未提供', '读取 tests/Dockerfile 后重跑'))
  } else {
    const copies = [...testsDockerfile.matchAll(/^\s*COPY\s+(\S+)/gim)].map((match) => match[1])
    const escaped = copies.filter((source) => source.startsWith('../') || source.startsWith('/'))
    checks.push(
      escaped.length === 0
        ? ok('G3.3', `tests/Dockerfile 的 COPY 源均为 context 内相对路径（${copies.length} 条）`)
        : fail('G3.3', `tests/Dockerfile 出现越界 COPY：${escaped.join(', ')}`,
          'Verifier 的源路径必须相对 tests/'),
    )
    const twoBackslash = /\r?\n[^\n]*\\\\\r?\n/.test(testsDockerfile)
    checks.push(
      twoBackslash
        ? fail('G3.4', 'tests/Dockerfile 疑似行尾双反斜杠（实测静态全绿、真机必挂）',
          '修正续行写法后重跑 dockerfile 预检')
        : ok('G3.4', 'tests/Dockerfile 未见行尾双反斜杠'),
    )
    const noDeps = /--no-deps/.test(testsDockerfile)
    checks.push(
      noDeps
        ? unknown('G3.5', 'tests/Dockerfile 使用 --no-deps，跳过的运行时依赖必须回写进交付件',
          '补齐被跳过的依赖并在交付说明中登记')
        : ok('G3.5', 'tests/Dockerfile 未使用 --no-deps'),
    )
  }

  if (typeof instructionMd === 'string' && instructionMd !== '') {
    const sections = ['Goal', 'Task Setting', 'Objective and Metrics', 'Allowed Scope',
      'Hard Boundaries', 'Submission Instructions', 'Workflow & Iteration', 'Completion Criteria']
    const missing = sections.filter((section) => !new RegExp(`^##\\s+${section}\\s*$`, 'm').test(instructionMd))
    checks.push(
      missing.length === 0
        ? ok('G3.6', `instruction.md 含完整八章节`)
        : fail('G3.6', `instruction.md 缺少章节：${missing.join(', ')}`,
          '补齐八章节，不得保留模板注释'),
    )
    const leaks = ['arxiv', 'arXiv', 'github.com/', 'arXiv:'].filter((token) => instructionMd.includes(token))
    checks.push(
      leaks.length === 0
        ? ok('G3.7', 'instruction.md 未见论文标题/arXiv ID/仓库名等泄露线索')
        : unknown('G3.7', `instruction.md 疑似出现答案线索：${leaks.join(', ')}`,
          '题面不得直接暴露论文标题、公开解法仓库或其他答案线索'),
    )
  }

  return { gate: 'G-DOCKERFILE', milestone: 'M3', verdict: verdictOf(checks), checks }
}

/** 轨迹八字段（教程第 3 章，顺序即规范顺序）。 */
export const TRAJECTORY_FIELDS = Object.freeze([
  'round', 'policy_name', 'method_summary', 'status', 'score', 'failure_reason', 'retained_best', 'time',
])

const TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/** 校验一条轮次记录；返回问题清单（空数组表示合规）。 */
export function validateTrajectoryRound(round, index) {
  const problems = []
  const where = `rounds[${index}]`
  const extra = Object.keys(round).filter((key) => !TRAJECTORY_FIELDS.includes(key))
  if (extra.length > 0) problems.push(`${where} 含未声明字段：${extra.join(', ')}`)

  if (round.round !== index + 1) problems.push(`${where}.round = ${round.round}，应从 1 起按顺序递增`)
  if (typeof round.policy_name !== 'string' || round.policy_name.trim() === '') {
    problems.push(`${where}.policy_name 必须为非空字符串`)
  }
  if (typeof round.method_summary !== 'string' || round.method_summary.trim() === '') {
    problems.push(`${where}.method_summary 必须为 1–3 句非空说明`)
  }
  if (typeof round.status !== 'string' || round.status.trim() === '') {
    problems.push(`${where}.status 必须填写真实执行状态`)
  }
  if (round.score !== null && !Number.isFinite(round.score)) {
    problems.push(`${where}.score 必须是有限数值或 null`)
  }
  if (round.score === null && (round.failure_reason === null || round.failure_reason === undefined)) {
    problems.push(`${where} 未出分时必须写 failure_reason`)
  }
  if (round.status === 'ok' && round.failure_reason !== null) {
    problems.push(`${where} 成功时 failure_reason 应为 null`)
  }
  if (typeof round.retained_best !== 'boolean') problems.push(`${where}.retained_best 必须为布尔值`)
  if (typeof round.time !== 'string' || !TIME_PATTERN.test(round.time)) {
    problems.push(`${where}.time 必须是 YYYY-MM-DD HH:mm:ss 字符串`)
  }
  return problems
}

/**
 * G-TRAJECTORY：两条轨迹的字段、时长与 7 小时例外资格（QA16/QA18/QA21）。
 */
export function gateTrajectory(input) {
  const checks = []
  const { codexTrajectory, seedTrajectory, runSummary } = input

  for (const [label, trajectory] of [['trajectory_codex.json', codexTrajectory], ['trajectory_seed.json', seedTrajectory]]) {
    if (!trajectory || !Array.isArray(trajectory.rounds)) {
      checks.push(unknown(`G11:${label}`, `${label} 缺失或 rounds 不是数组`, '按真实轮次整理 rounds 数组'))
      continue
    }
    if (trajectory.rounds.length === 0) {
      checks.push(unknown(`G11:${label}`, `${label} 的 rounds 为空`, '补真实迭代记录；不得用 Reference 冒充'))
      continue
    }
    const problems = trajectory.rounds.flatMap((round, index) => validateTrajectoryRound(round, index))
    checks.push(
      problems.length === 0
        ? ok(`G11:${label}`, `${label} 共 ${trajectory.rounds.length} 轮，八字段齐全`)
        : fail(`G11:${label}`, `${label} 字段问题 ${problems.length} 项：${problems.slice(0, 3).join('；')}`,
          '按八字段规范补齐；失败也保留记录，未出分记 null 并写明原因'),
    )
  }

  const runs = runSummary?.agent_execution
  if (!Array.isArray(runs) || runs.length < 2) {
    checks.push(unknown('G11:hours', 'run_summary.json 缺少两条模型组合的执行记录',
      '分别记录 Codex + GPT-5.6 Sol 与 Codex + Seed 2.1 Turbo'))
  } else {
    const exception = runSummary.fast_iteration_exception ?? {}
    const used = exception.used === true
    const floor = used ? EXCEPTION_EFFECTIVE_HOURS : MIN_EFFECTIVE_HOURS
    for (const run of runs) {
      const label = `${run.runtime} + ${run.model}`
      if (!Number.isFinite(run.duration_hours)) {
        checks.push(fail(`G11:hours:${label}`, `${label} 的 duration_hours 缺失或非数值`, '填实际有效执行时长'))
      } else if (run.duration_hours < floor) {
        checks.push(fail(`G11:hours:${label}`, `${label} 有效时长 ${run.duration_hours}h < ${floor}h`,
          used ? '不满足 7 小时例外' : `默认各不少于 ${MIN_EFFECTIVE_HOURS} 小时，两条不相加`))
      } else {
        checks.push(ok(`G11:hours:${label}`, `${label} 有效时长 ${run.duration_hours}h ≥ ${floor}h`))
      }
    }
    if (used) {
      const exceptionOk = exception.non_training === true && exception.short_iterations === true &&
        exception.rollable_proved === true && typeof exception.evidence === 'string' && exception.evidence.trim() !== ''
      checks.push(
        exceptionOk
          ? ok('G11:exception', '7 小时例外四项资格与证据齐备')
          : fail('G11:exception', '7 小时例外未满足全部条件',
            '须同时为 true：non_training / short_iterations / rollable_proved，且 evidence 说明依据'),
      )
    }
  }

  return { gate: 'G-TRAJECTORY', milestone: 'M4', verdict: verdictOf(checks), checks }
}

/**
 * G-NOP-RESULT：NOP 自检通过判据（SOP 规则 10 与 L11 通过判据）。
 * 传入同一次 Trial 的四件套元数据。
 */
export function gateNopResult(input) {
  const checks = []
  const { config, result, reward, logPresent, sameTrial } = input

  checks.push(config ? ok('G6.1', 'config.json 存在') : fail('G6.1', 'config.json 缺失', '随题包提交同一次 Trial 的 config.json'))
  checks.push(result ? ok('G6.2', 'result.json 存在') : fail('G6.2', 'result.json 缺失', '随题包提交同一次 Trial 的 result.json'))
  checks.push(
    typeof logPresent === 'boolean' && logPresent
      ? ok('G6.3', '运行日志存在')
      : fail('G6.3', '运行日志缺失', '提交该次 Trial 的运行日志'),
  )

  if (!result) {
    checks.push(unknown('G6.4', '无法核对 finished_at / exception_info', '提供 result.json 后重跑'))
  } else {
    checks.push(
      result.finished_at
        ? ok('G6.4', `Trial 正常结束于 ${result.finished_at}`)
        : fail('G6.4', 'finished_at 为空，Trial 未正常结束', '修复构建/移交/评分异常后重新自检'),
    )
    checks.push(
      !result.exception_info
        ? ok('G6.5', 'exception_info 为空')
        : fail('G6.5', `存在异常：${JSON.stringify(result.exception_info)}`, '按失败类型修复后重新自检'),
    )
    const mode = result.verifier_environment_mode ?? result.verifier?.environment_mode
    checks.push(
      mode === 'separate'
        ? ok('G6.6', '独立 Verifier 已按 separate 执行')
        : fail('G6.6', `verifier_environment_mode = ${JSON.stringify(mode)}`, '确认 separate 实际生效'),
    )
    const agentName = result.agent_info?.name ?? config?.agent?.name
    checks.push(
      agentName === 'nop'
        ? ok('G6.7', 'Agent 类型为 nop')
        : fail('G6.7', `Agent 类型为 ${JSON.stringify(agentName)}，非 nop`, '在目标 Harbor 将 Agent 类型设为 nop'),
    )
    const rewards = result.verifier_result?.rewards
    const scalar = typeof rewards === 'number' ? rewards : (rewards?.reward ?? null)
    checks.push(
      Number.isFinite(scalar)
        ? ok('G6.8', `reward 为有限数值 ${scalar}`)
        : fail('G6.8', `reward 非有限数值：${JSON.stringify(rewards)}`, '评分脚本必须实际出分并写入约定文件'),
    )
  }

  const rewardValue = typeof reward === 'number' ? reward : reward?.reward
  checks.push(
    Number.isFinite(rewardValue)
      ? ok('G6.9', `reward 文件含有限数值 ${rewardValue}`)
      : fail('G6.9', `reward 文件内容非有限数值：${JSON.stringify(reward)}`,
        'reward.txt 存单个有限数值；reward.json 存数值键值对象'),
  )

  checks.push(
    sameTrial === true
      ? ok('G6.10', '四类证据来自同一次 Trial')
      : fail('G6.10', '四类证据不同源', 'config/result/reward/日志必须来自同一次 Trial，不得拼接'),
  )

  return { gate: 'G-NOP-RESULT', milestone: 'M3', verdict: verdictOf(checks), checks }
}

/**
 * G-REPLAY-CONTRACT：提交物可复算契约（SOP 规则 20）。
 * 只做静态判据，真实复算由 Verifier 承担。
 */
export function gateReplayContract(input) {
  const checks = []
  const { ensembleHints = [], singleSave = [], predictionDtype } = input

  if (ensembleHints.length > 0 && singleSave.length > 0) {
    checks.push(fail('G4.1',
      `检测到集成提示（${ensembleHints.join(', ')}）但同时存在单对象保存（${singleSave.join(', ')}）`,
      '集成方法的 model.pt 契约必须能指回全部成员；只保存 models[0] 在可信复算下必然失分'))
  } else if (ensembleHints.length > 0) {
    checks.push(unknown('G4.1', `检测到集成提示：${ensembleHints.join(', ')}`,
      '静态自检确认保存对象覆盖全部成员'))
  } else {
    checks.push(ok('G4.1', '未见集成与单对象保存并存'))
  }

  if (predictionDtype === undefined) {
    checks.push(unknown('G4.2', '未提供 pred_test.npy 的 dtype', '核对为 NPY 且 int64'))
  } else if (predictionDtype === 'int64') {
    checks.push(ok('G4.2', 'pred_test.npy dtype = int64'))
  } else {
    checks.push(fail('G4.2', `pred_test.npy dtype = ${predictionDtype}，非 int64`,
      '按提交合同改为 NPY + int64'))
  }

  return { gate: 'G-REPLAY-CONTRACT', milestone: 'M5', verdict: verdictOf(checks), checks }
}

/**
 * G-SINGLE-SOURCE：同一事实单一真源（SOP 规则 19）。
 * 传入全包扫描到的同名量声明集合。
 */
export function gateSingleSource(input) {
  const checks = []
  const { anchorDeclarations = [], staleDeclarations = [] } = input

  if (anchorDeclarations.length === 0) {
    checks.push(unknown('G19.1', '未发现锚点/口径声明', '确认题包已声明 B/R/U 与协议'))
  } else if (anchorDeclarations.length > 1) {
    checks.push(fail('G19.1', `锚点/口径存在 ${anchorDeclarations.length} 套并存声明：${anchorDeclarations.join('；')}`,
      '全包只能一套生效声明；不同口径须明确标注为对照'))
  } else {
    checks.push(ok('G19.1', '锚点/口径为单一生效声明'))
  }

  checks.push(
    staleDeclarations.length === 0
      ? ok('G19.2', '未见预登记值与生效值自相矛盾')
      : fail('G19.2', `存在陈旧声明未清理：${staleDeclarations.join('；')}`,
        '披露变更及发生时间；不得保留自相矛盾的声明'),
  )

  return { gate: 'G-SINGLE-SOURCE', milestone: 'M5', verdict: verdictOf(checks), checks }
}

/**
 * G-PACK-VERIFY：打包一致性（SOP 规则 18 + 交付侧）。
 * 传入两份 path→sha256 映射。
 */
export function gatePackVerify(input) {
  const checks = []
  const { sourceHashes = {}, packedHashes = {}, forbiddenEntries = [] } = input

  const sourcePaths = Object.keys(sourceHashes).sort()
  const packedPaths = Object.keys(packedHashes).sort()
  const missing = sourcePaths.filter((path) => !(path in packedHashes))
  const extra = packedPaths.filter((path) => !(path in sourceHashes))
  const mismatched = sourcePaths
    .filter((path) => path in packedHashes && packedHashes[path] !== sourceHashes[path])

  checks.push(
    missing.length === 0 ? ok('G14.1', `交付包含全部 ${sourcePaths.length} 个文件`) : fail('G14.1', `交付包缺少 ${missing.length} 个文件：${missing.slice(0, 5).join(', ')}`, '重新打包'),
  )
  checks.push(
    extra.length === 0 ? ok('G14.2', '交付包无额外文件') : fail('G14.2', `交付包含未预期文件 ${extra.length} 个：${extra.slice(0, 5).join(', ')}`, '清理后重新打包'),
  )
  checks.push(
    mismatched.length === 0
      ? ok('G14.3', '逐文件 SHA-256 一致')
      : fail('G14.3', `${mismatched.length} 个文件哈希不一致：${mismatched.slice(0, 5).join(', ')}`,
        '任何字节改动必须重跑 NOP 并重建清单'),
  )
  checks.push(
    forbiddenEntries.length === 0
      ? ok('G14.4', '无缓存/临时文件残留')
      : fail('G14.4', `存在禁止项：${forbiddenEntries.slice(0, 8).join(', ')}`,
        '拒绝 __pycache__/.pyc/.pytest_cache/AppleDouble/.DS_Store'),
  )

  return { gate: 'G-PACK-VERIFY', milestone: 'M5', verdict: verdictOf(checks), checks }
}

/**
 * 门禁注册表。
 *
 * ## `authority` 字段：谁说了算
 *
 * 每道门禁声明它的权威判定者：
 *   · `'python'` —— SOP 随包的 Python 工具是权威。本文件里的同名函数只是
 *     **快速预判**，用于在没有 Python 或需要同步判定时给出近似结论。
 *     正式结论必须来自 Python 工具，因为那里编码了实战教训（L1–L32）与
 *     目标平台的原生契约，而这里没有。
 *   · `'js'` —— 没有对应的 Python 工具，本实现即权威。
 *
 * 声明这个字段的理由是教程规则 19「同一事实单一真源」：两套实现并存时
 * 必须明确哪一套生效，否则出现分歧时无从判断谁对。
 * 分歧的检测方式见 `scripts/ablation-gates.mjs`。
 */
export const GATES = Object.freeze({
  'G-SELECT': {
    fn: gateSelection, milestone: 'M1', title: '选题静态筛查', blocking: true,
    authority: 'python', pythonTool: 'paper-screen',
    note: '权威判定用 paper-screen（六类死因过滤器）；本实现只覆盖其中可静态求值的判据。',
  },
  'G-FEASIBILITY': {
    fn: gateFeasibility, milestone: 'M2', title: '可行性判定门', blocking: true,
    authority: 'python', pythonTool: 'feasibility-gate',
    note: '权威判定用 feasibility_gate.py；本实现额外校验 U 的方向一致性。',
  },
  'G-CONTRACT': {
    fn: gateTaskContract, milestone: 'M3', title: 'task.toml 原生契约', blocking: true,
    authority: 'python', pythonTool: 'harbor-task-contract',
    note: '权威判定用目标 Harbor 版本真加载；本实现只做四项必查的静态预判。',
  },
  'G-DOCKERFILE': {
    fn: gateDockerPathContract, milestone: 'M3', title: '双镜像路径契约', blocking: true,
    authority: 'python', pythonTool: 'dockerfile-preflight',
    note: '权威判定用 dockerfile_preflight.py；本实现额外检查题面八章节与泄露线索。',
  },
  'G-NOP-RESULT': {
    fn: gateNopResult, milestone: 'M3', title: 'NOP 自检结果', blocking: true,
    authority: 'js',
    note: 'NOP 四件套同源判定无对应 Python 工具，本实现即权威。',
  },
  'G-TRAJECTORY': {
    fn: gateTrajectory, milestone: 'M4', title: '轨迹与时长', blocking: true,
    authority: 'python', pythonTool: 'qa-implementation-review',
    note: '权威判定用 implementation_review.py 的 QA16/QA18/QA21；本实现是字段级预判。',
  },
  'G-REPLAY-CONTRACT': {
    fn: gateReplayContract, milestone: 'M5', title: '可复算契约', blocking: true,
    authority: 'python', pythonTool: 'replay-contract-gate',
    note: '权威判定用 replay_contract_gate.py；本实现只做静态特征匹配。',
  },
  'G-SINGLE-SOURCE': {
    fn: gateSingleSource, milestone: 'M5', title: '单一真源', blocking: true,
    authority: 'js',
    note: '单一真源扫描无对应 Python 工具，本实现即权威。',
  },
  'G-PACK-VERIFY': {
    fn: gatePackVerify, milestone: 'M5', title: '打包一致性', blocking: true,
    authority: 'js',
    note: '逐文件哈希比对无对应 Python 工具，本实现即权威。',
  },
})

/** 取某道门禁的权威判定者。 */
export function authorityOf(gateId) {
  return GATES[gateId]?.authority ?? null
}

/** 列出权威判定在 Python 侧的门禁。 */
export function pythonAuthoritativeGates() {
  return Object.entries(GATES)
    .filter(([, meta]) => meta.authority === 'python')
    .map(([gateId, meta]) => ({ gateId, pythonTool: meta.pythonTool, note: meta.note }))
}

/** 按里程碑取门禁 id 列表。 */
export function gatesForMilestone(milestone) {
  return Object.entries(GATES)
    .filter(([, meta]) => meta.milestone === milestone)
    .map(([id]) => id)
}
