# 客户端 UI 面板：从注册到可见的完整链路

> 本文记录 dsh-autoresearch-ui 面板「注册成功却不可见」问题的根因与修复，
> 也是 harness 客户端模块系统的实现笔记。

## 结论（三句话）

1. **注册 ≠ 物化**：`window.__ModuleLoader__.load({id, factory})` 只是把 factory 存进
   私有 `factories` 表；factory 真正执行（物化）发生在第一次 `import()`/`require()` 时，
   并 memoize 进 `loadCache`。
2. **物化的触发者是 boot 流程**：`bootClient → modules.entries.start(loader, manifest)`
   对 `manifest.plugins` 里**每个**条目调 `loader.create({name})`，Loader 经
   `internal.import` 物化对应 factory 并把其 exports 当作 Cordis 插件挂载。
   `dsh.client.immediately: true` 只提前**传输**（预取脚本），不提前物化。
3. **可见 ≠ 已挂载**：`main` 是 **keyed 槽**（`ui-layout` 声明），AppFrame 只渲染
   `entryKey === panelId` 的那个注册，默认 `conversation`。面板内容注册进 `main`
   只是「有了内容」，**用户入口**必须另注册 `sidebar.panellist`（导航行 + 图标），
   两者靠同一个 id 关联。

## 面板可见的完整协议（缺一不可）

```js
// 1. 内容：注册进 keyed 槽 main，key 就是面板 id
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main',
  key: 'autoresearch',            // ← panelId 选中时的匹配键
}, function AutoResearchPanel(props) { /* … */ }))

// 2. 入口：注册进 list 槽 sidebar.panellist，id 必须等于上面的 key
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist',
  id: 'autoresearch',             // ← 与 main.key 相同
  order: 20,                      // 侧边栏行序（plugins=0 在最前）
  label: 'AutoResearch',          // string | (() => string)
}, PanelGlyph))                    // 图标组件，收到 {size, active}
```

侧边栏（`ui-sidebar`）不从 `main` 槽推导导航行，而是订阅 `sidebar.panellist` 的注册：
`{id, order, label}` → 排序 → 渲染行；点击行走 `ctx.layout.selectPanel(id)`，
AppFrame 随之把 keyed 槽切到该 id。只做第 1 步的面板：已挂载、永远不显示。

## 包声明要求（package.json）

```json
{
  "exports": { "./client": "./client.js" },
  "dsh": {
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-ui-layout", "..."]
    }
  }
}
```

- node 半边（`ClientModuleRegistry`）扫描 host Loader 的每个 entry，解析其
  package.json 的 `dsh.client`（platform 必须 `"web"`），把 `exports["./client"]`
  指向的 bundle 读进启动图（`__DSH_BOOT__`），缺失即启动失败（loud）。
- `inject` 数组 = 浏览器模块图的依赖边（先到先物化），也是 Cordis 组合的服务等待。
- factory 必须无副作用、返回 `{apply, inject}`；样式/DOM 一律放进 `apply` 的
  `ctx.effect`（物化时执行、卸载时清理，HMR 才能正确重放）。

## 运行态取证方法（CDP）

```bash
electron.exe . --remote-debugging-port=9222
node scripts/cdp-probe.mjs 9222          # 查 __DSH_BOOT__ / loader 模式 / bundle 服务
node scripts/cdp-verify-panel.mjs 9222 out.png   # 查导航行 → 点击 → 查挂载 → 截图
```

关键判据：`__DSH_BOOT__.entries` 含本包 → bundle URL fetch 200 且内容是新代码 →
`__ModuleLoader__.mode === 'live'` 且 pendingQueue 空 → 侧边栏 aria-label 出现面板名
→ 点击后 `.autoresearch-panel` 挂载且 `aria-current="page"`。

## 附带修复：DSH_HOME 双家目录分叉

`install-profile.mjs` 原先默认装到 `~/.dsh`，而桌面壳经
`runtime-paths.resolveDshHome()` 解析到项目 `.dsh-home`——结果是
「安装成功但桌面端跑旧代码」。现安装器改用同一解析函数（显式 > 环境变量 >
项目 `.dsh-home`），三件套（安装器 / run-harness / desktop）收敛到单一真源。
改动 `packages/` 下源码后必须重跑 `node scripts/install-profile.mjs`（脚本会
清掉 profile 里的 file: 副本强制重链），再重启应用。

## 对抗性审查：滚动与可用性（2026-10-11）

