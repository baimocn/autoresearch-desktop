# 七条红线：实现状态

PRD 列了七条绝对红线。这份文档记录**每条在代码里的实际落点**，以及哪些是
本轮新写的、哪些本来就有。

分这张表的意义在于避免重复劳动，也避免把"写在文档里"当成"已经拦住"。

| # | 红线 | 实现落点 | 状态 |
|---|---|---|---|
| 1 | 数据泄露 | `G-DOCKERFILE` 的 `G3.8` / `G3.9` / `G3.10` | **本轮新增** |
| 2 | 预算公平（G02） | `G-FEASIBILITY` 的 seed 集与预算对齐 | 已有 |
| 3 | 原生 NOP | `nop_preflight.py`（随包 SOP 工具） | 已有 |
| 4 | 哈希对齐 | —— | **未实现**（见下） |
| 5 | 数学标定（G03） | `G-FEASIBILITY` 的 `R_LO=0.15` / `R_HI=0.8` / `3σ` / `5σ` | 已有 |
| 6 | 架构交付（禁 DinD） | `G-DOCKERFILE` 的 `G3.11` | **本轮新增** |
| 7 | 隔离 | `G-DOCKERFILE` 的 `G3.2`（私有内容不得进 Agent 镜像） | 已有 |

红线 2/3/5/7 已实现并在 `npm run check` 里跑。本轮补了 1 与 6，
没有另起一套「卡尺」，因为那样会产生两套判据，日后必定不一致。

**红线 4 是空头承诺，需要明确。** 本表曾把「哈希对齐」标为「已有」，落点写作
`G-CONTRACT` 的 `task_content_sha256` —— 但全库搜不到任何 `task_content_sha256`
实现（`gateTaskContract` 只做 G2.1–G2.6 的字段检查，其声明权威
`harbor_task_contract.py` 也没有任何哈希逻辑）。也就是说：

- 「交付物一改、旧的门禁结论即失效」这条规则目前**没有代码支撑**；
- `state.js` 的 `frozenManifest` / `intentionalChanges` 字段无人写入，
  于是 `phases.js` 里「冻结清单未登记改动数为 0」这个放行条件也永远不会被真正校验。

补法是给 `G-CONTRACT` 增加四路径内容哈希并写进 `state.json` 的 `frozenManifest`，
门禁结论与哈希绑定后再比对。在此之前，任何依赖「改了就失效」的判断都不可信。

## 红线 1：数据泄露

**判据**：Reference 或 Starter 在**训练路径**上读取验证集/测试集标签。

### 为什么不能一律命中即拦

朴素的「出现 val/test 就报错」会产生大量误报。`val_loader`、
`val_accuracy` 在正常评测代码里到处都是，而且**训练循环外**出现也完全合法。

误报的代价很实际。一条经常误报的检查，使用者会学会忽略它 ——
真泄露时也不会看。所以分三档：

| 档 | 含义 | 门禁动作 |
|---|---|---|
| `leak` | 训练路径上读取评测集**标签**，或求值评测集**注册** | `G3.8` **FAIL** |
| `suspect` | 训练路径上读取评测集**数据**，或训练期在评测集上评估 | `G3.9` UNKNOWN，待人工确认 |
| `mention` | 评测/日志语境，或未构成训练路径证据的评测集引用 | `G3.10` 记录，不拦 |

`mention` 也**如实列出**，不静默丢弃。丢弃会让人误以为文件干净。

判据的核心是**数据流位置**，不是关键词。标签词必须出现在能绑定数据的位置
（赋值左侧、下标/属性读取、loss 实参、读取调用），或由「遍历评测集并解包」
绑定；出现在 `def`/`class` 名、普通调用名（`split_labels(`）、循环变量
（`for label in ...`）里的标签词**不算**读标签 —— 那些只是命名习惯。

### 实现中踩到的七个坑（都靠消融实验抓出来）

**坑一：标签绑定与集合名不在同一行。** 最常见的泄露形态是

```python
val_loader = DataLoader(ValDataset(), batch_size=32)
for x, y in val_loader:        # ← 这里才把 y 绑到评测集
    loss = criterion(model(x), y)
    loss.backward()             # ← 这里才是训练
```

逐行看任何一行都不含「集合名 + 标签」组合，直接漏报。改成**滑动窗口**
（前后各 4 行）判定。

**坑二：`for x, y` 里既没有 "label" 也没有 "target"。** 词表再全也匹配不到，
因为字面上就是个解包。所以单独识别「遍历评测集并解包多个变量」这一形态。

**坑三：`\b` 匹配不了 `load_ground_truth()`。** 下划线在正则里属于单词字符，
所以 `\bground_truth\b` 前面要求非单词字符时，`_` 让它失败。改用
`(?<![A-Za-z0-9])` / `(?![A-Za-z0-9])`。

**坑四：`apk add` 不是 `apk install`。** 包管理器动词不统一，逐个覆盖
（apt/yum/dnf 用 install，apk 用 add）。

