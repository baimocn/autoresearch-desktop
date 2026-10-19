# 上游工具缺陷记录

本文件记录随包分发的第三方工具中**已确认的缺陷**。原则：

- **不修改上游文件**。随包脚本与上游逐字节相同，改动会破坏来源可信性与可追溯性。
- **如实记录**，包含复现步骤、独立证明与影响范围。
- **在本实现内规避**：可判定部分用正确的 JS 实现，并把权威归属显式声明。
- 使用这些工具时，若结论与本文档冲突，**以本文档的独立证明为准**。

---

## D1：`feasibility_gate.py` 的 Baseline 可达区间端点颠倒

**文件**：`packages/dsh-autoresearch-gates/assets/sop/tools/feasibility_gate.py`
**来源**：`autoresearch-sop-master/tools/feasibility_gate.py`（逐字节未改动）
**严重程度**：高 —— 门① 在主路径上恒判失败

### 复现

```bash
python feasibility_gate.py --from-probe --b 0.16 --r 0.145 --u 0.10
```

输出：

```
【门 ①】Reference 归一化 R_norm = (B−R)/(B−U) 需在 [0.15, 0.80]
  R_mean = 0.1450（n=1）
  ⇒ 为使 R_norm∈[0.15,0.80]，需要 B_mean ∈ [0.3250, 0.1529]
  当前 B_1 = 0.1600 → ✗ 不在区间内
     差距：需要 B 再高 0.1650（相对 51%）
```

### 独立证明

按教程公式直接手算，不依赖任何一方实现：

```
R_norm = (B − R) / (B − U)
取 R=0.145, U=0.10, B=0.16：
  R_norm = (0.16 − 0.145) / (0.16 − 0.10) = 0.015 / 0.060 = 0.25
  0.15 ≤ 0.25 ≤ 0.80  ✓ 实际在区间内
```

暴力扫描合法区间（步长 1e-5）：

```
合法 B 区间（升序）= [0.15295, 0.32500]
```

工具打印的区间是 `[0.3250, 0.1529]` —— **端点颠倒**。

### 根因

缺陷在第 98 行：

```python
b_lo, b_hi = B_for(R_HI), B_for(R_LO)     # k 越大 B 越小
```

其中 `B_for(k) = (R − k·U) / (1 − k)`。

对 k 求导：

```
d/dk [(R − kU)/(1 − k)] = (R − U) / (1 − k)²
```

正常 minimize 配置满足 `U < R`（U 是可达下限，R 是参考解，必高于 U），
因此 `R − U > 0`，导数**为正** —— k 越大 B 越大。

于是 `B_for(R_LO) < B_for(R_HI)`，正确的赋值应是：

```python
b_lo, b_hi = B_for(R_LO), B_for(R_HI)
```

作者的注释「k 越大 B 越小」在 `R < U` 时才成立，而那种配置本身是非法的
（U 高于 R 意味着参考解比可达下限还差）。

### 影响范围

门① 的区间检查 `b_lo <= B_1 <= b_hi` 在端点颠倒后变成
`0.325 <= B_1 <= 0.153`，**恒为假**。实测四种正常配置全部误判：

| U | R | B | 工具判定 | 实际 |
|---|---|---|---|---|
| 0.10 | 0.145 | 0.16 | ✗ 不在区间内 | ✓ R_norm=0.25 |
| 0.05 | 0.12 | 0.15 | ✗ 不在区间内 | ✓ R_norm=0.30 |
| 0.20 | 0.30 | 0.40 | ✗ 不在区间内 | ✓ R_norm=0.50 |
| 0.01 | 0.02 | 0.03 | ✗ 不在区间内 | ✓ R_norm=0.50 |

后果：**所有 minimize 任务都被判「结构性不可行」**，包括本可做的题。
按工具的建议动作，使用者会去「重做指标设计 / 换论文」，而问题其实在工具本身。

### 本实现的处理

`packages/dsh-autoresearch/lib/gates.js` 的 `reachableBaselineRange` 是独立实现，
按同一公式推导但**不复制端点的赋值顺序**，用 `Math.min/Math.max` 显式排序：

```js
const lo = Math.min(first, second)
const hi = Math.max(first, second)
```

验证：对上述四组配置，本实现的门① 均正确判为通过。

