# 工作台前端改造

这次改的是 `packages/dsh-autoresearch-ui/client.js`。两类问题，一类是**真的坏了**，
一类是**不好用**。

## 一、主题适配失效（真坏了）

### 症状

面板在浅色主题下出现深色块，在深色主题下看着正常。所以这个问题**只在切到浅色时
才暴露** —— 深色下截图会得到「一切正常」的假结论。

### 根因

CSS 自定义属性写错名字**不会报错**，只会静默回退到 fallback。代码里有四个名字
在 DSH 里根本不存在：

| 写的（错） | DSH 实际定义的 |
|---|---|
| `--dsw-alias-bg-elevated` | `--dsw-alias-bg-layer-1` / `bg-layer-2` |
| `--dsw-alias-border-secondary` | `--dsw-alias-border-l1` / `l2` / `l3` / `l4` |
| `--dsw-font-family-sans` | `--dsw-font-family` |
| `--dsw-font-family-mono` | `--dsw-font-markdown-code-block` |

而 fallback 又写成了**深色专用值**（`rgba(15,23,42,.35)`、`#e2e8f0`），
所以在浅色主题下就变成了深色块。

### 因果证明

不满足于「我改好了」，做了一次消融：在真实页面上把定义换回错名字，读解析值。

```
--dsw-alias-bg-elevated      解析值 ""          ← 不存在
--dsw-alias-bg-layer-1       解析值 "#232324"   ← 存在

用错名字时 --aw-bg → rgba(148,163,184,.055)   ← 退化成写死的灰
用对名字时 --aw-bg → #232324                  ← 取到主题色
```

脚本：`scripts/devtools/cdp-ablate-tokens.mjs`（9 项）

### 还改了什么

- fallback 全部换成**浅色下也成立**的颜色。原因很实际：fallback 只在 token
  解析失败时生效，而解析失败正是我们踩过的坑。把 fallback 写成深色，等于
  让故障表现得更隐蔽。
- 状态色（成功/警告/错误/失效）改用 `color-mix` 从主题色派生，不再写死
  一组「深色主题下好看」的固定值。
- 半透明派生色统一用 `color-mix(in srgb, ...)`，不再手写 rgba。

## 二、信息架构（不好用）

### 问题

九个标签平铺一行：任务、模式、四阶段、门禁、轨迹、双路质检、远端实验、
证据浏览、API 配置。它们**不是同一层的东西**混在一起：

- 「模式 / 四阶段 / 门禁」是**推进**流程
- 「轨迹 / 双路质检 / 远端实验 / 证据浏览」是**核查**取证
- 「任务组合 / API 配置」是**全局设置**，不属于任何任务

平铺的代价是使用者每次都要在九个里找，而且看不出自己在流程哪一段。

### 改法

改成两级：一级是「推进 / 核查」，二级只显示当前分组下的子页。

```
[推进 | 核查] │ 任务组合        ...spacer...        API 配置
   四阶段  门禁        ← 二级，只在「推进」选中时出现
```

顺带加的几处：

**面包屑。** 标题下方一行小字显示「推进 / 门禁」。这是原来最缺的信息 ——
九个平铺标签回答不了「我在流程哪一段」。

**任务条粘顶。** 原来「查看中的任务」混在正文里，长页面滚下去就看不见了，
容易看错任务。现在 `position:sticky` 常驻顶部，并加了「复制路径」按钮。

**跳转链接。** 键盘用户按一次 Tab 就被问「要不要跳过导航」，不必逐个穿过
九个标签。这是标准的 skip-link 模式。

**焦点可见性。** 用 `:focus-visible` 而不是 `:focus` —— 鼠标点击不该留焦点环，
键盘导航必须看得见焦点在哪。

**尊重减少动效。** `prefers-reduced-motion` 下把所有过渡压到最短。

**弹窗底色。** 原来用 `bg-base`（页面底色）做弹窗背景，浅色主题下弹窗会和
背景糊在一起。改用 `bg-overlay`（真正的浮层色）。

## 三、验证

| 脚本 | 项数 | 验的是什么 |
|---|---|---|
| `scripts/check-ui-tokens.mjs` | 8 | 引用的每个 token 名都在 DSH 里真实存在 |
| `cdp-assert-panel.mjs` | 21 | 结构、主题变量解析、对比度、键盘可达性 |
| `cdp-theme-switch.mjs` | 5 | `--aw-*` 与 DSH token **同源**（值相等） |
| `cdp-ablate-tokens.mjs` | 9 | 换回错名字会退化 —— 证明修复因果必要 |
| `cdp-theme-shots.mjs` | 10 | 双主题截图留档 |

`check-ui-tokens.mjs` 进 `npm run check`（其余是 devtools，需 CDP 端口）。

### 这个校验器为什么不是摆设

它的 token 清单**从随包 CSS 里现抠**（抠出 404 个），不写死在脚本里。
写死的话 DSH 升级后清单会过期，检查又会变成骗人的。

它还有反向自检：故意拿一个假 token 名去问，必须判「不存在」。
没有这条，一个永远返回「全部通过」的校验器也能骗过自己。

### 实测数据

