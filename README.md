# AutoResearch Desktop

把《AutoResearch 专家线下标注教程V3》的四阶段出题流程做成能跑的代码。底座是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

教程里写了四个阶段、九道门禁、三类交付目录。这些判据原本靠人记、靠翻文档对照。这个项目把它们变成了会给出结论的东西，跑一遍就知道哪道门没过，为什么没过。

## 起因是一个真实的坑

项目做到一半，发布门的质检命令开始失败。报错是 `unrecognized arguments`，指向 `--release-self-check`、`--reviewer-provider`、`--session-id`、`--clean-context` 这几个参数。

查下去才发现，仓库里存着两份质检脚本。教程附件那份是 0.3.2，上游最新那份是 0.3.4。发布门的工具注册表指向了 0.3.2，而 0.3.2 根本不认识这些参数。上游 0.3.4 全部接受。

麻烦的地方在于，这两份脚本**都有各自的用处**，不是谁复制粘贴忘了删。教程附件是权威判据口径，专家签字的就是那一套。上游 0.3.4 才有产出发布门证据需要的能力。出问题的地方在引用关系，发布门工具的职责和它实际读的那份脚本对不上。

修法是让引用跟着职责走。发布门工具去解析 0.3.4，判据口径仍然读教程附件，两边都保留。

修完之后补了一层机制，让这种事不会再悄悄发生。仓库里记着一份上游资产的基线，15 个文件，各带 SHA-256。`npm run check` 会拿当前磁盘上的字节去比对。实测改一个文件 29 个字节，立刻报 `DRIFTED` 并指出是哪个文件，退出码 1。恢复原样再跑，回到 `IN_SYNC`。

有意的升级需要显式接受，跑 `npm run upstream:accept` 重写基线。这样"主动升级"和"被动漂移"能分开。没有基线时报 `UNKNOWN` 而不是通过，因为没比对过不等于一致。

## 为什么不做自动同步

上游一变就自动跟进，听起来省事，实际会出事。

仓库的 `docs/upstream-defects.md` 里记着一个真实的上游缺陷，编号 D1。上游某个工具把端点弄反了，预设的四组配置全部判错。如果当时配了自动同步，这个缺陷会直接被搬进来，而且是静默的。

所以这里做的是检测加决策，不是自动改写。漂移检测只读，发现变化后交给人或模型判断。代价是多一步手动确认，收益是上游的错不会自动变成自己的错。

## 架构

```
packages/
  dsh-autoresearch/         引擎：四阶段状态机、九道门禁、脚手架、会话绑定
  dsh-autoresearch-skills/  技能供应：8 个 QA skill、SOP 经验理论、两份上游来源
  dsh-autoresearch-gates/   门禁桥：包装 SOP Python 工具，含上游来源声明与漂移检测
  dsh-autoresearch-qa/      双路质检：两个隔离 headless 进程加 fail-closed 聚合
  dsh-autoresearch-remote/  远端执行：SSH 自驱动脚本、机外快照
  dsh-autoresearch-api/     自定义 API 接入
  dsh-autoresearch-ui/      工作台界面
  dsh-ars-brand/            身份层：品牌位与归属说明
scripts/                    自检、消融、漂移基线、集成验证
docs/                       架构与专题说明
```

八个插件通过 profile 的 `dsh.profile.bundles` 挂载。harness 是唯一运行时，桌面壳只负责启动它。界面走官方 slot 和 `/api/autoresearch/*` 路由，没有 preload 注入 DOM。

## 快速开始

```bash
npm install
npm run profile:install
npm run harness
```

`npm run harness` 会打印一个带 token 的 URL，浏览器打开就是完整界面。建议存成书签。

也可以起 Electron 壳，本地免费。

```bash
npm run desktop
```

两条路是同一套东西，共用 `.dsh-home` 和同一份 profile。换启动方式不会看到不同的任务和配置。

打开界面后点侧边栏的 AutoResearch 进工作台，能看到四阶段进度、九道门禁结论、交付物缺口、迭代轨迹。

## 验证

```bash
npm run check
```