同时 `G-FEASIBILITY` 的权威归属仍标为 `python`（尊重上游设计意图），
但 `note` 字段说明「本实现额外校验 U 的方向一致性」，并在本文档记录该分歧。

### 建议

上游修复只需交换一行：

```python
- b_lo, b_hi = B_for(R_HI), B_for(R_LO)     # k 越大 B 越小
+ b_lo, b_hi = B_for(R_LO), B_for(R_HI)     # R > U 时 k 越大 B 越大
```

修复前，使用该工具做 minimize 判定时**不应采信门① 的结论**。

### D1 现状（2026-10-14 复核）

仍未修复。复核命令与输出：

```bash
python feasibility_gate.py --from-probe --b 0.16 --r 0.145 --u 0.10
  ⇒ 为使 R_norm∈[0.15,0.80]，需要 B_mean ∈ [0.3250, 0.1529]   ← 端点仍颠倒
```

`scripts/selftest-feasibility-direction.mjs` 的向后兼容节把它的行为**钉住**了：
那些用例的断言是「与 git HEAD 逐字节一致」而不是「判定正确」—— 所以 D1 若被
修掉，那个测试会失败并提醒复核，而不是静默改变语义。

---

## D2：`feasibility_gate.py` 把 minimize 口径写死，maximize 指标符号全反

**文件**：`packages/dsh-autoresearch-gates/assets/sop/tools/feasibility_gate.py`
**来源**：**本仓自有资产**（`upstream-baseline.json` 里 `source: "own-assets"`，
不是第三方上游文件）—— 因此本仓**可以直接修**，与 D1 的处置方式不同。
**严重程度**：高 —— 所有 maximize 指标被误判为「结构性不可行」，实测已导致
AutoRe1841 的 G-FEASIBILITY 在工具路径上永远过不了。

### 复现

```bash
python feasibility_gate.py --from-probe \
  --b 41.25,42.01,40.49 --r 50.09,51.39,48.57 --u 52.296667
```

输出（错误）：

```
【门 ①】… R_norm = (B−R)/(B−U) …
  ✗ B=41.2500 ≤ U=52.2967：U 必须严格小于 B（否则分母非正）
【门 ②】Δ = B_mean − R_mean 需 ≥ 3.0σ_B
  Δ=-8.7667  → ✗ 不足 （Δ/σ_B = -11.54）
【结论】✗ 不可行（结构性）
```

### 独立证明

该题 `tests/hidden_assets/anchors.json` 是评分锚点的规范落点，独立记录：

```
direction = "maximize"
Δ = 8.766667      delta_in_sigmas = 11.5351     （工具报 -8.7667 / -11.54）
reference_normalized = 0.793603 ∈ [0.15, 0.8]
headroom_satisfied = true
```

按 maximize 口径手算：`R_norm = (R−B)/(U−B) = (50.0167−41.25)/(52.296667−41.25)
= 8.7667/11.0467 = 0.7936` ✓。工具把符号整体取反了。

### 根因（两层，都不在"有人写错了一行"这个层面）

**第一层：脚本从一道 minimize 题里长出来，只见过那一种口径。**

脚本头注写明来源是 2026-10-07 的 AutoRe0566 实战（那次白烧 530 元）。
而 AutoRe0566 的指标是 `StatErr`——**误差，越小越好**，即 minimize。
脚本把那次事故的算式固化成判定：门① 用 `(B−R)/(B−U)`、门② 用 `Δ=B−R`、
以 `B ≤ U` 为硬失败。这三处都是 minimize 口径的**具体写法**，
不是参数化的 `direction` 分支。上游 master 原版里 `direction` 一词
出现 **0 次** —— 它压根没有方向概念。

所以脚本不是"默认 minimize"，而是**只会 minimize**。`--direction` 是我加的，
加的默认值必须等于"原来唯一会做的那件事"，否则就是静默改变既有题目行为。

**第二层：JS 侧的 `maximize` 默认来自归一化分数的定义，与脚本的"原始指标"是两个层次。**

这条是矛盾真正难解的原因。SOP SKILL.md 规则 3 与 scaffold 模板都把
`direction: "maximize"` 写成默认，因为**归一化后的 `score` 按定义就是越大越好**：
`score = (x − B)/(U − B)`。