```
--aw-bg   = #232324   与 DSH --dsw-alias-bg-layer-1 完全相等
--aw-line = #ffffff0f 与 DSH --dsw-alias-border-l1  完全相等
--aw-ink  = #f9fafb   与 DSH --dsw-alias-label-primary 完全相等

对比度：标题 17.45:1，标签 12.11:1，面包屑 4.92:1，按钮 17.45:1
（WCAG AA 要求正文 ≥ 4.5:1）
```

只断言「与 DSH 相等」而不写死具体颜色 —— 具体色值归 DSH 主题管，
我们写死会在主题升级时失效。

## 四、一处诚实说明

**截图我只生成了，没能自己看。** 当前模型不支持读图，所以判断依据是 DOM
计算样式与对比度断言，不是肉眼。截图留在 `cdp-theme-shots.mjs` 里，可用
`node scripts/devtools/cdp-theme-shots.mjs 9333 <url> <outDir>` 自己生成查看。

也就是说：「深色主题下好看」这条我**没有视觉确认**，只确认了数值指标
（对比度达标、变量同源、继承正常）。视觉品味层面的结论请你自己看一眼。

---

## 五、接手复审（有视觉确认的一轮）

上一轮留下的诚实说明是「截图只生成了，没能自己看」。这一轮补上了**看图**，
于是发现了两类纯数值断言抓不到的缺陷。

### 5.1 主按钮与选中标签完全看不见（真坏了）

**症状**：截图里 `登记任务`、`查看详情` 是一块**空白白框**，`任务组合` 标签
也是空白白框 —— 文字和背景同色，等于不可见。

**根因**：`--dsw-alias-brand-primary` 在 DSH 深色主题里是 **`#f9fafb`（近白）**。
它是"品牌**前景**色"，不是填充色。代码却把它当背景用：

```css
--aw-accent: var(--dsw-alias-brand-primary, #3b6fe0);   /* → #f9fafb */
.aw-btn[data-kind="primary"]{ background: var(--aw-accent); color: var(--dsw-alias-brand-text,#fff) }
```

`brand-text` 也是近白 → 白底白字。

**为什么上一轮的 DOM 断言没抓到**：它量的是 `el.color` 对 **`.aw-panel` 的背景**，
而主按钮的文字是白色、面板背景是深色 → 算出 17.45:1 判通过。参照系错了：
必须量元素**自己的**背景。修好参照系后同一个按钮变成 15.03:1（白底 + 深字）。

**修法**（都取 DSH 里成对的 token，浅色下自动反转）：

| 用途 | token 对 |
|---|---|
| 强调色（边框/焦点/强调文字） | `--dsw-alias-state-business-primary`（`#7aaaff`） |
| 主按钮填充 + 其上文字 | `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground` |
| 选中标签填充 | `--dsw-alias-button-ghost-active-fill` |

实测：深色下填充 `#f9fafb` / 文字 `#0f1115`；浅色下自动反转成填充 `#0f1115` /
文字 `#fff`。

### 5.2 徽章文字对比度不达标（真不好用）

状态色（`--dsw-alias-state-*-primary`）是**填充色**语义，当文字用两个主题都不达标：

| 徽章 | 浅色 | 深色 |
|---|---|---|
| `非任务` | 1.48:1 | 2.44:1 |
| `需关注` | 2.15:1 | — |
| `健康` | 2.28:1 | — |

AA 要求 4.5:1。修法：**文字改用中性可读色**（`--dsw-alias-label-secondary`），
状态改由**彩色圆点 + 底色浅染**表达。圆点此前压根没有背景色，等于不存在 ——
状态只靠文字色承载，这正是上面那个坑的另一面。

改后双主题 29 个元素全部 ≥ 4.5:1。

### 5.3 顺带修的两个测量陷阱

这两条不改代码，但**不改就会让断言骗自己**：

1. **量颜色前必须关掉过渡。** `.aw-btn` 带 `transition: background .15s`，
   切主题后 `getComputedStyle().backgroundColor` 停在过渡起点（上一个主题的值），
   于是报出成片假失败。测量前注入 `*{transition:none !important}` 即可。
2. **主题开关是 `body[data-ds-dark-theme]`**，不是 `<html data-ds-theme-source>`
   （后者只是来源标记，改它变量不变）。上一轮的 `cdp-theme-switch.mjs` 靠
   localStorage + reload，而 reload 在 Electron 上会把应用带走 —— 现在直接切属性。

### 5.4 新增的三个持久脚本

| 脚本 | 项数 | 验的是什么 |
|---|---|---|
| `cdp-contrast-both-themes.mjs` | 2 | 双主题下所有按钮/标签/徽章的文字 vs **自身背景** |
| `cdp-ablate-contrast.mjs` | 4 | 注入白底白字按钮，证明上面那个断言真抓得到（消融） |
| `cdp-theme-shots.mjs`（重写） | 6 | 双主题截图 + `--aw-bg` 在两主题下确实不同 |

`cdp-assert-panel.mjs` 的对比度段也改为「文字 vs 自身背景」，并加了**全量护栏**：
面板里每一个按钮/标签/徽章都要看得见 —— 具名清单漏掉哪个控件，它照样抓得住。

### 5.5 仍然只做了数值与视觉确认的部分

深色/浅色两张截图都看过了，控件可读性、主题反转、状态圆点都确认。
但**交互态**（hover / focus / disabled / 长文本溢出）没有逐个人肉核对，
只有 `:focus-visible` 与禁用透明度是代码层面确认的。
