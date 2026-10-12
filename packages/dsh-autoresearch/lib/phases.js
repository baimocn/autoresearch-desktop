/**
 * AutoResearch 四阶段定义 —— 忠实映射《AutoResearch 专家线下标注教程V3》第 1–4 章。
 *
 * 每个阶段声明：标识、教程章节、目标、必须产出的交付物、以及进入下一阶段前
 * 必须通过的门禁。交付物用「包内相对路径 + 是否必需」描述，由 state/scaffold
 * 模块据此做真实存在性核对，而不是只写进文档。
 *
 * @module dsh-autoresearch/phases
 */

/** 题目模式，教程第 1 章「出题模式与输入」。 */
export const TASK_MODES = Object.freeze({
  S1: {
    id: 'S1',
    name: 'S1 强约束',
    input: '候选论文和预置代码库',
    requirement: '优先选择有公开源码、相对 Baseline 有明确可测提升且资源可压缩的方向；抽取可验证的优化面并整理为问题定义、环境与评分校验。无需复现整篇论文，但必须提供一个合法、可复现的 Reference Solution。',
  },
  S2: {
    id: 'S2',
    name: 'S2 半开放',
    input: '研究方向或题面种子，以及参考材料、模型和数据白名单',
    requirement: '自行确定搜索空间、Baseline、难度、评分协议和完整题目。',
  },
  S3: {
    id: 'S3',
    name: 'S3 全开放',
    input: '已通过平台确认的 Proposal',
    requirement: '按确认后的任务说明实现；进入实现阶段后，交付格式与 S2 相同。',
  },
})

/** 领取后检查五项（教程第 1 章 checklist，逐条机器可核）。 */
export const INTAKE_CHECKS = Object.freeze([
  { id: 'input-downloadable', text: '任务输入可以正常下载，代码和数据的使用范围明确' },
  { id: 'metric-direction', text: '已确认主指标名称及 maximize 或 minimize 方向' },
  { id: 'resource-bounds', text: '已确认 GPU、CPU、内存、网络和单次迭代限制' },
  { id: 'visibility-bounds', text: '已确认 Starter Code、Public/Dev、Hidden Test 和 Reference Solution 的可见性边界' },
  { id: 'three-deliverables', text: '已确认最终需要提交 workspace/、expert_evidence/ 与 optimization_evidence/，并明确三者的可见性边界' },
])

/**
 * 四阶段。`deliverables` 的 path 相对任务根；`kind` 用于脚手架与校验：
 *   file / dir / json / toml / md
 *
 * `gates` 列的是门禁 id（与 gates.js 的 GATES 键一致）；里程碑归属由门禁自身
 * 声明，避免两处维护同一事实。
 */
