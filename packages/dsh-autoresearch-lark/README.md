# dsh-autoresearch-lark

飞书集成：题包状态 / 门禁结论 / 双轨轨迹 → 多维表格三表；群通知；CLI 逃生舱口。

## 三张表，为什么拆三张

与 `autoresearch-feishu-three-table` skill 的划分一致，按**更新频率**分：

| 表 | 一行代表 | 更新时机 |
|---|---|---|
| 任务 | 一个题包 | 阶段推进（按任务ID upsert，同一任务只一行） |
| 门禁 | 一次门禁结论 | **追加**（「上次为什么没过」不能被覆盖） |
| 轨迹 | 一条轨道的轮次摘要 | 追加 |

## 工具（6 个）

| 工具 | 说明 |
|---|---|
| `autoresearch_lark_status` | 授权状态 + 已配置三表 |
| `autoresearch_lark_provision` | 创建三表 Base，返回要写进配置的 token 与表 id |
| `autoresearch_lark_sync` | 把一个题包同步进三表（任务 upsert，其余追加） |
| `autoresearch_lark_records` | 读回记录（核对同步是否真的写进去了） |
| `autoresearch_lark_notify` | 往群发通知（门禁阻塞、阶段完成、算力成本） |
| `autoresearch_lark_raw` | 直接跑一条 lark-cli 命令（表单/审批/视图等未封装能力） |

## 首次使用

```text
1. autoresearch_lark_provision            # 建三表，拿到 baseToken 与 tbl* id
2. 写 .dsh-home/.lark.json（已 gitignore）：
   { "baseToken": "...",
     "tables": { "tasks": {"id":"tbl.."}, "gates": {"id":"tbl.."}, "trajectories": {"id":"tbl.."} },
     "chatId": "oc_..." }
3. autoresearch_lark_sync { task_root: "..." }
```

## 三个实测坑（都钉进了自测）

1. **子命令名不能猜**：没有 `+record-create`（是 `+record-batch-create`）、
   没有 `im +msg-send`（是 `im +messages-send`）、filter 形态会被 800010701 拒绝
   （必须走 keyword）。
2. **CLI 走 shell 时参数必须自己转义**：中文名带空格（`AutoResearch 联调测试`）
   曾被拆成两个位置参数。`lib/cli.js` 的 `shellQuote` 统一处理。
3. **响应字段名与直觉不一致**：`base_token`（不是 `app_token`）、`tables[].id`
   （不是 `table_id`）、记录是矩阵形状（`data.fields` 列名 + `data.data` 行）。
   **所有取值路径以实测为准，取不到就抛错** —— 早期按错误路径解析会静默
   拿到空数组，三表一行都没写还报「无错误」，这是最危险的失败形态。

## 设计取舍

- 走 CLI 不引 SDK：CLI 已装好并授权（DPoP + token 自动刷新），引 SDK 等于再管一份凭据。
- 同步失败默认**不阻塞**出题主流程（`strict: false`）：飞书不可达只记录，不挡题。
- 自测：`node scripts/selftest-integrations.mjs`。
