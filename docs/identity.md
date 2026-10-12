# 身份层 —— AutoResearch Sentinel (ARS)

把界面上的 DeepSeek 品牌换成自己的，并在「关于」页说明底座来源。
实现落在 `packages/dsh-ars-brand/`，不改上游任何产物。

## 换成什么

| 位置 | 原来 | 现在 | 机制 |
|---|---|---|---|
| 侧边栏品牌行 | 鲸鱼标 + `deepseek` + `HARNESS` | 哨塔标 + `AutoResearch Sentinel` | 槽位替换（`sidebar.brand.mark` / `sidebar.brand.name`） |
| 空会话 Hero 图标 | 鲸鱼标（动画） | 哨塔标 | 槽位替换（`conversation.hero.brand.mark`） |
| 启动闪屏字样 | `HARNESS` | `AutoResearch Sentinel` | 桌面壳注入 CSS |
| 设置 → 关于 | 无 | 归属说明页 | 槽位注册（`settings.section`） |
| 窗口标题 | — | `AutoResearch 出题工作台` | 桌面壳（本来就是我们自己的） |

## 为什么不是 fork 上游

改一个品牌，如果去 fork `deepseek-harness` 源码自己改造，要接手：

| 项 | 数量 |
|---|---|
| `@deepseek-ai/*` 包 | 288 |
| 其中带浏览器半边（`lib/client.js`） | 71 |
| 安装体积 | 251 MB |
| 仅 `dsh` 主包的直接依赖 | 82 |

底座是 `0.2.0-rc.2`（release candidate），仍在破坏性变更期。fork 意味着这 288 个
包的每一次修复、每一个安全补丁都要自己跟。

**收益对比**：fork 相比槽位替换，唯一多出来的能力是改启动闪屏那句字面量 ——
而那一条用桌面壳注入 CSS 就解决了，不需要 fork。

## 三个机制，按"干净程度"排序

### 1. 槽位替换（侧边栏 + Hero）—— 官方设计意图

品牌位是**槽位**，不是硬编码：

- `sidebar.brand.mark` / `sidebar.brand.name` 由 `dsh-client-ui-sidebar` **声明**
  （契约：`dsh-client-ui-sidebar/lib/types/client/contract/slots.d.ts`）
- `ui-brand-official` 只是这两个槽位的**默认占用者**，由 `dsh-web-app` 的
  bundle patch 声明

契约原文明确允许替换：

> Brand mark rendered in the expanded brand row and collapsed rail. Declared by
> this package's `sidebar` entry; **deployments may replace the shell's fish
> fallback without replacing the surrounding controls.**

所以「按 id 禁用官方占位行 + 注册自己的占用者」是官方设计意图，不是绕过。

Hero 同理：`conversation.hero.brand.mark` 在 `ui-conversation` 里只给了
一个**回退**（`renderSlot(..., { fallback: <HeroFish/> })`）—— 就是那只鲸鱼。
注册自己的占用者即替换回退。

### 2. 设置页（关于）—— 官方设计意图

`settings.section` 是 list 槽，每个条目是一整页。契约原文：

> a feature owns its own settings pages — **adding a setting never means editing
> the shell**

`order: 90` 让它排在官方各节之后。

### 3. 闪屏 CSS 覆盖 —— 唯一一处渲染层 hack

启动闪屏那句 `HARNESS` **不是槽位**，是构建产物里的字面量：

```js
// dsh-web-frontend/dist/assets/index-5SrrfWpU.js（压缩后）
this.wordmark = yn(xn.wordmark, "HARNESS")   // → <div class="_wordmark_u7vgf_31">HARNESS</div>
```

既没有槽位可注册，也没有 config 可改，只能在渲染层覆盖。
`src/main/index.js` 的 `applyBootBranding()` 在 `dom-ready` 时 `insertCSS`：

- 选择器用**类名前缀** `div[class^="_wordmark_"]`，因为类名带内容哈希
  （`_wordmark_u7vgf_31` 的 `u7vgf` 会随构建变化），全名匹配会在上游重建后失效
