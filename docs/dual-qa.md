# 双路独立质检

教程 V3 与 QA 技能对 M5 发布门的要求是：**两份独立质检报告**——同源提交包、不同 AI、不同会话、逐项判定无分歧，再由 fail-closed 聚合判定。手工做法是开两个新对话、各发一份提示词、各自跑脚本、最后手工比对。

本项目把这条链路做成三个工具，一次调用完成。

## 为什么必须两路

`qa_consensus.py` 的校验是 fail-closed 的，它逐条检查：

| 检查 | 要求 |
|---|---|
| 来源绑定 | 两份报告都绑定同一个 ZIP 的 SHA-256，且 `source.kind == "zip"` |
| 溯源一致 | `qa_run.artifact_sha256` 与 `source.sha256` 相同、`input_kind == "zip"` |
| 技能版本 | 两份都是 `autoresearch-qa-skills/0.3.4` |
| 干净上下文 | 两份的 `qa_run.clean_context` 都是 `true` |
| 身份不同 | `provider` / `model` / `version` 三元组两两不同 |
| 会话不同 | `session_id` 两个非空且不同 |
| 逐项一致 | QA01–QA21、G01–G03、H01–H06 的判定结果完全一致 |
| 结论通过 | 两份 `summary.decision` 都是 `PASS` |

任一不满足即 `NOT_READY`，退出码 1。

## 隔离怎么保证

不是靠约定，是靠结构：

| 维度 | 隔离方式 |
|---|---|
| 进程 | 每路一个独立 `dsh --profile headless` 进程；headless 无 Host、无 HTTP、无浏览器 |
| 数据 | 每路一个独立 `DSH_HOME`（`<workRoot>/lane-N/dsh-home`），会话与凭据不互污染 |
| 输出 | 每路一个独立输出目录；提示词明确「不要访问其他路的输出目录」 |
| 模型 | 每路一个独立 patch 文件，固定 `agent-default-model` 的 provider/model |
| 凭据 | 每路独立环境变量注入，不写进 profile、不落盘 |
| 身份 | `provider`/`model`/`version`/`session_id` 由编排层生成，模型无法伪造 |
| 上下文 | 提示词声明「本次会话是新会话，只收到这份提交包与以下指令」；报告里以 `--clean-context` 背书 |

## 用法

### 1. 配置两路

编辑 `packages/dsh-autoresearch-qa/cordis.patch.yml`：

```yaml
- insert:
    - id: autoresearch-qa
      name: dsh-autoresearch-qa
      config:
        taskRoot: '.'
        workDir: expert_evidence/dual-qa
        profile: headless
        skillName: autoresearch-task-qa
        lanes:
          - provider: anthropic
            model: claude-fable-5
            credentialEnv: ANTHROPIC_API_KEY
          - provider: openai
            model: gpt-5
            credentialEnv: OPENAI_API_KEY
```

两路的 `provider`/`model` 必须不同，否则工具会在启动前直接拒绝（而不是白跑两小时）。

也可以不写进配置，调用时传：

```
autoresearch_qa_dual {
  artifact: "expert_evidence/dual-qa/submission.zip",
  lanes: [
    { provider: "anthropic", model: "claude-fable-5", credentialEnv: "ANTHROPIC_API_KEY" },
    { provider: "openai", model: "gpt-5", credentialEnv: "OPENAI_API_KEY" }
  ]
}
```

### 2. 导出密钥

```bash
export ANTHROPIC_API_KEY=...
export OPENAI_API_KEY=...
```

密钥只经由环境变量进入子进程。`apiKey` 也可以直接写在 `lanes` 里，但那样会出现在会话记录中——不推荐。

### 3. 打包提交物

发布门只接受单个 `.zip`：

```
autoresearch_qa_pack { source: "workspace" }
```

输出确定性 ZIP（相同输入逐字节相同），自动排除 `__pycache__`、`.git`、`node_modules`、`*.pyc`、`*.log` 等禁止项。已存在的 ZIP 不会被覆盖——结论按 SHA-256 锚定。

### 4. 跑双路质检

```
autoresearch_qa_dual { artifact: "expert_evidence/dual-qa/submission.zip" }
```

两路**并行**执行，各自加载质检技能、按技能流程审查、用 `--release-self-check` 产出带来源绑定的报告，然后自动调用 `qa_consensus.py` 聚合。

### 5. 看结果

界面「双路质检」页签显示两路的 provider/model、会话 ID、结论、`clean_context`、耗时，以及聚合结论与未满足项。

或复核既有结果：

```
autoresearch_qa_verify { consensus: "expert_evidence/dual-qa/qa-consensus.json" }
```

## 留痕

每次运行写 `expert_evidence/dual-qa/run-manifest.json`，含：

- 提交包路径与 SHA-256
- 每路的身份、凭据环境变量名、报告路径与报告 SHA-256、退出码、耗时、起止时间
- 聚合结果路径与结论、未解决分歧、校验错误
- 两路是否共用同一凭据环境变量（如实标注，不假装完全独立）

重跑时旧清单自动归档为 `run-manifest.<时间戳>.json`，不覆盖。

