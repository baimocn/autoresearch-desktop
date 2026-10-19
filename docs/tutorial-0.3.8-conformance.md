# 与《AutoResearch 专家线下标注教程V3》v0.3.8 的逐条对照

> 对照对象：`D:\Desktop\智动化论文\AutoResearch 专家线下标注教程V3.zip`
> 文档版本：**v0.3.8（2026-10-12 更新）**
> 平台版本：`packages/*` 当前工作树（门禁资产 vendored 在 `skills-0.3.2` / `qa-0.3.4`）
> 对照日期：2026-10-13
>
> 行号均指解压后的 `AutoResearch 专家线下标注教程V3.md`。

---

## 0. 结论

**结构性对齐得很好**：四阶段、八章节题面、三目录交付、八字段轨迹、10h/7h 时长、
3σ/5σ 与归一化区间、归一化公式、废弃路径清单 —— 逐条对得上。
废弃路径清单甚至**逐项一致**，说明此前已有人按新版对齐过。

**但有 12 处未对齐**。其中 9 处**已修**，2 处等平台，1 处已核实无需改动：

| 严重度 | 问题 | 后果 | 状态 |
|---|---|---|---|
| 🔴 阻塞 | `tests/Dockerfile` 被硬要求 | 0.3.8 允许复用 Solver 镜像时省略；平台省略 → G3.3 UNKNOWN → 卡在阶段 2 | ✅ 已修 |
| 🔴 阻塞 | task.toml schema 分歧 | 平台要求 `[task].name` / 顶层 `schema_version` / `network_mode`，**0.3.8 模板里这三样都不存在** | ⏸ 等平台 |
| 🔴 缺失 | QA21 题包指纹无任何实现 | 0.3.8 的**新增必交项**；算法定义在未随包分发的 `task_fingerprint.py` 里 | ⏸ 等平台 |
| 🟡 缺失 | QA15 资源上限无校验 | ≤7200s / ≤8×H20-L20 / ≤64 核 | ✅ 已修（G2.7–G2.10） |
| 🟡 缺失 | 7 小时例外条件不全 | ≥3 轮闭环 / 重跑 / 写明节奏 | ✅ 已修（G11:exception:*） |
| 🟡 缺失 | `run_summary.validation` 无校验 | 四项自验声明 | ✅ 已修（G14.5） |
| 🟢 口径 | `nop_selfcheck` 目录名被当固定 | 0.3.8 只说「放入 expert_evidence/」 | ✅ 已修（降级 + 递归查找） |
| 🟢 口径 | `hidden_assets` 被当固定目录 | — | ✅ **核实无需改动**（脚手架文案已是 0.3.8 原话） |
| 🟢 口径 | `best_method` 只查存在性 | 0.3.8 有 4 项内容要求 | ✅ 已修（G14.6） |
| 🟢 缺失 | Git remotes/tags/reflog 清理无检查 | 数据隔离清单第 5 项 | ✅ 已修（G14.7） |
| 🟢 缺失 | 专家可夹带「审核通过」结论 | 教程明文禁止 | ✅ 已修（G14.8 / G14.9） |
| 🟢 缺失 | 资源字段名（`docker_image` / `gpu_types`） | 属 schema 项 | ⏸ 随第 2 项 |

> **两处更正**：本报告初版把「7 小时例外只查了 1 个条件」和「`hidden_assets` 被当固定目录」
> 写重了。复核代码后确认：四个资格字段**本来就查了**，`hidden_assets` 的脚手架文案
> **本来就是 0.3.8 原话**。详见 §2.5 与 §2.7 的更正说明。


---

## 1. 已对齐（逐条核对通过）

