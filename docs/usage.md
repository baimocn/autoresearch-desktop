# 使用指南

## 1. 开始一道题

打开工作台，在会话里让模型：

```
使用 autoresearch_init 初始化一道 S2 题目，标题「XXX 加速」，
taskId 用平台下发的编号，taskName 用 group/xxx
```

这会在当前工作目录生成三类顶层目录的完整骨架：

```
workspace/harbor_task/{instruction.md, task.toml, environment/, tests/}
workspace/reference/
expert_evidence/{专家作业说明文档.md, expert_annotation.json, run_summary.json,
                 trajectory_codex.json, trajectory_seed.json, best_method/, nop_selfcheck/}
optimization_evidence/{训练证据说明.md, baseline_runs/, reference_runs/, comparison_summary.json}
```

骨架里所有待填项都写成 `TODO` 或 `null`，**没有任何看起来像真实结果的数字**。轨迹 `rounds` 是空数组，`comparison_summary.status` 是 `NOT_RUN`。

## 2. 第 1 章：领取与边界确认

用 `autoresearch_intake` 逐条登记领取后检查五项。任一为 `unknown` 时结论为 `INCOMPLETE`：

```
autoresearch_intake {
  checks: {
    "input-downloadable": "pass",
    "metric-direction": "pass",
    "resource-bounds": "pass",
    "visibility-bounds": "unknown",
    "three-deliverables": "pass"
  }
}
```

如果做变体，同时登记变体信息。变体未改变有效维度（模型架构/优化目标/起始代码/限定搜索方向）、未引出本质不同的 Reference、或未独立重跑 B/R 与资源检查时，会明确列出问题。

五项清零后跑选题筛查：

```
autoresearch_gate { gate: "G-SELECT", payload: { title: "...", repo: "owner/name", license: "MIT",
  optimizationSurface: { methodLevel: true, summary: "..." }, duplicateChecked: true,
  communityBaseline: 60, reportedBaseline: 58, deltaPercent: 34, metricType: "physical",
  benchmarkCount: 3, ablationCount: 2 } }
```

也可以直接用 `autoresearch_gate_run` 调 SOP 的 `paper-screen` 工具（需要网络，会查 GitHub API）。

## 3. 第 2 章：题包构建

填写 `instruction.md` 的八章节与 `task.toml`。写完后跑三道静态门禁：

```
autoresearch_gate { gate: "G-CONTRACT", fromTask: true }      # task.toml 四项必查
autoresearch_gate { gate: "G-DOCKERFILE", fromTask: true }    # 路径契约 + 八章节 + 泄露检查
```

再用 `autoresearch_gate_run` 调随包的 Python 工具做更深的检查：

```
autoresearch_gate_run { tool: "harbor-task-contract", args: { task: "workspace/harbor_task" } }
autoresearch_gate_run { tool: "dockerfile-preflight",
  args: { dockerfiles: ["workspace/harbor_task/environment/Dockerfile",
                        "workspace/harbor_task/tests/Dockerfile"] } }
```

拿到 1 seed 的 B/R 探针数字后，先做纸面预解再投算力：

```
autoresearch_gate { gate: "G-FEASIBILITY", payload: {
  baselineValues: [0.1340], referenceValues: [0.1300], upper: 0.0310,
  direction: "minimize", referenceRecomputed: true } }
```

**R_norm 落在 [0.15, 0.8] 之外，或 Δ 不足 3σ_B 时不要投入全 seed 协议。** 这是 SOP 规则 11「探针优先」与规则 12「判定先算后跑」的机器化。

跑完 NOP Trial 后核对四件套：

```
autoresearch_gate { gate: "G-NOP-RESULT", payload: {
  config: {...}, result: {...}, reward: 0, logPresent: true, sameTrial: true } }
```

## 4. 第 3 章：迭代

每完成一轮记一次：

```
autoresearch_trajectory {
  track: "codex",
  policyName: "cosine-annealing-lr",
  methodSummary: "将固定学习率改为余弦退火；验证结果优于上一轮，因此保留该方向。",
  status: "ok",
  score: 0.23,
  retainedBest: true
}
```

工具会自动补 `round` 与 `time`，并校验八字段。失败轮次照记：`status` 填真实失败类型，省略 `score`（记为 `null`），并在 `methodSummary` 里写原因与下一步判断。

两条轨迹分别记：`track: "codex"` → `trajectory_codex.json`，`track: "seed"` → `trajectory_seed.json`。

全部记完后跑轨迹门禁：

```
autoresearch_gate { gate: "G-TRAJECTORY", fromTask: true }
```

## 5. 第 4 章：交付与质检