每路的原始输出也保留：`lane-N/prompt.txt`、`lane-N/model.patch.yml`、`lane-N/run.stdout.log`、`lane-N/run.stderr.log`、`lane-N/qa-report/`。

## 常见失败与含义

| 现象 | 含义 | 处理 |
|---|---|---|
| 工具直接拒绝启动 | 两路身份相同或缺字段 | 按提示改配置 |
| 某路未出报告 | 该路模型/凭据/网络有问题 | 看 `lane-N/run.stderr.log`；这是**该路失败**，不是题目失败 |
| 聚合 `NOT_READY` 且有「reviewers must use two different...」 | 两路身份撞了 | 换 provider 或 model |
| 聚合 `NOT_READY` 且有「lacks clean-context attestation」 | 该路报告缺 `--clean-context` | 检查提示词是否被改动 |
| 聚合 `NOT_READY` 且有未解决分歧 | 两路对某项判定不一致 | 这本身是有价值的信号：按分歧项复查题目，必要时返修后重跑 |
| 聚合 `NOT_READY` 且 decision 非 PASS | 质检发现实质问题 | 按报告里的退回说明修完，**重打 ZIP 后重跑两路** |

最后一条对应 SOP 规则 24：被质检锚定的交付物不得再改。改了一个字节，旧结论即失效，必须重跑。

## 与平台既有记录的关系

如果平台已提供同版本任务的完整质检记录，可以直接引用，无需重复执行。此时用 `autoresearch_qa_verify` 做只读复核，确认结论为 `PASS`、无未解决分歧、两路身份与报告同源即可。

## 配置两路（自定义模型，可视可写）

两路各引用一个**已声明的路由**与模型名，配置持久化在
`DSH_HOME/autoresearch-qa-lanes.json`：

```json
{ "lanes": [
  { "route": "llapi-a", "model": "deepseek-v4.1-flash" },
  { "route": "claude",  "model": "claude-sonnet-4" }
] }
```

配置入口两处等价：

- **工作台 →「双路质检」页**：两个下拉框（路由 / 模型），保存前就地校验
- 对话里 `autoresearch_qa_lanes` 工具（查看或保存）

路由本身在**工作台 →「API 配置」页**维护（添加端点、填密钥、探测可达性、
删除），或 `autoresearch_api_add`。密钥只存凭据文档 `$DSH_HOME/.credentials.yaml`
（0600），lanes 配置里只有引用名；跑质检时密钥以环境变量注入 lane 进程。

`autoresearch_qa_dual` 执行时的两路来源优先级：**显式 lanes 参数 > 保存的配置**。
保存的引用形态会被补全为可执行事实（api / baseURL / 凭据）；任一缺失（路由未声明、
密钥无值、两路身份相同）都以问题清单 BLOCKED，不猜测、不空跑。

> 同一端点的两个不同路由名（如 llapi-a / llapi-b）构成两个独立身份 —— 部分网关
> 只有一个模型可用时，这是满足「身份两两不同」的合法方式；有第二个真端点时
> 换成不同模型即可。

## lane 的 provider 声明必须写全（实测教训）

lane 用全新的 DSH_HOME（headless 是内置 profile，没有用户配置层），每路的
model patch 必须自带 `api` / `baseURL` / `apiKeyEnv` / `models`。只写
`apiKeyEnv` 的版本对自定义端点以 `NO_ADAPTER` 失败 —— 第一版就是这写的，
双路对你等于摆设。patch 的 config 是整体替换不是合并：这份 patch 就是该
lane 的全部 provider 事实。

## 无人值守的沙箱模式

lane 环境固定 `DSH_PERMISSION_MODE=danger-full-access`。原因：lane 是隔离的
一次性环境，而 Windows 上 `workspace-write` 的 ACL 授予会在部分目录以
`SetNamedSecurityInfoW failed (Win32 5)` 失败，且修复路径本身需要审批 ——
无人值守没有审批通道，形成死锁，两路都产不出报告。质检纪律由提示词与技能
约束（只读审查），不依赖文件沙箱。

## 端到端实测（llapi.org，2026-10-11）

```
两路来源：工作台配置
  第 1 路：llapi-a / deepseek-v4.1-flash @ https://llapi.org/v1（密钥 AUTORESEARCH_QA_KEY_A）
  第 2 路：llapi-b / deepseek-v4.1-flash @ https://llapi.org/v1（密钥 AUTORESEARCH_QA_KEY_B）
verdict: NOT_READY
lane 1: llapi-a exit=0 报告=有 240s
lane 2: llapi-b exit=0 报告=有 183s
consensus: NOT_READY
disagreements: [{'check': 'gate:G03', 'report_1': 'manual', 'report_2': 'fail'}, ...]
```

两路各自连上自定义端点、加载技能、完成完整审查、产出 SHA 锚定报告（送检包
`abec81ae…`），聚合按 fail-closed 记录逐项分歧。样例包是骨架任务，两路一致
判 FAIL 是正确结论；分歧项（G03/QA04/QA07/QA08/QA19）正是该机制的用途 ——
人工只需复核这几项，而不是重读两份 3 万字报告。
