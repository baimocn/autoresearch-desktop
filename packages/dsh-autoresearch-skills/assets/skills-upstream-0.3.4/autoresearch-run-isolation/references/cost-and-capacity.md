# GPU 成本与容量决策

## 不只比较表面单价

同时估算全小时制、全包日和小时 pilot + 包日正式窗口。固定成本包括 API、持久存储与传输；GPU、API 和存储分别记账。

```text
hourly_expected = hourly_price × (pilot_hours + formal_hours)
                + fixed_costs
                + reacquire_probability × reacquire_impact

daily_expected  = daily_price × ceil((pilot_hours + formal_hours) / 24)
                + fixed_costs

hybrid_expected = hourly_price × pilot_hours
                + daily_price × ceil(formal_hours / 24)
                + fixed_costs
```

`reacquire_impact` 只填写有依据的重建、重复测试、延期或错过验收窗口损失；不确定时分别计算低、中、高情景，不制造伪精确数字。

工具还输出小时制的“重获失败概率盈亏平衡点”。若对容量中断概率的保守估计高于该值，就不应因为小时单价看起来便宜而关机；若无法估计概率，至少比较“容量立即可得”和“关机后无法补测”两个边界情景。包日购买的是连续容量，不等于 24 小时都要有计算负载。

## 推荐顺序

1. 本地 CPU/MPS 或便宜小 GPU 完成构建、接口、单步训练、保存/重载和恢复检查。
2. 目标 GPU 按小时完成一对真实端到端 Baseline/Reference pilot，记录训练、评分、重载和快照时间。
3. pilot 通过且协议冻结后，才购买正式连续窗口；若关机后容量不可保证，把容量保险计入决策。
4. 小 GPU 结果不用于替代目标 GPU 的性能、峰值显存或时间门。
5. 若没有下一项能减少硬阻塞的实验，达到止损线或恢复失败，暂停新消费。

## 模型 API：套餐还是按量

先做资格判断，再比较价格。套餐必须覆盖正式运行所需的模型版本、区域、配额周期、并发、速率限制和商用/数据条款；任一不满足就选按量 API，不能用“单价更低”覆盖能力缺口。

资格都满足时，用预期正式用量而不是账户余额比较：

```text
payg = expected_units × payg_price_per_unit
plan = plan_price
     + max(0, expected_units - included_units) × overage_price_per_unit
```

- 需求尚未冻结、调用突发或只是 pilot：默认按量，先测真实 token/请求消耗。
- 双轨迹长跑且模型、并发和用量已经由 pilot 量出：超过盈亏平衡点再买套餐。
- 套餐未用完的额度、到期损失、失败重试和限流等待都记入台账；订阅额度不能跨任务冒充零成本。
- API 支出与 GPU 支出分栏。增加 API 预算不能修复低效应、错误评测或缺失证据。

运行 `python3 scripts/plan_capacity.py --help` 查看输入。提供任一 `--api-*` 参数时必须完整提供 API 比较参数；`--api-plan-fit/--no-api-plan-fit` 表示资格硬门槛。工具只做透明算术比较；库存、退款、预约、配额和报销资格仍需读取当前 provider 条款。
