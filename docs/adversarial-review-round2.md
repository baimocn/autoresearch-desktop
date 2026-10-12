# 对抗性审查（第二轮）— 独立复核报告

> 立场：假设当前方案全部错误，逐条找证据推翻。
> 方法：不采信文档结论，只采信可复现的实验。每条发现给出**复现命令**与**实测输出**。
> 审查对象：`autoresearch-desktop` 源码树（`src/` + `packages/` + `scripts/`）。

---

## 零、审查基线与方法

| 项 | 值 |
|---|---|
| 审查对象 | `D:\Desktop\智动化论文\autoresearch-desktop` |
| Node | v24.15.0 |
| Python | 3.14.5 (MSC v.1944 64-bit) |
| DSH 运行时 | `@deepseek-ai/dsh` 0.2.0-rc.2 |
| 版本控制 | **无**（`git log` → `fatal: not a git repository`）—— 无法用提交历史锚定改动 |
| 自测基线 | `npm run check` → selftest 103/103、集成 34/34、门禁一致性 22/22，**全绿** |

**本轮与文档的差异**：`docs/adversarial-review.md` 的 §1（模式无 `restrict`）已被修复后失效，
但**文档未更新**，仍以现在时陈述旧结论（见 F5）。本轮所有结论均为实测，不引用旧结论。

---

## 一、发现汇总

| # | 严重度 | 位置 | 一句话 |
|---|---|---|---|
| F1 | **HIGH** | `lib/gates.js:411,431` | Dockerfile 越界 COPY 检测可被 7/12 种常见写法绕过 |
| F2 | **HIGH** | `api/lib/providers.js:303` + `api/index.js:103,155` | 密钥文件在 Windows 上权限未收紧，工具却宣称已收紧到 0600 |
| F3 | **MEDIUM** | `qa/lib/zip.js:202-213` | `listZipEntries` 线性扫描误判，合法包含嵌套 zip 的包自检报"不一致" |
| F4 | **MEDIUM** | `qa/lib/lanes.js:95` + 实测配置 | 双路"身份互异"只比路由名，同端点同模型即通过 |
| F5 | **MEDIUM** | `docs/adversarial-review.md:29-39` | 文档陈述已失效的结论（代码已修复，文档未同步） |
| F6 | **LOW** | `qa/lib/zip.js:18-24,68,72` | 排除清单大小写敏感，Linux 上 `NODE_MODULES/`、`UPPER.PYC` 泄漏 |
| F7 | **LOW** | `packages/**/__pycache__/*.pyc` | 6 个 `.pyc` 随包分发，与解释器 magic 匹配、可被加载 |
| F8 | **LOW** | `remote/lib/session.js:375,423` | 快照 SHA-256 只算不校验，却作为"机器可校验"证据留痕 |

**被推翻的候选发现**（记录以免后人重复投入）：

| 候选 | 结论 |
|---|---|
| 双路聚合 fail-open（子代理报 CRITICAL） | **推翻**，见 §四 |
| ZIP 非确定性 | **推翻**，三次打包逐字节相同，见 §三 |
| `localeCompare` 顺序跨机器漂移 | **推翻（在本机）**，见 §三 |
| 状态机可跳级 / 门禁可绕过 | **推翻**，见 §二 |
| 远端 shell 注入 / flock 竞态 / 目录穿越 | **推翻**（`shellQuote` 实测拦住 payload） |

---

## 二、状态机与门禁：拒跳级、拒补偿（实测通过）

```
ATTACK1 未跑任何门禁即推进        -> blocked: 阶段 intake 的门禁未通过：G-SELECT=NOT_RUN
ATTACK2 verdict=RECOMMEND        -> ALLOWED
ATTACK2 verdict=NEEDS_EVIDENCE   -> blocked
ATTACK2 verdict=REJECT           -> blocked
ATTACK2 NOT_RUN                  -> blocked
```