| 0.3.8 要求 | 出处 | 平台实现 |
|---|---|---|
| 四阶段结构 | 第 1–4 章 | `lib/phases.js` 四阶段，`chapter` 字段标注章节 |
| 八章节题面 | L274–302 | `G3.6`（**本次修好**：原先不认 `## 1. Goal` 编号标题） |
| 题面无泄露线索 | L983 | `G3.7`（arxiv / github.com / 论文标题） |
| 三目录交付 | L731–769 | `phases.js` 阶段 4 交付物清单 |
| 八字段轨迹 | L677–703 | `TRAJECTORY_FIELDS` = round / policy_name / method_summary / status / score / failure_reason / retained_best / time |
| `time` 格式 | L688 | `TIME_PATTERN` = `YYYY-MM-DD HH:mm:ss` |
| 有效时长 ≥10h | L626–629 | `MIN_EFFECTIVE_HOURS = 10` |
| 7h 例外门槛 | L629 | `EXCEPTION_EFFECTIVE_HOURS = 7` |
| **旧门槛「12h 且 >15 轮」作废** | L117 | 平台无 12h、无轮次门槛 ✓ |
| 3σ/5σ 可分辨性 | L554–558 | `SIGMA_MULT_REQUIRED = 3` |
| R_norm ∈ [0.15, 0.8] | L538 | `R_LO = 0.15` / `R_HI = 0.8` |
| 归一化公式（双向） | L532–534 | `normalize()` 按 direction 分支 |
| U 方向必须越过 B | L540 | `G1.5` 显式检查 U 方向 |
| U ≠ B（分母非 0） | L540 | `G1.5` |
| Baseline 样本标准差 n−1 | L548 | `sampleStd` |
| 正式 seed 至少 3 次 | L550 | `MIN_SEEDS = 3`，波动大 `MIN_SEEDS_VOLATILE = 5` |
| **废弃路径清单** | L220 | `DEPRECATED_PATHS` **逐项一致**（trusted / tests/runtime / workspace/baseline / executions / runs / h20_anchor_runs.json / best_policy.py / trajectory.json） |
| NOP 自检判据 | L21–31 | `G-NOP-RESULT` 十项：config / result / log / finished_at / exception_info / separate / nop / reward 有限 / 同一次 Trial |
| reward 有限数值 | L109 | `G6.8` / `G6.9` |
| 独立 Verifier 入口 | L83 | `G3.3`–`G3.5`（tests/ 侧 Dockerfile 契约） |
| COPY 不越界、不混用任务根 | L82 | `G3.1` / `G3.3` |
| Agent 镜像不得复制 tests/Hidden/Reference | L341 | `G3.2` |
| 禁 DinD / 不采用 Compose | L19 / L111 | `G3.11`（红线 6） |
| 评分入口 `/tests/test.sh` | L83 | `G-NOP-RESULT` 与 `G-DOCKERFILE` 契约 |
| 三个目录职责不重复 | L769 | 交付物清单按目录划分 |
| `comparison_summary.json` v2 schema | L475 | 脚手架模板 `schema_version: autoresearch-comparison-summary.v2` ✓ |
| `run_summary` 的 agent_execution / fast_iteration_exception / validation | L854–882 | 脚手架模板**已按 0.3.8 形状**（含 `effective_rounds` / `typical_round_minutes`） |

---

## 2. 未对齐（按严重度）

### 🔴 2.1 `tests/Dockerfile` 被硬要求，0.3.8 允许省略

**0.3.8 原文**（L169、L512）：

> 复用 Solver 镜像时**无需 tests/Dockerfile**，tests/ 仍作为私有评分材料，仅上传到新的 Verifier sandbox
> 复用 Solver 镜像时**可省略此文件**，按目标版本上传 tests/

**平台现状**：`phases.js` 阶段 2 把 `workspace/harbor_task/tests/Dockerfile` 列为 **[必需]**；
`G-DOCKERFILE` 在 `testsDockerfile` 缺失时给 **G3.3 UNKNOWN** → 门禁 NEEDS_EVIDENCE →
`advanceState` 拒绝推进。

**实测**（省略 tests/Dockerfile）：

```
结论: NEEDS_EVIDENCE
  UNKNOWN G3.3 | tests/Dockerfile 内容未提供
```

**建议**：G3.3–G3.5 在 tests/Dockerfile 缺失时应**跳过**（并如实记录「复用 Solver 镜像」），
而不是 UNKNOWN。同时阶段 2 的必需交付物里把它降为非必需。

### 🔴 2.2 task.toml schema 分歧

**0.3.8 模板**（L228–254）实际字段：

```toml
artifacts = ["/workspace/solution"]
[environment]
docker_image = "hub.byted.org/<ns>/<task-work>:<tag>"
cpus / memory_mb / gpus / gpu_types / build_timeout_sec
[agent]
timeout_sec
[verifier]
timeout_sec
environment_mode = "separate"
[verifier.environment]
docker_image / cpus / memory_mb / gpus / build_timeout_sec
```

**平台 G-CONTRACT 检查**：`[task].name`、`[agent].network_mode`、`[verifier].network_mode`、
`[verifier].environment_mode`、`[environment].build_timeout_sec`、顶层 `schema_version`、顶层 `artifacts`。

**逐字段比对**：

