# 前置内容门槛 G01–G03

先介绍优化面、Baseline 实际方法和 Reference 实际方法，再做三门判断，然后继续 21 项检查。三门独立参与总评；分数提升大不能抵消纯调参或不公平对照。所有状态为 pass / fail / manual：证据证明不满足为 fail；关键事实无法确认为 manual，不以猜测判通过或不通过。

## G01：方法层优化空间

依次阅读 Allowed Scope、候选解析/guard、调用接口、Starter 与 Reference 实际差异。写明输入输出、固定量、可改对象和真正生效的改动。不能仅看 method.py 文件名或“允许算法优化”口号。

| 情况 | 判定 |
|---|---|
| 只能提交学习率、轮数、ridge/loss 权重等字面量；模型、目标结构、数据策略、算法流程固定，不能表达新方法 | fail，PURE_HYPERPARAMETER_SEARCH。增加可调维度或搜索轮数不能修复。 |
| 开放损失形式、采样/更新规则、架构模块、检索或推理策略等可执行接口，实际 guard 允许实现 | 可以 pass；无需要求论文创新、SOTA 或提交很大代码差异。 |
| 题面说开放，解析器却只接受常量；或声称新方法，代码只是搜索既有数值配置 | 以实际可执行边界判定；有直接限制证据则 fail。 |
| 只允许参数变化，但参数实际编码可组合程序、结构或策略 | 读语义及接口后判断，不能按“出现数字/字典”自动失败。 |
| 方法空间开放，参考解仅改 ridge 0.01→1.0 | 单凭该 diff 不能证明整题纯调参；记录 Reference 只证明参数收益，要求可发现的非纯调参方向证据，并检查 G02/G03/QA14。 |
| 研究对象是 HPO 算法，Agent 可实现优化器/搜索策略，在多个未见任务按预算评估泛化能力 | 属方法研究；与固定任务求一组最优数值区分。 |

用户给出的 q1 情形：若题面及 guard 只许 LOSS_WEIGHTS/TRAINING 字面量且禁止函数/类，Reference 只改 ridge，则可直接判 G01 失败。修复应开放真实方法接口或重设计任务；可以不给 method 只给可验证 Scaffold，或使用可运行朴素 Starter。不能靠把 Baseline 再削弱来修复。

## G02：Baseline 的合理性

使用已安装的 autoresearch-baseline-quality/SKILL.md 及其专项参考。主报告保留 Baseline 来源/版本、方法与预算介绍，以及以下最低核对结果：

1. 角色：Starter、正式对照 B、归一化锚点是否一致；Scaffold 无完整 method 时，独立可运行 Baseline 及映射是否披露。锚点 0 是定义，不代表随机或无效。
2. 功能：输入、标签、损失、训练/推理路径和 checkpoint 是否正常；有无默认不开训练、错误标签、禁用核心输入等直接反证。
3. 训练充分性：分别核对计划和实际 epochs/steps/tokens/样本、有效 batch、曲线、早停/超时/失败原因与选用 checkpoint。不能仅看训练命令中写的轮数，不能因“未收敛”或轮数少就直接失败。
4. 公平性：同数据/切分/指标/seed，预算与调参机会可比。研究训练效率时固定计算/时间/token 预算，不强迫相同 epochs；架构/模型容量本来可改时，不把差异自动判违规。合理压缩应对双方使用同一公开规则。
5. 代表性：经典/朴素方法可以合理；只有任务匹配、资源可行、同协议可比的常用更强对照证据，才能判明显过弱。外部核验只用可验证论文/官方实现/官方结果，记录版本日期；查不到记证据缺口，不凭模型印象编造 SOTA。
6. 完整性：全 seed、所有失败、调参范围和 checkpoint 选择完整披露，不能挑最差 B 与最好 R、复制 checkpoint 冒充独立训练。

至少展示 training_sufficiency、method_representativeness、budget_comparability、implementation_correctness、selection_integrity 五维事实，可在 G02.dimensions 保存。Baseline 专项“合理”映射 pass，“不合理”映射 fail，“有疑点/无法判断”映射 manual。描述“B 实际训练 1 epoch、R 100 epoch，训练预算不是允许变量”，不要描述无法证明的“专家故意作弊”。

已明确批准的算法 debug 题可有已声明故障起点，但需要健康对照和故障修复目标；不得以修复已知故障的增益冒充一般方法研究增益。

## G03：提升真实、充分且仍有空间

固定正式 seed 全集，核对各轮原始指标、质量门、方法版本和协议。正式训练的独立重训与同一模型的随机评估重复分开记录：不能复制同模型冒充重训，也不能把合法多次随机评估误判为伪造。训练型任务核对模型索引/哈希/reload 记录；只做静态检查，不能加载不可信模型。

令 Δ=R均值−B均值（maximize），或 B均值−R均值（minimize）；正数统一表示改善。分数为 Δ/abs(U−B均值)，U 必须在正确的改善方向。检查：

- 所有正式轮均有效、同口径、成对完整，Δ>0，Reference 归一化分数在 [0.15,0.8]，不能另改 U 制造达标。
- 随机评估至少 3 次；协议规定 5 次或更多则全交。σ_B 是 Baseline 原始指标的样本标准差，分母 n−1；须 Δ≥3σ_B。达到 3σ_B 但低于 5σ_B 可接受并建议增跑/复核；≥5σ_B 为强证据。不用标准误、配对差标准差或 Reference 方差替代 σ_B。
- σ_B=0 仍需 Δ>0；样本方差为 0 不足以证明整个评估确定。
- 确定性评估不恢复已删除的统一 5% 规则。若任务另外预先定义有效提升容差，则同时核对其数值和来源；不能看完结果再挑阈值。
- 剩余 headroom 原則应 ≥3σ_B；不足时说明风险并由 QA14 核对可持续改进空间，不把“原则上”悄悄改成一刀切强制门槛。
- 归一化上限不可信、协议不一致或来源无法核实，不能仅靠大分差放行；缺关键证据为 manual，明确质量门失败、数据不公平或数值未达门槛为 fail。

对外退回说明采用“观察到的事实及路径 → 为何不满足 → 专家应修改什么 → 重交需提供什么”。例如：优化面仅支持固定权重字典（instruction.md:xx、guard.py:yy），当前无法实现方法更新；请开放可调用的方法接口并同步约束校验，补充可运行 Baseline/Reference、方法差异说明和全部同 seed 对照结果。

## 数值输入与自动校验

完整字段见 implementation-report.md。G03.assessment 记录 direction、formal_seeds、declared_run_count、evaluation_mode、same_protocol、quality_valid、upper_bound、threshold_basis；可选 absolute_min_improvement/absolute_threshold_source。程序依据 overview.baseline_reference.paired_runs 复算 computed，不信手写均值、passed 或改善文本。人工仍必须核对数值来自所引用的 result.json，而不是把这一步当真实性认证。
