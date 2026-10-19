# 流程演练报告：AutoRe0566 全流程走查

> 目的：**验证平台流程的可行性**，不是完成这道题。
> 做法：用真实任务 `D:\Desktop\论文评测任务\AutoRe0566` 走完四阶段九门禁，
> 逐步核对产物是否符合预期；卡住的地方按用户授权用捏造数据先过，事后清理。
> 日期：2026-10-13

---

## 0. 结论摘要

**平台流程本身是通的**：四阶段全部推进到底，九道门禁全部拿到 RECOMMEND，
状态文件、工作台界面、门禁历史、产物核对四处一致。

但走这一遍暴露出 **5 个平台侧真实缺陷**（全部已修）和 **4 个环境/设计阻塞点**。
其中 3 个缺陷足以让**合法任务无法通过**——这才是"流程可行性"的真实答案：
流程的骨架是对的，卡在若干具体判据上。

| 类别 | 数量 | 已修 |
|---|---|---|
| 门禁误报（合法输入被判失败） | 3 | ✅ |
| 工作台摘要错误（显示错数据） | 2 | ✅ |
| 环境阻塞（Windows 沙箱） | 2 | 文档化，需使用者切换权限模式 |
| 设计缺口（UNKNOWN 无放行路径） | 1 | 待定 |
| 口径冲突（任务文件 vs 门禁 schema） | 2 | 待人工裁定 |

---

## 1. 流程走查结果（逐步）

| 阶段 | 门禁 | 结论 | 产物核对 |
|---|---|---|---|
| 1 领取 | G-SELECT | RECOMMEND（10/10 PASS） | ✅ 状态文件建立，identity 正确 |
| 2 命题 | G-FEASIBILITY | RECOMMEND | ✅ B/R/U 与归一化区间、σ 倍数判定正确 |
| 2 | G-CONTRACT | RECOMMEND（修正 payload 后） | ⚠️ 真实 task.toml 直接跑是 REJECT，见 §4 |
| 2 | G-DOCKERFILE | RECOMMEND（**真实文件、零捏造**） | ✅ 11 项判据全过 |
| 2 | G-NOP-RESULT | RECOMMEND | ✅ 十项证据齐备性判定正确 |
| 3 迭代 | G-TRAJECTORY | RECOMMEND | ✅ 两条轨迹 × 八字段 × 有效时长判定正确 |
| 4 发布 | G-REPLAY-CONTRACT | RECOMMEND | ✅ |
| 4 | G-SINGLE-SOURCE | RECOMMEND | ✅ |
| 4 | G-PACK-VERIFY | RECOMMEND | ✅ 哈希/缺件/残留三类判定正确 |

**推进机制**：`autoresearch_advance` 逐阶段校验"本阶段门禁是否全部 RECOMMEND"，
未过则拒绝推进。实测三次推进都正确（intake→authoring→iteration→release），
且每次回显该阶段的必需交付物与退出判据 —— 这部分设计是扎实的。

**产物核对**：`init` 建了 14 个骨架文件、`skippedExisting: 13` ——
**没有覆盖任何已有材料**（`writeIfAbsent` 生效）。原有 153 个小文件在演练前后
逐字节一致。

---

## 2. 门禁误报（已修，3 个）

### 2.1 G3.6 不认带编号的章节标题

**现象**：AutoRe0566 的 `instruction.md` 八个章节一个不少（`## 1. Goal`
… `## 8. Completion Criteria`），却被判「缺少全部八章节」，G-DOCKERFILE 直接 REJECT。

**根因**：匹配式是 `^##\s+Goal\s*$`，只认裸标题。而带编号是这类规范文档的常见写法
（本项目脚手架模板别处也用 `## 1. 题目身份`）。

**修法**：允许可选编号前缀（`1.` / `1、` / `1)`）。

**回归**：裸标题 / 数字加点 / 中文顿号三种写法都通过；真缺章节仍 FAIL。

### 2.2 红线 1 把 `torch.no_grad()` 下的评测循环判成泄露

**现象**：`workspace/reference/` 的两个参考实现被判 6 处「训练路径读评测集标签」，
G3.8 FAIL → G-DOCKERFILE REJECT。**而那 6 处是 `test_l2 = 0` 这样的指标累加器初始化。**

**根因**（两层）：
1. 触发信号来自窗口里的 `for x, y in test_loader:`（解包评测集），而窗口同时含
   训练上下文（`optimizer.step()`），于是窗口内每一行都被标成 leak；
