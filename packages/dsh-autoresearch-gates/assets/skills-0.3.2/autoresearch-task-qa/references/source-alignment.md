# 来源、版本与适用范围

本次版本 v0.3.2（2026-10-03），沿用 2026-09-30 的三期对齐依据，并按用户确认将当前题包版本的一次 NOP 自检记录设为必交。三期依据为用户确认的要求和[专家线下标注教程V3](https://bytedance.larkoffice.com/docx/DJhEdv0oTod4sExGgu6cp00onHg)（三期修改前 revision 222）；下表保留二期来源快照，用于追溯内容门与证据规则。

| 来源 | 读取版本 | 采用内容 |
|---|---|---|
| [专家线下教程](https://bytedance.larkoffice.com/docx/P1J5dgIw1oKchcxn29GcvzlMnSd) | revision 221（修改前） | 三目录、成对全部 seed、条件性模型证据、两条简化轨迹、双轨各10h与7h例外 |
| [算法规范](https://bytedance.us.larkoffice.com/docx/Th1ydNXiXoa59lxJrg0uYSnlsdc) | revision 1724（修改前） | 方法搜索空间、合理非平凡Baseline、归一化[0.15,0.8]、Baseline样本标准差的3σ门槛、5σ强证据、Harbor接口与12h容器稳定性目标 |
| 教程顶部 example.zip，附件 Tc56bO51bokIHOxGXP5cgPbvn9g | 83,826,813 字节；2026-09-18读取 | 仅取经检查的文件布局和构建路径；其静态代码并不能证明目标平台已经构建成功 |
| 用户本轮明确要求及提供的算法侧交流 | 2026-09-18 | 拒绝固定任务纯调参；Baseline不得取不合理弱对照；允许无method Scaffold或合理naive Starter；前置方法介绍和三门判定；专家可执行退回说明 |

优先采用本轮明确要求和已核实的有效条款。资料矛盾要记录裁定与依据，不以旧报告、附件的passed或已删除旧文覆盖。今后用户给新任务卡/新平台规范时读取并更新版本依据，不把此快照当永久部署版本。

2026-09-30 三期口径：Agent 与 Verifier 分别以 `environment/Dockerfile`、`tests/Dockerfile` 构建；显式 separate。公开 Dev 必须保留供 Agent 迭代，最终私有 Hidden 留在独立 Verifier。Hidden 是私有测试用例、标签、基准或评估生成逻辑等，训练与非训练任务均适用；目录名可不同，也可有依据地生成或安全注入。检查材料、来源与真实调用关系，不要求固定非空 `tests/hidden_assets/`。这覆盖历史附件将全部 tests 复制进 Agent 的做法。

2026-10-03 用户确认：必交一次当前题包版本的 NOP 自检记录，用于证明题包能构建并跑通 Harness。核对正常结束、独立 Verifier 执行及有效 reward，可复用平台已有同版本记录；缺少记录使 H06 与 QA17 fail，运行状态记 not_run。任务版本对应关系可引用已有配置、日志或专家说明。NOP 的 0 分本身不判失败。Oracle Trial 仍非必交。官方 [Separate verifier](https://docs.harborframework.com/core-concepts/tasks/separate-verifier) 说明独立环境及产物移交；[NOP 实现](https://github.com/harbor-framework/harbor/blob/main/src/harbor/agents/nop.py) 不执行求解操作，已有 Starter 并不会因此被清空。

## 本次明确裁定

- 算法规范中的“随机评分必须超出5σ”和“确定性超过Baseline 5%”均有删除线，已经废弃。生效的是3σ最低门槛、5σ强证据；确定性用真实正向改善、归一化范围及题目另行预声明容差。
- 教程主表和run_summary均为两条各10h，支持完整证据下各7h例外；启动Prompt仍写12h和大于15轮，属于内部冲突。本次按主表和正式字段统一为10h/7h；用户随后明确7h只适用于不涉及训练且单轮迭代很短的任务。训练/微调任务即使单轮快也须10h，不自行定义通用分钟数界线。容器存活12h属于另一个稳定性目标，不能拿来替代Agent有效时长。
- 教程“Baseline=未经修改Starter”是默认。用户允许Scaffold不给method时仍须提交明确来源、可运行朴素对照和与归一化锚点的映射，不能以随机/故障/未训练占位分数造提升。
- 教程可改文件示例为method.py，不表示只能改数字；检查真正的接口与guard。方法结构固定而仅可调权重的题不通过。
- example Dockerfile以任务根为构建上下文，容器根为/workspace。原生Harbor常见environment/上下文是另一套profile；不能混用。附件task.toml含自定义配置，test.sh只跑pytest，因此附件是布局示例，不是原生Harbor通过证书。具体适配实现必须查证。
- 提升空间Headroom的“原则上不少于3σ”应保留风险复核语气，不能升级为未声明的一刀切门槛。
- 两条 Agent 轨迹按三期教程记录八字段：round、policy_name、method_summary、status、score、failure_reason、retained_best、time；二期仅两字段的规则已被替代。有效时长仍从 run_summary 与实际记录核对，不能从时间戳跨度直接推算。ATIF 与专家轨迹不是同一 schema。

## 此Skill的静态覆盖边界

平台/专家的完整要求与自动静态质检的覆盖范围分开写。保留既有QA07/08仅题面泄露检查、QA15不审资源上限的范围，不把未覆盖要求删除出原始规范，也不能宣称其已通过。平台仍负责Hidden正式运行、完整物理隔离与资源/稳定性验证；本Skill可审已有证据，默认不执行未知代码或12h压测。Baseline预算公平、可机检硬约束及构建接入属于G02/QA05/H03的在检范围。

格式扩展只要等价、路径有效、证据完整就不自动扣错；必需字段缺失及真实调用失败不能以“允许扩展”豁免。退回说明引用待检材料，不能把本来源说明当作专家任务已经运行的证据。