**滚动断裂（严重）**：layout 的 centerCol 是 `height:100% + overflow:hidden`，
契约是「子面板自己滚动」（插件管理页同模式）。工作台面板曾把内容渲染成整块
（1776px），超出视口的部分被 hidden 直接裁掉 —— 任何栏目都滚不动。
修复：`.autoresearch-panel` 承载层 `height:100%; overflow-y:auto;
overscroll-behavior:contain`。

同轮审查修掉的其余三处：

1. **切页/换任务不回顶**：滚动容器是同一个承载层，上个页面留下的 scrollTop
   会让新页面从中间开始 —— 切换时 `scrollTo(0, 0)`。
2. **弹层缺 Esc 关闭 + 滚动穿透**：GateDetail 补 Esc 监听，打开期间
   `body.overflow = hidden`（关闭恢复）。
3. **证据浏览打开文件不定位**：长列表里点开文件，内容渲染在视口外等于没打开
   —— 打开后 `scrollIntoView(nearest)`。

设计契约沉淀：**注册进 `main` keyed 槽的页面必须自带滚动容器**，这是
ui-layout 的隐含契约（overflow:hidden 的 centerCol + 自滚动子面板）。

## UI 审计与重构（2026-10-12，对照 ui-ux-pro-max 检查清单）

用专业 UI 检查清单审计工作台，发现并修复 9 项问题：

| 问题 | 违反的规则 | 修复 |
|---|---|---|
| 10 种字号混用（11/11.5/12/12.5/13/14/15.5/16/17/20/21） | 字体系统一致性 | 收敛 5 档 token（xs/sm/md/lg/xl），13 处硬编码接入 |
| 卡片高度参差、同行内基线不齐 | 布局一致性 | 卡片直接作 grid item（去掉 wrapper）+ flex 纵向 + body 弹性 |
| 指标色彩无语义（橙/红/白/蓝混用） | 颜色不只传达信息 | 颜色只表「需要动作」：异常着色，正常中性 |
| 顶部色条 + 徽章 + 指标色三重表达同一件事 | 信息层次 | 左侧细色条 + 徽章两处，取消指标色 |
| 装饰性迷你柱图（无基线无标签，末柱被裁） | 图表规则 | 移除（信息由轨迹页承载） |
| 输入框占位文字被截断 | 表单规则 | 占位文案缩短 + 输入框 flex 自适应 |
| 「移除」按钮 hover 才可见 | 不依赖悬停 | 常驻显示在卡片 footer |
| 非任务根卡片点了进错误页 | 交互可预测性 | 非任务根不显示「查看详情」 |
| 按钮高 24px 低于可点击标准 | 触控目标 | min-height 30px（小号 26px） |

设计 token（.aw-panel 上定义）：字号 xs~xl、间距 4/8/12/16/24、圆角控件 7 容器 12。
所有色彩走 `--aw-*` 语义变量，组件不写硬编码色值。

### 第二轮：导航语义（对抗审查第 10~11 项）

前一轮解决的是「看起来乱」，这两项解决的是「看起来坏」——用户点进去发现内容跟自己无关：

| 问题 | 为什么算缺陷 | 修复 |
|---|---|---|
| 进程默认根（未初始化）作为一张卡片混在任务列表里 | 工作台里并不存在这个任务，它却是列表中的「一个条目」，且点进详情会展示一个空任务 | 移出网格，改为虚线提示条（`非任务` 徽章 + 路径 + 如何初始化），列表里只剩真任务 |
| 未选任务直接点「模式/四阶段/门禁/轨迹/双路/远端/证据」 | 以前静默回退到进程默认根，用户看到一个跟自己无关的目录，像页面坏了 | 新增 `TaskPicker`：显式「先选择一个任务」，整卡可点的任务列表；点选后进入详情 |
| 详情页路径过长换行撑高卡片 | 长绝对路径在卡片里折成两行，同一行卡片高度不齐 | 卡片只显示父级链（`…\autoresearch-desktop\.dsh-home\launch-root`），完整路径挂 `title` |

实现要点（`packages/dsh-autoresearch-ui/client.js`）：

- `DETAIL_TABS` 集合定义「需要任务」的页签；`needsTask = DETAIL_TABS.has(tab) && task === null`。
- `overview` 请求条件收紧为 `(tab === 'phases' || tab === 'gates') && task !== null`，未选任务时不再拿默认根的数据。
- `TasksView` 把 `cards` 拆成 `tasks`（真任务）与 `pendingRoot`（默认根且 `notTaskRoot`）。
- `parentPath()` 做左截断，避免长路径换行。

