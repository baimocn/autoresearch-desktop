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

import { stat, readdir, readFile } from 'node:fs/promises'
import { join, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ASSETS_ROOT = join(HERE, '..', 'assets')

/** 本包名，用于把「自身资产」与「兄弟包资产」区分开。 */
const OWN_PACKAGE = 'dsh-autoresearch-gates'

/**
 * 按包名解析兄弟包的**安装目录**。
 *
 * 这里刻意不用路径算术（`join(HERE,'..','..','..')` 再拼 `packages/<pkg>`）：
 * 那个表达式只在「从源码仓库运行」时成立。装进 profile 后本包位于
 * `<DSH_HOME>/profiles/<name>/node_modules/dsh-autoresearch-gates/lib`，
 * 往上三级是 **profile 目录**，`packages/...` 根本不存在 —— 实测 14 个工具里
 * 4 个（发布门那 4 个：qa-audit / qa-implementation-review / privacy-scan /
 * verify-skill-archive）解析为 null，发布门工具集在装好的应用里完全不可用；
 * 而仓库侧测试读的是源码副本，全绿也发现不了（这正是它潜伏至今的原因）。
 *
 * Node 的模块解析在两种布局下都正确：仓库里走工作区链接，profile 里走
 * `node_modules/<pkg>`。解析不到返回 null，调用方如实报「不可用」。
 */
const requireFromHere = createRequire(import.meta.url)
const packageDirCache = new Map()

function packageDirOf(name) {
  if (typeof name !== 'string' || name === '') return null
  if (packageDirCache.has(name)) return packageDirCache.get(name)
  let dir = null
  if (name === OWN_PACKAGE) {
    // 自身包不必经过解析器：本文件在 <pkg>/lib，上一级就是包根。
    dir = join(HERE, '..')
  } else {
    try {
      dir = dirname(requireFromHere.resolve(`${name}/package.json`))
    } catch {
      dir = null
    }
  }
  packageDirCache.set(name, dir)
  return dir
}

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
    // 方向：默认 minimize（与脚本默认一致，保持既有题目的行为）。
    // maximize 类指标（准确率/召回率/balanced accuracy 等越高越好）下 U 必然
    // 大于 B，必须显式声明 direction='maximize'，否则脚本按 minimize 判读，
    // 会把真实改善报成「U 必须严格小于 B」的假阳性。
    parameters: {
      direction: {
        type: 'string',
        enum: ['minimize', 'maximize'],
        default: 'minimize',
        description: '指标优化方向；maximize 类指标必须显式声明',
      },
      fromPaper: { type: 'boolean', description: '只用论文数字做纸面预解（最早期拦截）' },
      fromProbe: { type: 'boolean', description: '用探针/实验数字判定' },
      b: { type: 'array', items: { type: 'number' }, description: 'Baseline 指标（可多个 seed）' },
      r: { type: 'array', items: { type: 'number' }, description: 'Reference 指标（可多个 seed）' },
      u: { type: 'number', description: 'U：minimize 时是地板/下限，maximize 时是可达上限' },
      uHint: { type: 'number', description: 'P0 阶段的 U 估计值（论文最优值或完美模型期望）' },
      sigmaMult: { type: 'number', description: 'σ_B 倍数阈值' },
    },
    note: '只有 --from-paper 与 --from-probe 都返回可行，才允许投入全 seed 正式协议。'
      + '方向取自题目元数据的**原始指标**层（anchors.json / comparison_summary.metric /'
      + ' expert_annotation）；读不到时会告警并按 minimize 执行，'
      + 'maximize 类指标须显式传 direction=maximize，否则 U>B 会被误判为结构性不可行。',
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
    // 纯咨询工具没有判定语义，退出 0 不能被当成 PASS。
    exitZeroIsPass: false,
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
    // 0 只是「收完了」，报告本身是未完成初稿；2 是调用参数错，不是证据不足。
    exitZeroIsPass: false,
    exitTwoIsInputError: true,
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
    // 发布门证据的生产者：把退出 0 当 PASS，等于在「一次都没强制门禁」的运行上盖章。
    // 结论只在报告里，因此必须交给读报告的一方判定。
    exitZeroIsPass: false,
    exitTwoIsInputError: true,
    note: '默认 --fail-on never；退出 0 不代表 PASS，必须读报告里的结论字段。' +
      '发布门路径需追加 --release-self-check 与 reviewer/session/clean-context 参数。',
  },
  // ── 发布前隐私扫描（上游仓库级工具，L3 演练中实测发现真实泄露后采纳） ──────
  //
  // 采纳理由（实测，非推测）：把它跑在本仓**已发布的公开内容**上，
  // 报出 45 项，其中 PRIVATE_COLLAB_URL 与 PRIVATE_IPV4 两类我的人工检查
  // 完全漏掉 —— 因为泄露的不是密钥，是内网地址，我的清单里没有这一类。
  // 详见 docs/l3-rehearsal.md §三。
  'privacy-scan': {
    id: 'privacy-scan',
    script: 'privacy_scan.py',
    resolveFrom: 'upstream-tools-0.3.4',
    title: '公开前隐私扫描（上游仓库级工具）',
    description: 'fail-closed 扫描：本机路径、私钥、API token、JWT、bearer、'
      + '内网协作 URL、邮箱、内网 IPv4、敏感文件名；会深入归档成员与二进制串。'
      + '命中值会被脱敏后才输出，不打印敏感内容本身。',
    milestones: ['M5'],
    requires: ['python3'],
    exitSemantics: { 0: '未发现隐私问题', 1: '发现隐私问题（fail-closed）', 2: '参数或路径错误' },
    // 0 是真通过；2 是调用参数/路径错，不是证据不足。
    exitTwoIsInputError: true,
    note: '退出码 1 是**真实发现**，不是工具故障。' +
      '注意它默认不读 .gitignore，因此在本仓直接跑会扫到 .dsh-home/ 与 node_modules/；' +
      '要判定「发布内容是否干净」，应对**发布产物或干净 clone** 跑，而不是对工作树跑。',
  },
  'verify-skill-archive': {
    id: 'verify-skill-archive',
    script: 'verify_skill_archive.py',
    resolveFrom: 'upstream-tools-0.3.4',
    title: '可分发 skill ZIP 结构校验（上游仓库级工具）',
    description: '校验一个可分发 OpenAI skill ZIP 的结构契约（--expected-skill 指定期望技能名）。',
    milestones: ['M5'],
    requires: ['python3'],
    exitSemantics: { 0: '结构契约满足', 1: '结构不符合契约', 2: '参数错误' },
    exitTwoIsInputError: true,
    note: '只校验结构契约，不校验内容正确性；内容正确性由双路质检负责。',
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
  'upstream-tools-0.3.4': {
    id: 'upstream-tools-0.3.4',
    // 上游**仓库级** scripts/，不属于任何单个技能，因此单独登记一个来源。
    // 与 upstream-0.3.4 分开的理由：这两份的生命周期不同。技能脚本随技能包
    // 发布，仓库级工具随仓库发布；上游改其中一个时不该让另一个的来源失效。
    root: 'assets/upstream-tools-0.3.4',
    package: 'dsh-autoresearch-gates',
    label: 'autoresearch-skills 仓库级工具 0.3.4',
    capabilities: {
      'release-self-check': false,
      'reviewer-identity': false,
      'clean-context': false,
      'fail-on-incomplete': false,
    },
  },
})