而 `feasibility_gate.py` 处理的是**归一化之前的原始指标**（误差、损失等，
越小越好）。同一道 AutoRe0566 的元数据把这件事写得非常清楚：

```
task.toml      : metric = "score"            metric_direction = "maximize"
expert_annotation: metric_direction = "minimize（原始指标）；[task].metric=score 归一化后 maximize
```

**两个默认值各自都对，只是量的不是同一个东西。** JS 门禁读 `anchors.json`
的 `direction`（描述归一化 score），Python 脚本被喂进原始 B/R/U
（描述原始指标）—— 两层之间差一次方向翻转，而**没有任何东西在两边之间做映射**。
这就是矛盾的来源：不是谁写错了，是两层口径被当成了同一层。

**加剧因素**：`authority: 'python'` 的声明在 `lib/gates.js:1267` 的 GATES 注册表里
（**不在** `lib/tools.js`；我第一版 D2 写错了位置，已更正）。
它让"以 Python 为准"看起来是既定事实，而 Python 那边只会 minimize。
加上全仓库当时**零测试**覆盖该脚本，这个矛盾长期无人发现。

### 为什么这个矛盾难以"改个默认值"解决

把任一侧默认改成另一侧，都会**静默反转**既有题目：

- 脚本默认改 `maximize` → 所有 minimize 题（如 AutoRe0565）符号全反。
- JS 默认改 `minimize` → 所有归一化 score 题（AutoRe0566 / auto2604 等）符号全反。

而且两处默认值**各自都有正当理由**，见上。所以正确处理不是统一默认值，
而是**让方向来自题目元数据**（下一节），并在读不到时如实告警而不是猜。

### 本实现的处理（已修，非规避）

1. 脚本新增 `--direction {minimize,maximize}`，**默认 `minimize`**；
   minimize 分支算式、文案、退出码**逐字节不变**（有回归测试钉住）。
2. `buildArgv` 透传该参数，且**只在显式 `maximize` 时**才传 ——
   缺失/null/minimize 一律不传，argv 与改动前逐字符相同。
3. 方向改为**从题目元数据派生**，不再依赖调用方记忆。关键是**必须落在
   「原始指标」那一层**（见根因第二层）：只认描述原始指标的来源，顺序为
   `tests/hidden_assets/anchors.json` → `optimization_evidence/comparison_summary.json`
   （要求其 `metric` 不是 `"score"`）→ `expert_evidence/expert_annotation.json`
   的 `metric_direction`（取其开头字面量，容忍带解释的长串）。
   两处都读不到就**不猜**，并在工具报告里明确写出「方向未声明，结果可能
   符号全反」（这一行已实测）。
4. `collectFromTask` 补上 `G-FEASIBILITY` 分支（此前**完全没有**，
   `fromTask: true` 喂进去的是空 payload，方向永远到不了门禁）。
5. `lib/tools.js` 原先登记的 `parameters` 字段**没有任何消费者**（死数据）；
   `autoresearch_gate_env` 这个被两处文案指向的工具**从未实现**。
   两者一并补上，方向参数才真的可被模型发现。

回归测试：`scripts/selftest-feasibility-direction.mjs`（50 项，接入 `npm run check`）。

#### 实现过程中我自己踩的坑（记下来，因为它是这个缺陷的浓缩版）

方向派生的**第一版**我读的是 `[task].metric_direction`。对 AutoRe1841 没问题，
但一测 AutoRe0566 就露馅了：派生出 `maximize`，而那道题的原始指标是
**minimize 的 StatErr** —— 正好相反，而且它恰恰是脚本诞生的那道题。

原因就是根因第二层说的：`[task].metric = "score"` 时，同一行的
`metric_direction` 按题目自己的注释是「固定 maximize」，是个**恒真式**。
读它等于把「归一化 score 越大越好」这件定义当成了「原始指标越大越好」的
证据。现在要求方向与原始指标同层，并把 AutoRe0566 作为负向用例钉进测试。

### 仍未解决的一点（如实声明）

两处**默认值互相矛盾**：脚本默认 `minimize`，`gates.js` 默认 `maximize`。
现由「元数据派生 + 未声明时如实告警」兜住，但若某题元数据缺失且调用方不声明，
两条路径仍会得出相反结论。彻底解决需要统一默认值或让元数据成为必需项 ——
那会反转既有题目的行为，**不宜静默改动**，故如实留在此处。