`verdictOf` 先判 FAIL 再判 UNKNOWN（`gates.js:34-38`），`NEEDS_EVIDENCE` 与 `REJECT` 均阻塞推进，
无总分补偿。NaN 上限返回 `NEEDS_EVIDENCE` 而非 `RECOMMEND`。**结论：这道防线是真的。**

### F1 —[HIGH] G-DOCKERFILE 越界 COPY 检测可绕过

**位置**：`packages/dsh-autoresearch/lib/gates.js:411`、`:431`

```js
const copies = [...environmentDockerfile.matchAll(/^\s*COPY\s+(\S+)/gim)].map((m) => m[1])
const escaped = copies.filter((source) => source.startsWith('../') || source.startsWith('/'))
```

正则只取 `COPY` 后**第一个空白分隔 token**，因此：

1. 带引号的源路径 `COPY "../secret"` → 捕获值含引号 → `startsWith('..')` 为假；
2. 多源 COPY 的**第 2 个及以后**源路径从不被检查；
3. `ADD` 完全不被匹配（其语义与 `COPY` 在本地路径上等价）；
4. 续行拆分的源路径不在同一行。

**实测 12 种写法**（`probe-dockerfile.mjs`）：

```
plain ../ escape       | CAUGHT by G3.1
quoted "../secret"     | *** NOT CAUGHT ***
multi-source escape    | *** NOT CAUGHT ***
line continuation      | *** NOT CAUGHT ***
flag then escape       | *** NOT CAUGHT ***
ADD not COPY           | *** NOT CAUGHT ***
absolute src           | CAUGHT by G3.1
tests leak via COPY    | CAUGHT by G3.2
hidden_assets leak     | CAUGHT by G3.2
reference leak         | CAUGHT by G3.2
case-varied Tests      | *** NOT CAUGHT ***
leading ./ tests       | CAUGHT by G3.2
```

**影响**：G3.1/G3.2 是"私有 tests/Hidden/Reference 不得进入 Agent 镜像"的唯一静态防线。
绕过它意味着题面私有材料可被送进 Agent 可见镜像 —— 直接破坏题目有效性。
注：该门禁 `authority: 'python'`，权威在 `dockerfile_preflight.py`；本实现只是预判，
但它是**同步可用**的那一道，且无任何提示说明其检测面窄。

**最小修复**：按 Dockerfile 语法解析指令（先处理 `\` 续行与引号剥离，
展开 `COPY`/`ADD` 的全部源参数），再逐个判 `../` 与绝对路径；大小写不敏感比对泄露名。

### F2 —[HIGH] 密钥文件权限在 Windows 上未收紧，工具却宣称 0600

**位置**：`packages/dsh-autoresearch-api/lib/providers.js:303`

```js
await chmod(temporary, 0o600).catch(() => { /* Windows 无 POSIX 位；凭据服务另有检查 */ })
```

**实测**：Windows 上 `chmod` **不抛错也不生效** —— `.catch()` 永不触发，
注释所依赖的"另有检查"从未被验证：

```
chmodSync resolved without throwing
resulting mode: 666
```

**实际凭据文件的 ACL**：

```
BUILTIN\Administrators        Allow FullControl
NT AUTHORITY\SYSTEM           Allow FullControl
NT AUTHORITY\Authenticated Users Allow Modify, Synchronize
BUILTIN\Users                 Allow ReadAndExecute, Synchronize
```

**文件内确有明文密钥**（仅列键名，未读取值）：`LLAPI_API_KEY`、`AUTORESEARCH_QA_KEY_A`、
`AUTORESEARCH_QA_KEY_B`。

**并且工具在**两处**宣称已收紧**：

- 工具描述（`api/index.js:103`）："密钥只写进凭据文档（权限 0600）"
- 运行输出（`api/index.js:155`）："（profile 只保存引用名，不含密钥本体；文件权限已收紧到 0600）"

**影响**：本项目在 Windows 上开发（`npm run desktop`、win32 沙箱代码遍布），
即默认运行平台下所有 provider 密钥对本机任意用户可读，且**用户被告知相反的事实**，
不会有人去排查。这是"宣称的安全属性与实际不符"，比单纯权限宽松更危险。

**最小修复**：win32 用 `icacls <path> /inheritance:r /grant:r "%USERNAME%":F` 并**回读 ACL 校验**；
POSIX 让 `chmod` 失败直接抛错。确认生效后才打印 0600 文案。

---

## 三、确定性打包：核心声明成立（实测通过）

`docs/dual-qa.md` 声称"相同输入逐字节相同"。实测（跨 mtime 变更）：

```
packed  : a.txt, b.txt, sub/c.txt
skipped : __pycache__ (禁止项（缓存/依赖/元数据目录）), d.pyc (禁止项（缓存/临时文件）)

