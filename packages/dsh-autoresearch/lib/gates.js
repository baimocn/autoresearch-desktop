/**
 * 门禁判定 —— 把教程与 SOP 的判据实现为纯函数，便于单测与复用。
 *
 * 三态语义与 SOP `tools/milestone_gate.py` 保持一致：
 *   RECOMMEND(0) / NEEDS_EVIDENCE(2) / REJECT(1)
 * 不做总分补偿：任一硬门 FAIL 即 REJECT。
 *
 * @module dsh-autoresearch/gates
 */

// 红线静态扫描（数据泄露、DinD/Compose）拆在独立模块，本文件只做折叠。
import { scanRedLines } from './redlines.js'

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
    // G0.10 的归一化判据输入（与 G-FEASIBILITY 同名，便于同一份数据两门复用）。
    baseline, reference, upper, direction, sigmaMultiple,
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

  // ── G0.10 增益幅度：**与 G1.6 同口径**，不再用裸百分比 ────────────────────
  //
  // 旧实现只比较裸百分比 `deltaPercent < 10`，该口径对**负值有界**指标
  //（连续控制回合回报，取值 −∞…0，越接近 0 越好）在数学上失真：
  //
  //   · 优化空间衡量的是「从 B 到 U 走完了多少」= (R−B)/(U−B)，
  //     分母是**方法到上限的距离**，与指标量级无关。
  //   · 裸百分比的分母是 |B|，即「基线离 0 多远」——
  //     它由回报参考点 / 归一化常数决定，与方法能提升多少无关。
  //
  // 平移不变性检验（已独立复算）：对同一任务做纯平移 B→B+C
  //（与优化空间完全无关的重参数化），距离 Δ 与 U−B 均不变 ⇒ R_norm 严格不变，
  // 但裸百分比剧烈变化：
  //
  //   C=0    B=−249.25  R_norm=0.599  裸百分比 7.10%  → 旧判定 UNKNOWN
  //   C=100  B=−149.25  R_norm=0.599  裸百分比 11.86% → 旧判定 PASS
  //
  // 优化空间自始至终没变，结论却翻转 —— 说明旧判据测的是「参考点离 0 多远」，
  // 而不是「还有多少提升空间」。同一文件的 M2 门 G1.6 用的是
  // R_norm∈[0.15,0.8]（正确、量级无关），两个里程碑对同一语义用两套不相容口径。
  //
  // 修法：优先用与 G1.6 一致的归一化 / σ 判据；只在**确实拿不到 B/R/U** 时
  // 才回退到百分比，且回退时如实标注为粗判，不让 `>=10` 直接变成 PASS。
  // 依据：权威侧（paper_screen.py §三 2001 同构标准）本来就把这条记为 WARN，
  // 而 WARN **不参与退出码**（只有 FAIL→rc=1、MANUAL→rc=2），即不阻塞。
  // JS 此前把它升级成阻塞性 UNKNOWN，比权威更严 —— 那是不对的。
  {
    const hasMetrics = Number.isFinite(baseline) && Number.isFinite(reference) && Number.isFinite(upper)
    const hasSigma = Number.isFinite(sigmaMultiple)
    if (hasMetrics) {
      const dir = direction === 'minimize' ? 'minimize' : 'maximize'
      // 方向与 U 的关系不自洽时，不在这里重复报错（G1.5 负责），只如实说明不可判。
      const denom = dir === 'maximize' ? upper - baseline : baseline - upper
      if (denom > 0) {
        const rNorm = dir === 'maximize'
          ? (reference - baseline) / denom
          : (baseline - reference) / denom
        const inWindow = rNorm >= R_LO && rNorm <= R_HI
        const sigmaOk = hasSigma ? sigmaMultiple >= SIGMA_MULT_REQUIRED : null
        checks.push(
          inWindow && (sigmaOk === null || sigmaOk)
            ? ok('G0.10', `优化空间充足（与 G1.6 同口径）：R_norm=${rNorm.toFixed(4)} ∈ [${R_LO}, ${R_HI}]`
              + (hasSigma ? `，Δ=${sigmaMultiple.toFixed(1)}σ_B ≥ ${SIGMA_MULT_REQUIRED}σ` : ''))
            : unknown('G0.10', `优化空间按归一化口径不足：R_norm=${rNorm.toFixed(4)}`
              + (hasSigma ? `，Δ=${sigmaMultiple.toFixed(1)}σ_B` : '')
              + (Number.isFinite(deltaPercent) ? `（论文声称裸增益 ${deltaPercent}%）` : ''),
            inWindow ? 'σ 分离度不足：换方向或提高 U 的依据' : '换方向或改 U 的依据'),
        )
      } else {
        checks.push(ok('G0.10',
          `已提供 B/R/U，但 ${dir} 下 U 未越过 B ⇒ 归一化不可判；`
          + '该矛盾由 G-FEASIBILITY 的 G1.5 负责，本节不重复判定'))
      }
    } else if (hasSigma) {
      checks.push(sigmaMultiple >= SIGMA_MULT_REQUIRED
        ? ok('G0.10', `优化空间按 σ 判据充足：Δ=${sigmaMultiple.toFixed(1)}σ_B ≥ ${SIGMA_MULT_REQUIRED}σ`)
        : unknown('G0.10', `Δ=${sigmaMultiple.toFixed(1)}σ_B < ${SIGMA_MULT_REQUIRED}σ，优化空间不足`,
          '换方向或改 U 的依据'))
    } else if (Number.isFinite(deltaPercent)) {
      // 回退口径：如实标注为粗判 —— 裸百分比对负值有界指标失真。
      checks.push(deltaPercent >= 10
        ? ok('G0.10', `声称增益 ${deltaPercent}% ≥ 10%（粗判：未提供 B/R/U；`
          + '该口径对负值有界指标失真，仅供参考）')
        : unknown('G0.10',
          `仅能按百分比粗判：${deltaPercent}%（未提供 B/R/U，无法用归一化口径）`,
          '提供 baseline/reference/upper 或 sigmaMultiple 后按 R_norm 与 σ 判据复判；'
          + '注意：主指标若为负值有界（回合回报等），裸百分比会低估优化空间'))
    } else {
      checks.push(unknown('G0.10', '声称增益未提供', '从论文主图读取增益幅度，或直接提供 B/R/U'))
    }
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
  const VALID_NETWORK = new Set(['no-network', 'public', 'allowlist'])
  const KNOWN_BAD_NETWORK = new Set(['none', 'no_network', 'noNetwork', 'disabled', 'off', 'false', 'isolated'])

  // ── 与 Python 权威逐条对齐 ────────────────────────────────────────────────
  // 本函数的 authority 是 assets/sop/tools/harbor_task_contract.py 的 static_checks()。
  // 之前两边**读的不是同一批字段、严重度也不一致**，后果很实在：
  //   · JS 读 `environment.network_mode` / `verifier.environment.network_mode`，
  //     权威读 `[agent]` / `[verifier]` —— 于是常见误写
  //     `[agent] network_mode = "none"` 在 JS 侧判 RECOMMEND，而 Harbor 原生会拒；
  //     而这个 JS 结论正是 advanceState 消费的那个。
  //   · 权威把 environment_mode≠separate、build_timeout 偏低/缺失、顶层
  //     artifacts / schema_version 缺失都判 **warn**，JS 全判 FAIL —— 同一份
  //     task.toml，JS 说 REJECT 而权威说「需人工确认」。
  // 现在：FAIL 与 WARN 严格照抄权威，WARN 映射为 UNKNOWN（三态里的「需人工确认」）。

  // G2.1 曾只检查「非空」，于是放过了 `adello-ltssl-flexda` 这种单段名字。
  // 而 harbor 0.24.0 的 TaskConfig 校验会直接拒绝它：
  //   Value error, Package name must be in 'org/name' format with alphanumeric
  //   characters, hyphens, underscores, and dots. Cannot start with a dot or
  //   contain '..'. Got: adello-ltssl-flexda
  // 后果链条（实测，非推测）：名字非法 → TaskModel.is_valid_dir 返回 False →
  // 本地路径数据集遍历子目录时一个都不认 → JobPlan.resolve_task_configs 得到 0 个
  // 任务 → harbor run 抛 "ValueError: Either datasets or tasks must be provided."
  // 即题包根本无法被 Harbor 运行，而这道门却给了 RECOMMEND。
  // 因此这里按 harbor 自己的规则检查 org/name 两段结构。
  // 注意：harbor 的报错文案是该字段的唯一权威来源，此处逐条对齐它。
  const nameOk =
    typeof task.name === 'string' && task.name.trim() !== ''
  if (!nameOk) {
    checks.push(
      fail('G2.1', '[task].name 必填且不得为空', '补 [task] name 字段'),
    )
  } else {
    const name = task.name.trim()
    const segments = name.split('/')
    // 每段：字母数字开头，其后可含字母数字、连字符、下划线、点；不得含 '..'。
    const segRe = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
    const bad = []
    if (segments.length !== 2) {
      bad.push(`必须是恰好两段 org/name，实际 ${segments.length} 段`)
    }
    for (const seg of segments) {
      if (seg === '') bad.push('存在空段')
      else if (seg.startsWith('.')) bad.push(`段 "${seg}" 以点开头`)
      else if (seg.includes('..')) bad.push(`段 "${seg}" 含 '..'`)
      else if (!segRe.test(seg)) bad.push(`段 "${seg}" 含不允许的字符`)
    }
    checks.push(
      bad.length === 0
        ? ok('G2.1', `[task].name = ${name}（org/name 两段结构合法）`)
        : fail(
            'G2.1',
            `[task].name = ${name} 不是 harbor 要求的 org/name 形式：${bad.join('；')}`,
            "改成 org/name 两段式（如 autoresearch/adello-ltssl-flexda）。" +
              'harbor 的原话：Package name must be in \'org/name\' format with ' +
              "alphanumeric characters, hyphens, underscores, and dots. Cannot " +
              "start with a dot or contain '..'。若不改，harbor run 会因解析出 0 个" +
              '任务而抛 "Either datasets or tasks must be provided."。',
          ),
    )
  }

  // network_mode：权威只读 [agent] 与 [verifier]；**缺省不算失败**（Python 直接 continue）。
  for (const section of ['agent', 'verifier']) {
    const holder = toml?.[section]
    if (holder === null || typeof holder !== 'object') continue
    const mode = holder.network_mode
    if (mode === undefined) continue
    if (!VALID_NETWORK.has(mode)) {
      const hint = KNOWN_BAD_NETWORK.has(String(mode)) ? '（常见误写）' : ''
      checks.push(fail(`G2.2:${section}`, `[${section}].network_mode = "${mode}" 不是合法枚举值${hint}`,
        `只能是 ${[...VALID_NETWORK].join(' / ')}`))
    } else {
      checks.push(ok(`G2.2:${section}`, `[${section}].network_mode = ${mode}`))
    }
  }
  // 其他位置出现的 network_mode：权威不读，因此不得判 FAIL ——
  // 但要如实说明「这里写了也不生效」，否则用户会以为自己配对了。
  for (const [label, holder] of [
    ['environment', environment],
    ['verifier.environment', verifier.environment],
  ]) {
    const mode = (holder ?? {}).network_mode
    if (mode === undefined) continue
    const accepted = VALID_NETWORK.has(mode)
    // 用 ok 而不是 unknown：这条是**信息性**提示，不是待补证据。
    // 判 UNKNOWN 会让它阻塞阶段推进（UNKNOWN 与 FAIL 在 advanceState 眼里一样拦），
    // 实测把 AutoRe1841 卡在阶段 2 —— 而它的写法只是无效、无害，不该拦。
    // 信息保留在 detail 里，门禁报告照样看得到。
    checks.push(ok(`G2.2:${label}`,
      `${label}.network_mode = ${JSON.stringify(mode)} —— 该位置**不在** Harbor 契约的检查范围` +
      `（权威只读 [agent] 与 [verifier]），写了也不生效${accepted ? '' : '，且取值本身也非法'}`))
  }

  // environment_mode：缺失/非法 → FAIL；非 separate → WARN（权威如此，不升级为 FAIL）。
  const envMode = verifier.environment_mode
  if (envMode === undefined) {
    checks.push(fail('G2.3', '[verifier].environment_mode 未声明',
      '独立评分要求显式 environment_mode = "separate"'))
  } else if (!['separate', 'shared'].includes(envMode)) {
    checks.push(fail('G2.3', `[verifier].environment_mode = "${envMode}" 非法`,
      '合法值只有 separate / shared'))
  } else if (envMode !== 'separate') {
    checks.push(unknown('G2.3', `[verifier].environment_mode = "${envMode}"`,
      '本题流程要求独立评分（separate），请确认这是有意为之'))
  } else {
    checks.push(ok('G2.3', '[verifier].environment_mode = "separate"'))
  }

  // build_timeout_sec：非数值 → FAIL；偏低/缺失 → WARN（权威如此）。
  const FLOOR = 3600
  const buildTimeout = environment.build_timeout_sec
  if (buildTimeout === undefined) {
    checks.push(unknown('G2.4', '[environment] 未声明 build_timeout_sec',
      `Harbor 默认 600s，装不下含 torch 的镜像（首建实测约 1578s）；建议显式声明 ≥${FLOOR}`))
  } else if (!Number.isFinite(Number(buildTimeout))) {
    checks.push(fail('G2.4', `[environment].build_timeout_sec = ${JSON.stringify(buildTimeout)} 不是数值`,
      '改成数值，建议 ≥3600'))
  } else if (Number(buildTimeout) < FLOOR) {
    checks.push(unknown('G2.4', `build_timeout_sec = ${Number(buildTimeout)} < ${FLOOR}`,
      `含重型依赖的镜像首建实测可达 1578s；建议提高到 ≥${FLOOR}`))
  } else {
    checks.push(ok('G2.4', `build_timeout_sec = ${Number(buildTimeout)} ≥ ${FLOOR}`))
  }

  // 顶层 artifacts / schema_version：权威判 warn，JS 不得升级为 FAIL。
  const artifacts = toml?.artifacts
  checks.push(
    Array.isArray(artifacts) && artifacts.includes('/workspace/solution')
      ? ok('G2.5', `顶层 artifacts = ${JSON.stringify(artifacts)}`)
      : unknown('G2.5', `顶层 artifacts = ${JSON.stringify(artifacts)} 未包含 /workspace/solution`,
        '提交物移交依赖它，统一采用顶层 artifacts = ["/workspace/solution"]'),
  )

  checks.push(
    toml?.schema_version !== undefined
      ? ok('G2.6', `schema_version = ${toml.schema_version}`)
      : unknown('G2.6', '顶层 schema_version 缺失',
        '按目标 Harbor 版本声明；裸键写在 [task] 之下会归属该表'),
  )

  return { gate: 'G-CONTRACT', milestone: 'M3', verdict: verdictOf(checks), checks }
}