## W3：webserver 把路由抛错一律吞成 400 空响应

**现象**：connection fetch 路由内任何异常 → webserver 层 `res.writeHead(400)`
无响应体（`packages/host/webserver/src/index.ts` 的 per-request catch）。
插件里 `Response.json({error}, {status:400})` 之外的一切抛错（包括携带
status 的业务错误）到浏览器都成了「400 + 空 body」。

**影响**：错误信息只在 harness 服务端日志里；浏览器侧 `response.json()`
解析空串抛 "Unexpected end of JSON input"，真实原因不可见。

**处置（本项目）**：路由内不抛业务错误，一律 return JSON 错误响应。
`resolveTaskRoot` 已改为返回 null、调用点显式回错。上游若把 per-request
catch 改为透传 handler 的 Response 或至少带上 message，可让所有插件受益。

---

## D3：G-SELECT 的 G0.10 用裸百分比判优化空间（负值有界指标失效）

**文件**：`packages/dsh-autoresearch/lib/gates.js`（G0.10）
**来源**：本仓自有资产（JS 门禁实现）
**严重程度**：中高 —— 合法题目被**永久阻塞**在 intake，且唯一"绕开"方式是伪造 `deltaPercent`
**报告**：由出题方 auto2604 于 2026-10-16 提交（附平移不变性论证与复算脚本）

### 缺陷

G0.10 只比较裸百分比 `deltaPercent < 10`，未考虑指标值域：

```js
if (Number.isFinite(deltaPercent) && deltaPercent < 10) {
  checks.push(unknown('G0.10', `声称增益 ${deltaPercent}% < 10%，可能无足够优化空间`, ...))
```

对**负值有界**指标（连续控制回合回报，取值 −∞…0，越接近 0 越好）该口径失真：

- 优化空间 = 「从 B 到 U 走完了多少」= `(R−B)/(U−B)`，分母是**方法到上限的距离**。
- 裸百分比的分母是 `|B|`，即「基线离 0 多远」—— 由回报参考点/归一化常数决定，
  **与方法能提升多少无关**。

**平移不变性检验**（对同一任务做 `B→B+C`，与优化空间完全无关的重参数化）：

| C | B | 裸百分比 | R_norm | 旧判定 |
|---|---|---|---|---|
| 0 | −249.25 | 7.10% | **0.599** | ❌ UNKNOWN |
| 100 | −149.25 | **11.86%** | **0.599** | ✅ PASS |
| 200 | −49.25 | 35.94% | **0.599** | ✅ PASS |

优化空间自始至终没变（R_norm 恒 0.599），结论却翻转 —— 证明旧判据测的是
「参考点离 0 多远」。**同一文件的 M2 门 G1.6 用的是 `R_norm ∈ [0.15, 0.8]`（正确、量级无关），
两个里程碑对同一语义用两套不相容口径。**

### 权威侧本来就不阻塞（这是修法的依据）

`paper_screen.py` §三 2001 同构标准把这条记为 **WARN**，而 WARN **不参与退出码**
（只有 `FAIL→rc=1`、`MANUAL→rc=2`）。即权威不因增益 7.1% 阻塞；
JS 却把它升级成阻塞性 UNKNOWN（UNKNOWN 与 FAIL 在 `advanceState` 眼里一样拦）。

### 修法

G0.10 改为**优先用与 G1.6 一致的归一化/σ 判据**：

1. 有 `baseline/reference/upper` → 按 `R_norm ∈ [0.15,0.8]`（可叠 `sigmaMultiple ≥ 3σ`）；
   方向与 U 的关系不自洽时**不在此处重复报错**（那是 G1.5 的职责）。
2. 只有 `sigmaMultiple` → 按 σ 判据（量级无关）。
3. 都没有 → 回退百分比，但**如实标注为粗判**，且 `≥10%` 也只说明"粗判通过"，
   不宣称"空间充足"。

端到端实测：auto2604 由 `NEEDS_EVIDENCE` → **`RECOMMEND`**，
G0.10 detail 为 `R_norm=0.5990 ∈ [0.15, 0.8]，Δ=26.7σ_B ≥ 3σ`。

