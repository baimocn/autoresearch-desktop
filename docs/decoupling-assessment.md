# 解耦评估 —— 上游升级会把我们打断在哪里

> 评估对象：`autoresearch-desktop`（7 个插件 + Electron 桌面壳）对
> `@deepseek-ai/dsh*@0.2.0-rc.2` 的依赖面。
> 结论基于对 `node_modules/@deepseek-ai/*` 的类型声明、JSDoc、官方
> `cordis-plugin-development` 技能文档与 `dsh-app-boot` 源码的逐条核对。
> 命名目标：**AutoResearch Sentinel (ARS)**。

---

## 0. 结论摘要

好消息：**我们踩在官方 API 上的比例比预想高得多。** 唯一直接 npm 导入是
`defineTool`（有 `.d.ts`、有 exports 映射）；其余全部走 Cordis 服务，且
`agent/pre-step` 改写、`agent.ctx.tools.restrict`、`sessionProjections` 注册
这三处最容易写错的，我们的写法与官方 `references/practices.md` 逐条吻合。

坏消息有三个，都不是"用了内部接口"，而是**没接上官方给的防护**：

| # | 问题 | 后果 |
|---|---|---|
| **R1** | `peerDependencies` 只声明了 `@deepseek-ai/dsh-tools`，**没声明我们真正依赖的包**（sidebar / layout / connection / skill / session-persistence） | 官方兼容门保护不到真正的风险面 |
| **R2** | `@deepseek-ai/dsh-tools` 钉死 `0.2.0-rc.2`（精确版本，无 caret） | 上游一发 rc.3，profile **直接启动失败**（抛异常，不是警告） |
| **R3** | 客户端半个世界依赖 `window.__ModuleLoader__`，**全库无类型声明、无文档** | 唯一一处"无声约定"，改名即整块 UI 静默失效 |

外加一处**潜在缺陷**（不是解耦问题，但同一类风险）：

| # | 问题 | 后果 |
|---|---|---|
| **R4** | 我们往 `agent/pre-step` 注入的消息带 `source.kind: 'autoresearch-step'`（自有值） | 上游若收紧 `source.kind` 校验，历史会话会像上次缺 `id` 那样**整体拒绝加载** |

**建议的改造顺序**：先做 R1+R2（半天，纯声明，立刻让兼容门开始干活），
再做 R3（一天，加一层启动自检），R4 做防御性兜底。

---

## 1. 我们实际依赖的上游面（完整清单）

### 1.1 npm 直接导入

| 包 | 导入 | 位置 |
|---|---|---|
| `@deepseek-ai/dsh-tools` | `defineTool` | 6 个插件的 `index.js:16` 附近（UI 包不导入） |

客户端 `packages/dsh-autoresearch-ui/client.js` **零外部导入**，只
`require('react')`。这一点符合官方 `references/practices.md`：
> Do not `require('@deepseek-ai/dsh-client-ui-primitives')` or load any other
> Harness Client package as a module.

### 1.2 Cordis 服务面（宿主）

| 服务 · 方法 | 调用次数 | 提供方 | 稳定性 |
|---|---|---|---|
| `ctx.tools.register` | 19 | `dsh-tools` | **A** 有 `.d.ts`，`ToolDefinition` 有类型 |
| `ctx.connection.fetch.register` | 11 | `dsh-client-connection` | **A** `HostConnectionFetch.register(route)` 有完整 JSDoc |
| `ctx.effect` | 16 | `cordis` | **A** 框架核心 |
| `ctx.tools.guard` | 2 | `dsh-tools` | **A** `PreToolDecision` 有类型；`index.d.ts:646` 有文档 |
| `ctx.systemPrompt.section` | 1 | `dsh-system-prompt` | **A** 官方 practices 明确推荐 |
| `ctx.systemPrompt.getSectionOrder` | 1 | 同上 | **A** |
| `ctx.skills.registerProvider` | 1 | `dsh-skill` | **A** `dsh-skill/lib/types/index.d.ts:247` 有签名 |
| `ctx.sessionProjections.register` | 1 | `dsh-session-persistence-*` | **A** 官方 practices 明确推荐 |
| `ctx.on('agent/created')` | 1 | 框架事件 | **A** |
| `ctx.on('agent/pre-step')` | 1 | 框架 waterfall | **A** |
| `ctx.agents`（仅注入，未使用） | 0 | — | **死依赖**，见 §4 |

