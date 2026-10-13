# L3 演练记录：真实上游比对

> 目的：验证「发现 → 评估 → 接受」闭环能否在**真实上游更新**上工作。
> 结论先行：**上游比对路径已验证可用；本次实测无漂移；但演练暴露出一个
> 与漂移无关的严重问题（隐私泄露），以及 0.3.8 来源 UNKNOWN。**

---

## 一、演练对象

| 项 | 值 |
|---|---|
| 上游仓库 | `bosprimigenious/autoresearch-skills`（公开） |
| 上游 VERSION（实测） | `0.3.4` |
| 本地 vendored VERSION | `0.3.4` |
| 比对方法 | `gh api` 拉取上游文件字节，与本地逐字节 SHA-256 比对 |
| 脚本 | `scripts/l3-rehearsal.mjs` |

用户指出上游**实际已到 0.3.8**。我未能定位该来源：
公开 GitHub 仍为 0.3.4；本地 `_extract/autoresearch-skills-main` 为 0.3.4；
教程附件为 0.3.2；`论文评测任务` 下的发布物（manifest/sha256/zip）均为 0.3.4。

**因此 0.3.8 的获取方式记为 UNKNOWN，等待来源确认。**
这不影响本轮对「比对机制本身」的验证结论 —— 机制已用真实上游跑通。

---

## 二、比对结果

```
上游 VERSION：0.3.4
本地 VERSION：0.3.4

一致：9 个脚本（逐字节相同）
  implementation_review.py / audit_task.py / qa_consensus.py
  content_gates.py / harbor_review.py / docker_paths.py
  submission_format.py / audit_collection.py / aggregate_qa_reports.py

SKILL.md：8 个全部逐字节相同
技能目录：上游 8 个 vs 本地 8 个，无新增、无缺失
内容不同：0
本地缺失：0
拉取失败：0
```

**结论：本地 vendored 0.3.4 与当前公开上游完全同步。**
这不只是"没报错"，而是 17 个文件的 SHA-256 逐一比对相同。

### 上游有而我们没有的工具脚本（9 个）

这些是仓库级 `scripts/`，不属于 task-qa 技能，因此未被纳入比对：

```
build_qa_release.py       6982   构建发布包
privacy_scan.py          14041   公开前隐私扫描（fail-closed）
sync_formats.py           2706
validate_route_evals.py   3544
validate_skills.py        1765
verify_skill_archive.py   3363   校验可分发 skill ZIP 结构契约
test_privacy_scan.py      7769
test_release_infra.py     3869
test_sync_formats.py       986
```

---

## 三、演练暴露的真实问题：公开仓库隐私泄露

这是本轮**最重要的发现**，且与上游漂移无关。

我把上游的 `privacy_scan.py` 拿来跑在**已发布的公开仓库**上：

```
FAIL: 45 privacy finding(s); matched values and sensitive locations were suppressed
exit=1
```

其中我人工检查**完全漏掉**的两类：

### 1. PRIVATE_COLLAB_URL —— 4 个字节跳动内网文档链接

```
https://bytedance.larkoffice.com/docx/DJhEdv0oTod4sExGgu6cp00onHg     (2 文件)
https://bytedance.larkoffice.com/docx/P1J5dgIw1oKchcxn29GcvzlMnSd   (7 文件)
https://bytedance.larkoffice.com/wiki/A7FUwJBALici6Gku3rWc4EsinLf    (4 文件)
https://bytedance.us.larkoffice.com/docx/Th1ydNXiXoa59lxJrg0uYSnlsdc (3 文件)
```

关键事实：**上游公开仓库里没有这些链接**（实测确认）。
它们只存在于教程附件 0.3.2 那一份。也就是说，这 11 个文件里的内网链接
是我们这份公开仓库**独有**的暴露。

归属：教程附件 0.3.2 = 11 个文件；上游 0.3.4 = 2 个（仅 `feishu-three-table`
的技能名本身含 feishu，不含内网 URL）。

### 2. PRIVATE_IPV4 / SENSITIVE_FILENAME

`permission-scan` 另报了内网 IPv4 与敏感文件名各若干。

### 3. CREDENTIAL_ASSIGNMENT（26 处）

绝大多数是**变量名赋值**（如 `process.env.X_API_KEY = ...`）与文档示例，
属于扫描器的保守报法，不是真密钥。这类需要逐项判断，不能一律视为泄露。

---

## 四、我的人工检查为什么漏了

上一轮我做的检查是：