十一步，合计 312 项，当前全部通过。

| 步骤 | 项数 | 验的是什么 |
|---|---|---|
| `syntax-guard` | 54 个模块 | 所有 JS 模块可解析 |
| `tool-registry-guard` | 16 | 每个插件真的把工具注册进了 ctx.tools |
| `selftest` | 103 | 门禁判据、状态机、脚手架、技能目录 |
| `selftest:remote` | 19 | SSH 容错、脚本幂等、账本、失败路径 |
| `selftest:api` | 28 | 声明校验、patch 生成、凭据改写、端点探测 |
| `ablation:mode` | 23 | 工作流模式开关是否产生可观测差异 |
| `ablation:gates` | 22 | JS 预判与 Python 权威判定是否一致 |
| `ablation:upstream` | 16 | 上游引用与漂移检测的因果证明 |
| `ablation:selfreview` | 25 | 对改造本身的对抗性自审 |
| `ablation:deliberation` | 26 | 审议台的对抗性角色是否产生可观测差异 |
| `upstream:check` | 17 项资产 | 漂移检测 |
| `verify:integration` | 34 | 起真实 harness 进程验证插件加载与路由 |

`syntax-guard` 和 `tool-registry-guard` 排在最前是有原因的，它们是我自己踩坑之后加的，堵的是同一类缺口。

有一次改 `qa/index.js` 时误用了动态 `await import()`，`apply()` 不是 async，直接语法错误。可当时整套检查**仍然全绿**，因为集成验证加载的是 `profile:install` 装进 profile 的副本，根本没读这个坏掉的源文件。也就是说，源码改坏之后测试可以继续骗人。

`syntax-guard` 堵住了「代码不可解析」。但还有第二类漏洞，插件**能加载**、工具却**没注册成功**。集成验证只检查「插件有没有 import 失败」，不检查注册结果，所以这类问题同样可以一路绿到底。`tool-registry-guard` 直接构造最小 ctx 逐个 apply 插件，读出真实注册的工具名，与预期名单比对。实测把语法错误注入 `qa/index.js`，它报出 `FAIL dsh-autoresearch-qa 可加载（语法/顶层错误）` 并 exit 1。

它读的是**源码字节**而不是 profile 缓存副本，所以不受缓存影响。代价是它需要 `npm run profile:install` 建过解析根，否则插件之间的裸包名 import 无法解析。

改过 `packages/` 下的源码后必须重跑 `npm run profile:install`。pnpm 对 `file:` 依赖缓存副本，不刷新会跑到旧代码。

## 门禁

九道门，对应五个里程碑，不可跳级。

| 门禁 | 里程碑 | 判定内容 |
|---|---|---|
| `G-SELECT` | M1 | 选题静态筛查，看优化面、baseline 可比性、指标类型、benchmark 广度 |
| `G-FEASIBILITY` | M2 | 判定门是否闭合，即 `R_norm ∈ [0.15, 0.8]` 且 `Δ ≥ 3σ_B` |
| `G-CONTRACT` | M3 | `task.toml` 原生契约四项必查 |
| `G-DOCKERFILE` | M3 | 双镜像路径契约、越界 COPY、题面八章节 |
| `G-NOP-RESULT` | M3 | NOP 四件套同源与出分有效性 |
| `G-TRAJECTORY` | M4 | 八字段合规、两条轨迹时长、7 小时例外资格 |
| `G-REPLAY-CONTRACT` | M5 | 集成方法提交契约、`pred_test.npy` dtype |
| `G-SINGLE-SOURCE` | M5 | 同一事实单一真源 |
| `G-PACK-VERIFY` | M5 | 打包逐文件哈希一致、缓存残留 |

结论是三态，`RECOMMEND`、`NEEDS_EVIDENCE`、`REJECT`。任一硬门失败就是 `REJECT`，热度、引用数、新颖性不能拿来抵消。未知项记 `UNKNOWN`，不写成通过。

## 模型可用的工具

20 个。

**任务与门禁**

