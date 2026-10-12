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