export const PHASES = Object.freeze([
  {
    id: 'intake',
    order: 1,
    chapter: '第 1 章 登录并领取本地出题任务',
    title: '领取与边界确认',
    goal: '确认任务输入、出题模式和资源边界，再开始实现。领取后不要直接改代码，先核对任务卡中的要求是否完整、材料是否可访问。',
    gates: ['G-SELECT'],
    deliverables: [
      { path: 'task_identity.json', kind: 'json', required: true, note: 'Task ID、S1/S2/S3、研究方向、变体编号' },
      { path: 'intake_checklist.json', kind: 'json', required: true, note: '领取后检查五项逐条结论' },
      { path: 'optimization_surface.md', kind: 'md', required: true, note: '优化面初判：可修改面、冻结面、反例、最小验证合同' },
    ],
    exitCriteria: [
      '任务输入可下载且使用范围明确',
      '主指标名称与方向已确认',
      '资源与单次迭代限制已确认',
      '四类可见性边界已确认',
      'M1 selection 门禁返回 RECOMMEND',
    ],
  },
  {
    id: 'authoring',
    order: 2,
    chapter: '第 2 章 构建 Repo',
    title: '题包构建与双镜像',
    goal: '最终 Repo 只保留任务运行所需的标准目录。先完成任务定义，再搭建环境和评测，最后加入可运行解法。路径、文件名和可见性边界必须保持一致。',
    gates: ['G-FEASIBILITY', 'G-CONTRACT', 'G-DOCKERFILE', 'G-NOP-RESULT'],
    deliverables: [
      { path: 'workspace/harbor_task/instruction.md', kind: 'md', required: true, note: '八章节题面，不得保留模板注释' },
      { path: 'workspace/harbor_task/task.toml', kind: 'toml', required: true, note: 'schema_version、顶层 artifacts、separate' },
      { path: 'workspace/harbor_task/environment/Dockerfile', kind: 'file', required: true, note: 'context = environment/' },
      { path: 'workspace/harbor_task/environment/starter', kind: 'dir', required: true, note: '起始实现；构建时初始化 starter 与 solution' },
      { path: 'workspace/harbor_task/environment/public_eval', kind: 'dir', required: true, note: '公开 Dev 评分入口，Agent 可见可调用' },
      { path: 'workspace/harbor_task/tests/Dockerfile', kind: 'file', required: true, note: 'context = tests/，独立 Verifier 镜像' },
      { path: 'workspace/harbor_task/tests/test.sh', kind: 'file', required: true, note: '正式评分入口，写 reward.txt 或 reward.json' },
      { path: 'workspace/harbor_task/tests/grader.py', kind: 'file', required: true, note: '可信正式评分实现' },
      { path: 'workspace/reference', kind: 'dir', required: true, note: '专家侧参考解，Agent 不可见' },
      { path: 'optimization_evidence/训练证据说明.md', kind: 'md', required: true, note: 'B/R、优化面、seed、协议、质量门、复现方式' },
      { path: 'optimization_evidence/comparison_summary.json', kind: 'json', required: true, note: '逐 seed 成对值 + 统计量与显著性判定' },
    ],
    exitCriteria: [
      'instruction.md 含完整八章节且无答案泄露',
      'task.toml 通过目标 Harbor 原生契约预检',
      '公开 Dev 入口可运行并给出真实代理分数',
      'Hidden 评测材料已准备并声明供给方式',
      'M2 pilot 与 M3 container 门禁返回 RECOMMEND',
    ],
  },
  {
    id: 'iteration',
    order: 3,
    chapter: '第 3 章 执行 Agent 自迭代',
    title: '两条长程轨迹',
    goal: 'Agent 自迭代用于验证题目可以持续优化。逐轮保留方法迭代记录并保存最终最佳方法的完整代码。',
    gates: ['G-TRAJECTORY'],
    deliverables: [
      { path: 'expert_evidence/trajectory_codex.json', kind: 'json', required: true, note: 'Codex + GPT-5.6 Sol，rounds 数组，每轮八字段' },
      { path: 'expert_evidence/trajectory_seed.json', kind: 'json', required: true, note: 'Codex + Seed 2.1 Turbo，rounds 数组，每轮八字段' },
      { path: 'expert_evidence/best_method', kind: 'dir', required: true, note: '唯一最终方法，不含历史快照' },
      { path: 'expert_evidence/run_summary.json', kind: 'json', required: true, note: '两条轨迹的实际有效时长与自验状态' },
    ],
    exitCriteria: [
      '两条轨迹各自有效执行不少于 10 小时（7 小时例外须满足全部条件）',
      '每轮完整包含八个字段，失败也保留记录',
      'best_method/ 已在干净任务快照中重跑并成功出分',
      'M4 long_run 门禁返回 RECOMMEND',
    ],
  },
  {
    id: 'release',
    order: 4,
    chapter: '第 4 章 整理轨迹与专家证据',
    title: '三目录交付与独立质检',
    goal: '整理最终专家出题包：可执行题目、专家交付，以及证明优化面与参考解真实有效的训练证据。',
    gates: ['G-REPLAY-CONTRACT', 'G-SINGLE-SOURCE', 'G-PACK-VERIFY'],
    deliverables: [
      { path: 'expert_evidence/专家作业说明文档.md', kind: 'md', required: true, note: '七段顺序，只陈述专家自验事实' },
      { path: 'expert_evidence/expert_annotation.json', kind: 'json', required: true, note: '精简机读标注，不含运行日志或审核结论' },
      { path: 'expert_evidence/run_summary.json', kind: 'json', required: true, note: '两组合有效时长与四项自验' },
      { path: 'expert_evidence/README.md', kind: 'md', required: false, note: '推荐：统一格式说明' },
      { path: 'optimization_evidence/README.md', kind: 'md', required: false, note: '推荐：通用目录与汇总规则' },
      { path: 'optimization_evidence/baseline_runs', kind: 'dir', required: true, note: '逐 seed：result.json / run.log / model（训练型）' },
      { path: 'optimization_evidence/reference_runs', kind: 'dir', required: true, note: '与 Baseline 同 seed 一一配对' },
      { path: 'optimization_evidence/comparison_summary.json', kind: 'json', required: true, note: '3σ/5σ 判定与 validity 块' },
      { path: 'expert_evidence/nop_selfcheck', kind: 'dir', required: true, note: '同一次 NOP Trial 的 config/result/reward/日志' },
    ],
    exitCriteria: [
      '三类交付均完整且职责不重复',
      '两份独立 QA 报告聚合共识为 PASS',
      'NOP 自检记录为当前题包版本且四件套同源',
      'M5 release 门禁返回 RECOMMEND',
      '交付字节冻结清单未登记改动数为 0',
    ],
  },
])

/** 按 id 取阶段。 */
export function phaseById(id) {
  return PHASES.find((phase) => phase.id === id)
}

/** 下一阶段；已是最后阶段时返回 undefined。 */
export function nextPhase(id) {
  const current = phaseById(id)
  if (current === undefined) return undefined
  return PHASES.find((phase) => phase.order === current.order + 1)
}

/** 教程第 1 章「题目变体」有效性判据。 */
export const VARIANT_RULES = Object.freeze({
  mustChange: ['模型架构', '优化目标', '起始代码', '限定搜索方向'],
  mustProduce: '本质不同的 Reference Solution',
  mustRerun: ['Baseline', 'Reference', '评分校验', '随机性检查', '资源检查'],
  notVariant: ['只改标题', '只改随机 seed', '无实质影响的参数'],
})

/** 教程明确废弃、不得再提交的旧结构。 */
export const DEPRECATED_PATHS = Object.freeze([
  'workspace/harbor_task/environment/trusted',
  'workspace/harbor_task/tests/runtime',
  'workspace/baseline',
  'workspace/harbor_task/executions',
  'workspace/harbor_task/runs',
  'optimization_evidence/h20_anchor_runs.json',
  'expert_evidence/best_policy.py',
  'expert_evidence/trajectory.json',
])