- 找 `credential|.env|secret|token` 命名的文件
- 拿本地真实密钥值做全文匹配
- 检查 `.dsh-home` 是否被跟踪

这三项都能过，因为**泄露的不是密钥，是内网地址**。
我的检查清单里根本没有"内网 URL / 协作平台链接"这一类。

这正是 L3 演练的价值：**用别人的工具检查自己的盲区**。
`privacy_scan.py` 覆盖的类别（内网路径、私钥、JWT、bearer、
协作 URL、邮箱、二进制串、归档内部）比我的手工清单完整得多。

---

## 五、处置建议（待用户决定）

| 选项 | 影响 |
|---|---|
| 从公开仓库删除这些链接 | 保留文档结构，改占位符；改动 vendored 副本字节 |
| 保留不动 | 内网文档地址公开可见 |
| 把 0.3.2 附件排除出公开仓库 | 会丢掉权威判据口径的参考副本 |

**已采纳**：`privacy_scan.py` 带入随包工具并接进检查链（用户已确认）。

---

## 六、演练副产品：采纳上游工具时发现并修掉的 3 个真实缺陷

L3 演练的价值不止于"确认同步"。把上游工具纳入本仓的过程，暴露了三个
我自己的缺陷 —— 这些缺陷在"只看不接"的状态下永远不会显形。

### 缺陷 A：`resolveUpstreamAsset` 对 undefined 逻辑名崩溃

新增来源 `upstream-tools-0.3.4` 后，`npm run upstream:check` 直接抛
`TypeError: The "path" argument must be of type string`。

根因：`drift.js` 的 `probeCapabilities` 遍历**全部** `UPSTREAM_SOURCES`，
用 `REVIEW_SCRIPT[sourceId]` 查该来源的复核脚本名。查表没有新来源，
得到 `undefined`，而 `resolveUpstreamAsset` 直接把它喂给 `join()`。

修法（低耦合，不动调用方）：`resolveUpstreamAsset` 在入口处判定
`typeof logical !== 'string'` 即返回 `null`。理由：调用方用查表形式是
合理的写法，"表里没有"是正常情况而非异常，不应让整个检查链崩掉。
同时给 `root` 也加了类型判定。

### 缺陷 B：「不适用」被误报成「能力退化」

修掉 A 之后，检查报出一个**假**的不符项：

```
upstream-tools-0.3.4 / (resolve)：声明=true 实测=false
```

原因：仓库级工具来源本来就不提供 `implementation_review.py`，
但 `upstream-baseline.mjs` 把所有 `resolved: false` 一律当成能力不符。

这是**误报**，而且危害不小 —— 假的不符项会淹没真信号，让人逐渐
忽略这条检查。修法：`probeCapabilities` 对无复核脚本的来源返回
`notApplicable: true`，基线脚本跳过它。语义上把
「该来源不适用」与「该来源能力变了」彻底分开。

### 缺陷 C（自我审查发现）：新采纳的资产没进漂移基线

我把 `privacy_scan.py` 带进仓库并注册成工具，但**忘了把它加进
`MONITORED_ASSETS`**。基线仍是 15 项，新资产不受监控。

也就是说：我采纳了一个防止"静默沿用旧判据"的工具，
却没有把**它自己**纳入防静默机制。这类错误靠读代码很难发现，
是靠"改完再跑一遍数一下基线项数"发现的 —— 15 而不是预期的 17。

修法：补进 `MONITORED_ASSETS`（role 分别为 `privacy-gate` 与
`archive-contract`），基线重写后为 **17 项**。

---

## 七、本轮结论

**已验证**
- 上游比对机制在真实上游上跑通，17 个文件逐字节比对
- 本地 0.3.4 与公开上游完全同步（9 脚本 + 8 SKILL.md 全同）
- 漂移检测在新增资产后仍为 IN_SYNC / exit 0
- 采纳的 `privacy_scan.py` 自带 11 项上游测试全部通过

**已发现并修复（真实缺陷）**
- 公开仓库暴露 4 个内网协作 URL（上游无此暴露）—— **待处置，见 §五**
- 我的人工隐私检查清单不完整（缺"内网地址"这一类）
- 缺陷 A / B / C，见 §六

**UNKNOWN**
- 0.3.8 的来源与内容 —— 用户告知已存在，但我无法定位
- 因此「本地是否落后于 0.3.8」**无法判定**，不得记为同步
- 公开仓库内网链接的可访问性未验证（需登录态才能确认是否匿名可读）