/**
 * 提取 Dockerfile 中全部 COPY/ADD 的源路径。
 *
 * ## 为什么不能用 `/^\s*COPY\s+(\S+)/gim`
 *
 * 上一轮复审实测：那个正则**漏掉 7 种等价写法**，越界 COPY 可以轻松绕过。
 * 漏掉的形态包括：
 *   1. 带引号          COPY "../secret" /x
 *   2. 单引号          COPY '../secret' /x
 *   3. JSON 数组形式    COPY ["../secret", "/x"]
 *   4. 大小写混合       copy ../secret /x        （已有 i 标志，这项原本能中）
 *   5. ADD 指令        ADD ../secret /x         （原本只匹配 COPY）
 *   6. 带 --from       COPY --from=builder /x /y
 *   7. 带 --chown 等    COPY --chown=u:g ../s /x
 *   8. 制表符分隔       COPY\t../secret\t/x
 *
 * 所以这里改成：先剥掉指令后的全部 flag，再正确切分引号/JSON 形式，
 * 并对 COPY 与 ADD 都生效。返回 `{ source, flags }` 便于调用方区分
 * `--from=` 这种合法的多阶段引用。
 */
export function extractCopySources(text) {
  const results = []
  if (typeof text !== 'string') return results

  // 逻辑行：处理反斜杠续行，把跨行的 COPY 合成一行再解析。
  //
  // 关键细节：续行拼接时**不能插入空格**。Dockerfile 的续行语义是直接拼接，
  // 插入空格会把 `../sec\` + `ret` 变成 `../sec ret`，路径被切断，
  // 越界检测随即失效（实测漏报）。因此这里只剥掉反斜杠与行尾空白，
  // 不加分隔符。
  const logicalLines = []
  const rawLines = text.split(/\r?\n/)
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i]
    while (/\\[ \t]*$/.test(line) && i + 1 < rawLines.length) {
      line = line.replace(/\\[ \t]*$/, '') + rawLines[++i].replace(/^\s+/, '')
    }
    logicalLines.push(line)
  }

  for (const raw of logicalLines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(COPY|ADD)\b([\s\S]*)$/i.exec(line)
    if (m === null) continue

    const directive = m[1].toUpperCase()
    let rest = m[2].trim()
    const flags = []

    // 剥掉前导 flag（--from=、--chown=、--chmod= 等），它们不是源路径。
    // 注意：flag 可能带引号，如 --chown="1000:1000"。
    for (;;) {
      const f = /^--([A-Za-z][A-Za-z0-9-]*)(?:=("[^"]*"|'[^']*'|\S+))?\s*/.exec(rest)
      if (f === null) break
      flags.push(`--${f[1]}${f[2] !== undefined ? `=${f[2]}` : ''}`)
      rest = rest.slice(f[0].length)
    }
    if (rest === '') continue

    let source = null
    if (rest.startsWith('[')) {
      // JSON 形式：COPY ["src", "dst"] —— 取第一个元素。
      const inner = /^\[([\s\S]*)\]/.exec(rest)
      if (inner !== null) {
        const parts = inner[1].split(',').map((p) => p.trim().replace(/^["']|["']$/g, '')).filter((p) => p !== '')
        if (parts.length > 0) source = parts[0]
      }
    } else {
      // shell 形式：可带引号，可能多个源（最后一个才是目标，但越界判定
      // 关注任一源，因此这里只取第一个不带引号剥离后的 token）。
      const tokens = []
      const tokenRe = /"([^"]*)"|'([^']*)'|(\S+)/g
      let t
      while ((t = tokenRe.exec(rest)) !== null) {
        tokens.push(t[1] ?? t[2] ?? t[3])
      }
      // 全部源 = 除最后一个（目标）之外的所有 token；取第一个源。
      if (tokens.length >= 2) source = tokens[0]
      else if (tokens.length === 1) source = tokens[0]
    }

    if (source !== null && source !== '') {
      results.push({ directive, source, flags, raw: line })
    }
  }
  return results
}

/**
 * 判定一个 COPY/ADD **条目**是否越界（逃出构建上下文）。
 *
 * 必须看 flags，不能只看 source —— 这是之前的一个硬失败：
 * 多阶段构建里 `COPY --from=builder /out/app /app` 的源**按构造就是绝对路径**，
 * 而它来自另一个构建阶段、不是宿主上下文，完全合法。旧实现把所有绝对路径
 * 一律判越界，于是任何标准多阶段 Dockerfile 都过不了 G-DOCKERFILE。
 * 提取器本来就把 flags 一起返回（见 extractCopySources 的注释），
 * 只是没有任何调用方读它。
 */
export function isEscapingEntry(entry) {
  const source = entry?.source
  if (typeof source !== 'string' || source === '') return false
  const normalized = source.replace(/\\/g, '/')
  const fromStage = (entry?.flags ?? []).some((flag) => flag.startsWith('--from'))
  if (fromStage) {
    // 源来自构建阶段：绝对路径合法，但仍不得用 .. 逃出该阶段的文件系统。
    return normalized.split('/').includes('..')
  }
  // ../ 开头、绝对路径、或任何路径段里含 .. 都能逃出上下文。
  if (normalized.startsWith('/')) return true
  if (normalized.startsWith('../') || normalized === '..') return true
  return normalized.split('/').includes('..')
}

/** 只看源路径的越界判定（不区分 --from）。保留给不带 flags 的调用方与单测。 */
export function isEscapingSource(source) {
  return isEscapingEntry({ source, flags: [] })
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
    const entries = extractCopySources(environmentDockerfile)
    const copies = entries.map((e) => e.source)
    const escaped = entries.filter((e) => isEscapingEntry(e))
    checks.push(
      escaped.length === 0
        ? ok('G3.1', `environment/Dockerfile 的 COPY/ADD 源均为 context 内相对路径（${copies.length} 条）`)
        : fail('G3.1', `environment/Dockerfile 出现越界 COPY/ADD：${escaped.map((e) => `${e.directive} ${e.source}`).join(', ')}`,
          'Agent 的源路径必须相对 environment/，禁止 COPY ../ 或绝对路径'),
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
    // 教程 v0.3.8（L169 / L512）明确允许**复用 Solver 镜像**：
    //   「复用 Solver 镜像时无需 tests/Dockerfile，tests/ 仍作为私有评分材料，
    //     仅上传到新的 Verifier sandbox」
    // 因此缺这个文件不是「证据不足」，而是**一种被认可的交付方式**。
    // 早期判 UNKNOWN 会让门禁永远给不出 RECOMMEND，把合法任务卡在阶段 2
    // （UNKNOWN 与 FAIL 在 advanceState 眼里一样拦）。
    //
    // 代价要说清：跳过 tests 侧静态检查意味着越界 COPY、行尾双反斜杠、--no-deps
    // 这三项没人看，改由平台在 Verifier 侧核对。三条检查照样发出（标注不适用），
    // 让检查集在两条路径下保持一致，下游不必区分。
    checks.push(ok('G3.3', '未提供 tests/Dockerfile —— 按「复用 Solver 镜像」处理，tests/ 由平台上传到独立 Verifier sandbox'))
    checks.push(ok('G3.4', '复用 Solver 镜像：tests/Dockerfile 的行尾双反斜杠检查不适用'))
    checks.push(ok('G3.5', '复用 Solver 镜像：tests/Dockerfile 的 --no-deps 检查不适用'))
  } else {
    const entries = extractCopySources(testsDockerfile)
    const escaped = entries.filter((e) => isEscapingEntry(e))
    checks.push(
      escaped.length === 0
        ? ok('G3.3', `tests/Dockerfile 的 COPY/ADD 源均为 context 内相对路径（${entries.length} 条）`)
        : fail('G3.3', `tests/Dockerfile 出现越界 COPY/ADD：${escaped.map((e) => `${e.directive} ${e.source}`).join(', ')}`,
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
    // 章节标题允许带编号前缀（`## 1. Goal` / `## 2、Task Setting`）。
    //
    // 早期只匹配 `^## Goal$`，于是**真实题面**被判「缺少全部八章节」——
    // 实测 AutoRe0566 的 instruction.md 八个章节一个不少，只是写成了
    // `## 1. Goal` 的形式。带编号是这类规范文档的常见写法（本项目脚手架模板
    // 别处也用 `## 1. 题目身份`），只认裸标题等于要求用户迁就门禁。
    const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const missing = sections.filter((section) =>
      !new RegExp(`^##\\s+(?:\\d+\\s*[.、)）]?\\s*)?${escapeRe(section)}\\s*$`, 'm').test(instructionMd))
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

  // ── 红线 1：数据泄露（Reference/Starter 不得读评测集标签进训练） ──────────
  //
  // 分档的理由见 redlines.js 顶部：一律命中即拦会因 `val_loader` 这类
  // 正常写法大量误报，误报多了这条检查会被忽略，真泄露时也不会看。
  // 因此只有「训练路径上读评测集标签」判 fail，其余降为 unknown 待人工确认。
  const scanFiles = Array.isArray(input.sourceFiles) ? input.sourceFiles : []
  if (scanFiles.length === 0) {
    checks.push(unknown('G3.8', '未提供 reference/ 或 starter/ 源码，红线 1 未扫描',
      '读入 reference/ 与 starter/ 下的源码文件后重跑'))
  } else {
    const red = scanRedLines({ files: scanFiles, scope: input.sourceScope ?? 'reference/starter' })
    const hard = red.leak.hard
    const suspect = red.leak.suspect
    checks.push(
      hard.length === 0
        ? ok('G3.8', `红线 1：${red.scannedFiles} 个源文件未见"训练中读取评测集标签"`)
        : fail('G3.8', `红线 1 触发：训练路径上读取评测集标签/注册 ${hard.length} 处`,
          hard.slice(0, 3).map((f) => `${f.path}:${f.line} ${f.text}`).join(' | ')),
    )
    checks.push(
      suspect.length === 0
        ? ok('G3.9', '红线 1：未见训练路径上的评测集数据读取')
        : unknown('G3.9', `红线 1 待确认：训练路径上出现评测集数据读取 ${suspect.length} 处`,
          suspect.slice(0, 3).map((f) => `${f.path}:${f.line} ${f.text}`).join(' | ')),
    )
    // mention 只记录不判 —— 但必须如实列出，不静默丢弃。
    if (red.leak.mention.length > 0) {
      checks.push(ok('G3.10', `红线 1：${red.leak.mention.length} 处非训练语境的评测集引用（正常评测代码或证据不足，不拦）`))
    }
  }

  // ── 红线 6：严禁 DinD，内场不接受 Compose ────────────────────────────────
  //
  // 扫描范围**必须包含两个 Dockerfile**，而不只是源码文件。
  // 理由（实测）：DinD 最典型的出现位置就是 Dockerfile（`RUN apt-get install
  // docker-ce`、`COPY --from` 挂 socket、`services:` 段），只扫 reference/ 会
  // 漏掉绝大多数真实案例 —— 第一版就犯了这个错。
  const archTargets = [...scanFiles]
  if (typeof environmentDockerfile === 'string' && environmentDockerfile !== '') {
    archTargets.push({ path: 'environment/Dockerfile', text: environmentDockerfile })
  }
  if (typeof testsDockerfile === 'string' && testsDockerfile !== '') {
    archTargets.push({ path: 'tests/Dockerfile', text: testsDockerfile })
  }
  const arch = scanRedLines({ files: archTargets, scope: 'dockerfiles + source' })
  const archHard = arch.architecture.hard
  checks.push(
    archHard.length === 0
      ? ok('G3.11', `红线 6：${archTargets.length} 个目标未见 DinD 或 Compose 依赖`)
      : fail('G3.11', `红线 6 触发：检测到 DinD 或 Compose ${archHard.length} 处`,
        archHard.slice(0, 3).map((f) => `${f.path}:${f.line} [${f.id}] ${f.why}`).join(' | ')),
  )

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

      // 教程 v0.3.8 L631-641 的例外条件不止"四个 flag 为 true"，还有可核对的
      // 量化要求。早期只查了 flag，于是「勾了 true 但轨迹只有 1 轮」也能过。
      //   · 条件 2：每条轨迹至少完成 3 轮有效闭环
      //   · 条件 5：写明有效迭代轮数与典型单轮耗时
      //   · 条件 4：best_method/ 已在干净快照重跑并出分（读 validation 声明）
      const roundCounts = [
        ['trajectory_codex.json', codexTrajectory],
        ['trajectory_seed.json', seedTrajectory],
      ]
      const thin = roundCounts
        .filter(([, trajectory]) => !Array.isArray(trajectory?.rounds) || trajectory.rounds.length < 3)
        .map(([label, trajectory]) => `${label}(${Array.isArray(trajectory?.rounds) ? trajectory.rounds.length : 0} 轮)`)
      checks.push(
        thin.length === 0
          ? ok('G11:exception:rounds', '7 小时例外：两条轨迹各 ≥3 轮有效闭环')
          : fail('G11:exception:rounds', `7 小时例外要求每条轨迹 ≥3 轮，当前：${thin.join('、')}`,
            '例外条件 2：提出并实施方法改动 → 获得同口径评分结论 → 据此形成下一轮决策'),
      )

      const paceGaps = runs
        .filter((run) => !Number.isFinite(run.effective_rounds) || run.effective_rounds < 3
          || !Number.isFinite(run.typical_round_minutes))
        .map((run) => `${run.runtime} + ${run.model}`)
      checks.push(
        paceGaps.length === 0
          ? ok('G11:exception:pace', '7 小时例外：已写明有效迭代轮数与典型单轮耗时')
          : fail('G11:exception:pace', `7 小时例外要求写明 effective_rounds(≥3) 与 typical_round_minutes，缺：${paceGaps.join('、')}`,
            '例外条件 5：在 run_summary 与专家说明中写明实际时长、有效轮数、典型单轮耗时与理由'),
      )

      checks.push(
        runSummary?.validation?.best_method_rerun_passed === true
          ? ok('G11:exception:rerun', '7 小时例外：best_method 已在干净快照重跑出分')
          : fail('G11:exception:rerun', '7 小时例外要求 best_method 已在干净任务快照中重跑并成功出分',
            '例外条件 4：run_summary.validation.best_method_rerun_passed 须为 true'),
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
 *
 * ## 判据是「值冲突」，不是「出现次数」
 *
 * 规则 19 原话：「锚点/口径/基线在全包只能有**一套生效声明**；不同口径须明确
 * 标注为对照」，要防的是**同一事实存在互相矛盾的两份声明**（例如改了 B 锚点
 * 却没改另一处，留下自相矛盾的旧值）。
 *
 * 早期实现只数声明**个数**（`length > 1` 即 FAIL），于是**任何同时遵守教程
 * 两处要求的题包都必然被拒**：教程自身的 schema 里有
 * `expert_annotation.score_contract.metric`，又要求口径写进
 * `optimization_evidence/comparison_summary.json`。两处值**完全相同**也判 REJECT
 * （实测 AutoRe 题包：comparison_summary.metric=balanced_accuracy 与
 * expert_annotation.metric=balanced_accuracy 并存 → REJECT）。
 *
 * 后果是作者为过检查只能删掉教程要求的字段，而两处都有真实消费者
 * （`gates/lib/tools.js` 的方向三级回退、UI 的 score_contract 读取）——
 * 门禁反而在逼题包降低信息完整性。摘要与明细并存本身是正常文档结构，
 * 摘要复述真值不是「第二套声明」。
 *
 * 因此改为：**同一个键出现不同值才 FAIL**；出现多个不同键（或键不同、值也
 * 不同）时无法判定是否同一事实，降为 UNKNOWN 待人工确认，不误报成冲突。
 *
 * @param {{anchorDeclarations?: (string|{key: string, value: unknown, source?: string})[],
 *          staleDeclarations?: string[]}} input
 *   `anchorDeclarations` 每项形如 `'文件.字段=值'`（采集侧现状）或结构化
 *   `{key, value, source}`。两种都认 —— 采集侧尚未改造时不至于失能。
 */
export function gateSingleSource(input) {
  const checks = []
  const { anchorDeclarations = [], staleDeclarations = [] } = input

  if (anchorDeclarations.length === 0) {
    checks.push(unknown('G19.1', '未发现锚点/口径声明', '确认题包已声明 B/R/U 与协议'))
  } else {
    // 结构化为 {key, value, source}。字符串形态按第一个 '=' 切分：
    // 键取「最后一个点之后」的字段名（`comparison_summary.metric` → `metric`），
    // 这样两个文件里的同名字段会归到同一个键下比较。
    const parsed = anchorDeclarations.map((entry) => {
      if (entry !== null && typeof entry === 'object') {
        return {
          key: String(entry.key ?? '').trim(),
          value: entry.value,
          source: String(entry.source ?? entry.key ?? '(未命名来源)'),
        }
      }
      const text = String(entry)
      const eq = text.indexOf('=')
      if (eq < 0) return { key: '', value: text, source: text }
      const lhs = text.slice(0, eq).trim()
      return {
        key: lhs.split('.').pop() ?? lhs,
        value: text.slice(eq + 1).trim(),
        source: lhs,
      }
    })

    // 无键声明（不含 '=' 的旧形态）无法判断是否同一事实，只能退回数个数。
    const unkeyed = parsed.filter((d) => d.key === '')
    const byKey = new Map()
    for (const d of parsed) {
      if (d.key === '') continue
      if (!byKey.has(d.key)) byKey.set(d.key, [])
      byKey.get(d.key).push(d)
    }

    /** 值的比较口径：字面量直接比，其余用 JSON 归一化再比。 */
    const norm = (v) => (typeof v === 'string' ? v : JSON.stringify(v))
    const conflicts = []
    for (const [key, items] of byKey) {
      const values = new Set(items.map((i) => norm(i.value)))
      if (values.size > 1) {
        conflicts.push(`${key}: ${items.map((i) => `${i.source}=${norm(i.value)}`).join(' vs ')}`)
      }
    }

    const describeAll = () => parsed.map((d) => `${d.source}=${norm(d.value)}`).join('；')
    /** 多声明同值时的说明 —— 值一致是「重复/摘要式声明」，不是第二套生效声明。 */
    const agreed = () => (parsed.length > 1 ? `（${parsed.length} 处声明值一致）` : '')

    if (conflicts.length > 0) {
      checks.push(fail('G19.1', `同一事实存在互相矛盾的声明：${conflicts.join('；')}`,
        '同一个键只能有一个值；保留生效值，更正或删除其余声明'))
    } else if (unkeyed.length === 0) {
      // 每个键都只有一个值 —— 无论有几个键（metric 与 direction 本就是两个
      // 不同事实）都不构成冲突。重复复述同一值也不是「第二套生效声明」。
      checks.push(ok('G19.1', `锚点/口径为单一生效声明${agreed()}`))
    } else if (byKey.size === 0) {
      // 全部无法归键：保留旧语义（多于一条即视为多套声明）。
      checks.push(unkeyed.length > 1
        ? fail('G19.1', `锚点/口径存在 ${unkeyed.length} 套并存声明：`
          + `${unkeyed.map((d) => norm(d.value)).join('；')}`,
          '全包只能一套生效声明；不同口径须明确标注为对照')
        : ok('G19.1', '锚点/口径为单一生效声明'))
    } else {
      // 有键与无键混杂：无键声明无法判断归属哪个事实，如实降为待确认。
      checks.push(unknown('G19.1',
        `锚点/口径存在 ${byKey.size + unkeyed.length} 处无法归并为同一事实的声明：${describeAll()}`,
        '确认这些声明描述的是同一事实；若是，收敛为同一个值；若否，明确标注为对照'))
    }
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
/**
 * QA15 资源上限（教程 v0.3.8 L16 / L266）。
 *
 * 「完整单轮资源需求 ≤7200 秒、≤8 张 H20/L20 GPU、≤64 核 CPU，覆盖任务所需
 *   训练、重载和评分。GPU 题只用 H20/L20；CPU 题保持 gpus=0，不为适配模板增加 GPU。」
 *
 * ## 为什么单独成函数、且由**发布期**门禁调用，而不是阶段 2 的契约门
 *
 * QA15 在教程里是**提交期质检项**（「本版重点检查什么」表 + L989「提交前专家自查」），
 * 不是构建题包的前置条件。放进阶段 2 会把「还没填资源字段」当成构建阻塞，
 * 实测直接卡住 4 个真实任务（它们大多缺 time_limit_seconds 或 gpu_types）。
 * 放在打包门：提交前必须达标，中途不拦。
 *
 * 两种 schema 都要认（0.3.8 用 [environment]/[verifier.environment] + gpu_types 复数，
 * 旧写法用 [resources] + gpu_type 单数），否则换 schema 后这道检查会静默变成"没数据"。
 */
export function gateResourceLimits(toml) {
  const checks = []
  const environment = toml?.environment ?? {}
  const verifier = toml?.verifier ?? {}
  const verifierEnv = verifier.environment ?? {}
  const legacy = toml?.resources ?? {}
  const pick = (...values) => values.find((value) => value !== undefined && value !== null) ?? undefined

  const cpuMain = pick(environment.cpus, legacy.cpu_cores)
  const cpuVerifier = verifierEnv.cpus
  const gpuMain = pick(environment.gpus, legacy.gpu_count)
  const gpuVerifier = verifierEnv.gpus
  const gpuTypes = pick(environment.gpu_types, verifierEnv.gpu_types,
    legacy.gpu_type === undefined ? undefined : [legacy.gpu_type])

  // G15.1 单轮出分预算 ≤7200s。超限不判 FAIL —— 教程 L600 允许「记录原因和判据
  // 并提交平台复核」，所以降为 UNKNOWN 要人确认，而不是硬拒。
  const timeLimit = toml?.task?.time_limit_seconds ?? toml?.time_limit_seconds
  if (timeLimit === undefined) {
    checks.push(unknown('G15.1', '未声明 time_limit_seconds（单轮出分预算）',
      '教程要求完整单轮出分 ≤7200s；无法满足时须记录原因与判据并提交平台复核'))
  } else if (!Number.isFinite(Number(timeLimit))) {
    checks.push(fail('G15.1', `time_limit_seconds = ${JSON.stringify(timeLimit)} 不是数值`, '改成数值（秒）'))
  } else if (Number(timeLimit) > 7200) {
    checks.push(unknown('G15.1', `time_limit_seconds = ${Number(timeLimit)} 超过 7200s 上限`,
      '若无法通过缩小模型/数据/训练步数满足，须在专家说明里记录原因与判据并提交平台复核；不得默默提高资源'))
  } else {
    checks.push(ok('G15.1', `time_limit_seconds = ${Number(timeLimit)} ≤ 7200`))
  }

  // G15.2 CPU 合计 ≤64 核（两个 sandbox 相加）。
  const cpuParts = [cpuMain, cpuVerifier].filter((value) => Number.isFinite(Number(value)))
  const cpuTotal = cpuParts.reduce((sum, value) => sum + Number(value), 0)
  if (cpuParts.length === 0) {
    checks.push(unknown('G15.2', '未声明 CPU 核数（[environment].cpus / [resources].cpu_cores）',
      '教程要求单轮 CPU 需求 ≤64 核'))
  } else if (cpuTotal > 64) {
    checks.push(fail('G15.2', `CPU 合计 ${cpuTotal} 核 > 64`, '单轮 CPU 需求上限 64 核，含两个 sandbox'))
  } else {
    checks.push(ok('G15.2', `CPU 合计 ${cpuTotal} 核 ≤ 64`))
  }

  // G15.3 GPU 合计 ≤8 张。
  const gpuParts = [gpuMain, gpuVerifier].filter((value) => Number.isFinite(Number(value)))
  const gpuTotal = gpuParts.reduce((sum, value) => sum + Number(value), 0)
  if (gpuParts.length === 0) {
    checks.push(unknown('G15.3', '未声明 GPU 数量（[environment].gpus / [resources].gpu_count）',
      '教程要求单轮 GPU 需求 ≤8 张；CPU 题应显式写 gpus = 0'))
  } else if (gpuTotal > 8) {
    checks.push(fail('G15.3', `GPU 合计 ${gpuTotal} 张 > 8`, '单轮 GPU 需求上限 8 张'))
  } else {
    checks.push(ok('G15.3', `GPU 合计 ${gpuTotal} 张 ≤ 8`))
  }

  // G15.4 卡型：GPU 题只用 H20/L20；CPU 题不得声明 gpu_types。
  //
  // 匹配必须**按型号 token**，不能整串精确比对 —— 真实任务写的是厂商全名
  // （`NVIDIA L20`、`NVIDIA A800 80GB PCIe`），精确比对会把合法的 L20 判成非法。
  const isAllowedType = (raw) => {
    const text = String(raw).toUpperCase()
    // 允许带厂商前缀与容量后缀：NVIDIA L20 / L20 48GB / l20
    return /(^|[^A-Z0-9])(H20|L20)([^0-9]|$)/.test(text)
  }
  if (gpuTotal === 0) {
    checks.push(
      gpuTypes === undefined || (Array.isArray(gpuTypes) && gpuTypes.length === 0)
        ? ok('G15.4', 'CPU 题：未声明 gpu_types（符合「CPU 题不为适配模板增加 GPU」）')
        : fail('G15.4', `gpus 合计为 0 却声明了 gpu_types = ${JSON.stringify(gpuTypes)}`,
          'CPU 题应删除 gpu_types 字段'),
    )
  } else if (!Array.isArray(gpuTypes) || gpuTypes.length === 0) {
    checks.push(unknown('G15.4', 'GPU 题未声明 gpu_types',
      '教程要求 GPU 题仅用 H20/L20；请显式声明以便核对'))
  } else {
    const illegal = gpuTypes.filter((type) => !isAllowedType(type))
    checks.push(
      illegal.length === 0
        ? ok('G15.4', `GPU 卡型 ∈ {H20, L20}：${gpuTypes.join(', ')}`)
        : unknown('G15.4', `GPU 卡型含非内场型号：${illegal.join(', ')}`,
          '内场 GPU 题统一 H20、L20 也接受；原题依赖其他卡型须先调整题目与配置，并复核受影响结果'),
    )
  }

  return { checks }
}

export function gatePackVerify(input) {
  const checks = []
  const {
    sourceHashes = {}, packedHashes = {}, forbiddenEntries = [],
    runSummary = null, bestMethodFiles = null, gitState = null,
    annotation = null, expertDoc = null, taskToml = null,
    packNote = null, packError = null,
  } = input

  const sourcePaths = Object.keys(sourceHashes).sort()
  const packedPaths = Object.keys(packedHashes).sort()
  const missing = sourcePaths.filter((path) => !(path in packedHashes))
  const extra = packedPaths.filter((path) => !(path in sourceHashes))
  const mismatched = sourcePaths
    .filter((path) => path in packedHashes && packedHashes[path] !== sourceHashes[path])

  // ── 空集不得判 PASS（G14.1–G14.3）─────────────────────────────────────────
  //
  // 这三项此前在入参缺失时恒判 PASS：`sourceHashes`/`packedHashes` 默认 `{}`，
  // 于是 missing/extra/mismatched 都是空数组，三项一起报 PASS，报告里写着
  // 「交付包含全部 **0** 个文件」。
  //
  // 后果比 FAIL 严重：FAIL 会促使人排查；**空集上的 PASS 让人以为已验证**。
  // 实测本仓曾真实发生过打包事故（`*.preM5` 备份泄漏进 Agent 镜像与交付 ZIP），
  // 而这道门全程未报警一次 —— 因为它的判据从来没有输入。
  //
  // SOP 的口径是「UNKNOWN ≠ FAIL」，但**空集更不等于 PASS**：
  // 一个没有任何检查对象的检查必须报 UNKNOWN，让「没验」这件事显式可见。
  // 两侧分别判定：源树为空与包为空是两种不同的缺失，各自如实报出。
  const sourceEmpty = sourcePaths.length === 0
  const packedEmpty = packedPaths.length === 0

  checks.push(
    sourceEmpty || packedEmpty
      ? unknown('G14.1',
        `打包一致性无法判定：${sourceEmpty ? '源哈希为空' : ''}`
        + `${sourceEmpty && packedEmpty ? '、' : ''}${packedEmpty ? '包哈希为空' : ''}`,
        '提供 artifact（交付 ZIP 路径），或确认任务根三个交付目录下有文件；'
        + '空集不等于通过 —— 该检查此前会在此恒报 PASS')
      : missing.length === 0
        ? ok('G14.1', `交付包含全部 ${sourcePaths.length} 个文件`)
        : fail('G14.1', `交付包缺少 ${missing.length} 个文件：${missing.slice(0, 5).join(', ')}`, '重新打包'),
  )
  checks.push(
    sourceEmpty || packedEmpty
      ? unknown('G14.2',
        `包内容无法判定：${packedEmpty ? '包哈希为空（没有可比对的包）' : '源哈希为空（没有基准）'}`,
        packedEmpty
          ? '提供 artifact（交付 ZIP 路径）后重跑；空包不等于「无额外文件」'
          : '提供源树哈希；只有包哈希时无法判断哪些是「额外」文件')
      : extra.length === 0
        ? ok('G14.2', `交付包无额外文件（比对 ${sourcePaths.length} 个源文件）`)
        : fail('G14.2', `交付包含未预期文件 ${extra.length} 个：${extra.slice(0, 5).join(', ')}`, '清理后重新打包'),
  )
  checks.push(
    sourceEmpty || packedEmpty
      ? unknown('G14.3', '逐文件哈希无法比对：缺少源哈希或包哈希',
        '提供 artifact 路径后重跑；该检查此前会在此恒报 PASS')
      : mismatched.length === 0
        ? ok('G14.3', `逐文件 SHA-256 一致（${sourcePaths.length} 个文件）`)
        : fail('G14.3', `${mismatched.length} 个文件哈希不一致：${mismatched.slice(0, 5).join(', ')}`,
          '任何字节改动必须重跑 NOP 并重建清单'),
  )
  // G14.4 的判据是「禁止项列表为空」，它**不依赖**哈希集合：
  // 禁止项是从源树与包内实际扫出来的，扫过且没命中才是真 PASS。
  // 只有连扫都没扫（两侧都空）时才无法区分「干净」与「没扫」。
  checks.push(
    forbiddenEntries.length === 0 && sourceEmpty && packedEmpty
      ? unknown('G14.4', '禁止项无法判定：未扫描任何文件',
        '提供 artifact 或确认源树非空后重跑；空集不等于「干净」')
      : forbiddenEntries.length === 0
        ? ok('G14.4', `无缓存/临时文件残留（已扫 ${sourcePaths.length} 个源文件与 ${packedPaths.length} 个包内条目）`)
        : fail('G14.4', `存在禁止项：${forbiddenEntries.slice(0, 8).join(', ')}`,
          '拒绝 __pycache__/.pyc/.pytest_cache/AppleDouble/.DS_Store 与备份残留'),
  )

  // 采集过程本身出问题时**显式报出**，不要混进上面四项的结论里：
  // 「采集失败」与「采集到空集」是两种不同的缺失，混一起会让人查错方向。
  if (packError !== null && packError !== undefined) {
    checks.push(unknown('G14.0', `打包判据输入采集失败：${packError}`,
      '可用 artifact 参数显式指定交付 ZIP 路径；这是采集问题，不是交付物问题'))
  }

  // ── G14.5 自验声明（教程 v0.3.8 L877-882 / L886）──────────────────────────
  //
  // 「各项自验任一为 false 时，先修复再提交」；`optimization_evidence_complete`
  // 仅表示专家已备齐第三个目录，不代表平台审核通过。
  // 放在打包门而不是轨迹门：这些字段在阶段 3 可能合理地还是 false（活还没干完），
  // 到发布阶段才是硬要求。
  if (runSummary === null || typeof runSummary !== 'object') {
    checks.push(unknown('G14.5', '未读到 run_summary.json，自验声明无法核对',
      '提供 expert_evidence/run_summary.json'))
  } else {
    const validation = runSummary.validation ?? null
    const FIELDS = ['baseline_passed', 'reference_passed', 'optimization_evidence_complete', 'best_method_rerun_passed']
    if (validation === null || typeof validation !== 'object') {
      checks.push(unknown('G14.5', 'run_summary.json 缺 validation 段（四项自验状态）',
        `须声明 ${FIELDS.join(' / ')}`))
    } else {
      const notPassed = FIELDS.filter((field) => validation[field] !== true)
      checks.push(
        notPassed.length === 0
          ? ok('G14.5', '四项自验声明均为 true')
          : fail('G14.5', `自验未通过：${notPassed.map((f) => `${f}=${JSON.stringify(validation[f])}`).join('、')}`,
            '任一为 false 须先修复再提交；optimization_evidence_complete 只表示第三目录已备齐，不代表平台审核通过'),
      )
    }
  }

  // ── G14.6 best_method/ 内容（教程 v0.3.8 L949-957）────────────────────────
  //
  // 早期只查目录存在，于是「空目录」或「混进了 Reference / Hidden / 密钥」都能过。
  // 四项要求里可静态核对的是「非空」与「不含 Reference/Hidden/密钥」；
  // 「仅保留最终方法」「已在干净快照重跑」属运行期事实，由平台验证。
  if (bestMethodFiles === null || !Array.isArray(bestMethodFiles)) {
    checks.push(unknown('G14.6', '未读到 best_method/ 文件清单', '提供 expert_evidence/best_method/ 下的文件列表'))
  } else if (bestMethodFiles.length === 0) {
    checks.push(fail('G14.6', 'best_method/ 为空目录', '放入最终最佳方法的入口脚本、源码与必需配置'))
  } else {
    // 只按文件名判，不读内容 —— 名称里带 reference/hidden/密钥后缀的是明确的越界信号。
    const suspicious = bestMethodFiles.filter((name) =>
      /(^|\/)(reference|hidden|hidden_assets|secret|credentials?)(\/|$)/i.test(name)
      || /\.(pem|key|p12|pfx)$/i.test(name))
    checks.push(
      suspicious.length === 0
        ? ok('G14.6', `best_method/ 含 ${bestMethodFiles.length} 个文件，未见 Reference/Hidden/密钥`)
        : fail('G14.6', `best_method/ 含疑似越界文件：${suspicious.slice(0, 5).join(', ')}`,
          'best_method/ 只放最终方法代码；不得包含 Reference、Hidden 数据、评分日志或密钥'),
    )
  }

  // ── G14.7 Git 清理（教程 v0.3.8 L582 / L1017）────────────────────────────
  //
  // 「Git remotes、tags、reflog 和包含答案线索的修复提交已清理」。
  // 任务根不一定是 git 仓库 —— 那就如实标"不适用"，不伪造通过也不硬拦。
  if (gitState === null || typeof gitState !== 'object') {
    checks.push(unknown('G14.7', '未探测任务根的 Git 状态', '读取 .git 后重跑；非 git 仓库可标为不适用'))
  } else if (gitState.isRepo !== true) {
    checks.push(ok('G14.7', '任务根不是 Git 仓库，Git 清理检查不适用'))
  } else {
    const problems = []
    if (Array.isArray(gitState.remotes) && gitState.remotes.length > 0) {
      problems.push(`remote ${gitState.remotes.length} 个（${gitState.remotes.slice(0, 3).join(', ')}）`)
    }
    if (Array.isArray(gitState.tags) && gitState.tags.length > 0) {
      problems.push(`tag ${gitState.tags.length} 个`)
    }
    checks.push(
      problems.length === 0
        ? ok('G14.7', 'Git 仓库：无 remote、无 tag')
        : unknown('G14.7', `Git 仓库未清理：${problems.join('、')}`,
          '清理 remotes / tags / reflog 及含答案线索的修复提交；确需保留须说明理由'),
    )
  }

  // ── G14.8 / G14.9 不得夹带审核结论（教程 v0.3.8 L787 / L798）──────────────
  //
  // 教程对这两份交付物的措辞是明确的禁止项：
  //   · 专家作业说明文档：只陈述专家自验事实，**不写"审核通过"或官方 Hidden 结果**
  //   · expert_annotation.json：**不写** `approved` / `audit_passed` / 官方 Hidden 分数
  // 「专家声称已通过审核」会让下游误以为平台已验收，所以这是可静态拦的实质问题，
  // 不是措辞偏好。
  //
  // 注意：教程同时写明「完整物理隔离、正式 Hidden 运行及平台稳定性**另由平台验证**」
  // （L125）—— 那两项静态查不了，本门禁不假装覆盖。
  const AUDIT_CLAIM = /(审核通过|审核已通过|已通过审核|audit[_ ]?passed|approved\s*[:=]\s*true|官方\s*Hidden\s*(分数|结果)\s*[:=])/i
  if (annotation === null || typeof annotation !== 'object') {
    checks.push(unknown('G14.8', '未读到 expert_annotation.json', '提供精简机读标注后重跑'))
  } else {
    const flat = JSON.stringify(annotation)
    const hasKey = ['approved', 'audit_passed', 'auditPassed'].some((key) => Object.hasOwn(annotation, key))
    checks.push(
      !hasKey && !AUDIT_CLAIM.test(flat)
        ? ok('G14.8', 'expert_annotation.json 未夹带审核结论')
        : fail('G14.8', 'expert_annotation.json 含审核结论字段或"已通过"表述',
          '只放题目类型、优化面、指标方向、B/R/U 与隔离声明；不写 approved / audit_passed / 官方 Hidden 分数'),
    )
  }

  if (typeof expertDoc !== 'string' || expertDoc === '') {
    checks.push(unknown('G14.9', '未读到 expert_evidence/专家作业说明文档.md', '提供专家说明后重跑'))
  } else {
    checks.push(
      !AUDIT_CLAIM.test(expertDoc)
        ? ok('G14.9', '专家作业说明文档未声称审核通过或官方 Hidden 结果')
        : fail('G14.9', '专家作业说明文档含"审核通过"或官方 Hidden 结果表述',
          '只陈述专家自验事实；平台审核结论与官方 Hidden 结果不由专家写入'),
    )
  }

  // ── QA15 资源上限（教程 v0.3.8 L16 / L266）──────────────────────────────
  //
  // 放在**打包门**而不是阶段 2 的契约门：QA15 在教程里是提交期质检项
  // （「本版重点检查什么」表 + L989「提交前专家自查」），不是构建题包的前置条件。
  // 放进阶段 2 会把「还没填资源字段」当成构建阻塞，实测直接卡住 4 个真实任务。
  if (taskToml === null || typeof taskToml !== 'object') {
    checks.push(unknown('G15', '未读到 task.toml，QA15 资源上限无法核对', '提供 workspace/harbor_task/task.toml'))
  } else {
    checks.push(...gateResourceLimits(taskToml).checks)
  }

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