```
autoresearch_gate { gate: "G-SINGLE-SOURCE", fromTask: true }   # 锚点单一真源
autoresearch_gate { gate: "G-REPLAY-CONTRACT", payload: {...} } # 可复算契约
autoresearch_gate { gate: "G-PACK-VERIFY", payload: {...} }     # 打包哈希一致
autoresearch_audit {}                                            # 三类目录完整性 + 废弃结构残留
```

再做独立质检（只读）：

```
autoresearch_gate_run { tool: "qa-audit", args: { source: "workspace", outDir: "../qa-report" } }
```

注意：`qa-audit` 的初次 `inventory.json` 与 `report.*` 是**未完成初稿**，不能把关键词命中当语义结论。语义结论需要按技能正文的流程人工/模型填写 `review.json` 后再跑一次。

## 5.5 双路独立质检（M5 发布门）

发布门要求两份独立质检报告。一条命令完成：

```
autoresearch_qa_pack { source: "workspace" }
autoresearch_qa_dual { artifact: "expert_evidence/dual-qa/submission.zip" }
```

先确认两路配置：

```
autoresearch_qa_lanes {}
```

两路的 `provider`/`model` 必须不同。密钥通过环境变量注入（`credentialEnv` 只声明变量名）：

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

跑完后界面「双路质检」页签显示两路身份、结论、`clean_context` 与聚合判定。完整说明见 [双路质检说明](dual-qa.md)。

## 5.8 自定义 API（可选）

默认用哪个模型由你定。声明一个自定义端点：

```
autoresearch_api_options {}          # 看支持的协议与常见端点预设
autoresearch_api_add {
  route: "deepseek", models: ["deepseek-chat"],
  apiKey: "sk-...", setDefault: true
}
autoresearch_api_verify {}           # 真加载校验
```

密钥只进凭据文档（0600），profile 只存引用名。界面「API 配置」页签可查看所有路由，不显示密钥本体。

给双路质检配两路（身份必须不同）：

```
autoresearch_api_dual_lanes {
  laneA: { route: "gateway-a", api: "openai-completions", baseURL: "https://a.example.com/v1", models: ["model-x"], keyEnv: "A_KEY", apiKey: "sk-a" },
  laneB: { route: "gateway-b", api: "anthropic-messages", baseURL: "https://b.example.com", models: ["model-y"], keyEnv: "B_KEY", apiKey: "sk-b" }
}
```

详见 [自定义 API 接入](custom-api.md)。

## 6. 阶段推进

```
autoresearch_advance { to: "authoring" }
```

被拒绝时错误信息会列出未通过的门禁与结论。**不允许跳级与回退**：返修应当新建 run 并保留旧 receipt。

## 7. 界面

工作台面板有四个页签：

| 页签 | 内容 |
|---|---|
| 四阶段 | 每阶段的交付物就位数、门禁结论、缺失必需件、退出判据 |
| 门禁 | 九道门的目录与最近一次结论，点击查看逐条判据与修复动作 |
| 证据浏览 | 四个白名单根目录下的文件树；点开文本文件直接看内容 |
| 轨迹 | 两条轨迹的逐轮记录与统计（轮次/出分/失败/最佳标记/最新分） |
| 双路质检 | 两路 provider/model、会话、结论、clean_context、耗时与聚合判定 |
| 远端执行 | 远端目标、任务状态、机外快照 |
| API 配置 | 自定义路由的协议、地址、模型与密钥有无值（不回显密钥） |

## 8. 常见问题

**问：界面显示「未运行」是什么意思？**
该门禁还没跑过。门禁结论按被检对象的当前状态记录；交付物一改，旧结论即失效，应重跑。

**问：为什么 Docker 相关工具说不可用？**
本机没装 Docker。双镜像构建与 NOP Trial 必须在有 Docker 的环境执行，本机只能做静态判定。这不是失败，是能力不足 —— 报告里应如实写「未运行」。

**问：改了插件源码但界面没变？**
pnpm 对 `file:` 依赖会缓存副本。重跑 `npm run profile:install`（脚本会先删除旧副本再重新链接），然后重启 harness。

**问：技能有同名两份，用哪个？**
教程 V3 附件版本优先（`autoresearch-task-qa`、`autoresearch-baseline-quality`）。两份都保留，`autoresearch_skills` 会列出被遮蔽的来源，便于比对版本差异。

**问：双路质检一路失败怎么办？**
该路失败不等于题目失败。先看 `expert_evidence/dual-qa/lane-N/run.stderr.log` 判断是模型/凭据/网络问题还是质检本身发现问题。前者修环境后重跑，后者按报告退回说明修题目。

**问：能改门禁阈值吗？**
不能。`R_LO`、`R_HI`、`SIGMA_MULT_REQUIRED`、`MIN_EFFECTIVE_HOURS` 等常量直接来自教程正文，改动它们等于改判据。需要调整时应当改的是题目设计（指标、规模、U 的估计依据），不是门槛。