回归测试：`scripts/selftest.mjs` 新增 6 项（含平移不变性、方向配错不重复报错、
回退口径标注、正基线行为不变）。`scripts/selftest-feasibility-direction.mjs` 新增 10 项。

### 未做（如实声明）

`collectFromTask` **没有 G-SELECT 分支**，因此 `fromTask: true` 不会自动带上
`baseline/reference/upper/sigmaMultiple` —— 调用方仍须显式传这些字段才能走归一化口径。
auto2604 的 B/R/U 目前只存在于 `intake_checklist.json` 的**散文**里
（`_evidence/pde_gain_summary.py` 只打印不落 JSON），没有机器可读落点，
所以平台无法代它派生。**给 B/R/U 一个机器可读的规范落点**
（例如 `optimization_evidence/gain_evidence.json`）是下一步，
但那需要先定 schema，不在本次修复范围。

---

## D4：`paper_screen.py` 死因3 在负基线下增益符号翻转

**文件**：`packages/dsh-autoresearch-gates/assets/sop/tools/paper_screen.py`
**来源**：**本仓自有资产**（`upstream-baseline.json` 里 `source: "own-assets"`），可直接修
**严重程度**：高 —— 所有负基线题目**恒判 FAIL 并给出"直接弃题建议"**

### 缺陷（第 123 行原式）

```python
abs_gain = args.reported_baseline * args.delta_percent / 100.0
```

基线为负值时该式得到**负的增益**，于是 `gain_from_community = abs_gain - gap` 恒 ≤ 0
⇒ `verdict = "FAIL"`，并额外输出「★ 直接弃题建议」。**与增益大小完全无关。**

实测 auto2604：`B=−249.25`、`R=−231.55`，真实增益 `+17.70`，原式算出 `−17.70`，
于是报「扣除 baseline 低估后增益 ≤ 0 → 该题不可做（1851 同款死因）」。

### 修法与兼容性

```python
abs_gain = abs(args.reported_baseline) * args.delta_percent / 100.0
```

取 `|baseline|` 对**正基线不改变任何数值** —— auto1851 那类既有判例
（论文 baseline 被低估 23.8）逐字节不变，已用测试钉住。

修复后 auto2604：`FAIL=2 → FAIL=0`，增益显示 `+17.7`，退出码 `1 → 2`（仅剩 MANUAL 的 trivial 基线待实查）。

### 这条缺陷报告**没有**提到

报告只点了 JS 侧 G0.10，未提 `paper_screen.py` 的同一类问题。
但通过工具接口调用时，**先把题目拦死的是这一条**（rc=1 + 弃题建议），
G0.10 只是次级阻塞。两者都已修。

---

## D5：G-PACK-VERIFY 的 G14.1–G14.3 恒真 PASS（空集上的假绿灯）

**文件**：`packages/dsh-autoresearch/lib/gates.js`（G14.1–G14.4）
**来源**：本仓自有资产（JS 门禁实现）
**严重程度**：高 —— **恒真检查**，比 FAIL 更危险：FAIL 促使人排查，假绿灯让人以为已验证
**报告**：由出题侧 AutoRe1841 于 2026-10-16 提交（编号 DSH-AR-2026-1016-01）

### 缺陷

`gatePackVerify` 的三项判据全部依赖入参，而入参默认空：

```js
const { sourceHashes = {}, packedHashes = {}, forbiddenEntries = [] } = input
const missing = sourcePaths.filter(...)   // 空 ⇒ []
checks.push(missing.length === 0 ? ok('G14.1', `交付包含全部 ${sourcePaths.length} 个文件`) : ...)
//                                            报告里写着「交付包含全部 0 个文件」
```

而 `sourceHashes`/`packedHashes`/`forbiddenEntries` **从来没有任何调用方构造过**
（全仓 grep 仅命中 gates.js 自身与一处测试），`collectFromTask` 的
G-PACK-VERIFY 分支不返回它们，工具 schema 里也没有传 ZIP 路径的参数。
三重缺失叠加 ⇒ 空集 ⇒ 三项一起 PASS。

**最小复现：空任务根（甚至不存在的路径）也全 PASS。** 已实测。

后果：本仓真实发生过 `*.preM5` 备份文件经目录级 COPY 进 Agent 镜像、
又被打包脚本打进交付 ZIP 的事故，而这道门（含 G14.4）**全程未报警一次**。