2. `evalCtxRe`（评测语境白名单）里**没有** `no_grad` / `inference_mode` / `.eval()`，
   且只测本行不测窗口，于是教科书式的 `with torch.no_grad():` 评测块不被认作评测语境。

**修法**：评测语境加入 `no_grad` / `inference_mode` / `.eval()`，并改看窗口。

**消融**：两种真实泄露形态（`load_ground_truth()` 后 backward、训练里遍历
`val_loader`）仍各抓 5 处 —— 放宽没有放到失效。

### 2.3 红线 1 的 suspect 兜底分支把噪音变成硬阻塞

**现象**：`suspect` 档产生 20 条「待确认」，全是噪音：形状断言、训练 DataLoader
构造、计时、print、以及 `public_eval` 里的禁用名单。G3.9 UNKNOWN → 门禁给不出
RECOMMEND。

**根因**：分级链最后一级是 `else level = 'suspect'` **兜底**，于是任何
"窗口里有信号、本行完全无关"的行都被标成待确认。窗口是 ±4 行，而
`train_loader` 与 `test_loader` 的构造天然相邻，必然互相污染。

**修法**：suspect 必须由**本行**给出评测集名或评测数据读取；无本行信号的行
不产出 finding。

**为什么这条尤其值得记**：gate 里那段注释写着「其余降为 unknown **待人工确认**」，
读起来比 FAIL 软。但 `advanceState` 对 FAIL 与 UNKNOWN **一视同仁**，都拦。
噪音于是变成与硬失败等价的阻塞，而且平台上**没有任何"确认后放行"的入口**。

---

## 3. 工作台摘要错误（已修，2 个）

### 3.1 minimize 指标下把最差一轮报成最佳

`trajectoryDigest` 硬写 `best: Math.max(...scores)`。AutoRe0566 的主指标 StatErr
是 **minimize**，三轮 8.9 → 8.4 → 7.9（越来越好），工作台显示 `best = 8.9`
——**首轮、最差的那个**。

修法：读标注文件里的方向，minimize 取 min。方向解析取**第一个**方向词
（真实标注常写成「minimize（原始指标）；[task].metric=score 归一化后 maximize」，
原始指标方向才是轨迹分数的口径）。

### 3.2 校准面板对专家手写标注整块显示为空

`calibrationDigest` 只认嵌套式字段（`score_contract.*` + `statistics.*`），
而真实专家标注用的是**扁平式**：

| 数据 | 真实字段 | UI 原本找的 |
|---|---|---|
| 指标名 | `metric_name` | `score_contract.metric` |
| 方向 | `metric_direction` | `score_contract.direction` |
| U | `comparison_summary.U` | `upper_bound.raw_value` |
| B/R | `comparison_summary.B_mean/R_mean` | `statistics.baseline_mean/...` |
| 锚点 | `anchors.{B_mean,U,calibration_status}` | — |

**零重叠**，于是数据都在、面板全空。修法：两种写法都认，并如实暴露
`calibrationStatus`（`NOT_RUN` 不伪装成有数据）。

---

## 4. 需要人工裁定的口径冲突（2 个）

这两条**不是缺陷，是两套 schema 打架**，我无权替上游定夺。

### 4.1 task.toml 的 schema 与门禁期望不一致

AutoRe0566 的 `task.toml` 头部注释写明「Harbor schema，字段口径对齐
work_auto0340 已核样例」，它用的是：

| 字段 | 真实 task.toml | 门禁/权威期望 |
|---|---|---|
| 题目名 | `[task].title` | `[task].name` |
| schema 版本 | `[task].schema_version` | 顶层 `schema_version` |
| 构建超时 | `[task].time_limit_seconds` + `[resources]` | `[environment].build_timeout_sec` |

直接 `fromTask` 跑 G-CONTRACT → REJECT（G2.1 FAIL、G2.4/G2.6 UNKNOWN）。

**要裁定的是**：到底哪套是目标 Harbor 版本的原生 schema。
若是前者，门禁的权威脚本 `harbor_task_contract.py` 需要更新。

### 4.2 `network_mode = "none"` —— 已按教程 v0.3.8 更正

真实 task.toml 在 `[agent]` 与 `[verifier]` 两处都写 `network_mode = "none"`，
门禁判 FAIL —— 依据是 SOP `field-lessons.md`「`none` 是常见误写，合法值为
`no-network` / `public` / `allowlist`」。