| 平台检查 | 0.3.8 模板里存在？ |
|---|---|
| `[task].name` | ❌ **不存在**（模板无 `[task]` 表） |
| 顶层 `schema_version` | ❌ **不存在** |
| `[agent].network_mode` | ❌ **不存在**，且 L258 明确「**不声明** no-network 或网络白名单」 |
| `[verifier].network_mode` | ❌ 同上 |
| `[verifier].environment_mode` | ✅ 存在 |
| 顶层 `artifacts` | ✅ 存在 |
| `[environment].build_timeout_sec` | ✅ 存在 |

**结论**：6 项里 3 项在 0.3.8 schema 下**必然 FAIL/UNKNOWN**。

这条直接影响判断：**`network_mode = "none"` 不是「写错枚举值」，而是这个字段本就不该声明。**
我此前在演练报告里按 SOP 推断「应改成 `no-network`」——**按 0.3.8 应改为删除该字段**。

**建议**：以 0.3.8 模板为准重写 `gateTaskContract`；`network_mode` 若存在则校验枚举，
**缺失不再判 UNKNOWN**（而是「未声明，符合当前内场要求」）。

### 🔴 2.3 QA21 题包指纹完全没有实现

**0.3.8 要求**（L18、L850–898）：

> `run_summary.json` 的 `task_binding` 记录 `hash_profile` 与 `task_content_sha256`；
> 范围固定为 `environment/`、`task.toml`、`tests/`、`instruction.md`。目录内全量递归，
> 缺字段待补，哈希不一致须核对版本。
> `python3.11 <Skill目录>/scripts/task_fingerprint.py <harbor_task目录>`

**平台现状**：
- 全库搜 `task_binding` / `task_content_sha256` / `hash_profile` → **只有 vendored 的 0.3.4 QA 脚本里
  一个同名的 `trial_task_binding`**（那是 NOP trial 的版本映射，**与题包指纹不是一回事**）
- 脚手架 `RUN_SUMMARY_TEMPLATE` **缺 `task_binding` 整块字段**
- `docs/red-lines.md` 的「红线 4 哈希对齐」此前标为「已有」，实为空头承诺（**已在上一轮改为「未实现」**）

**这正是红线 4 的具体化** —— 0.3.8 把当年那条模糊的「哈希对齐」写成了明确要求。

**建议**：
1. 脚手架模板补 `task_binding` 两字段
2. 新增 `G-FINGERPRINT` 门禁（或并入 G-PACK-VERIFY）：按四路径递归算 SHA-256，
   与 `run_summary.task_binding.task_content_sha256` 比对，`hash_profile` 必须是 `harbor-task-inputs-v1`
3. 实现 `task_fingerprint.py` 的等价 JS 版本（`hash_profile` 定义需与 Skill 内脚本一致，
   否则算出的哈希对不上 —— 这是**必须先拿到那个脚本**才能确定的部分）

### 🟡 2.4 QA15 资源上限无校验

**0.3.8 要求**（L16、L266）：完整单轮 ≤7200 秒、≤8 张 H20/L20、≤64 核 CPU；GPU 题只用 H20/L20。

**平台现状**：全库无 `7200` / `max_gpus` / `gpu_types` 相关校验。

**建议**：在 G-CONTRACT 增加资源判据：`[environment]` + `[verifier.environment]` 的
`cpus` 合计 ≤64、`gpus` 合计 ≤8、`gpu_types ⊆ {H20, L20}`、`time_limit_seconds` ≤7200。

### 🟡 2.5 7 小时例外只查了一部分条件

> **更正**：本报告初版写「只查了 1 个条件」，**不准确**。
> 复核代码后发现 `G11:exception` **已经**校验了四个资格字段
> （`non_training` / `short_iterations` / `rollable_proved` / `evidence` 非空）。
> 真正缺的是下面这几条量化要求。

**0.3.8 的 5 个条件**（L631–641）：

| # | 条件 | 平台原本 | 现状 |
|---|---|---|---|
| 1 | 两个模型组合各 ≥7h | ✅ `duration_hours` | — |
| — | 四个资格字段为 true | ✅ `G11:exception` | — |
| 2 | 每条轨迹 ≥3 轮有效闭环 | ❌ | ✅ **本轮已补** `G11:exception:rounds` |
| 3 | 方法摘要能看出连续演进 | 静态难判 | 由平台/人工复核 |
| 4 | `best_method/` 已在干净快照重跑出分 | ❌ | ✅ **本轮已补** `G11:exception:rerun`（读 `validation.best_method_rerun_passed`） |
| 5 | 写明有效轮数与典型单轮耗时 | ❌ | ✅ **本轮已补** `G11:exception:pace`（读 `effective_rounds` / `typical_round_minutes`） |

