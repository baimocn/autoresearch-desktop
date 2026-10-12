# 自定义 API 接入

用哪个 API、哪个模型，完全由你定：任意 OpenAI 兼容或 Anthropic 兼容端点，任意模型名，不必在内置服务商目录里。

## 两种配置方式

| 方式 | 适合 | 入口 |
|---|---|---|
| 声明式（本插件） | 脚本化、批量配置、双路质检配对 | `autoresearch_api_*` 工具 |
| 表单式（内置） | 手工试一下、随手改 | 界面「设置 → 模型」页 |

两者写同一份 profile 与凭据文档，不另造存储，可以混用。

## 支持的协议

`api` 字段只接受三个值（这是 pi-ai 承认的全部协议，不是我们的限制）：

| 协议 | 用于 |
|---|---|
| `openai-completions` | 绝大多数 OpenAI 兼容端点（DeepSeek、Moonshot、通义、智谱、SiliconFlow、ollama、vLLM…） |
| `openai-responses` | 走 OpenAI Responses API 的端点 |
| `anthropic-messages` | Anthropic 官方与兼容实现 |

## 快速开始

```
# 1. 看有哪些预设（预设只是建议，任何端点都能手填）
autoresearch_api_options {}

# 2. 声明一个路由
autoresearch_api_add {
  route: "my-gateway",
  api: "openai-completions",
  baseURL: "https://gateway.example.com/v1",
  models: ["model-a", "model-b"],
  keyEnv: "MY_GATEWAY_API_KEY",
  apiKey: "sk-...",
  setDefault: true
}

# 3. 校验配置能被原生接受
autoresearch_api_verify {}

# 4. 重启 harness（桌面壳菜单 Harness → 重新启动 Harness）
```

用预设时更短：

```
autoresearch_api_add { route: "deepseek", models: ["deepseek-chat"], apiKey: "sk-..." }
autoresearch_api_add { route: "ollama", models: ["qwen2.5:14b-instruct"], setDefault: true }
```

本地推理（ollama / vLLM）也在预设里，不要求真实密钥。

## 密钥怎么存

**profile 只保存引用名，密钥本体进凭据文档。** 这是凭据服务的既有分层：

| 位置 | 内容 | 权限 |
|---|---|---|
| `build/autoresearch-api.patch.yml` | `apiKeyEnv: "MY_GATEWAY_API_KEY"` —— 只有名字 | 普通文件 |
| `$DSH_HOME/.credentials.yaml` 的 `refs` 段 | `MY_GATEWAY_API_KEY: sk-...` | 0600 |

也可以完全不用凭据文档，直接 `export MY_GATEWAY_API_KEY=...`（启动环境可见即可）。

写凭据文档时做**最小改写**：只动 `refs` 段需要改的行，`records` 段、注释、空行逐字节保留。全量重写会丢掉作者意图，也可能破坏其他功能的凭据。

## 生成的两份文件

```
build/autoresearch-api.patch.yml     provider 声明（协议/地址/模型/密钥引用名/请求头）
build/autoresearch-model.patch.yml   默认模型指向
```

桌面壳启动时按顺序叠加三层 patch：

```
autoresearch.patch.yml       挂载 AutoResearch 插件
autoresearch-api.patch.yml   自定义 provider（可覆盖默认）
autoresearch-model.patch.yml 默认模型
```

后层可覆盖前层，所以你的配置优先级最高。

## 端点探测

```
autoresearch_api_probe { route: "my-gateway" }
```

区分三种情况，便于定位问题：

| 结果 | 含义 | 下一步 |
|---|---|---|
| 2xx | 端点可达且鉴权通过 | 可以直接用 |
| 401 / 403 | 端点活着，密钥有问题 | 检查密钥有效性、过期、对该模型的权限 |
| 404 | 端点活着，但没有 `/models` 路由 | 可能 baseURL 需要带 `/v1`；部分服务不提供模型列表，不影响实际调用 |
| 连接失败 | 地址或网络问题 | 检查 baseURL、代理、防火墙 |

**404 不判为失败**：很多网关不实现模型列表接口，但正常能推理。

## 给双路质检配两路

发布门要求两路身份（provider/model/version）两两不同。一条命令配好：