`autoresearch_init` 初始化任务并生成题包骨架
`autoresearch_gate` 运行一道门禁并留痕
`autoresearch_advance` 推进阶段，门禁未过则拒绝
`autoresearch_trajectory` 按八字段追加一轮迭代记录
`autoresearch_gate_run` 运行随包 Python 门禁工具，原样透出退出码

**双路质检与审议**

`autoresearch_qa_pack` 打包确定性 ZIP
`autoresearch_qa_lanes` 查看与校验双路配置
`autoresearch_qa_dual` 两路并行独立质检加聚合
`autoresearch_qa_verify` 只读复核既有聚合结果
`autoresearch_deliberate` 多模型对抗审议一个方向，产出方案加反驳加代价

**远端执行**

`autoresearch_remote_target` 登记远端服务器
`autoresearch_remote_probe` 探测远端能力
`autoresearch_remote_submit` 投递自驱动任务
`autoresearch_remote_probe_job` 查询任务状态
`autoresearch_remote_snapshot` 采集机外快照
`autoresearch_remote_status` 持久化体检
`autoresearch_remote_exec` 远端执行短命令

**API 接入**

`autoresearch_api_add` 声明自定义端点与模型
`autoresearch_api_verify` 真加载校验
`autoresearch_api_dual_lanes` 一次配好双路质检的两路

## 双路独立质检

教程对 M5 发布门的要求是两个独立会话、不同 AI、各出一份报告，同源 ZIP，身份两两不同，逐项判定无分歧，再由 `qa_consensus.py` 聚合。

隔离是结构性的，不是写在提示词里的约定。

| 维度 | 做法 |
|---|---|
| 进程 | 每路一个独立 `dsh --profile headless` |
| 数据 | 每路独立 `DSH_HOME` |
| 输出 | 每路独立目录，提示词禁止读另一路 |
| 模型 | 每路独立 patch 固定 provider 与 model |
| 凭据 | 每路独立环境变量注入，不落盘 |

两路身份相同会在启动前被拒绝，不会白跑。

这里有一件需要说清的事。身份校验比的是 provider、model、version 三个字段。如果两路用同一个端点、同一个模型，只是路由名不同，校验是能过的。`docs/dual-qa.md` 里如实写明了这一点。它能提供的独立性低于两个真正不同的模型，这个差别使用者应当知道。

## 决议审议台

双路质检验的是「已经做完的题」。审议台处理更早的问题，也就是「这个方向该不该做」。做之前先让几个模型吵一架，比做完再发现方向错了便宜得多。

它的做法不是「让几个模型讨论出方案」。那个做法有陷阱，各写一版再取共识会把分歧**平均掉**而不是**解决掉**。三个模型若共享同一批训练偏差，它们会一起错，而且「多数一致」会让错误显得更可信。所以它按**对抗**组织，每路有固定的举证义务，彼此不重复。

| 角色 | 义务 | 禁止 |
|---|---|---|
| 提案方 | 给出一个明确方向，说明依据、收益、以及自己认为可能失败的地方 | 不许罗列多个方向让决策者挑 |
| 反例方 | 必须找出至少 3 个具体失败模式、反例或未验证假设 | 找不到就写找不到，不得为凑数编造 |
| 代价方 | 给出资源、时间、许可代价，判断不可逆性 | 不评价方向好不好，只算代价 |

反例方是强制项，配置里没有它会被直接拒绝。没有反例的审议只是几个模型并行的自说自话。

产出是「一个方案 + 已知的反驳 + 明确的代价」，不是「一个更对的答案」。聚合器刻意不裁判、不打分、不投票，只按角色归类、标出失败的路、标出角色缺席。结论里带一条固定声明，写明它不能替代实测证据。审议说可行和实测 `R_norm ∈ [0.15, 0.8]` 是两件事。

**它不接门禁。** 这一条是刻意的。一旦审议结论成为推进阶段的前置条件，它就会退化成合规仪式，使用者会为了过门凑一份「看起来被审议过」的记录。所以它只产出材料，不被任何门禁读取。