> ⚠️ **本报告当时按 SOP 推断「应改成 `no-network`」，对照 v0.3.8 后这个结论是错的。**
>
> v0.3.8 的 task.toml 模板里**根本没有 `network_mode` 字段**，且 L258 明确写着：
> 「当前内场**不声明** storage_mb 磁盘配额、no-network 或网络白名单」。
>
> 所以正确动作不是「改名」，而是**删除该字段**。详见
> [tutorial-0.3.8-conformance.md](tutorial-0.3.8-conformance.md) §2.2。

---

## 5. 环境与设计阻塞点

### 5.1 Windows 沙箱 ACL（每条命令都失败）

会话默认权限「工作区内修改」下，**每条命令**都在沙箱 ACL 阶段失败：

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\Desktop\智动化论文)
```

用户目录缺少 `WRITE_DAC`，沙箱无法授权。切到「完全权限」后一切正常。
启动器本应设 `DSH_PERMISSION_MODE=danger-full-access`，但会话级设置覆盖了它。

### 5.2 agent 试图改磁盘 ACL 来"修"沙箱（已拒绝）

平台内的 agent 自己诊断出 ACL 问题（加载了 `diagnose-windows-sandbox-acl` 技能），
然后请求批准一个脚本去给 `D:\Desktop\智动化论文` 补权限 —— 会修改用户磁盘的
ACL 并删除外来的应用包权限项。

**这是过度反应**：根因是会话权限模式，不是目录权限。我拒绝了该请求，
改为切换权限模式。harness 在被拒后正确地要求它「停止绕路并解释」，
这部分行为是对的。

### 5.3 上游 API 慢且不稳

- 单个 1-token 请求实测 **16.2 秒**
- 演练末尾连续 5 次请求 **全部 502/503**（`Upstream service temporarily unavailable`）

表现：一轮"深度求索中"8 分钟无任何输出、无工具调用；失败时平台报
`PI_AI_ERROR` + "本轮运行失败"。

**这是流程最大的现实瓶颈**：一轮有效工作要十几分钟，且随时可能整轮作废。

### 5.4 门禁的 UNKNOWN 没有放行路径

`advanceState` 要求本阶段门禁**全部 RECOMMEND**。而门禁把"证据不足/需人工确认"
表达为 UNKNOWN（如 G3.9、G1.4），UNKNOWN 与 FAIL 一样拦。

于是：**任何需要人工判断的判据，都会永久阻塞推进**，因为工具面里没有
"我已复核，确认放行"的入口。建议给 `autoresearch_gate` 增加一个显式的
`acknowledged` 字段（记录复核人与理由），或让 `advance` 接受
"UNKNOWN 且已复核"的组合。

---

## 6. 关于本次演练的方法说明（重要）

**上游 API 挂掉之后，我改用平台自己的工具层继续跑**，脚本是
`scripts/devtools/ars-drive-tools.mjs`：它把插件的 `apply(ctx, config)` 跑在
最小 ctx 桩上，捕获 `defineTool` 注册的定义，再逐个 `execute(args, exec)`。

走的路径与 agent 调用**完全相同**：同样的参数校验、同样的 `resolveRootFor`、
同样的 `mutate` 原子写回、同样的门禁函数。区别只有一个：**调用者是人而不是模型**。

因此本次演练验证的是：

- ✅ 平台能不能跑通（阶段推进、门禁判定、状态写入、产物核对、工作台呈现）
- ❌ **没有**验证模型会不会照着步骤指令做（这一步被上游故障挡住了）

已确认平台侧的步骤注入是正常工作的 —— 会话日志里能看到每步都有
`<autoresearch_step phase="intake">` 指令，明确告诉模型该推进、该补哪三个交付物。
只是模型那一侧的请求失败了。

---

## 7. 清理

演练中按授权使用了捏造数据，全部已还原：

| 项目 | 处置 |
|---|---|
| `expert_evidence/trajectory_codex.json` | 还原为 `{"rounds": []}` |
| `expert_evidence/trajectory_seed.json` | 还原为 `{"rounds": []}` |
| `expert_evidence/run_summary.json` | 删除追加的 `agent_execution`，**真实九阶段内容原样保留** |
| `autoresearch-state.json` | **删除**（其 9 条 RECOMMEND 全部基于捏造数据，留着会误导） |

**完整性核验**：原有 153 个小文件与演练前**逐字节一致（0 差异）**。

仍留在任务目录的 14 个文件是 `autoresearch_init` 生成的**脚手架骨架**
（README 模板、空轨迹、模板 grader.py、requirements.txt），不含任何捏造数字。
它们与 `init` 在任何任务上会生成的东西一致；如需彻底还原可一并删除。

备份位置：`_ars_run_backup/AutoRe0566/`（全量清单 + 153 个小文件副本）。
