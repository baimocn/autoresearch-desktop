# AutoDL 与飞书集成（2026-10-27）

> 背景：出题人在 AutoDL 上租算力做探索/预跑，在飞书里同步进度与审批。
> 此前这两条通道靠手工（网页点实例、聊天里报状态），平台对它们零感知。
> 本轮把两条通道接进平台，并保留各自的硬约束。

## 0. 结论

| 层 | 新增 | 状态 |
|---|---|---|
| 算力 | `packages/dsh-autoresearch-autodl`（14 个工具） | 真实 API 端到端通过 |
| 飞书 | `packages/dsh-autoresearch-lark`（6 个工具） | 真实建表 + 同步 + upsert 通过 |
| 前端 | 工作台新增「算力」「飞书」两个标签 | 路由真实数据驱动 |
| QA | 补 3 个缺失脚本 + 5 份参考规范，默认入口可运行 | 332 项测试（1 项上游 Windows 路径缺陷） |
| 守卫 | `tool-registry-guard` 断言 20 个新工具、`selftest-integrations` 入 check 链 | 31 项自测 |

`npm run check` 全绿（EXIT=0，19 个子套件）。

## 1. AutoDL：算力接入

**它和内场是两件事。** 内场（Harbor 正式评分）只接受 H20/L20；AutoDL 上能租到的
H800/4090/PRO6000 只用于专家自己的探索、预跑、依赖验证。本包不参与内场门禁。

端点表集中在 `lib/client.js` 的 `ENDPOINTS`，以官方文档
`https://www.autodl.com/docs/instance_pro_api/` 为准。三个实测要点：

- 真实路径带 `pro` 段（`/api/v1/dev/instance/pro/list`）。早期按直觉命名
  （`/dev/instance/list`）全部 404 —— **端点不能猜**，改一处就够。
- GET 接口（snapshot/status）也要带 JSON body，这是官方的写法。
- HTTP 200 里可能是 `code != "Success"`（实测 balance 传错参数时返回
  `RequestParameterIsWrong`），必须判 `code`，只看 `response.ok` 会把失败当成功。

### 全自动的安全边界

「全自动」的钥匙不是能开，而是保证会关。三道护栏（缺一不可）：

1. **预算护栏**：创建前按 `单价 × 时长` 估算，超过 `maxTotalYuan`（默认 20 元）
   直接拒绝。官方文档**没有写明** `payg_price` 的计费时长单位，所以单价必须
   由使用者按自己的账单口径填 —— 宁可拒绝也不猜一个数字放行。
2. **租约账本**：先写租约（含到期时间）再调创建 API。反过来在「创建成功、
   写账本前崩溃」时会留下一个**永远不在账本里的实例**，再也不会被回收。
   账本损坏时报错而不是当空 —— 当空等于丢实例。
3. **回收**：默认只关机（保留磁盘）。`release` 删数据不可恢复，必须显式 confirm。

创建/释放不进前端按钮：它们涉及真实计费与不可恢复删除，留在对话工具里走
显式 `confirm`。前端只给查询与关机（关机不花钱且面板要看得见跑着什么）。

## 2. 飞书：三表同步

三张表按**更新频率**拆（与 three-table skill 一致）：任务表按任务ID upsert、
门禁表与轨迹表追加 —— 「上次为什么被拒」不能被覆盖。

三个实测坑，全部钉进自测：

1. **子命令名不能猜**：没有 `+record-create`（是 `+record-batch-create`）、
   没有 `im +msg-send`（是 `+messages-send`）、filter 形态被 800010701 拒绝（必须 keyword）。
2. **CLI 走 shell 时参数必须自己转义**：`AutoResearch 联调测试` 被拆成两个
   位置参数（`shell: true` + 数组在 Node 里只拼接不转义）。
3. **响应字段与直觉不一致**：`base_token`（非 `app_token`）、`tables[].id`
   （非 `table_id`）、记录是矩阵形状。早期按错误路径解析 → 静默空数组 →
   三表零写入还报「无错误」。**取不到就抛错**，静默失败比报错危险。

设计取舍：走 CLI 不引 SDK（CLI 已授权，DPoP + token 刷新都是它的）；同步失败
默认不阻塞出题（`strict: false`）。

## 3. 前端

工作台顶栏新增「算力」「飞书」两个全局标签（与「API 配置」同层）：

- **算力**：余额/实例/护栏三卡片、实例表（含一键开关机）、租约与回收
  （预演 / 执行 / 核对账本）。
- **飞书**：授权/三表/当前任务三卡片、一键建 Base、一键同步当前任务。

后端路由 `/api/autoresearch/autodl`、`/api/autoresearch/lark` 直接调两个包的
lib —— 与工具入口共用同一份配置解析（`lib/config.js`），避免 token/账本
解析逻辑漂移。

## 4. QA 资产补齐

审阅 skill 0.3.10-standard-waiver.5 相对内置资产缺 3 个脚本（默认入口
`audit_standard_with_waivers.py`、`audit_legacy_task.py`、`audit_format_repair.py`）
与 5 份参考规范，已补齐。`audit_standard_with_waivers.py --help` 可运行。

上游 332 项测试里 1 项失败：`test_submission_format.py` 期望 `submission_root`
为原生反斜杠路径，而 `submission_format.py` 内部统一成 `/`。这是**上游脚本在
Windows 上的既有缺陷**（原始 zip 与平台资产一致，本轮未改任何上游脚本），
已登记 `docs/upstream-defects.md`。

## 5. 已知边界（如实声明）

- **AutoDL 没有库存/价格查询端点**。库存只能从实例列表间接看；价格只随
  snapshot 返回，且文档未写明计费时长单位。因此预算护栏要求使用者显式填单价。
- **创建仍需显式 confirm**。全自动指「开关机、回收、账本核对不需要人」；
  花钱开新实例这一步保留人的一票。
- **飞书同步只覆盖状态**。B/R/U 锚点值、门禁的完整 12 项明细没有进表格
  （门禁表存结论与首条问题）；需要全量时用 `autoresearch_lark_raw`。
- **`direction` 长串解释**只取首个字面量参与比较，与 `tools.js` 同口径；
  若两个文件的解释文本本身有差异（非字面量部分），不会被误判为冲突。