修完后实测：勾了 flag 但轨迹只 1 轮、未写耗时、未重跑 best_method —— 三种都判 FAIL。


### 🟡 2.6 `run_summary` 新字段无校验

脚手架模板已写 `effective_rounds` / `typical_round_minutes` / `validation.*`，
但**没有任何门禁读它们**。0.3.8 明确（L886）：

> `optimization_evidence_complete` 仅表示专家已备齐第三个目录
> 各项自验任一为 `false` 时，先修复再提交

**建议**：`G-TRAJECTORY` 或新增门禁校验 `validation` 四项为 true（发布阶段）。

### 🟢 2.7 目录名被当固定：`nop_selfcheck` 与 `hidden_assets`

> **更正**：本报告初版把两条并列，**`hidden_assets` 那条说错了**。
> 复核后发现脚手架的 `tests/hidden_assets/README.md` 文案**已经是 0.3.8 的原话**：
> 「Hidden 评测材料必需；**目录名只是示例**。可私有侧预置，或由平台在评分时安全注入…」，
> 且 `tests/hidden_assets` **不是**必需交付物。这条无需改动。

**0.3.8 原文**（L29）：NOP 记录「将同一次 Trial 的 config.json、result.json、
reward.txt 或 reward.json，以及运行日志**放入 expert_evidence/**」—— 未指定子目录名。

**平台原本**：阶段 4 把 `expert_evidence/nop_selfcheck` 列为**必需**目录，
且 `collectFromTask('G-NOP-RESULT')` 只从固定路径读证据 —— 把一种约定当成了要求。

**本轮修法**（两处）：
1. 该交付物降为**非必需**（保留作为推荐位置）
2. `collectFromTask('G-NOP-RESULT')` 改为**递归查找** `expert_evidence/`，
   按文件名（`config.json` / `result.json` / `reward.txt|json` / `*.log`）认证据，
   不再依赖目录名

实测：四类证据分散在 `expert_evidence/trial-20261013/` 与 `expert_evidence/` 两层下，
`fromTask` 全部找到并让门禁判 RECOMMEND。


### 🟢 2.8 `best_method` 只查存在性

**0.3.8 的 4 项**（L949–957）：仅最终方法、含入口与必需配置、不含 Reference/Hidden/密钥、
已在干净快照重跑出分。

**平台现状**：只查 `expert_evidence/best_method` 存在。

**建议**：至少加「不含 Reference/Hidden 线索」与「非空」两项（后两项需运行期证据，属平台职责）。

### 🟢 2.9 Git 清理无检查

**0.3.8**（L582、L1017）：Git remotes / tags / reflog 与含答案线索的修复提交已清理。

**平台现状**：无检查。任务目录不一定是 git 仓库。

**建议**：可选门禁 —— 若任务根是 git 仓库，检查 remote 列表与 `git log` 是否含答案线索。

### 🟢 2.10 资源字段名分歧

0.3.8 用 `[environment].docker_image`（预构建镜像）+ `gpu_types`（复数）；
AutoRe0566 用 `[agent].dockerfile` + `[resources].gpu_type`（单数）。

**建议**：以 0.3.8 模板为准；`gpu_types` 复数、CPU 题删除该行。

### 🟢 2.11 / 2.12 静态难查项（可标注为平台职责）

- 候选在 Verifier 中的受限执行（L521、L995）
- 评分函数连续/单调/不裁剪（L536、L997）

这两条 0.3.8 也写明由平台侧验证，平台门禁可只做**声明性检查**
（如要求专家说明里写明机制），不必静态判定。

---

## 3. 建议动作（按优先级）

| 顺序 | 动作 | 代价 | 影响 | 状态 |
|---|---|---|---|---|
| 1 | G3.3–G3.5 在 `tests/Dockerfile` 缺失时按「复用 Solver 镜像」判 PASS；阶段 2 该交付物降为非必需 | 半天 | 解除 🔴 阻塞 | ✅ **已修** |
| 2 | 按 0.3.8 模板重写 `gateTaskContract`：删 `[task].name` 与顶层 `schema_version` 要求，`network_mode` 缺失不判 UNKNOWN | 半天 | 解除 🔴 阻塞 | ⏸ **等平台** |
| 3 | 脚手架 `RUN_SUMMARY_TEMPLATE` 补 `task_binding` 两字段 | 1 小时 | 让模板与 0.3.8 一致 | ✅ **已修** |
| 4 | 实现 QA21 题包指纹门禁 | 1–2 天 | 补上唯一缺失的**必交项** | ⏸ **等平台（缺 task_fingerprint.py）** |
| 5 | QA15 资源上限判据 | 半天 | 补 🟡 | ✅ **已修**（G2.7–G2.10） |
| 6 | 7 小时例外的其余条件 | 半天 | 补 🟡 | ✅ **已修**（rounds / pace / rerun） |
| 7 | `validation` 四项校验 | 2 小时 | 补 🟡 | ✅ **已修**（G14.5） |
| 8 | `nop_selfcheck` 解绑目录名 | 半天 | 补 🟢 | ✅ **已修**（交付物降级 + fromTask 递归查找） |
| 9 | `best_method` 内容检查、Git 清理检查 | 1 天 | 补 🟢 | ✅ **已修**（G14.6 / G14.7） |
| 10 | 不得夹带审核结论（annotation / 说明文档） | 2 小时 | 补 🟢 | ✅ **已修**（G14.8 / G14.9） |

### 本轮（5–10 项）实现摘要

| 门禁 | 新判据 | 依据 |
|---|---|---|
| G-PACK-VERIFY | `G15.1` 单轮 ≤7200s（超限判**需复核**，不硬拒） | L268 / L600 |
| G-PACK-VERIFY | `G15.2` CPU 合计 ≤64 核（两个 sandbox 相加） | L266 |
| G-PACK-VERIFY | `G15.3` GPU 合计 ≤8 张 | L266 |
| G-PACK-VERIFY | `G15.4` GPU 题仅 H20/L20；CPU 题不得声明 `gpu_types` | L226 / L266 |
| G-TRAJECTORY | `G11:exception:rounds` 每条轨迹 ≥3 轮闭环 | L635 |
| G-TRAJECTORY | `G11:exception:pace` 写明 `effective_rounds`(≥3) 与 `typical_round_minutes` | L641 |
| G-TRAJECTORY | `G11:exception:rerun` `best_method` 已重跑出分 | L639 |
| G-PACK-VERIFY | `G14.5` `validation` 四项须全为 true | L877–886 |
| G-PACK-VERIFY | `G14.6` `best_method/` 非空且不含 Reference/Hidden/密钥 | L949–957 |
| G-PACK-VERIFY | `G14.7` Git remotes/tags 已清理（非仓库则不适用） | L582 / L1017 |
| G-PACK-VERIFY | `G14.8` `expert_annotation.json` 不得含 `approved` / `audit_passed` | L798 |
| G-PACK-VERIFY | `G14.9` 专家说明不得声称「审核通过」或官方 Hidden 结果 | L787 |

### ⚠️ QA15 放在**发布期**而非阶段 2 —— 一处实现过程中的纠错

初版把 `G2.7`–`G2.10` 加进了阶段 2 的 `G-CONTRACT`。实测**直接卡住 4 个真实任务**
（`AutoRe0566` / `AutoRe1841` / `auto2604` / `AutoRe1852` 都没写全 `time_limit_seconds`
或 `gpu_types`）—— 而 QA15 在教程里是**提交期质检项**（「本版重点检查什么」表
+ L989「提交前专家自查」），不是构建题包的前置条件。

已改为独立函数 `gateResourceLimits()`，由**打包门**调用（`G15.x`）。
效果：阶段 2 不再因资源字段缺失而阻塞；提交前仍强制达标。

同时修掉一处**卡型匹配 bug**：初版按整串精确比对 `{H20, L20}`，而真实任务写的是
厂商全名（`auto2604` 的 `gpu_type = "NVIDIA L20"`）→ 合法的 L20 被判非法。
改为按**型号 token** 匹配（`NVIDIA L20` / `L20 48GB` / `l20` 都算合法，
`NVIDIA A800 80GB PCIe` 仍判需复核）。修后 `auto2604` 的 QA15 全部达标。

另修一处**我引入的回归**：`G2.2:environment`（network_mode 写在 Harbor 不读的位置）
原本判 UNKNOWN，而 UNKNOWN 与 FAIL 一样拦 —— 把 `AutoRe1841` 卡在阶段 2。
那条只是**信息性**提示（写了无效但无害），已改为不阻塞（信息保留在 detail 里）。

配套改动：
- `collectFromTask('G-PACK-VERIFY')` 收集 `runSummary` / `bestMethodFiles` / `gitState` /
  `annotation` / `expertDoc` / `taskToml`（**Git 状态直接读 `.git/config` 与 refs，不 spawn 进程**）
- `collectFromTask('G-NOP-RESULT')` 改为递归找四类证据
- 脚手架 `task.toml` 模板补 `time_limit_seconds = 7200` 与 `gpu_types = ["H20"]`

### 对真实任务的实测影响（4 个已存在任务）

| 任务 | 阶段 2 契约门 | 发布期 QA15 | 说明 |
|---|---|---|---|
| `AutoRe1841` | **RECOMMEND** | 缺 `time_limit_seconds` / `gpu_types` | 可推进到双轨前 |
| `AutoRe1852` | **RECOMMEND** | 缺 `time_limit_seconds` / `gpu_types` | 可推进到双轨前 |
| `AutoRe0566` | REJECT | 14400s 超限 + A800 非内场卡型 | **被待定的 schema 项挡住** |
| `auto2604` | REJECT | 全部达标 | **被待定的 schema 项挡住** |

后两个的 REJECT **全部来自第 2 项（task.toml schema 分歧）**：
`[task].name` 缺失（真实文件用 `title`）、`network_mode = "none"` 判非法枚举、
`build_timeout_sec` / `schema_version` 层级不同。**等平台更新后才能推进。**

**新增的 JS/Python 覆盖范围差异已登记**：`gateTaskContract` 现在比 Python 权威
多查 QA15 资源上限，已写入 `ablation-gates.mjs` 的 `EXPECTED_DIVERGENCES`。
（`advanceState` 消费的是 JS 结论，所以这是有意的门槛，不是缺陷。）


### 第 2 项为什么需要你定夺

平台的门禁有**两份实现**，必须同时改才不会制造新的分歧：

- JS 侧：`lib/gates.js` 的 `gateTaskContract`
- Python 权威：`assets/sop/tools/harbor_task_contract.py`（vendored 自 SOP）

0.3.8 的 task.toml 模板里**没有** `[task].name`、没有顶层 `schema_version`、
也没有 `network_mode`（L258 明确「不声明 no-network 或网络白名单」）。
按 0.3.8 改，等于要**同时改这两份实现**，并且要确认 Python 那份的改动会不会与
上游 SOP 后续版本冲突。

**我上一轮修 G-CONTRACT 时刚把 JS 对齐到 Python 权威**（原先两边读的段落都不一样）。
现在若单改 JS 去迁就 0.3.8，就会重新造出「JS 说 PASS、Python 说 FAIL」的分歧 ——
那正是我上一轮修掉的那类缺陷。所以这条我不擅自动手。

**建议**：先确认 Python 权威脚本是否也会随 0.3.8 更新；若会，等它更新后一起改；
若不会，我再把两份一起改并补一条「两边同口径执行」的对比测试（像 G-CONTRACT 现在那样）。

### 第 4 项的前置依赖

`hash_profile = "harbor-task-inputs-v1"` 的**具体算法定义**在三期质检 Skill 的
`scripts/task_fingerprint.py` 里，**本 zip 未包含该脚本**。

在拿到它之前，我只能实现「按四路径递归算 SHA-256」的合理版本，但
**算出的哈希大概率与官方脚本不一致** —— 那会让所有题包都判「哈希不一致」，
比不做还糟。

**建议**：向平台索取 `task_fingerprint.py`，或它针对某个真实题包输出的
`hash_profile` + `task_content_sha256` 样例，用于反推算法（至少能确定：
是否对文件排序、路径前缀怎么写、空目录与隐藏文件是否计入、目录名是否参与哈希）。


---

## 4. 与上一轮演练报告的关系

上一轮跑 AutoRe0566 时我按 SOP 推断了两件事，**对照 0.3.8 后需要更正**：

| 上轮结论 | 0.3.8 口径 |
|---|---|
| `network_mode = "none"` 是「常见误写」，应改成 `no-network` | **该字段不应声明**（L258 明确不声明网络白名单）；正确动作是**删除** |
| 红线 4「哈希对齐」是空头承诺，建议补 `task_content_sha256` | ✅ 方向正确，且 0.3.8 已把它写成明确要求（QA21 + `task_binding` 两字段） |

其余结论（G3.6 编号标题、红线 1 的 `no_grad` 误报、suspect 噪音、工作台 best 方向、
校准面板字段名）与 0.3.8 无冲突，仍然成立。