**坑五：标识符子串不是数据流（实测误报）。** 旧实现用无边界子串匹配
`LABEL_READ` / `EVAL_SET`，于是 `split_labels` 命中 `labels`、
`test_class_names` 命中 `test`。实测 AutoRe1852 的 `score/score.py` 里 7 行
无害的词表运算（把类名归一化、求评测类别与训练类别词表的词面交集）因此
**全判 leak、门禁硬拒**，而该文件真正的违规（下面坑六）却只判 mention。
指错位置比纯误报更危险：照着 207–213 行改，门禁变绿，真漏洞原样留存。

**坑六：训练语境里的 `for ... in ... train` 语义是反的。**
`for label in train_class_names` 是在遍历训练词表，不是训练动作，旧规则却把它
当训练语境，把「任何遍历名字里带 train 的集合的循环」都拉进 leak 判定
（正是坑五那 7 行的触发条件之一）。

**坑七：子串匹配的误报会「换个规则复发」。** 只给 `LABEL_READ` 加位置要求
是不够的 —— 复测发现 `strongLabelRe`（`test_labels_format` 命中
`test_labels`）与 `unpackOverEvalRe`（`for i, name in enumerate(val_class_names)`
里的 `val_class_names`）仍在做同一件事：**用名字里的子串决定判定**。
每修一处就冒出下一处。所以判定依据本身必须换掉，见下。

### 判据：标识符分量 + 位置（不是子串）

红线 1 的判定不再基于「文本里是否出现某个词」，而是两级：

1. **标识符分量**。把标识符按 snake_case / camelCase / 数字边界切成**整分量**
   再比较。`val_loader` → `[val, loader]` 命中评测集；`test_labels_format` →
   `[test, labels, format]` 的尾分量是 `format`，**不是**标签名；
   `interval` 是单分量，不会被 `val` 命中。标签词之后只允许跟容器/集合后缀
   （`val_labels_list` 是标签集合；`val_labels_count`、`val_labels_helper` 不是）。
2. **位置**。标签名只有落在数据位置才算「读标签」：赋值（且右侧是读取）、
   下标键、属性、loss 实参、赋值右侧的评测限定标签名。作为**调用名**出现
   （`split_labels(`、`load_labels(`）一律不算 —— 那正是原始误报的形态。

「是否在训练路径上」也随之改成结构判据：`for <vars> in <训练数据容器>`
（`train_loader`）或反传/优化器。单变量训练循环（`for batch in train_loader:`）
**算**训练语境 —— 训练步常封在 `train_step()` 里，窗口内看不到字面
`.backward`，漏掉它会把真泄露降级为 mention。

解包遍历的评测集必须是**数据容器**（`val_loader`/`test_dataset`），
不能是词表/配置（`val_class_names`/`test_config`）—— 这是区分
`for x, y in val_loader:`（泄露）与 `for i, name in enumerate(val_class_names):`
（遍历词表）的唯一可靠依据。

扫描前还会**剥离三引号块**：一句 `"""注意：不要用 cfg.DATASETS.TEST 做训练。"""`
曾把一份劝阻违规的 docstring 判成 leak。

### 补上的正向规则（治漏报）

旧规则没有任何一条专门认「训练路径读评测集注册」这一形态，于是真违规漏报。
现在补三条：

| 形态 | 判据 | 档 |
|---|---|---|
| 求值评测集注册 | `cfg.DATASETS.TEST` / `cfg["DATASETS"]["TEST"]` / `getattr(..., "TEST")` 出现在训练路径（窗口内有 `DATASETS.TRAIN`、训练语境，或所在函数是 `build_model`/`train*` 之类） | `leak`；证据不足时 `suspect` |
| 训练期在评测集上评估 | 训练命令/配置里评测间隔非零（`EVAL_PERIOD`、`val_check_interval`、`eval_interval` …） | `suspect` |
| 训练入口构造评测集 | 训练脚本里**调用**（不是定义）`build_eval_loaders()` / `get_eval_dataset()` 之类 | `suspect` |

「评测间隔非零」只落 `suspect`：静态文本无法证明「训练命令是否覆盖了
`DATASETS.TEST`」，证据不足以定 `leak`，如实留在待确认档，不虚报。

### 已知局限

「是否在训练路径上」是**启发式**判定，精心构造的写法仍可能漏报。这是
静态扫描的固有边界，不是可以靠调参消除的。缓解措施是 `mention` 档全部
如实列出供人工复核。

本次修复的目标是消除**已实测到的这一类误报**（标识符子串）并补上
**已实测到的这一类漏报**（训练路径读评测集注册），**不宣称红线 1 已完备**。
如实声明的边界：

