# devtools —— 调试期一次性脚本（已归档）

这些脚本是开发调试时写的，**不是产品路径的一部分**，保留仅供排查时参考。
产品路径只有 `scripts/` 下的自检套件与 `run-harness.mjs` / `install-profile.mjs`。

| 脚本 | 用途 | 什么时候还有用 |
|---|---|---|
| `cdp-probe.mjs` | 连 CDP 查 `__DSH_BOOT__` / 模块加载器状态 | 面板不显示、怀疑模块没物化时 |
| `cdp-verify-panel.mjs` | 点侧边栏入口 → 查面板挂载 → 截图 | 面板可见性回归 |
| `cdp-verify-workbench.mjs` | 工作台 API + 交互 + 截图综合验收 | 大改 UI 后的人工验收 |
| `cdp-verify-ui-structure.mjs` | 导航结构断言（默认根不进卡片网格、未选任务出选择器）+ 9 页巡检 + 截图 | 改动任务列表/页签逻辑后 |
| `cdp-verify-brand.mjs` | 身份层验收：品牌位是否被接管、官方品牌是否已消失、「关于」页是否注册 + 截图 | 改动 `dsh-ars-brand` 或品牌槽位后 |
| `cdp-contrast-both-themes.mjs` | 双主题对比度体检：面板内所有按钮/标签/徽章的文字 vs **自身背景** | 改动任何颜色 token 或控件样式后 |
| `cdp-ablate-contrast.mjs` | 对比度断言的消融：注入白底白字按钮，验证它真被抓到 | 怀疑对比度断言是摆设时 |
| `cdp-theme-shots.mjs` | 双主题截图留档 + 断言 `--aw-bg` 在两个主题下确实不同 | 改动主题 token 后 |
| `cdp-ui-test.mjs` | 早期 UI 冒烟 | 基本被上面两个取代 |
| `read-session-tail.mjs` | 读会话日志尾部（Node 版） | 排查会话历史问题 |
| `_fix-selftest.mjs` / `_review-actions.mjs` | 重构期的一次性改写工具 | 基本不再需要 |

用法（需要应用带 `--remote-debugging-port=9223` 启动）：

```bash
node scripts/devtools/cdp-verify-workbench.mjs 9222 _vision_test/out "D:\path\to\task"
node scripts/devtools/cdp-verify-ui-structure.mjs 9223 _vision_test/ui
```

`cdp-verify-ui-structure.mjs` **默认不 reload 页面**：实测对 Electron 页做
`Page.reload` 会把整个 app 带走（execution context 换掉、进程随后退出）。装了新
profile 后重启 Electron 即可；确实需要 reload 时显式加 `--reload`。

**注意**：`repair-session-ids.py` 留在 `scripts/` 而非此处 —— 它是修复历史会话
损坏的**运维工具**（脚本缺陷导致用户会话不可读时的补救），不是调试脚本。

## 两个只有真跑才能发现的坑（写给下一个改样式的人）

**1. 主题开关是 `body[data-ds-dark-theme]`，不是 `<html data-ds-theme-source>`。**
后者只是"主题来源"标记（system/user），改它变量不会变；CSS 里也搜不到
`data-ds-theme-source` 选择器。真正的开关在 body 上：有该属性 = 深色，移除 = 浅色
（`--dsw-alias-*` 就定义在 `body` 与 `body[data-ds-dark-theme]` 两组规则里）。

**2. 量颜色之前必须关掉过渡。**
`.aw-btn` 等带 `transition: background .15s`，切换主题后
`getComputedStyle().backgroundColor` 会**停在过渡起点**（上一个主题的值）——
于是对比度断言量到的是"上一主题"的颜色，报出成片假失败。
`cdp-contrast-both-themes.mjs` / `cdp-assert-panel.mjs` 都在测量前注入
`*{transition:none !important}`，测完移除。

**3. `getComputedStyle(el).color` 未必是 `rgb()`。**
token 用 `color-mix` 派生时会是 `color(srgb r g b / a)`。解析函数要两种都认，
认不出的**跳过该元素**而不是抛异常 —— 早期版本在这里抛了 TypeError，
结果"检查了 0 个元素"却只报一条失败，看着像通过。