### 1.3 Cordis 服务面（客户端）

| 服务 · 方法 | 次数 | 契约所有者 | 稳定性 |
|---|---|---|---|
| `ctx.slots.register` | 2 | `dsh-client-ui-slots` | **B** 见下 |
| `ctx.slots.inject` | 2 | 同上 | **B** |
| `ctx.layout.selectPanel` | 1 | `dsh-client-ui-layout` | **A** `ILayout` 有完整类型 + `@throws` 文档 |

### 1.4 我们注册的槽位及其契约所有者

槽位名**不是**随便的字符串——每个都有声明所有者，且都带类型契约：

| 槽位 | kind | 所有者包 | 契约文件 |
|---|---|---|---|
| `main`（key 为 `autoresearch`） | `keyed` | `dsh-client-ui-layout` | `types/client/index.d.ts:33` |
| `sidebar.panellist` | `list` | `dsh-client-ui-sidebar` | `types/client/contract/slots.d.ts:16` |

`sidebar.panellist` 的契约明确要求 **list id 必须等于 main panel 的 key**
（`id: MainPanelId`），且 owner props 是 `{ size: number; active: boolean }`
—— 我们传的 `PanelGlyph({ size, active })` 正好吻合。

`main` 的契约原文：
> Central panel selected by sidebar entry id. The reserved `conversation` key
> hosts the Conversation; other keys receive no Session binding.

这正是我们之前踩的坑（面板注册了不渲染）的根因，也是官方**已声明**的语义。

### 1.5 桌面壳与脚本

| 耦合 | 位置 | 类型 |
|---|---|---|
| CLI 参数 `--profile / --patch / --host / --port / --no-open` | `src/main/harness-launcher.js:53-57` | **A** `dsh/lib/bin.js` 有 commander 帮助文本，是公开 CLI |
| dsh 入口路径 `node_modules/@deepseek-ai/dsh/lib/bin.js` | `src/main/runtime-paths.js:59` | **D** 包内文件布局 |
| profile 目录 `.dsh-home/profiles/<name>` | `src/main/runtime-paths.js:64` | **D** 布局约定（有 `DSH_PROFILE_DIR` 环境变量可替代） |
| 会话日志 `session.v4.jsonl.zstd`（多帧 zstd） | `scripts/repair-session-ids.py:64` | **D** 存储格式，见 §5 |

---

## 2. 稳定性分层

- **A 类 · 有类型声明的公开 API**（上面绝大多数）
  上游改签名会同时改 `.d.ts`，是"有意识的破坏"，且 `cordis_inspect_query`
  可以查当前实际签名。**风险可控。**
