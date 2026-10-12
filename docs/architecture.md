# 架构说明

## 分层

```
┌─────────────────────────────────────────────────────────────┐
│ Electron 主进程（src/main）                                  │
│   · 启动 harness 子进程并等待就绪                             │
│   · 窗口加载 harness 自己的 Web UI（contextIsolation+sandbox）│
│   · 外部链接交给系统浏览器                                    │
└────────────────────────┬────────────────────────────────────┘
                         │ spawn: dsh --profile autoresearch
                         │        --patch build/autoresearch.patch.yml
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ dsh harness 进程（profile: autoresearch）                    │
│  bundles: dsh-base → dsh-web-app → 四个 autoresearch 插件     │
├─────────────────────────────────────────────────────────────┤
│  dsh-autoresearch          四阶段状态机 / 九道门禁 / 脚手架   │
│  dsh-autoresearch-skills   技能供应（8 QA + SOP）             │
│  dsh-autoresearch-gates    Python 门禁工具桥                  │
│  dsh-autoresearch-ui       宿主路由 + 浏览器面板              │
│  dsh-autoresearch-qa       双路质检编排（起两个 headless 子进程）│
└────────────────────────┬────────────────────────────────────┘
                         │ 双路质检：每路独立进程 + 独立 DSH_HOME
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ dsh harness（profile: headless）× 2                          │
│   · 无 Host / 无 HTTP / 无浏览器                              │
│   · 各自固定 provider/model，各自独立凭据                      │
│   · 只收到「提交 ZIP + 提示词 + 输出目录」                      │
└─────────────────────────────────────────────────────────────┘
                         │ HTTP（回环 + token）
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 浏览器（harness Web UI）                                     │
│   · 会话面板 → AutoResearch 出题工作台                        │
│   · /api/autoresearch/{overview,gate,browse,trajectory}      │
└─────────────────────────────────────────────────────────────┘
```

## 为什么是插件而不是独立应用

教程与 SOP 的判据需要在**会话中**被模型调用，也需要**在界面上**被人看到。把判据做成 harness 插件，两件事同时成立：

- 模型通过 `autoresearch_*` 工具读写同一份状态，不需要额外协议
- 人通过客户端插件的 slot 看到同一份状态，不需要数据同步
- 状态落在任务根的一个 JSON 文件里（`autoresearch-state.json`），满足「同一事实单一真源」

## 状态机纪律

阶段推进的硬约束（`packages/dsh-autoresearch/lib/state.js`）：

```
advanceState(state, target):
  1. 目标必须是当前阶段的下一阶段（禁止跳级、禁止回退）
  2. 当前阶段的全部门禁结论必须是 RECOMMEND
     · NEEDS_EVIDENCE 与 REJECT 同样阻断
     · 未运行（undefined）同样阻断
  3. 通过后写入 history，记录 from/to/时间/门禁结论
```

回退被拒绝的理由是教程的「不做总分补偿」与「用新 run/trial ID 重跑，不改写旧 receipt」：返修应当新建运行，而不是回退状态抹掉历史。

## 门禁三态与退出码

与 SOP `milestone_gate.py` 完全一致：

| 结论 | 退出码 | 含义 |
|---|---|---|
| `RECOMMEND` | 0 | 全部硬门通过 |
| `REJECT` | 1 | 存在硬门 FAIL |
| `NEEDS_EVIDENCE` | 2 | 有 UNKNOWN 项未清零 |

`verdictOf` 的实现刻意让 FAIL 优先于 UNKNOWN —— 存在硬门失败时不因为还有待补项而给出模糊结论。

## 只读边界

视图层（`dsh-autoresearch-ui`）只读，且限制在四个白名单根目录内：

```
workspace/harbor_task
workspace/reference
expert_evidence
optimization_evidence
```

越界路径返回 403，白名单外的路径同样返回 403。写操作全部走 `autoresearch_*` 工具，视图不能改状态。

## 双路质检的隔离模型

发布门要求两份独立报告。这里的「独立」由三层结构保证，任何一层都不依赖模型自觉：

**进程层。** 每路是一个独立的 `dsh --profile headless` 子进程。headless 组合包刻意不含 Host、HTTP server、Web runtime 与浏览器插件，因此两路之间没有共享的服务面。

**数据层。** 每路一个独立 `DSH_HOME`（`lane-N/dsh-home`）。会话日志、凭据存储、附件目录全部隔离；两路的会话 ID 由编排层各自生成 UUID，不来自模型。

**提示层。** 提示词只给出本路的提交包路径、输出目录与脚本命令，并显式声明「不要访问其他路的输出目录」。模型看到的上下文里没有另一路的任何痕迹。

模型的输出不参与身份构造：`provider`/`model`/`version`/`session_id` 全部由编排层写进命令行参数，模型改不了。因此共识脚本校验的身份字段是可信的。

## 依赖解析的两个坑

构建过程中实际踩到并修复：

