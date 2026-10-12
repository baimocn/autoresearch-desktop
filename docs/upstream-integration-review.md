# 与上游/SOP 的对接审查

> **状态更新（本轮已实施修复）**：本报告的 §3.2（版本分叉导致发布门失效）与
> §五（无同步机制）已修复并通过消融验证。修复方案与验证证据见
> [first-principles-dynamic.md](first-principles-dynamic.md) §七。
>
> **重要修正**：本报告 §六 原建议「三份副本收敛为一份、统一到 0.3.4」是**错的**，
> 已在本轮第一性原理分析中撤回 —— 两个来源是**不同职责**（权威判据口径 vs
> 发布门证据），收敛会删掉权威口径。正确修法是「让引用跟随职责」。
> 详见 [first-principles-dynamic.md](first-principles-dynamic.md) §一。

> 问题：AutoResearch 实现是否与 SOP、上游质检 skills 正确对接？
> 上游调整时，是否有机制让「某个模型」做出对应修改？
>
> 结论：**对接是"复制粘贴式"的，不是"引用式"的；上游调整后没有任何机制触发修改。**
> 且当前已发生一次真实漂移，导致发布门的质检命令**必然失败**。

---

## 一、结论速览

| 问题 | 答案 | 证据 |
|---|---|---|
| 与 SOP 对接了吗？ | 对接了，但以**整包复制**方式 | `assets/sop/` 内 24 个文件原样分发 |
| 与上游质检 skills 对接了吗？ | 对接了，但存在**三份副本** | `qa-0.3.4` / `skills-0.3.2` / `skills-upstream-0.3.4` |
| 上游调整时能自动跟进吗？ | **不能。无同步机制、无版本探测、无漂移告警** | `scripts/` 下无任何 sync/update/drift 逻辑 |
| 当前是否已经漂移？ | **是，且已导致功能失效** | 见 §三 |
| 有"模型"负责做出修改吗？ | **没有。** 无 CI、无定时任务、无版本比对脚本 | 见 §五 |

---

## 二、对接方式：复制而非引用

上游产物以**逐文件复制**进入本仓，且无版本清单、无来源哈希记录：

```
packages/dsh-autoresearch-gates/assets/sop/        24 个文件（SOP 工具与探针）
packages/dsh-autoresearch-gates/assets/qa-0.3.4/   10 个文件（上游 QA 脚本）
packages/dsh-autoresearch-skills/assets/skills-0.3.2/
packages/dsh-autoresearch-skills/assets/skills-upstream-0.3.4/
```

`docs/upstream-defects.md` 的原则是"**不修改上游文件**，随包脚本与上游逐字节相同"。
实测确认该原则在 SOP 侧被遵守（两份 `feasibility_gate.py` SHA-256 完全相同：
`78FAFE63…D8D1FC`）。**问题不在"是否忠实复制"，而在"复制了三份、且没有谁负责让它们一致"**。

---

## 三、已发生的真实漂移（HIGH）

### 3.1 三份副本，两份是真上游，一份是旧的 —— 而被引用的是旧的那份

以 `implementation_review.py` 为例，用与加密无关的 fnv1a 摘要比对
（本机 hex 摘要被环境重定向为全零，故不采信 `Get-FileHash`）：

| 文件 | qa-0.3.4 | skills-0.3.2 | skills-upstream-0.3.4 |
|---|---|---|---|
| `audit_task.py` | c946002a | **4058e680** | c946002a |
| `implementation_review.py` | c5ad10a7 | **69adab60** | c5ad10a7 |
| `content_gates.py` | d2d018b5 | **22a69a68** | d2d018b5 |
| `docker_paths.py` | 2488eb15 | **6346d542** | 2488eb15 |

`qa-0.3.4` 与 `skills-upstream-0.3.4` **逐字节相同**（真上游 0.3.4）；
`skills-0.3.2` 是**旧的教程附件版**，与两者都不同。

**而两处运行时引用指向了旧的那份：**

```js
// packages/dsh-autoresearch-gates/lib/tools.js:145
script: 'skills-0.3.2/autoresearch-task-qa/scripts/audit_task.py',
// packages/dsh-autoresearch-gates/lib/tools.js:155
script: 'skills-0.3.2/autoresearch-task-qa/scripts/implementation_review.py',
```

同一仓库内 `dsh-autoresearch-qa` 却**优先用 0.3.4**、并带 fallback：

```js
// packages/dsh-autoresearch-qa/index.js:83-104
const qaScripts = join(projectRoot, 'packages', 'dsh-autoresearch-gates', 'assets', 'qa-0.3.4')
// 候选：qa-0.3.4 优先，其次 skills-upstream-0.3.4
```

**同一个上游事实，两个包做出了不同的版本选择。** 这正是 SOP 规则 19
「同一事实单一真源」要防的情况。

### 3.2 漂移已导致发布门质检命令必然失败

`dsh-autoresearch-qa/lib/runner.js:123-128` 指示质检 lane 执行：

```
--release-self-check \
--reviewer-provider "<provider>" \
--session-id "<sessionId>" \
--clean-context
```

**但被引用的 0.3.2 版不支持这些参数。** 实测两者对同一组参数的反应：

```
=== LIVE 0.3.2 copy given the release-gate flags ===
usage: implementation_review.py [-h] [--out-dir OUT_DIR]
                                [--policy {implementation,precheck}]
                                [--review REVIEW]
                                [--fail-on {never,fail,warn,manual}]
implementation_review.py: error: unrecognized arguments:
  --release-self-check --reviewer-provider --session-id S1 --clean-context
exit=2

=== UPSTREAM 0.3.4 copy given the same flags ===
usage: implementation_review.py [-h] [--out-dir OUT_DIR]
                                [--policy {implementation,precheck}]
                                [--review REVIEW]
                                [--fail-on {never,fail,warn,manual,incomplete}]
                                [--release-self-check]
                                [--reviewer-provider REVIEWER_PROVIDER]
                                ...
exit=2（仅因缺 positional source，参数本身全部被接受）
```

