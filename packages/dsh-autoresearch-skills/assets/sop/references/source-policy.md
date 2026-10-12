# 来源、版本与口径

这是 2026-10-05 对来源项目本地文档的整理快照。技能可在其他目录使用，不依赖原项目路径；在新项目内用 `rg --files` 定位当前资料，确认任务卡、Harbor/provider、Schema 和运行环境。没有当前资料时按本快照辅助工作，明确尚未核实最新平台口径。

## s1

来源：`平台文档/AutoResearch 三期培训流程说明.md`。

采用领题、题库同时未完成最多 3 道、领取后 24h 初版仓库、GPU 报批与报销、六步交付、三类目录及一次返修。自行选题等待项目组确认；按该文不受题库释放/三题限制。费用与日期是项目当期口径，不能推广成所有项目规则。

GPU 填规格（含 CPU/内存）、数量、天数和训练总成本；按规格单价×数量×天数估算，先报组长审批。未提供统一 GPU 日价或固定天数；模型费用和 GPU 费用分开，不拿 Seed API 示例费用当 GPU 报价。

## s2

来源：`平台文档/作业详细教程.md`。

采用制作步骤、训练产物/独立重载、完整正式实验、双轨时长、八字段、NOP。其 TOML 示例将 artifacts 放在 verifier 表内，与 V3 主文及实际质检合同不同，采用下文 s3/s5 明确的顶层配置。

## s3

来源：`平台文档/AutoResearch 专家线下标注教程V3/AutoResearch 专家线下标注教程V3.md`，含 2026-09-29 PCA 双镜像对齐和 2026-09-30 三期要求。

主要采用：八章题面、公开 Dev/最终 Hidden 时序、两个独立 context、受限候选执行、真实成对证据、Baseline 代表性、3σ/5σ、归一化、两组指定模型/有效时长、唯一最佳与最终 NOP。

正式合同：顶层 `artifacts=["/workspace/solution"]`，verifier 表设置 separate。schema_version=1.3 和资源值是样例，字段支持和真实生效必须按目标部署验证。单轮尽量≤2h、容器存活≥12h、Reference 剩余 Headroom 原则上≥3σ_B 是目标/原则，不能升级为未声明的机械淘汰门槛。

## s4

来源：`平台文档/规范格式/规范格式.md`。

采用三目录与 optimization_evidence 最小字段/条件性模型结构。其示例树将完整 harbor_task 标为 Agent 可见、列源码 solution、写 Hidden 注入空目录；按 s3/s5 解释：完整包只交平台，不整体暴露；运行时提交面从 Starter 初始化，源码 Oracle 可选；Hidden 必须有真实准备/调用/隔离证据，允许预置、生成或安全注入，不接受空目录或无依据承诺。

## s5

来源：`autoresearch-task-qa` v0.3.2（2026-10-03）及其 `source-alignment.md`、`research-quality.md`、`implementation-policy.md`、`harbor-harness.md`、`submission-format.md`、`docker-path-contract.md`、`implementation-report.md`。

采用 G01–G03、21 项检查、Harbor H01–H06、当前版本 NOP 必交、分开静态结论与真实运行范围、退回事实/修复/验收材料、schema 4 review 的规则。

已核对来源附件 CLI：`audit_task.py` 是旧入口，不支持 `--review`；`implementation_review.py` 支持该参数、当前 21 项和 schema 4 报告，支持 report.txt/md/json 与 return_to_expert.txt。默认 fail-on never，退出 0 不代表 PASS。未来版本先核对 --help，不永久锁死本次差异。

静态 QA07/08 仅题面，QA15 跳过资源上限；这些范围不豁免环境物理隔离、预算公平、资源/稳定性和正式 Hidden。没有当前 QA 工具时，只能交人工自查，不能宣称生成了官方机检产物。

## s6

来源：`autoresearch-baseline-quality/SKILL.md`。

采用角色区分、来源/实现/实际训练量/公平预算/参数选择/seed/收益归因与选择披露。合理 naive/经典方法可作正式对照；故障、异常缩减或不公平数据/预算必须有事实才判退。缺关键材料为待补证，不能推测专家动机。

## s7

来源：PCA 教学包 `pca_teaching_example/README.md`。

仅用于布局、公开小样本与独立评分时序教学。其旧原生评分有截断/分段与饱和；未取得完整 Docker/Harbor/Hidden、B/R 全 seed 和两轨长程证据。公开 smoke 不等于正式研究收益或验收通过；不可把 Reference 冒充 Agent 最佳。

## s8

来源：`平台文档/Autoresearch 难度打标PE/Autoresearch 难度打标PE.md`。

环境 E、优化面 O 各四维 0–2 分，按原文升级规则取高定级，缺证默认 1 并降低置信度。这里只作为原项目专家侧预估快照；当前自选题入库/顶会/查重如有服务器最新规则，按其专门工具，不用本文件代替。

## 跨文档明确裁定

- 两组各有效≥10h；7h 仅无训练、单轮很短、各≥3方法闭环等全部证据成立时适用。旧 12h/大于15轮不是统一门槛；12h 容器目标另算。
- 随机最低改善≥3σ_B，5σ_B 强证据；确定性旧固定5%已废弃。σ_B 是 B 的 n−1 样本标准差，不是标准误或配对差方差。
- 原始 x 优于 U 可得到>1；有效负分不自动无效。非作弊 Hard Gate=-1，其他错误分类，不能统一写0/-1。
- B/R 正式运行均值是锚点；正式实验完成前只做接口预验，不能拿 smoke/合成输入造 B。完成标定后写回评分并复验。
- U 必须独立有依据且在改善方向；不得为了达标倒推。Reference 不作唯一答案或上限。
- 完整正式 seed、失败日志、每 seed 实际模型/独立重载不能被精简版轨迹省略。未知时间/指标填 null，不补造。
- 自动检查/文件齐全不能替代有效候选端到端；NOP 早退不能证明完整 Hidden；同版最终 NOP 仍是必交项。

把新版本差异写入当前题目的专家说明，记录来源与影响；据实际运行合同更新验证范围，不把本快照当作永久平台部署事实。
