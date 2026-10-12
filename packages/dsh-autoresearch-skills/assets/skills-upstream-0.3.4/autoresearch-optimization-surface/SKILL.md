---
name: autoresearch-optimization-surface
description: 从论文、代码和评测资源中筛选 AutoResearch 优化面，排除纯调参、不可隔离、不可复算或收益不足的方向，并产出可验证题目合同。用于选优化面和更换失败方向。
---

# AutoResearch 优化面选择

阅读 [selection-gates.md](references/selection-gates.md)，并对每个候选给出代码入口、Baseline、可改方法族、主指标、质量门、成本和证据来源。

优先选择能够修改算法或计算图、可由固定接口承载、能用成对实验复算的方向。单纯学习率、epoch、阈值或常量搜索不作为方法级优化面；只有当题目开放了产生新方法的实现接口时，参数可以是方法的一部分。

先用最小真实实验验证：Baseline 正常、Reference 有稳定正向改善、质量门不过拟合单一 seed、逐条件代价在预算内。任何一项不成立就换方向，不用长轨迹掩盖不可行题目。

最终输出一个推荐方向和最多两个备选；推荐必须说明为什么它比备选更安全，以及失败时的退出条件。