0.3.2 缺失的正是**来源绑定与独立性自证**所依赖的全部开关：
`--release-self-check`、`--reviewer-provider/-model/-version`、`--session-id`、`--clean-context`。
`--fail-on` 也少了 `incomplete` 这一档。

**影响**：`qa_consensus.py` 校验 `qa_run.clean_context == true`、
`reviewer.provider/model/version` 非空、`source.kind == "zip"`（`qa_consensus.py:62-72`）。
用不支持的脚本产出的报告无法带上这些字段 → 聚合必然 `NOT_READY`。
**发布门在这条路径上是断的，而 `npm run check` 全绿（103/34/22 全过）——测试没有覆盖到它。**

---

## 四、对接链条的实际形态

```
上游 autoresearch-sop / autoresearch-skills
        │  （人工复制，无版本记录、无哈希清单）
        ▼
packages/…-gates/assets/sop/            ← 24 文件，逐字节忠实
packages/…-gates/assets/qa-0.3.4/       ← 真上游 0.3.4
packages/…-skills/assets/skills-0.3.2/  ← 旧教程附件（被 tools.js 引用）
packages/…-skills/assets/skills-upstream-0.3.4/ ← 真上游 0.3.4（被 qa 引用）
        │
        ▼
gates/lib/tools.js  → 硬编码 skills-0.3.2，无 fallback
qa/index.js         → qa-0.3.4 优先 + fallback
```

**上游调整后，链路是断的**：既没有拉取入口，也没有比对手段，
更没有"发现不一致就报警"的检查。两份副本已经分叉，且分叉方向与引用关系相反 ——
**更旧的版本被更常用的包引用**。

---

## 五、"有模型能做出对应修改吗" —— 没有

实测检索 `scripts/` 全部 14 个脚本，与上游同步相关的逻辑**零命中**
（唯一匹配是 `ablation-gates.mjs` 里提到 D1 的注释）：

| 机制 | 存在？ |
|---|---|
| 上游版本探测（比对远端 tag/VERSION） | **无** |
| 资产哈希清单 + 校验 | **无**（`packages/` 内无任何 sha256 清单文件） |
| 漂移检测 / 一致性门禁 | **无** |
| 定时或 CI 触发 | **无**（无 `.github/`、无 CI 配置） |
| 人工更新手册 | **无**（`docs/` 下无 upgrade/sync 文档） |

现有唯一"接近"的东西是 `scripts/ablation-gates.mjs`（门禁一致性消融实验），
但它比对的是**JS 实现 vs Python 实现**的判定分歧，
**不比对两个 Python 副本之间的版本差异** —— 所以它发现不了 §三 的问题。

**因此答案是否定的**：上游调整后，没有任何自动化、也没有任何被指派的模型/流程
会去做对应修改。当前三份副本的分叉是被**无意中留下的**，且已静默地破坏了发布门。

---

## 六、建议

### 立即（恢复功能）

1. **统一引用到真上游 0.3.4**：把 `gates/lib/tools.js:145,155` 改为
   `qa-0.3.4/…`（或改为像 `qa/index.js` 那样的"优先 0.3.4 + fallback"解析），
   与 `dsh-autoresearch-qa` 的口径对齐。
2. **加一条回归测试**：断言 `runner.js` 拼出的每个参数都能被
   `implementation_review.py --help` 接受。这类"命令与脚本能力不匹配"必须被测试捕获 ——
   现有 226 项测试没覆盖它。

### 短期（让漂移可见）

3. **资产来源清单** `assets/UPSTREAM.json`：记录每个来源的
   `{id, upstream, version, files: {path: sha256}}`，与上游逐字节比对。
4. **漂移门禁**：新增一个只读脚本，比对三份副本，不一致即报 `NEEDS_EVIDENCE`，
   并把结果接进 `npm run check`。
5. **单一真源**：三份副本收敛为一份（真上游 0.3.4），
   旧教程附件版若确需保留（`catalog.js` 声明"教程正文以它为准"），
   必须以**显式对照**形式保留并标注其能力子集，而不是让它继续充当运行时依赖。

### 中期（回答"模型能否跟进"）

6. 上游同步是一条**可编排任务**，而不是期待有人记得：定期拉取上游 → 逐字节比对 →
   生成差异报告 → 由模型按报告改引用/适配 → 跑回归 → 出 PR。
   当前项目已具备 `autoresearch_remote_*` 与 workflow 能力，
   缺的是**触发入口**与**比对基线**（即第 3 条）。

---

## 七、审查局限

1. **无版本控制**（`git log` → not a repository），无法确认三份副本的分叉发生在何时、
   由哪次改动引入；只能证明"当前状态不一致且引用指向旧版"。
2. 我**未**比对 `assets/sop/` 全部 24 个文件与上游远端（无上游访问凭据、无网络基线），
   仅验证了 `feasibility_gate.py` 两份内部一致。
3. 我**未**运行完整双路质检（需真实模型与凭据），
   故 §3.2 的结论是"参数必被拒绝 + 聚合必缺字段"的**静态推导 + 实测参数解析**，
   而非端到端跑通后的观测。
4. 运行 `python …--help` 会生成 `__pycache__`（Python 副作用）。
   我在 `skills-0.3.2/.../scripts/` 下产生的 `__pycache__` **已删除**；
   `qa-0.3.4/__pycache__` 是仓内既有内容，未改动。