- **变量名以 `eval_` 开头**（如 `eval_labels`、`eval_json`）会命中评测语境豁免
  `evalCtxRe` 里的 `eval_`，把该窗口降为 `mention`。这是**既有行为**，本次未改动
  —— 收窄 `eval_` 会波及正常评测代码（`eval_loss` 累加器等），引入新误报的风险
  大于收益。稳妥的修法是按「是否真在算指标」判语境，不是继续加词。
- **「读取评测集数据并送进 loss」若变量名不带标签证据**（如 `ann = json.load(...)`）
  只到 `suspect` 而非 `leak`：静态扫描无法证明读到的就是标注，如实分档。
- **按名取注册**（`MetadataCatalog.get("nwpu_val_instance")`，不写 `DATASETS.TEST`）
  不检出：需要把配置里的评测集名与代码关联，属跨文件分析，当前未做。
- **「训练命令是否覆盖了测试集」无法静态验证**，所以评测间隔非零只落 `suspect`。
  同理，纯 yaml 里写 `DATASETS: TEST:`（没有对应的 `.py` 读取、也没有非零评测间隔）
  不检出。
- **「定义」与「使用」的界限**：训练脚本里定义一个评测集加载器构造函数
  （`def get_val_loader`）不再被判 `EVAL_LOADER_CALL`；但若同窗口还有评测集
  数据读取，仍会落 `suspect` 待人工确认 —— 是否真在训练里用，静态看不出来。

**这一步没有被自动化取代**：门禁只负责把可疑位置摆到人眼前。

## 红线 6：架构交付

**判据**：严禁 DinD，内场不交付依赖 Compose 的方案。

这条命中即 `FAIL`，不设中间档。理由：DinD 在评测环境会因缺 privileged
权限或嵌套存储驱动直接跑不起来，属于「静态全绿、真机必挂」。提交后才
暴露的代价极高，所以不给"警告"这个选项。

覆盖四类共 20 余种写法：

| 类别 | 覆盖写法 |
|---|---|
| 挂 socket | `docker.sock`、`--mount type=bind`、`/var/run/docker` |
| 起 daemon | `dockerd`、`service docker start`、`systemctl start docker`、`DOCKER_HOST=unix:` / `tcp:` |
| 装 docker | apt/yum/dnf `install`、apk `add`、pip、conda/mamba |
| Compose | `docker compose`、`docker-compose`、`compose.yaml`、`services:` 顶层键 |

### 扫描范围必须包含 Dockerfile

第一版只扫 `reference/` 源码，结果漏掉了绝大多数真实案例 ——
DinD 最典型的出现位置恰恰是 **Dockerfile**（`RUN apt-get install docker-ce`）。
这个错是接线检查抓出来的，不是读代码看出来的。

所以 `G3.11` 的扫描目标是**源码 + 两个 Dockerfile**。即使没有提供源码，
红线 6 依然照扫 Dockerfile，不会因为缺源码而失能。

### 顺带修掉的旧缺陷 F1

上一轮复审发现 `G3.1` 的 `/^\s*COPY\s+(\S+)/gim` 漏掉 7 种等价写法，
越界 COPY 可以绕过。红线 6 属于同一类检测，不能重复这个错误，所以
顺手把 COPY/ADD 解析重写了。

新解析覆盖：双引号、单引号、JSON 数组、`ADD`、`--from`、`--chown`、
制表符分隔、反斜杠续行。

**续行拼接不能插空格。** Dockerfile 的续行语义是直接拼接，插入空格会把
`../sec\` + `ret` 变成 `../sec ret`，路径被切断，越界检测随即失效。
这个也是消融实验抓出来的。

越界判定同时覆盖 `../x`、`/abs`、`a/../../b` 三种形态 —— 只看前缀
`../` 会漏掉路径中段的 `..`。

## 验证

| 脚本 | 项数 | 验的是什么 |
|---|---|---|
| `scripts/ablation-redlines.mjs` | 79 | 检测能力、等价写法、误报控制、门禁折叠、标识符分量误报回归语料、正向规则 |
| `scripts/check-gate-wiring.mjs` | 11 | 真实任务树下自填 payload 是否真的读了源码 |

`check-gate-wiring.mjs` 存在的理由：红线逻辑再对，如果 `autoresearch_gate`
构造 payload 时没把源码读进来，红线在真实流程里只会报「未扫描」。
**它就成了只活在消融实验里的纸面门禁。** 这类脱节读代码很难发现，
所以用临时任务树端到端跑一次 —— 造含泄露与 DinD 的目录，看是否真判 REJECT。

## 没有做的事

**没有按 PRD 的「四个卡尺」另写一套脚本。** 卡尺 1（哈希）、3（σ/U 标定）、
4（复验熔断）在门禁与随包 SOP 工具里已经存在且在跑。再写一套会产生两套
判据，日后必然不一致 —— 而门禁判据不一致比没有判据更危险。

**没有做 Web UI。** 门禁结论已经是结构化 JSON 且落盘留痕，任何前端都能读。
先加前端只会让改动面变大，对拦截能力零贡献。
