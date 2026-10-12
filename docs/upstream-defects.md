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