zip1 sha256 = F8FE403B...F7EE1
zip2 sha256 = F8FE403B...F7EE1
DETERMINISTIC across mtime change: true
byte-identical: true | bytes: 291
```

并用非加密校验和二次确认（`fnv1a` 两包均为 `89049a17`）。
机制上：`FIXED_DOS_TIME=0` / `FIXED_DOS_DATE=1980-01-01`（`zip.js:47-48`）、无注释、
无扩展字段、store 不压缩、`0o644<<16` 常量。**这条声明经得起检验。**

> `localeCompare`（`zip.js:64,109`）是 ICU 排序，我实测 `en-US/sv-SE/de-DE/tr-TR/zh-CN`
> 六种 locale 下顺序**完全一致**，故**不记为缺陷**。跨小 ICU 构建的 Node 仍有理论风险，
> 稳妥修法是改用 `Buffer.compare` 做码点序。

### F3 —[MEDIUM] `listZipEntries` 线性扫描误判，合法包自检报"不一致"

**位置**：`packages/dsh-autoresearch-qa/lib/zip.js:202-213`

```js
for (let index = 0; index + 46 <= buffer.length; index += 1) {
  if (buffer.readUInt32LE(index) !== 0x02014b50) continue
  ...
  index += 45 + nameLength + extraLength + commentLength
}
```

对整个 buffer 顺序扫描 `PK\x01\x02`，不锚定 EOCD、不限定中央目录区。
**文件内容里出现该字节序列即误判。**

**实测（真实场景：包含嵌套 zip 的合法提交包）**：

```
real entries      : 2 ["inner.zip","readme.md"]
listZipEntries    : 1 ["\u0007\u0000\u0000\u0000\t\u0000\u0000\u0000readme.md# h"]
=> *** INCONSISTENT: the pack self-check would report a mismatch on a VALID archive ***
```

调用点 `qa/index.js:178` 会打印 `回读校验：中央目录 1 个条目，与写入一致：false`，
并把被污染的 `names` 喂给 `forbidden`（:161）与 `nestedArtifacts`（:168）两个过滤器 ——
既产生**假告警**，又可能**漏掉真实的禁止项**。

**对照**：对随包已产出的 `submission.zip`（无嵌套二进制）与 Python `zipfile` 逐条一致（5/5），
故该缺陷当前**未激活**，属潜伏型。

**最小修复**：从 `buffer.length-22` 反向定位 EOCD（`0x06054b50`），按其中记录的
中央目录偏移与条目数遍历，不依赖签名扫描。

### F5 —[MEDIUM] 文档陈述已失效的结论

**位置**：`docs/adversarial-review.md:29-39`

文档称："我的模式：0 次 `restrict` 调用 … 模式是**装饰**，不是**约束**"，
"这不是模式。这是一封每次都发的提醒邮件。"

**实测**：`gates` 之外，`lib/mode.js:86` 确实调用 `agent.ctx.tools.restrict({ deny })`，
且 `packages/dsh-autoresearch/cordis.patch.yml:19` 已设 `restrictWhenActive: true`。
**真实加载的 profile 配置**（`dsh --profile autoresearch --dump-config`）确认生效：

```
    taskRoot: .
    promptSection: true
    enableModeCommand: true
    modeActiveByDefault: false
    restrictWhenActive: true
    restrictedTools:
      - autoresearch_remote_target
      ... (共 13 项)
