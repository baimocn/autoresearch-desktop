# dsh-autoresearch-autodl

AutoDL 算力接入：账户/实例/镜像查询、带预算护栏的全自动开关机与租约回收。

## 它和「内场」是两件事

| | 内场（Harbor 正式评分） | AutoDL（本包） |
|---|---|---|
| 卡型 | 只接受 H20 / L20（QA15） | H800 / 4090 / PRO6000 等都能租 |
| 用途 | 正式评分，不可妥协 | 专家探索、预跑、依赖验证 |
| 门禁 | QA15 / 红线 | 本包不参与内场门禁 |

把两台机器混为一谈是这层设计里最想避免的错误。

## 工具（14 个）

| 工具 | 读/写 | 说明 |
|---|---|---|
| `autoresearch_autodl_account` | 读 | 余额（元）+ 累计消费 + 实例概览 |
| `autoresearch_autodl_instances` | 读 | 实例列表（状态、GPU、到期） |
| `autoresearch_autodl_specs` | 读 | 可租 GPU 规格、数据中心、创建参数约束（无需 token） |
| `autoresearch_autodl_images` | 读 | 自定义镜像 |
| `autoresearch_autodl_snapshot` | 读 | 单实例详情（SSH、价格、资源）；**SSH 密码不回显** |
| `autoresearch_autodl_leases` | 读 | 租约账本：本平台开过哪些实例、是否超期 |
| `autoresearch_autodl_estimate` | 读 | 创建前估算费用（纯本地计算） |
| `autoresearch_autodl_reconcile` | 写账本 | 核对账本与云端漂移 |
| `autoresearch_autodl_reap` | 写云端 | 回收超期实例（默认只关机；`dry_run` 预演） |
| `autoresearch_autodl_create` | 写云端 | 创建实例（**需显式 `confirm:true`**，先过预算护栏） |
| `autoresearch_autodl_power` | 写云端 | 开机 / 关机 |
| `autoresearch_autodl_release` | 写云端 | 释放（**不可恢复**，需显式 `confirm:true`） |
| `autoresearch_autodl_save_image` | 写云端 | 保存当前环境为镜像 |
| `autoresearch_autodl_cost` | 读 | 单实例实时成本 |

## 全自动的安全边界

「全自动」的钥匙不是「能开」，而是「保证会关」。三道护栏：

1. **预算护栏**：创建前按 `pricePerHourYuan × hours` 估算，超过 `maxTotalYuan`（默认 20 元）直接拒绝。
   官方文档**没有写明** `payg_price` 的计费时长单位，所以单价必须由使用者按自己的账单口径填 —— 宁可拒绝也不猜一个数字去放行。
2. **租约账本**：每次创建先写租约（含到期时间）再调 API，落盘 JSON。进程崩溃后租约还在，可被回收。
3. **回收**：`reap` 默认只**关机**（保留磁盘）；`release` 会删数据，必须显式确认。

## 配置

token（二选一）：
- 环境变量 `AUTODL_TOKEN`
- `.dsh-home/.autodl.json`：`{"token": "..."}`（该目录已被 gitignore）

策略（cordis 配置）：`leaseFile`、`maxTotalYuan`、`pricePerHourYuan`、`reapMode`、`defaultGpuSpec`。

## API 端点以官方文档为准

端点清单集中在 `lib/client.js` 的 `ENDPOINTS`。真实路径带 `pro` 段
（`/api/v1/dev/instance/pro/list`），早期按直觉命名全部 404 —— 别再猜。
两个容易踩的形状：GET 接口也要带 JSON body；HTTP 200 里可能是
`code != "Success"`（必须判 `code`，不能只看 `response.ok`）。

自测：`node scripts/selftest-integrations.mjs`（本地层必跑，线上层有 token 才跑）。