- 作用域限定在 `[data-dshBoot]` 之内 —— 那只在启动闪屏根节点上出现，
  因此这段 CSS 不可能影响主界面
- 覆盖失败只是继续显示原文，不影响任何功能

## 顺序约束（会静默失败的那一条）

profile 按 `dsh.profile.bundles` 的顺序叠加各 bundle 的 patch 层，**后者覆盖前者**。
本包的 patch 按 id 命中 `ui-brand-official` 并置 `disabled: true` —— 只有当本 bundle
排在 `@deepseek-ai/dsh-web-app` **之后**才生效。

**排错位置不会有任何报错，只会静默不生效**（品牌位继续显示官方鲸鱼）。
因此：

- `scripts/install-profile.mjs` 的 `PACKAGES` 里 `dsh-ars-brand` 必须最后，
  且安装器会把已被手工改乱的位置**显式归位**到末尾，而不是只靠"追加缺失项"
- `scripts/selftest.mjs` 有 4 项断言守着这个不变量（补丁语义、顺序、槽位齐全、
  闪屏选择器），排在错误位置会让自检失败

## 合规性（对照官方 practices.md）

官方 `cordis-plugin-development/references/practices.md` 的硬性要求，逐条对照：

| 要求 | 本包 |
|---|---|
| 不得 `require` 任何 Harness Client 包（`dsh-client-ui-primitives` 等） | ✅ 只用 `require('react')` |
| 工厂必须无副作用；样式/注册在 `apply` 的 `ctx.effect` 内 | ✅ |
| 样式只走 `--dsw-alias-*` 主题 token | ✅ token 改名只掉样式，不会渲染崩 |
| 通过 `ctx.slots.inject(ownerKey, () => ctx.slots.register(...))` 贡献 | ✅ |
| 不替换 app root、不向 `document.body` 追加 | ✅ |
| 图标自绘，不复制官方 primitives | ✅ 哨塔为自绘 SVG |

## 没改掉的部分（如实说明）

空会话 Hero 的标题 **`探索未至之境`** 和 **`预览版`** 徽章仍是 DeepSeek 的文案。

原因：它们是**语言字典条目**（`dsh-client-ui-conversation` 的 `hero.headline`），
而 locale 服务是**单占用者**设计 —— 重复注册会抛异常：

```js
// dsh-client-locale/lib/client.js
for (const [locale] of pairs)
  if (locales.has(localeKey(locale)))
    throw new Error(`locale namespace "${ns}" already has locale "${locale}"`)
```

文档原文：*"Duplicate (ns, locale) throws (single occupant; a namespace's texts
have one owner)."* 也就是说这不是"难做"，是**契约上不允许**。

三个选项：

1. **保持现状**（当前选择）—— 它是一句标语而非品牌标识；「关于」页已明确
   说明底座来自 DeepSeek，保留其标语与署名一致。
2. **CSS 覆盖** —— 和闪屏同一套机制。可行，但比闪屏更脆：闪屏是纯装饰，
   Hero 标题是版式的一部分，隐藏后要自己补位，且换语言时文案对不上。
3. 上游若将来把 Hero 文案改成槽位，就能像侧边栏一样干净替换。

## 验收

```bash
# 结构断言（自检 4 项）
node scripts/selftest.mjs

# 活体验收：品牌位 + 关于页 + 截图（需要 app 带 --remote-debugging-port=9223）
node scripts/devtools/cdp-verify-brand.mjs 9223 _vision_test/brand
```

闪屏覆盖可以用合成元素直接验证（不需要抓那一秒）：

```js
// 造一个同构元素读计算样式
const root = document.createElement('div'); root.setAttribute('data-dshBoot', '')
const w = document.createElement('div'); w.className = '_wordmark_u7vgf_31'; w.textContent = 'HARNESS'
root.append(w); document.body.append(root)
getComputedStyle(w).visibility              // 'hidden'
getComputedStyle(w, '::after').content      // '"AutoResearch Sentinel"'
```