/**
 * 从题目元数据里读**原始指标**的优化方向。
 *
 * ## 为什么需要它（缺陷 3）
 *
 * 脚本默认 minimize，JS 门禁默认 maximize —— 两处默认**互相矛盾**。方向只能靠
 * 调用方手工声明，不声明就按各自的默认走，同一道题在两条路径上可能得出
 * 相反结论。而「改个默认值」不是解法：把任一侧默认改成另一侧，都会**静默
 * 反转**所有依赖旧默认的既有题目。
 *
 * ## 这个矛盾的真实成因：两层口径被当成了同一层
 *
 * · `feasibility_gate.py` 处理**归一化之前的原始指标**（误差/损失，越小越好）
 * · `gates.js` 的 `direction` 默认 `maximize`，描述的是**归一化后的 score**
 *   （`score = (x−B)/(U−B)`，按定义越大越好）
 *
 * 两层之间差一次方向翻转。AutoRe0566 的元数据把这件事写得很清楚：
 *
 *     metric_direction = "minimize（原始指标）；[task].metric=score 归一化后 maximize"
 *
 * 所以**不能拿 `[task].metric_direction` 当脚本的方向**：它的 metric 是
 * `"score"` 时，那一位按题目自己的注释是「固定 maximize」—— 是个恒真式，
 * 不携带任何关于原始指标的信息。实测：AutoRe0566 的原始指标是 minimize
 * 的 StatErr，而 `[task].metric_direction` 写着 maximize；直接采信会得到
 * **正好相反**的判定。
 *
 * 因此本函数只认**描述原始指标**的来源：
 *
 *   1. `workspace/harbor_task/tests/hidden_assets/anchors.json` 的 `direction`
 *      —— 它同时含 `metric`（原始指标名）与原始尺度的 `baseline_values`，
 *      层次明确。AutoRe1841 实测：metric=balanced_accuracy、scale=0-100。
 *   2. `optimization_evidence/comparison_summary.json` 的顶层 `direction`
 *      —— **仅当它同时给出原始指标名**（`metric` 为非空字符串且不是 `"score"`）
 *      时才采信；否则它描述的可能是归一化层。
 *   3. `expert_evidence/expert_annotation.json` 的 `score_contract` / 顶层
 *      `metric_direction` —— 同样要求指标名不是 `"score"`。
 *
 * **读不到就返回 null，由调用方决定怎么办** —— 本函数绝不猜、绝不返回默认值。
 * 一个猜出来的方向会让「方向没声明」这件事实消失，而那正是缺陷 1 的成因。
 *
 * @returns {{direction: 'minimize'|'maximize', source: string}|null}
 */