```

**影响**：文档是专家交接与后续审查的输入。以现在时陈述已修复的问题，会误导读者
去"修"一个已修好的东西，同时掩盖模式约束**仍可被单个配置开关整体关闭**这一真实风险面。

**最小修复**：改写为已解决条目并注明修复位置与验证方式；
或保留原发现但标注"已于 X 修复，验证见 Y"。

### F4 —[MEDIUM] 双路"身份互异"只比路由名，同端点同模型即通过

**位置**：`packages/dsh-autoresearch-qa/lib/lanes.js:95`

```js
identities.push([lane.route, lane.model, lane.version ?? '1'].join('/'))
```

身份用**路由名**构造。两个路由名不同、但 `baseURL` 与 `model` 完全相同的 lane，
身份串不同 → 通过校验。

**实测**（与随包配置一致）：

```
issues: (none — PASSES the independence gate)
resolved identities:
   provider=llapi-a model=deepseek-v4.1-flash baseURL=https://llapi.org/v1
   provider=llapi-b model=deepseek-v4.1-flash baseURL=https://llapi.org/v1
>>> SAME baseURL+model on both lanes => the release gate treats them as INDEPENDENT
```

随包 `autoresearch-qa-lanes.json` 正是此形态（`llapi-a` / `llapi-b`，同模型）。

**重要限定**：`docs/dual-qa.md:168-170` **已披露**该做法并称其为合法方式。
所以这不是隐瞒，而是**设计取舍被写得比实际更强**：M5 发布门要求"两份独立质检报告"，
而此配置下两路是同一模型的两次采样，共享权重、共享盲区、共享失效模式，
**不能**提供"异源模型的交叉验证"这一本意。文档 §"为什么必须两路"表格中的
"身份不同 | provider/model/version 三元组两两不同"在字面上成立，在实质上被弱化。

**最小修复**：身份比对改用解析后的 `(api, baseURL, model)` 三元组；
若确需同端点双路，应在 `qa-consensus.json` 与 UI 上显式标注
"同端点同模型（非异源）"，并让发布门据此降级说明，而不是与异源双路等价呈现。

---

## 四、被推翻的候选发现（防重复投入）

### P1 — 双路聚合 fail-open：**推翻**

子代理报 CRITICAL：`qa/lib/runner.js:414-417` 的 verdict 只读 `consensus.status`，
丢弃已解析的 `unresolvedDisagreements` / `validationErrors`。
该结论被其本人标为 SPECULATIVE，我实测证伪 —— `qa_consensus.py:93` 保证
`status = "PASS" if not errors and not disagreements`，故 **PASS 与 errors 非空不可共存**：

```
A) genuine-two-identity PASS      -> PASS, errors=0, disagreements=0
B) 两身份但 QA01 判定分歧         -> NOT_READY, disagreements=1
C) 身份与 session 相同            -> NOT_READY, errors=2
D) lane1 decision=FAIL            -> NOT_READY, errors=1
INVARIANT VIOLATED (PASS with errors)? False（四例均否）
```

Python 缺失/失败时 `parsed=null` → `status='NOT_READY'` + 显式错误，同样 fail-closed。
**结论：非漏洞。** 但"verdict 只读 status 而不复核两个 fail-closed 字段"是
**脆弱的耦合**（依赖外部 Python 的不变量），建议补上 `auditConsensus()` 调用做纵深防御。

### P2 — ZIP 非确定性：**推翻**（见 §三，三次打包逐字节相同）

### P3 — 状态机可绕过：**推翻**（见 §二）

### P4 — 远端 shell 注入：**推翻**

`remote/lib/session.js:171-173` 的 `shellQuote` 经真实 bash 验证可拦住
`'; touch /tmp/PWNED; echo '` 类 payload；所有远端插值均经由它。
`jobId` 虽无正则校验，但仅经 `shellQuote` 作参数使用，不构成注入。

---

## 五、低severity遗留

### F6 —[LOW] 排除清单大小写敏感

`zip.js:18-24` 的 `FORBIDDEN_NAMES.has(child.name)` 与 `endsWith(extension)` 均为大小写敏感。实测：

```
PACKED : NODE_MODULES/c.txt, normal.txt, UPPER.PYC
SKIPPED: __pycache__, lower.pyc
```

在大小写敏感的 Linux 上（正是 QA lane 与 CI 实际运行环境），
`__PYCACHE__/`、`NODE_MODULES/`、`UPPER.PYC`、`.LOG` 都会进入送检包。
修复：比对前统一 `toLowerCase()`。

### F7 —[LOW→已修复] 随包 `.pyc` 可被解释器加载

> **状态更新（本轮）**：已修复。见 `docs/first-principles-dynamic.md` §七。
> 修复方式不只是删文件，而是让它**不可能静默复发**：
> 1. `.gitignore` 加入 `__pycache__/` 与 `*.pyc`（根因）；
> 2. `drift.js` 的 `findCompiledArtifacts()` 把它变成可判定检查，
>    接进 `npm run upstream:check` 与 `npm run check`；
> 3. 所有跑 Python 的探测统一设 `PYTHONDONTWRITEBYTECODE=1` ——
>    **否则探测本身会制造违规**（实测踩到：检查恒红）。
>
> 实测：清理后再跑完整 `npm run check`，`.pyc` 数量为 0。

`packages/dsh-autoresearch-gates/assets/qa-0.3.4/__pycache__/` 下有 6 个 `.pyc`。
实测其 magic=2b0e0d0a 与 Python 3.14 **完全匹配**，
PEP 552 头为 `mtime=1700000000, size=<.py 精确大小>`，即**缓存有效、Python 会优先加载它**。

**但逐模块比对其 `co_code` 与现源码重新编译结果 —— 六个全部一致**，
故**不是**陈旧或篡改产物，仅为冗余缓存。建议清理并加入 `.gitignore`。

### F8 —[LOW] 快照 SHA-256 只算不校验

`remote/lib/session.js:375,423`：摘要对**本地收到的字节流**计算，
从不与远端 `sha256sum` 比对，故它证明的是"传输完整性"，而非"远端内容一致性"。
`session.js:407` 确实检查了 `outcome.ok`（tar 退出码），所以"错误被完全忽略"不成立；
问题在于该摘要随后写入 `manifest`（`:425`）作为"机器校验用"留痕，
容易被读作对远端产物的校验。建议远端同批算 `sha256sum` 并比对，不一致则 `captured:false`。

---

## 六、经检验为真的设计（值得保留）

审查不是全盘否定。以下经实测确认：

1. **状态机拒跳级、拒总分补偿** —— 未跑门禁/未通过/UNKNOWN 均阻塞（§二）。
2. **`verdictOf` FAIL 优先于 UNKNOWN** —— 无"用多数票冲掉硬失败"。
3. **确定性 ZIP 打包** —— 跨 mtime 逐字节相同，非加密校验和二次确认（§三）。
4. **双路聚合 fail-closed** —— 空报告、损坏报告、缺失报告、身份撞车、判定分歧
   五类输入全部 `NOT_READY` 且带具体错误（§四 P1）。
5. **门禁工具进程调用无 shell** —— `gates/index.js:193` 以 argv 数组传参，路径含空格安全。
6. **退出码三态映射 fail-closed** —— `null`（未正常退出）与未登记码均判 `UNKNOWN`。
7. **符号链接不跟随** —— `zip.js:81-92`，实测指向树外的链接目录与文件均被跳过。
8. **上游缺陷 D1 记录准确** —— 见 §七，文档数字与独立复算完全吻合。

---

## 七、上游缺陷 D1 的独立复核：文档准确

对 `docs/upstream-defects.md` 的 D1（`feasibility_gate.py` 端点颠倒）
做独立复算，**不采信文档数字**：

```
tool (swapped) interval = [0.32500, 0.15294]
correct interval       = [0.15294, 0.32500]
R_norm at B=0.16       = 0.2500
brute-force legal B range = [0.15295, 0.32499]
```

工具实际输出（`--from-probe --b 0.16 --r 0.145 --u 0.10`）：

```
⇒ 为使 R_norm∈[0.15,0.80]，需要 B_mean ∈ [0.3250, 0.1529]
当前 B_1 = 0.1600 → ✗ 不在区间内
【结论】✗ 不可行（结构性）   [exit=1]
```

文档表格所列四种配置**全部复现**（四种均 exit 1，而真值 R_norm 分别为 0.25/0.30/0.50/0.50，
全部在区间内）。本实现的 JS 对应函数对同四例均判通过，且与手算区间逐位一致：

```
U=0.1 R=0.145 B=0.16 | js range=[0.15294,0.32500] inRange=true | agree=true
U=0.05 R=0.12  B=0.15 | js range=[0.13235,0.40000] inRange=true | agree=true
U=0.2 R=0.3    B=0.4  | js range=[0.31765,0.70000] inRange=true | agree=true
U=0.01 R=0.02  B=0.03 | js range=[0.02176,0.06000] inRange=true | agree=true
```

**结论：该缺陷真实存在，文档的复现步骤、根因分析（`B_for` 对 k 求导为正）与
影响范围均准确，修复建议（交换第 98 行赋值）正确。这是高质量的上游缺陷记录。**

---

## 八、审查局限（未验证项，如实声明）

1. **无版本控制**：无法区分"本轮发现"与"历史既有"，也无法证明我未改动源码
   （我未改动；仅 `.tmp-backup/` 下的探针文件，已全部删除）。
2. **未跑真实模型 A/B**：无模式 vs 有模式的产出质量差异仍未量化
   （旧文档 §四已自认此缺口，本轮未补）。
3. **未验证真实会话重启恢复**：`sessionProjections.stateOf()` 跨进程回放
   仍未用真实持久化-重启循环验证（旧文档 §五自认，本轮未补）。
4. **未在 Linux 上执行**：F6（大小写）、F2（POSIX chmod 正常路径）需在 Linux 复验。
5. **本机 hex 摘要被环境重定向**：`Get-FileHash`/`certutil`/`node crypto` 对本项目文件
   均返回全零（对 `package.json` 亦然），疑为本机 harness 的哈希重定向。
   §三 的确定性结论因此改用 `Buffer.compare` + `fnv1a` 交叉验证，不依赖该通道。
6. **未审 `assets/` 下随包 Python 工具内部逻辑**（除 D1 与 `qa_consensus.py` 的
   PASS 不变量外），其结论按 `docs/upstream-defects.md` 的原则以"未改动上游"对待。

---

## 九、修复优先级

**立即（破坏题目有效性或宣称与实际不符）**

1. **F2** 密钥权限：改为可证实的 ACL 收紧，或在无法收紧时**如实报告**未收紧。
2. **F1** Dockerfile 越界检测：按语法解析全部源参数，含引号/续行/`ADD`/多源。

**近期（潜伏，条件触发即误判）**

3. **F3** `listZipEntries` 改用 EOCD 锚定。
4. **F4** 双路身份改用解析后的 `(api, baseURL, model)`；同源双路显式降级标注。
5. **F5** 同步 `docs/adversarial-review.md` 的失效结论。

**低**

6. **F6** 排除名改大小写不敏感比对。
7. **F7** 删除随包 `.pyc` 并加入 `.gitignore`。
8. **F8** 快照加远端 `sha256sum` 比对。

---

*本报告全部结论基于本轮实测；每条发现的复现方式已内联，未采信任何既有文档结论作为证据。*