1. **`@deepseek-ai/*` 裸导入无法从插件目录解析。** 插件目录没有 `node_modules`，harness 把 profile 的依赖闭包镜像到 `$DSH_HOME/profiles/node_modules`。因此 `@deepseek-ai/dsh-tools` 必须声明为**真实 dependency**（而非 peerDependency），pnpm 才会把它装进 profile。

2. **pnpm 对 `file:` 本地依赖会缓存副本。** 改了源码但版本号未变时，profile 里仍是旧副本。`scripts/install-profile.mjs` 因此在安装前先删除 profile 中的既有副本，强制重新链接。

另外两处 API 契约也需要对齐：

3. **`output.schema` 用值 schema DSL，不是裸 JSON Schema。** 顶层 `required` 数组不被支持；必需性写在属性级 `required: true`，且对象必须显式声明 `additionalProperties`。

4. **系统提示章节的 `order` 必须是有限数字。** 取值来自 `ctx.systemPrompt.getSectionOrder(<已知名称>)`，未知名称返回 `undefined`。

## 桌面壳的三个启动契约

实测踩到并修复，三个都只在真跑 Electron 时才暴露：

1. **`ELECTRON_RUN_AS_NODE=1` 必须显式设置。** 打包/开发环境下 `process.execPath` 是 `electron.exe`；不设这个变量，子进程会再开一个 Electron 应用实例而不是执行脚本，现象是子进程无任何输出。同时要剥掉从外层继承来的同名变量，避免它被带进来又没清理。

2. **`DSH_HOME` 必须与安装脚本共用同一解析。** 原先桌面壳用 Electron 的 `userData`，安装脚本用项目 `.dsh-home`，于是「装好的 profile 桌面端看不见」。现在收敛到 `src/main/runtime-paths.js`，优先级：显式参数 → `DSH_HOME` → 项目内 `.dsh-home`。刻意不用 `userData`：它随应用名与打包方式变化，会让同一个项目在不同启动路径下看到不同 profile。

3. **Electron 版本受 harness 原生绑定约束。** `@deepseek-ai/dsh-app-boot` 的原生绑定按 Electron 版本校验 V8 指纹，支持列表是 `43.0.0 / 44.0.0 / 44.7.0 / 45.0.0-alpha.6`。装 43.7.9 会以 `node-addon-require-builtin unsupported` 拒绝启动。`package.json` 已固定 44.7.0。

## 自定义 API 的三层 patch

桌面壳启动时按顺序叠加，后者可覆盖前者：

```
autoresearch.patch.yml        挂载 AutoResearch 插件
autoresearch-api.patch.yml    自定义 provider 声明（协议 / 地址 / 模型 / 密钥引用名）
autoresearch-model.patch.yml  默认模型指向
```

只有真实存在的 patch 文件才会被加上 —— harness 遇到找不到的 overlay 会直接拒绝启动，所以启动器先做 `existsSync` 过滤。启动日志会打印实际叠加的层，便于核对。

密钥不进任何一层：profile 只保存 `apiKeyEnv` 引用名，值在 `$DSH_HOME/.credentials.yaml` 的 `refs` 段（0600）。写该文件时做最小改写，只动 `refs` 段需要改的行，`records` 段与注释逐字节保留。

## 双路质检的两个额外坑

构建时实际踩到并修复：

5. **`--patch` 路径按子进程 cwd 解析。** 每路的 cwd 是 `lane-N/`，若传相对路径会解析成 `lane-N/lane-N/model.patch.yml` 而找不到文件。所有 patch 路径一律转绝对路径。

6. **只声明 `agent-default-model` 不够。** 不声明 `llm-pi-ai.providers.<provider>.apiKeyEnv` 时该路由没有适配器，直接以 `NO_ADAPTER` 失败。但未提供凭据时又不能覆盖 `llm-pi-ai`——覆盖成空 profile 会以 `MISSING_CREDENTIAL` 失败。因此：给了 `credentialEnv` 才写这一段。

## 不导出 schemastery Config 的原因

三个插件都用模块内 `DEFAULT_CONFIG` + `apply(ctx, rawConfig)` 合并的方式，而不是导出 `Config` schema：

- schemastery 在插件目录不可解析（同上第 1 点），引入它需要额外依赖
- cordis 允许无 `Config` 的插件直接接收 patch 里的原始 config 对象，行为等价

配置仍由 `cordis.patch.yml` 提供，可被后续 patch 层整体替换。

## 缺前置条件的处理

`checkPrerequisites` 返回三种状态：

| 状态 | 含义 | 行为 |
|---|---|---|
| `true` | 可运行 | 正常执行 |
| `'partial'` | 部分可运行（如需 root 的工具在非 root 环境） | 执行静态判据部分，声明限制 |
| `false` | 不可运行 | 拒绝执行，返回明确原因 |

拒绝时返回 `verdict: 'NOT_RUN'` 而不是 `FAIL` —— 缺 Docker 不是候选失败，也不是题目失败，是**本机能力不足**。这个区分对应 SOP 规则 22「沙盒建立失败判基础设施故障，绝不回落宿主执行」。