独立性如实分三档。同一个端点同一个模型跑多路只是同一模型的多次采样，能减少随机性，不能减少系统性偏差，这一档标为 `single` 并写明这个限制。不同路由标 `multi-provider`。分级结果写在 manifest 里，使用者能看到自己拿到的是哪一档。

有一项**没有验证**。真实模型在三种角色下的输出质量差异还没测过，那需要真实 API 调用且结果不可复现。消融实验只证明了提示词携带了角色义务，不证明模型会遵守它。如果模型无视约束、三路输出高度相似，这个模块的价值就退回到 `single` 档。验证方法是在有凭据的环境跑一次真实审议，人工比对三路差异度。这一步还没做。

细节见 `docs/deliberation-board.md`。

## 工作流模式

前面七个插件是工具箱，能力都在，但需要模型想起来调用。模式解决的是这个。进入后由状态机驱动，每一步开始前主动告诉模型现在在哪、下一步做什么、什么被禁止。

```
/autoresearch          进入模式
/autoresearch off      退出
```

注入的内容分四部分，当前阶段与目标、本步应做的事、待处理门禁、模式纪律。几个设计上的取舍值得说明。

顺序有讲究，先说要做什么，再说缺什么，因为顺序影响模型先动哪个念头。它也不写"你可以调用 X 工具"，工具目录已经列了，模式只说现在该做什么。指令本身带指纹，阶段、门禁结论、缺失数量都没变时就不重复注入。另外，未运行的门禁同样阻塞，不能因为某道门还没跑就跳过它。

## 随包技能

教程附件 0.3.2 提供 `autoresearch-task-qa` 和 `autoresearch-baseline-quality`。

上游 0.3.4 提供八个，`paper-discovery`、`optimization-surface`、`baseline-quality`、`task-authoring`、`run-isolation`、`task-qa`、`feishu-three-table`、`conversation-handoff`。

SOP 经验理论提供 `autoresearch-task-sop`，含 34 条执行规则、L1 到 L32 实战教训、失败模式、沙盒隔离、GPU 预算。

同名技能保留两份来源，教程附件优先。这不是没清理干净的重复，两份服务不同职责。漂移检测会把它们的哈希都记下来，谁变了都能看出来。

## 已知限制

远端执行需要宿主的 `ssh` 客户端。插件不接收也不存储密钥内容。

本机没有 Docker 时，双镜像构建、完整 Harbor 自验、NOP Trial 跑不了，但可以在租用的服务器上跑，用 `autoresearch_remote_probe` 确认能力后投递。门禁工具会如实报告不可用。`G-CONTRACT` 和 `G-DOCKERFILE` 仍能做静态判定，但不能替代真机构建和正式 Hidden 验收。

双路质检需要两套可用的模型凭据。缺凭据时那一路以 401 失败并如实记录。两路都失败判 `INCOMPLETE`，不会误报成通过。

自定义 API 的协议只有三种，`openai-completions`、`openai-responses`、`anthropic-messages`，这是 pi-ai 的能力边界。

门禁结论是本地判定事实，与平台官方审核结论严格区分。需要 root 的工具默认禁用，可以在配置里开。桌面壳没做代码签名和自动更新。

有两条需要 Linux 验证的问题还没验。`zip.js` 的排除规则对文件名大小写敏感，以及凭据文件的 `chmod 0600` 在 POSIX 上是否真的生效。Windows 上实测 `chmodSync` 不抛错但权限仍是 666，工具却对着用户声称 0600，这一条在 Windows 上确实不成立。

## 目录里还有一个更早的审查

`docs/adversarial-review-round2.md` 记着八项确认的缺陷和五项被推翻的猜测。留下的价值主要在后一半，那五项我一开始怀疑有问题，实测下来站得住，写下来免得后面有人重复劳动。

`docs/first-principles-dynamic.md` 记着这一轮改造的完整推演，包括我**撤回**过的一条建议。我最初主张把三份脚本副本收敛成一份，后来发现两个来源是刻意分工的，收敛会把权威判据口径删掉。这个错误留在了文档里。

## 许可证

MIT。DeepSeek Harness 及其依赖遵循各自上游许可证。
