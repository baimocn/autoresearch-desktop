# dsh-ars-brand

ARS 身份层。两件事，全部走官方槽位，不改上游任何产物：

1. **接管侧边栏品牌位** —— `sidebar.brand.mark` + `sidebar.brand.name`
2. **提供「关于」设置页** —— `settings.section`，说明本项目基于 DeepSeek Harness 搭建

## 为什么不用 fork 上游

改一个侧边栏品牌，如果去 fork `deepseek-harness` 源码自己改造，要接手：

| 项 | 数量 |
|---|---|
| `@deepseek-ai/*` 包 | 288 |
| 其中带浏览器半边（`lib/client.js`） | 71 |
| 安装体积 | 251 MB |
| 仅 `dsh` 主包的直接依赖 | 82 |

而且底座是 `0.2.0-rc.2`（release candidate），上游仍在破坏性变更期 ——
fork 意味着这 288 个包的每一次修复、每一个安全补丁都要自己跟。

**收益对比**：fork 相比槽位替换，唯一多出来的能力是改启动闪屏那句
`HARNESS`（构建产物里的字面量）。闪屏由桌面壳注入 CSS 处理，不需要 fork。

## 为什么禁用 `ui-brand-official` 是合规的

品牌位是**槽位**，不是硬编码：

- `sidebar.brand.mark` / `sidebar.brand.name` 由 `dsh-client-ui-sidebar` **声明**
  （契约：`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts`）
- `ui-brand-official` 只是这两个槽位的**默认占用者**，由 `dsh-web-app` 的
  bundle patch 声明

契约原文明确允许替换：

> Brand mark rendered in the expanded brand row and collapsed rail. Declared by
> this package's `sidebar` entry; **deployments may replace the shell's fish
> fallback without replacing the surrounding controls.**

所以「按 id 禁用官方占位行 + 注册自己的占用者」是官方设计意图。

## 顺序约束（重要）

profile 按 `dsh.profile.bundles` 的顺序叠加各 bundle 的 patch 层，**后者覆盖前者**。
本包的 patch 按 id 命中 `ui-brand-official` 并置 `disabled: true`，只有当本 bundle
排在 `@deepseek-ai/dsh-web-app` **之后**才生效。

`scripts/install-profile.mjs` 以「追加到 bundles 末尾」的方式登记本包，保证了这个顺序。
如果手工调整 `dsh.profile.bundles` 的顺序，**必须让 `dsh-ars-brand` 留在最后**。

## 归属

底座（插件框架、Web 客户端、会话与工具运行时）由 DeepSeek 提供，本项目未修改其源码。
品牌标为自绘 SVG（哨塔），未使用上游 `dsh-client-ui-primitives` 的图形资源。