export async function readTaskMetricDirection(taskRoot) {
  if (typeof taskRoot !== 'string' || taskRoot.trim() === '') return null
  const root = isAbsolute(taskRoot) ? taskRoot : resolve(process.cwd(), taskRoot)

  /** 只接受两个字面量，其它一律视为未声明（含大小写变体与脏值）。 */
  const accept = (value, source) => (
    value === 'minimize' || value === 'maximize' ? { direction: value, source } : null
  )

  /**
   * 归一化层标记：`metric` 是 `"score"` 时，同一份记录里的 `direction`
   * 描述的是归一化分数（恒为 maximize），对本函数毫无信息量。
   */
  const isScoreLayer = (metricName) => (
    typeof metricName === 'string' && metricName.trim().toLowerCase() === 'score'
  )

  // 来源一：anchors.json —— 层次最明确（自带 metric 名与原始尺度值）
  try {
    const raw = await readFile(
      join(root, 'workspace', 'harbor_task', 'tests', 'hidden_assets', 'anchors.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (!isScoreLayer(parsed?.metric)) {
      const hit = accept(parsed?.direction, 'workspace/harbor_task/tests/hidden_assets/anchors.json')
      if (hit !== null) return hit
    }
  } catch { /* 不存在或不可解析：换下一个来源 */ }

  // 来源二：comparison_summary.json 顶层 direction（要求 metric 不是 score）
  try {
    const raw = await readFile(join(root, 'optimization_evidence', 'comparison_summary.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const metricName = typeof parsed?.metric === 'string' ? parsed.metric : parsed?.metric?.name
    if (!isScoreLayer(metricName)) {
      const hit = accept(parsed?.direction, 'optimization_evidence/comparison_summary.json')
      if (hit !== null) return hit
    }
  } catch { /* 不存在或不可解析：换下一个来源 */ }

  // 来源三：expert_annotation 的 metric_direction（同样要求指标名不是 score）
  try {
    const raw = await readFile(join(root, 'expert_evidence', 'expert_annotation.json'), 'utf8')
    const parsed = JSON.parse(raw)
    // 该字段可能是 "minimize（原始指标）；[task].metric=score 归一化后 maximize"
    // 这种**带解释的长串** —— 取开头的第一个字面量，而不是要求整串相等。
    const declared = parsed?.metric_direction ?? parsed?.score_contract?.direction
    const metricName = parsed?.metric_name ?? parsed?.score_contract?.metric
    if (!isScoreLayer(metricName) && typeof declared === 'string') {
      const leading = /^\s*(minimize|maximize)/.exec(declared)
      const hit = accept(leading?.[1], 'expert_evidence/expert_annotation.json metric_direction')
      if (hit !== null) return hit
    }
  } catch { /* 不存在或不可解析：视为未声明 */ }

  return null
}

/**
 * 源码仓库根目录 —— **仅对源码检出（source checkout）有意义**。
 *
 * 只有漂移检查（lib/drift.js 的 buildBaseline/detectDrift/findCompiledArtifacts）
 * 用它，而那些是 `npm run upstream:check` 这类开发期命令，本来就只在仓库里跑。
 *
 * 不要用它做运行期资产解析：装进 profile 后这个表达式得到的是 profile 目录，
 * 见 packageDirOf() 的说明。运行期一律走 packageDirOf()。
 */
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
  // logical 必须是字符串。调用方常写成 REVIEW_SCRIPT[sourceId] 这种查表形式，
  // 表里没有该来源时得到 undefined —— 那是「这个来源不提供该脚本」的正常情况，
  // 应当返回 null（调用方如实报不可用），而不是让 join() 抛 TypeError
  // 把整条检查链带崩。实测：新增一个来源但没同步补查表时就会触发。
  if (typeof logical !== 'string' || logical === '') return null

  const candidates = []
  if (sourceId === undefined) {
    candidates.push(join(ASSETS_ROOT, logical))
  } else {
    const source = UPSTREAM_SOURCES[sourceId]
    if (source === undefined) return null
    const roots = source.roots ?? [source.root]
    for (const root of roots) {
      if (typeof root !== 'string') continue
      // 优先在声明包内找，再在其 fallback 包内找。
      for (const pkg of [source.package, source.fallbackPackage]) {
        const pkgDir = packageDirOf(pkg)
        if (pkgDir === null) continue
        candidates.push(join(pkgDir, root, logical))
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
      // 方向只在显式声明 maximize 时透传。
      //
      // 刻意**不**把缺失回退成 maximize：feasibility_gate.py 的默认是 minimize，
      // 未传参数时行为与历史一致。若这里猜测方向，既会让 minimize 题目被静默
      // 反转，也会掩盖「调用方根本没声明方向」这一事实。
      // 缺失、null、'minimize' 一律不传，argv 与改动前完全相同。
      if (args.direction === 'maximize') push('--direction', 'maximize')
      push('--sigma-mult', args.sigmaMult)
      break

    case 'harbor-task-contract':
      push('--task', args.task)
      push('--build-timeout-floor', args.buildTimeoutFloor)
      push('--json', args.json)
      break

    case 'dockerfile-preflight':
      // 必须挡掉字符串：`for...of` 会把它按字符拆开，于是 Python 收到 15 个
      // 单字符位置参数（'e','n','v','/','D'…），报出来的错完全指不到真因。
      // 参数是 additionalProperties，字符串是合法输入，所以这里要显式拒绝。
      if (typeof args.dockerfiles === 'string') {
        throw new Error('dockerfiles 必须是数组（每个元素一个 Dockerfile 路径），收到的是字符串')
      }
      for (const file of args.dockerfiles ?? []) {
        if (typeof file === 'string' && file !== '') argv.push(file)
      }
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

    // 这两个曾经漏了 case，而工具的 enum 是由 TOOL_REGISTRY 生成的 ——
    // 模型被明确告知可以选它们，选了却必然抛「未知工具」。两个列表手工维护，
    // 于是漂移。下面这组断言（以及 selftest 里的覆盖检查）就是为了不再漏。

    case 'privacy-scan':
      // 用法：privacy_scan.py [-h] [root] —— root 是位置参数。
      push(args.source, true)
      break

    case 'verify-skill-archive':
      // 用法：verify_skill_archive.py --expected-skill X archive —— 标志在前，归档在后。
      // 位置参数优先取 source（本表其他工具的统一约定），兼容 archive 别名。
      push('--expected-skill', args.expectedSkill)
      push(args.source ?? args.archive, true)
      break

    default:
      throw new Error(`未知工具：${toolId}`)
  }

  return argv.filter((value) => value !== undefined && value !== null)
}

/**
 * 每个已登记工具都必须有 buildArgv 分支。
 *
 * 工具 id 的 enum 由 TOOL_REGISTRY 生成，而 argv 组装是另一个手工维护的 switch；
 * 两处漂移时，模型会被提供一个**必然失败**的选项（`privacy-scan` 与
 * `verify-skill-archive` 就这样失效过）。这个函数把漂移变成可测事实。
 *
 * @returns 缺分支的工具 id 列表；空列表 = 已对齐。
 */
export function findToolsWithoutArgvBranch() {
  const missing = []
  for (const toolId of Object.keys(TOOL_REGISTRY)) {
    try {
      // 空 args 只验证「有没有分支」；具体参数由调用方负责。
      buildArgv(toolId, {})
    } catch {
      missing.push(toolId)
    }
  }
  return missing
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