- **B 类 · 有契约但靠声明合并、我们没参与类型系统**
  槽位名通过 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap {...} }`
  声明，是**编译期**契约。我们的插件是纯 JS、不过 tsc，所以**零编译期保护**：
  上游重命名一个槽位，我们不会报错，只会静默不渲染（就是之前那个 bug 的形态）。
- **C 类 · 无任何声明的约定**
  `window.__ModuleLoader__.load({ id, factory })`。全库搜不到 `.d.ts` 声明，
  但 **71 个官方客户端模块**（`dsh-api-*`、`dsh-client-ui-*` 的 `lib/client.js`）
  都用这个模式。属于"事实标准但无契约"。
- **D 类 · 包内文件布局与存储格式**
  dsh 入口路径、profile 目录结构、会话日志的 zstd 多帧格式。上游重构内部结构
  不会认为这是破坏性变更。

---

## 3. 上游自带的三道防护（我们没接上）

这是本次评估最重要的发现：**上游给了工具，我们一个都没用。**

### 3.1 插件兼容门（`compatibility.json`）

`dsh-app-boot/lib/index.js:286` `evaluatePluginCompatibility()`：

```js
// loadProfileDirectory()，第 930 行
const issue = evaluatePluginCompatibility(bundleManifest, exemptions)
if (issue !== void 0 && !issue.exempted) throw new Error(pluginCompatibilityWarning(issue))
```

机制（`evaluatePluginCompatibility`，第 286-300 行）：
- 读每个 bundle 的 **`peerDependencies`**，与当前 dsh 运行时版本比对。
- **只检查名字等于 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的项**：
  ```js
  if (name !== "@deepseek-ai/dsh" && !name.startsWith("@deepseek-ai/dsh-")) continue
  ```
  所以 `@deepseek-ai/cordis: ^4.0.1` **根本不参与校验**（caret 是惰性的）；
  而 `@deepseek-ai/dsh-tools` 参与。
- 比对用 `semver.satisfies(runtime, range, { includePrerelease: true })`：
  精确 `0.2.0-rc.2` 对运行时 `0.2.0-rc.3` **不满足** → 命中。
- 不兼容 → **在 profile 加载阶段直接抛异常**，profile 起不来（fail loud，不是静默坏）。
- 逃生舱：`dsh plugin allow-version` 或插件管理器授予"精确版本豁免"，
  持久化在 `<profileDir>/compatibility.json`。
- 提示原文：`Running it may cause crashes or data loss. Update the plugin or
  install a plugin version compatible with this dsh runtime.`

**为什么它现在保护不到我们**：我们 7 个插件的 `peerDependencies` 只有

```json
{ "@deepseek-ai/cordis": "^4.0.1", "@deepseek-ai/dsh-tools": "0.2.0-rc.2" }
```

第一个不参与校验，第二个只覆盖工具注册。而真正决定我们能不能跑的是
`dsh-client-ui-sidebar`（槽位）、`dsh-client-ui-layout`（`main` 槽 + `ILayout`）、
`dsh-client-connection`（`fetch.register`）、`dsh-skill`（`registerProvider`）、
`dsh-session-persistence-jsonl`（日志格式）。这些包一个都没声明。

已核实这 5 个包在当前 profile 的 `node_modules` 里都存在且版本均为
`0.2.0-rc.2`，所以补声明不会引入解析失败：

```
dsh-client-ui-sidebar            0.2.0-rc.2
dsh-client-ui-layout             0.2.0-rc.2
dsh-client-connection            0.2.0-rc.2
dsh-skill                        0.2.0-rc.2
dsh-session-persistence-jsonl    0.2.0-rc.2
```

→ **R1**：把这 5 个包按 `0.2.0-rc.2` 补进 `peerDependencies`，兼容门才开始保护
真正的风险面。（`@deepseek-ai/cordis` 可以留着，但要知道它是惰性的。）

### 3.2 `cordis_inspect_query` —— 活的 API 探针

官方 `cordis-plugin-development` 技能把"发现 API"的权威手段定为：

```
cordis_inspect_query（Service / Event / Tool / Slots / Theme / Config.listConfigs）
```

原文：*"Confirm every Service method, Event name, and dispatch mode named here
with `cordis_inspect_query` before relying on it; **the installed Harness is the
authority**."*

这意味着我们**可以自动核对**：注册前先查 `Slots` 里有没有 `sidebar.panellist`，
查 `Service` 里 `tools.guard` 的签名。B 类和 C 类风险因此可以变成**运行时自检**，
而不是靠人记。

### 3.3 `plugin_manager install_bundle` —— 官方安装路径

技能文档明确禁止我们现在的做法：

> Do not write the profile's `package.json` or `cordis.patch.yml`, create
> packages under `$DSH_HOME`, or run pnpm in the profile directory:
> `install_bundle` performs those steps.

我们的 `scripts/install-profile.mjs:171-187` **手工改写 profile 的
`package.json`** 的 `dsh.profile.bundles` 数组。它同时也调了 `dsh` 自带的
`plugin add`（第 5 行注释），所以不是完全绕过，但那段手写
manifest 的部分是**没有契约的**：上游改 `dsh.profile.bundles` 的结构
（例如变成对象数组、或加 required 字段），我们会在安装期静默写坏 profile。

---

## 4. 顺带发现的两个小问题

**死依赖**：`packages/dsh-autoresearch/index.js:40`

```js
export const inject = ['tools', 'systemPrompt', 'sessionProjections', 'agents']
```

`agents` 在整个包内**没有任何使用**（全包 grep 只有这一行）。
官方 practices 说 inject 里的服务是激活条件——多声明一个就是多一个
"这个 profile 没装它就整个插件不激活"的约束。删掉即可。

**`agent.ctx` 注册的卸载缺口**：`lib/mode.js:80-105`

```js
const activeRestrictions = new WeakMap()   // agent → disposer
```

官方 practices：
> Register per-agent behavior on `agent.ctx` … Wrap it in one `agent.ctx.effect()`
> and also keep that disposer, keyed by agent, in your plugin's own effect;
> **unloading the plugin does not dispose `agent.ctx` registrations by itself.**

我们保留了 disposer 并在退出模式时调用，这部分是对的；但
`activeRestrictions` 是 `WeakMap`，**插件卸载时无法枚举、无法清理**，
工具限制会残留。且没有套 `agent.ctx.effect()` 做兜底。
另外 WeakMap 无法枚举也意味着没有"全部撤除"的路径。

---

## 5. 风险点逐条：断裂方式与收敛代价

### R1 · `peerDependencies` 没声明真实依赖面

- **上游升级时怎么断**：不适用——这条是"现在就没防护"。真正的问题是
  `dsh-client-ui-sidebar` 改了 `sidebar.panellist` 的 owner props（比如
  `{size, active}` 改成 `{size, active, collapsed}`），我们照旧传参，
  React 组件拿到 `undefined`，**渲染成空白或抛错但被槽位吞掉**
  （控制台 `slot entry crashed in '<slot>'`）。
- **收敛代价**：**半天**。纯声明工作，改 7 个 `package.json` 的
  `peerDependencies`。收益是立刻把 R2 的兼容门接到真实风险面上。
- **注意**：声明后上游一升级，兼容门会**拦住 profile 启动**。这是想要的行为
  （fail loud），但要配合 R2 的处理流程。

### R2 · `dsh-tools` 钉死精确版本 `0.2.0-rc.2`

- **上游升级时怎么断**：上游发 `0.2.0-rc.3` → `evaluatePluginCompatibility`
  判定不兼容 → `loadProfileDirectory` 抛异常 → **双击启动器直接失败**，
  报 `Plugin dsh-autoresearch@0.1.0 is incompatible with dsh 0.2.0-rc.3`。
  不是静默坏，是硬停。
- **收敛代价**：**一次性脚本 + 一个流程**。rc 阶段（`0.2.0-rc.x`）上游必然频繁
  破坏性变更，精确钉死是**对的**（这是 fail-loud 的设计意图，不要改成 `^`）。
  要做的是：
  1. 写一个 `scripts/check-upstream.mjs`：比对 `node_modules` 里的实际版本
     与 7 个插件的 peer 声明，列出不一致。
  2. 升级流程固定为：改 peer 版本 → 跑 `npm run check`（225 项）→
     跑 `cordis_inspect_query` 自检（见 §3.2）→ 修 → 重启验收。
- **建议**：保持精确版本，**不要**改成 caret。caret 会让上游的破坏性变更
  静默通过兼容门，那才是最坏的形态。

### R3 · `window.__ModuleLoader__` 无契约

- **上游升级时怎么断**：上游换掉客户端模块加载器（或改 `load()` 的签名、
  或改 `factory(require)` 的 require 解析规则）→ 我们的 `client.js`
  **整个不执行**。因为它在 `__ModuleLoader__.load` 的 factory 里，
  加载器不认就没有任何报错路径，表现为"侧边栏没有 AutoResearch 那一行"。
  这正是之前"面板注册了但不渲染"的同族故障。
- **缓解因素**：所有官方客户端插件（`dsh-api-*`、`dsh-client-ui-*`）
  都用同一个模式，属于**事实标准**。上游要换就得同时改几十个官方包，
  概率低，但影响面 100%。
- **收敛代价**：**一天**。在 `apply()` 里加启动自检：
  1. 检查 `window.__ModuleLoader__?.load` 是函数；
  2. 注册后用 `cordis_inspect_query` 的 `Slots.listSubTree`（或直接查
     `slots` 服务的注册表）确认 `main` 与 `sidebar.panellist` 里真的有
     `autoresearch` 这一条；
  3. 失败时往 `shell.overlay` 槽位（官方声明为"frame-wide 附加座位"）
     打一条可见的告警，而不是静默消失。
  这样 B 类和 C 类风险都变成"能看见的失败"。

### R4 · 自有的 `source.kind: 'autoresearch-step'`

- **现状澄清**：`lib/mode.js:320-340` 的 `createStepMessage` 走的是
  `agent/pre-step` 的 **messages 通道**，是**消息**不是**会话事件**，
  所以不受官方那条"未知事件类型拒绝解释"的限制（注释里已经写明）。
  之前的历史加载失败是**缺 `id`**，已修。
- **残留风险**：`source.kind` 是信封字段，我们塞了一个自有值。上游若把
  `source.kind` 收紧成联合类型校验，写入会被拒——表现与上次一样：
  **含注入消息的历史会话整体拒绝加载**。
- **收敛代价**：**半天**做防御。两条路选一：
  1. 用官方推荐的规范路径构造（`dsh-llm` 的 `createUserMessage`），
     不自己拼信封；
  2. 保留自定义构造，但把 `source` 收窄成上游已认的值（例如不带 `kind`，
     或只带已声明的 kind），改用别的字段标记来源。
- **另外**：`scripts/repair-session-ids.py` 依赖 `session.v4.jsonl.zstd`
  多帧 zstd 格式（D 类）。上游换存储格式（`v4` → `v5`）这个脚本会失效。
  建议：脚本开头先探测文件名版本，找不到 `v4` 就明确报"存储格式已变更，
  本工具需要更新"，而不是静默 0 修复。

---

## 6. 改造优先级

| 优先级 | 动作 | 代价 | 收益 |
|---|---|---|---|
| **P0** | 补全 7 个插件的 `peerDependencies`（sidebar / layout / connection / skill / session-persistence） | 半天 | 官方兼容门开始保护真实风险面；R1 消除 |
| **P0** | `scripts/check-upstream.mjs`：声明版本 vs 实际版本比对 | 半天 | R2 变成可发现、可流程化 |
| **P1** | 客户端启动自检 + `shell.overlay` 告警 | 一天 | R3 从"静默消失"变"能看见" |
| **P1** | 删掉死依赖 `agents`；`agent.ctx` 注册补 `agent.ctx.effect()` 兜底 | 1 小时 | 消除激活约束与卸载残留 |
| **P2** | `createStepMessage` 改走规范构造，或收窄 `source` | 半天 | R4 消除 |
| **P2** | `repair-session-ids.py` 加存储格式版本探测 | 1 小时 | 工具失效时可自证 |
| **P2** | 评估改用 `plugin_manager install_bundle` 替代手写 profile manifest | 一天 | 去掉安装期的无契约写入 |
| **P3** | UI 文案接入 Client locale 服务 | 一天 | 符合官方 practices（纯规范，不影响稳定） |

**不建议做的**：把 `0.2.0-rc.2` 改成 caret 范围。rc 阶段上游会有破坏性变更，
精确钉死 + fail-loud 兼容门是正确设计；放宽只会把"启动失败"变成"运行期诡异"。

---

## 7. 与「层 2 工作流画像化」的关系

本次评估只覆盖"我们与上游的接缝"。**层 2（把 `phases.js`/`gates.js` 从源码
常量抬成可加载的任务画像）不改变本评估的任何结论**——它动的是我们自己的
数据模型，不碰上游接口。两者可以并行推进，互不阻塞。

顺序建议：先做 P0（半天，让防护生效），再做层 2（因为它才是"平台是你的"
的实质），层 1 品牌改造顺手带上 ARS 命名。