```
autoresearch_api_dual_lanes {
  laneA: { route: "gateway-a", api: "openai-completions", baseURL: "https://a.example.com/v1", models: ["model-x"], keyEnv: "A_KEY", apiKey: "sk-a" },
  laneB: { route: "gateway-b", api: "anthropic-messages", baseURL: "https://b.example.com", models: ["model-y"], keyEnv: "B_KEY", apiKey: "sk-b" }
}
```

两路 route 相同时**直接拒绝**——不会让你跑完两路才在聚合阶段发现身份撞车。

写完后 `npm run profile:install` 刷新 profile，重启 harness，再跑 `autoresearch_qa_dual`。

## 校验为什么必须真加载

`autoresearch_api_verify` 不只是检查语法，它会真实执行 `dsh --dump-config`：

> **能解析 ≠ 原生接受。**

配置语法正确但 native 层不接受（例如协议名不在表里、字段名拼错），dump-config 会失败或该行消失。只有真加载通过才算配置可用。

## 常见问题

**问：模型名写错会怎样？**
声明阶段不校验模型名是否存在——很多端点不提供模型列表，无法离线校验。写错的后果是调用时返回模型不存在错误。先用 `autoresearch_api_probe` 确认端点通，再试一次调用。

**问：能用中转/代理网关吗？**
能。它就是「自定义 baseURL + 自定义协议」的标准场景。如果网关要求额外的鉴权头，用 `headers` 传：

```
autoresearch_api_add {
  route: "proxy", api: "openai-completions",
  baseURL: "https://proxy.example.com/v1", models: ["gpt-4o"],
  headers: { "x-custom-auth": "..." }
}
```

**问：切换默认模型要重启吗？**
要。默认模型读自 profile 的 patch 层，改动需要重启 harness 才生效。

**问：能配多个路由同时用吗？**
能。`autoresearch_api_list` 列出全部路由；会话里可以按需切换模型，默认模型只是新建 agent 的起点。

**问：密钥会不会被写进日志？**
`autoresearch_api_list` 只回显引用名与「有无值」，不显示密钥本体。界面「API 配置」页签同样。写盘时密钥只进凭据文档。

## 已知限制

- **协议只有三种**：不在表里的协议无法接入，这是 pi-ai 的能力边界。
- **探测只发 `/models` GET**：不发送任何任务内容，但部分端点可能因此返回非标准状态码。
- **模型名不做存在性校验**：见上。
- **切换默认模型需要重启**：配置在 profile patch 层。

## 密钥明文存储（本机设计）

密钥以**明文**保存在 `DSH_HOME/.credentials.yaml`（权限 0600）：

```yaml
version: 1
refs:
  LLAPI_API_KEY: sk-...
  ANTHROPIC_KEY: sk-ant-...
records: {}
```

这是单机使用场景的**有意设计**，不是妥协：

- 多个模型 = 多个路由 = 多把密钥，需要能被直接查看与管理
- 页面不回显密钥本体（只显示「有值/无值」），需要查看或编辑时直接打开该文件
- API 配置页底部显示该文件的完整路径，点开即可编辑
- 备份/迁移时把这个文件带上即可（和其它 DSH_HOME 内容一起）

## 多模型与编辑语义（2026-10-12 修复）

**修复前**：对已有路由提交表单会**整个覆盖** provider 声明 —— 给路由追加模型 B，
原有模型 A 会丢失；改密钥也得重打全部字段。

**修复后**（`mergeProviders` 的保留语义）：

| 字段 | 语义 |
|---|---|
| 未提供 / 留空 | **保留现有值** |
| `models` 空数组 | 保留现有模型列表 |
| `models` 非空数组 | 覆盖为给出的完整列表 |
| `baseURL` 显式空串 | 删除该键（切回协议默认地址） |

配套的界面改动：

- **「编辑」按钮**：一键把该路由当前配置填进表单（含多模型逗号列表）；
  密钥输入框留空 = 保留现有密钥
- 表单提示「编辑已有路由时：留空的字段保留现值 —— 只补密钥或加模型都不必重打其它项」
- 保存后回显生效模型列表（`effectiveModels`）+ 凭据文件路径

端到端验证（真实 HTTP + cookie 认证）：只给 keyEnv 不带 models → 模型保留；
显式给两个模型 → 列表变两个；双路质检配置器的下拉同步出现新模型。