### 修法（报告 §5.1–5.3 全部采纳）

1. **空集不得判 PASS**（最关键，§5.3）。三项改为：任一哈希集合为空 ⇒ **UNKNOWN**，
   并在 detail 里区分「源哈希为空」与「包哈希为空」两种不同缺失。
   G14.4 同理 —— 只有**两侧都没扫**时才 UNKNOWN（禁止项是从实际扫描得来的，
   扫过没命中才算真干净）。
   > SOP 的口径是「UNKNOWN ≠ FAIL」，但空集更不等于 PASS：
   > 一个没有任何检查对象的检查必须报 UNKNOWN，让「没验」显式可见。

2. **补 `fromTask` 输入**（§5.1）。新增 `lib/pack-scope.js`：
   - `collectSourceHashes`：按三个交付目录采集逐文件 sha256
   - `collectPackedHashes`：按字节解析 ZIP 中央目录并逐条目复算（不调外部解压工具）
   - `findDeliveryZip`：只找任务根**一层**内的唯一 .zip（**不递归** ——
     递归会把 `_data/` 下的数据集 zip 误当交付包，那种误判比「找不到」危险）
   - `forbiddenReason`：缓存/临时/备份残留判定，含 `*.preM5` 这一**真实事故指纹**

3. **加 `artifact` 工具参数**（§5.2）并透传到 `collectFromTask`。

4. **采集失败与空集分开报**：新增 `G14.0`，采集过程出错时显式报 UNKNOWN，
   避免混进交付物结论里让人查错方向。

### 采集范围（报告 §6 的那个决策点）—— 已用真实数据核定

范围取自 AutoRe1841 实际使用的打包脚本 `_m5_pack_submission.py`：

```
DELIVER = ["workspace", "expert_evidence", "optimization_evidence"]
```

排除项也逐条对齐（`__pycache__` / `.pytest_cache` / `.ipynb_checkpoints` 等目录、
`.DS_Store` / `Thumbs.db` / `desktop.ini` 文件、`.pyc` / `.pyo` 后缀）。

**不采用「任务根全量」**：任务根还有 `_evidence/`、`_probe_kit/`、`_m5_stage/`、
`_data/` 等私有工作目录，它们不进交付包也不该进。用全量当基准会让每道题都产生
大量「合理但无解」的 FAIL。该题自带的独立校验器也正是按两个域分别比对，
其 `deliver` 域报 **202/202 完全一致** —— 与本次实现吻合。

### 端到端实测（AutoRe1841，交付 ZIP 96 MB）

```
sourceHashes: 202 | packedHashes: 202 | forbidden: 0

PASS  G14.1  交付包含全部 202 个文件
PASS  G14.2  交付包无额外文件（比对 202 个源文件）
FAIL  G14.3  3 个文件哈希不一致：m5_handoff_pending_platform.md,
             m5_independent_pack_verify.json, trajectory_codex.json
PASS  G14.4  无缓存/临时文件残留（已扫 202 个源文件与 202 个包内条目）
```

**G14.3 的 FAIL 是真发现，不是误报**：ZIP 构建于 11:47:08，
而那三个文件在 11:47:10 / :18 / :36 又被改写 —— **包已过期**。
独立校验器在 11:47:10 跑过并报 202/202（当时确实一致），此后文件才变的。
这正是这道门存在的意义：报告 §1 说「从未报过警」，现在它真的报了，
而且报的是真实差异。

### 回归测试

`scripts/selftest-pack-verify.mjs` —— 64 项，接入 `npm run check`。
覆盖报告 §5.4 的 T1–T5，外加：
- 空集必须 UNKNOWN（含空任务根走完整 fromTask 路径）
- 只有源哈希/只有包哈希两种半边情形
- 禁止项识别（含 `*.preM5` 真实事故指纹、`.bak`/`.orig`/`~` 同类风险、正常文件不误报）
- ZIP 查找只在一层内、多 zip 时不猜、显式 artifact 优先
- **自建样本的打包→复算往返**（不依赖用户数据）：哈希三项 PASS 且
  G14.4 对缓存残留 FAIL，证明两类判据互不掩盖
- 非 ZIP 文件如实抛错，不静默当空集（那会变成假 PASS）