验收脚本：`scripts/devtools/cdp-verify-ui-structure.mjs`（CDP，逐页巡检 + 结构断言 + 截图）。

## 轨迹页判读（2026-10-14，四项修复）

「核查 → 轨迹」页此前有三处**各写一遍、各错各的**，全部由真实任务暴露。
现在判据统一在 `packages/dsh-autoresearch/lib/trajectory.js`（纯函数、可测）。

### 1. 「没出分」不是「失败」

旧实现用 `status !== 'ok'` 计数，于是：

| 任务 | 轨迹 | 总轮次 | 旧显示「失败」 |
|---|---|---|---|
| AutoRe1841 | seed | 9 | **6** |
| AutoRe1852 | codex | 13 | **13** |
| AutoRe1852 | seed | 8 | **8** |

被判为失败的 `static_screen_no_run` / `blocked_no_compute` / `partial_progress_no_metric`
等，都是 SOP 要求的**如实标注**。后果是激励反了：如实标注的人看到全红，
谎报 `ok` 的人显示全绿。

现在分三桶：`scored`（有分）/ `failed`（**开头**是失败词）/ `no_score`（其余）。
失败判据限定在**开头**，因为失败词出现在中间通常是在描述"关于失败的事" ——
实测反例 `corrected_prior_error`（更正了此前的错误）按"包含 error"会被算成失败。
页面同时把**原始 status 分布**原样列出，判据保守就把判断材料一并给出。

### 2. 「最佳分」必须按指标方向取

`/trajectory` 路由用 `Math.max` 硬取，而同一文件的 `trajectoryDigest` 却已按方向取 ——
两份实现漂移。minimize 题会把**最差**一轮报成最佳。现在共用
`summarizeRounds(rounds, direction)`，且 **direction 为 null 时不猜**，
显示「最佳分（方向未知）」而不是给一个可能是错的数。

顺带修掉 `metricDirectionOf` 的字段形状 bug：它读 `comparison.metric.direction`，
而真实文件是 `comparison.metric`（字符串）+ `comparison.direction`（顶层），
于是 AutoRe1841 的方向读成 null。现改为委托 gates 包的 `readTaskMetricDirection`
（唯一真源，见 `docs/upstream-defects.md` D2 的两层口径说明）。

### 3. 标定常数不是得分

`score` 按 SOP 是「本轮方法的 Public/Dev 原始指标实测值」。而 `R_norm`
（Reference 在评分公式下的位置）是**标定常数**：B/R/U 一定就不变。
实测 AutoRe1841 有三轮把 `reference_normalized`（0.793603）填进 score，
页面显示"最佳分 0.793603"，看起来像跑出了成绩。

- **读取侧**：值与该题标定常数逐位相同时，单元格标「标定常数?」（悬浮说明来源）；
  若**所有**出分轮次都是标定常数，页首标「本轮次无真实得分」。
- **写入侧**：`autoresearch_trajectory` 工具把它作为 `problems` 告警 ——
  **只告警、不拒写、不改数**：轨迹是专家的原始记录，平台不该替作者决定什么能记。

### 4. 双轨是否真的开跑

**轨迹文件存在 ≠ 双轨跑过。** 出题过程本身也会记轮次 —— 实测 AutoRe1841 的
9 轮全是静态筛查/绑定/阻塞记录，而 `run_summary.json` 的
`agent_execution[*].duration_hours` **全是 null**（SOP 规则 8 要求两条轨道各 ≥10h）。
工作台此前把它显示成"轨迹已有 9 轮、有最佳分"，看起来像双轨已完成。

现在轨迹页与任务卡都读时长证据，未开跑时明确标注「双轨尚未开跑」并说明
"下方轮次是出题过程记录"。

### 验收

- `scripts/selftest-trajectory.mjs` —— 64 项，含合成数据与真实任务端到端。
- `scripts/devtools/cdp-verify-trajectory.mjs` —— 真实渲染验收。
  断言**以接口返回为准**而非写死数据条件：这些文件正被出题会话实时改写
  （实测验收过程中轨迹从 10 轮变 11 轮、标定常数被清成 null）。

### 未修的一项（属于任务数据，不是显示缺陷）

AutoRe1841 的 11 轮**全部** `retained_best: true`。SOP 要求选**唯一** best_method，
全部标 best 等于没选。这是数据问题，平台不擅自改动 —— 留给作者决定。
