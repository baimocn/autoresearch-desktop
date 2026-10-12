# 工作流模式

## 问题：工具箱 vs 模式

前面七个插件都是**工具箱**——能力都在，但需要模型想起来调用。这有两个后果：

1. 模型可能忘了调 `autoresearch_gate` 就直接改代码
2. 即使调了，它也可能在门禁未通过时推进阶段

**模式不是提醒，是驱动。** 进入模式后，每一步开始前由状态机主动告诉模型：现在在哪、下一步做什么、什么被禁止。不依赖模型记得。

## 三层实现

| 层 | 作用 |
|---|---|
| 会话投影 | 折叠 `autoresearch/mode` 事件；恢复会话后仍处于模式 |
| 条件式提示章节 | 仅模式激活时注入，内容随阶段与门禁实时变化 |
| `agent/pre-step` 拦截 | 每步开始前把指令追加为**持久消息** |

前两层决定「模型能看到什么」，第三层决定「模型每步必然看到什么」。

第三层是关键：`agent/pre-step` 是瀑布事件，在每步组装请求前触发。追加的消息进入会话日志，因此**模型可见 ⟺ 已记录**，与 `plan-mode` 同样的时序。

## 进入与退出

在会话里输入：

```
/autoresearch          # 进入
/autoresearch off      # 退出
```

进入后界面「工作流模式」页签显示当前阶段、本步该做的事、本阶段门禁与缺失交付物。

## 注入的内容

每步注入的是一段 `<autoresearch_step>` 指令，含四部分：

```
阶段 2/4：题包构建与双镜像（第 2 章 构建 Repo）
本阶段目标：最终 Repo 只保留任务运行所需的标准目录……

本步应做的事：
  1. 处理门禁 G-FEASIBILITY（可行性判定门，里程碑 M2）
     该门禁最近结论为 REJECT。失败只修当前最早失败项，后续暂停。
  2. 补齐缺失的必需交付物（2 项）
     · task_identity.json —— Task ID、S1/S2/S3
  3. 本轮结束后立即记录八字段轨迹；未记录的这一轮不算发生过

待处理门禁：
  G-FEASIBILITY（M2）REJECT
  G-DOCKERFILE（M3）未运行
  G-NOP-RESULT（M3）未运行

模式纪律（本模式下必须遵守）：
  · 门禁未全部通过前不得推进阶段；不允许跳级与回退
  · 未知项写 UNKNOWN，缺失的命令/时间/退出码写 null 并解释，不伪造
  · 每轮迭代必须留八字段记录，score 以评分脚本实际输出为准
  · 交付物一改，旧的门禁结论即失效，必须重跑
  · 不访问未公开评测资产、不修改 solution/ 以外的任务文件、不篡改评分脚本
```

**顺序有讲究**：「本步应做的事」写在「待处理门禁」之前——先说要做什么，再说缺什么。顺序影响模型先动哪个念头。

**不写「你可以调用 X 工具」**：工具目录已经列了。模式只说现在该做什么，因为模式的职责是驱动，不是介绍。

## 提醒抑制

指令带一个指纹，由「阶段 + 各门禁结论 + 缺失数量」构成。

```
intake|G-SELECT=null|missing=2
```

指纹未变时**不重复注入**，只更新提示章节。这样：

- 阶段或门禁状态一变，下一步立刻收到新指令
- 状态没变时不把相同文本反复塞进上下文

提醒次数记在 `autoresearch/step` 事件里，可回放审计。

## 阻塞优先级

`blocking` 按「最早失败者优先」排序，且**未运行的门禁同样阻塞**——不能因为某道门还没跑就跳过它。

| 门禁状态 | 是否阻塞 | 指令怎么说 |
|---|---|---|
| `REJECT` | 是 | 「该门禁最近结论为 REJECT。失败只修当前最早失败项，后续暂停。」 |
| `NEEDS_EVIDENCE` | 是 | 同上（需补证也是未通过） |
| 未运行 | 是 | 「该门禁尚未运行。先补齐它的输入，再运行。」 |
| `RECOMMEND` | 否 | 全部通过时改为「可以推进到阶段 X」 |

## 与工具的关系

模式不替代工具，两者分工：

| | 工具 | 模式 |
|---|---|---|
| 谁发起 | 模型 | 状态机 |
| 何时 | 模型想起来时 | 每步开始前 |
| 内容 | 「有什么能力」 | 「现在该做什么」 |

模式注入的指令会引导模型去调对应工具，但即使模型没照做，下一步的指令仍会指向同一个阻塞项——**它绕不过去**。

## 状态从哪来

指令内容全部读自 `autoresearch-state.json` 与交付物实际存在性。模式**不持有自己的状态副本**（除了提醒指纹的缓存），因此：

- 门禁结论更新后，下一步的指令自动反映新结论
- 交付物一改，下一步就会看到它又缺了

缓存只用于「这次要不要注入」的判断，真相始终在状态文件与远端磁盘上。

## 已知限制

- **模式需要会话内切换**：`/autoresearch` 是命令，不能通过配置文件默认开启。这是刻意的——做题与随便聊天应当区分。
- **注入的消息是 user 角色**：system 提示在请求组装期固定，而这里要在步与步之间插入新指令。作为持久消息追加才能与日志一致。`source.kind` 标记为 `autoresearch-step`，便于与真人输入区分。
- **提醒抑制按会话内存**：进程重启后第一次一定注入，之后才按指纹抑制。这比「重启后静默」安全。

## 多任务并行：会话 ↔ 任务绑定（方案 A）

一个会话驱动**一个**任务根；同时推进 N 个任务 = N 个会话各绑一个根。
工作台面板（侧边栏 AutoResearch → 任务）总览全部注册任务，只读。

- `/autoresearch task <路径>` 把当前会话绑定到任务根；绑定存
  `DSH_HOME/autoresearch-session-tasks.json`（sessionId → 路径，重启仍生效）
- `/autoresearch task` 查看绑定；`/autoresearch unbind` 解除
- 工具的任务根解析顺序：**显式 task 参数 > 会话绑定 > 进程配置根**；
  绑定与默认根不同时，每步指令回显绑定路径并要求工具调用显式携带 task
- 会话绑定与默认根一致时不占指令篇幅 —— 指令里只有差异信息才值得占预算

工作台清单存 `DSH_HOME/autoresearch-workbench.json`；UI 支持登记/移除/按
父目录扫描（判定标记：`task.toml` 或 `autoresearch-state.json`）。

## 模式激活时的工具限制

限制是**每个 agent 自己的** scoped 生效，两条覆盖路径缺一不可：
`agent/created`（创建时已激活：配置驱动、重启恢复）与命令处理器（会话中途
进入/退出，agent 已存在）。曾经的 bug：这段逻辑被错误嵌进命令处理器的
leaving 分支，只有退出模式才注册限制且无条件生效。

## /autoresearch 的自动登记（不写死路径）

不带参数进入模式 = 「把当前目录的任务纳入工作流」。命令处理器自己完成识别
与登记（确定性代码，比让模型自由发挥可靠）：

1. 已绑定 → 沿用
2. 会话 cwd 本身是任务根 → 绑定 + 登记工作台
3. cwd 一级子目录里恰好一个任务根 → 绑定 + 登记
4. 多个候选 → 列出让用户选，不猜测
5. 都没有 → 如实说明，指引 autoresearch_init

任务根判定标记（三种来源都算）：`autoresearch-state.json`（init 写的状态）、
`workspace/harbor_task/task.toml`（教程 V3 权威位置）、顶层 `task.toml`。
实测教训：只认自己的状态文件会把按教程手工搭的任务包拒之门外。

`autoresearch_init` 同样在创建后自动登记 + 绑定当前会话 —— 「任务在某目录
存在」与「工作台看得见它、本会话驱动它」是同一件事，不该让用户做两遍。

## 桌面端默认完全访问

桌面壳给 harness 设 `DSH_PERMISSION_MODE=danger-full-access`。原因：默认的
workspace-write 要在会话工作目录写受限 SID 的 ACE，需要目录的 WRITE_DAC
权限；用户机器上多数目录只有 Modify，授予阶段直接
`SetNamedSecurityInfoW failed (Win32 5)` 失败 —— 所有 pwsh 都跑不了，每个
新会话都得手动切「完全权限」。教程要求的任务隔离由 Docker 提供，本沙箱是
桌面编辑器自身的文件护栏，放开不削弱隔离。lane 环境同此设置。

## 注入消息必须带 id（存储校验，实测踩过）

`agent/pre-step` 注入的 user 消息会被持久化为 `user/message` 事件。存储层校验
每条消息事件必须有**非空 `id`**（`assertMessageEventShape`），缺失时**整个会话
日志被拒绝加载**（「历史加载失败：stored session is corrupt」）。

规范路径是 llm 包的 `createUserMessage`（自动生成 uuid）；本项目不引依赖，
`createStepMessage` 手写 `id: randomUUID()` —— 等价。

第一版没写 id，后果：**所有含注入消息的历史会话全部无法加载**，且损坏在
写入瞬间已定型（读取端无法豁免）。修复脚本
`python scripts/repair-session-ids.py` 扫描会话日志给缺 id 的消息事件补
uuid（逐事件多帧 zstd 读、单帧重写、先备份）；只补身份不改对话内容。

## 命令交互的两个实测教训（/autoresearch 无反应事件）

1. **声明 `input` 的命令第一次 Enter 是「认领参数」，不执行**。composer 保留
   `/autoresearch ` 等待参数，用户视为「没反应」，再按一次才执行 —— 日志里
   args 全是空格就是证据。最常用的无参进入必须零摩擦：`/autoresearch` 不声明
   input（bare Enter 直执行）；参数化子命令拆成独立命令
   `/autoresearch-off`（退出）、`/autoresearch-task <路径>`（绑定，参数必需，
   claim 合理）。
2. **命令成功要有跨面板的强反馈**。命令结果只渲染成对话流里一张折叠的小卡片
   （`GenericCommandCard`），用户完全无感。修复：client 侧监听
   `command/executed`（与 shipped 的 session-log-export 同写法），成功后
   `ctx.layout.selectPanel(PANEL)` 自动切到工作台 + 广播刷新。
   坑：client 插件访问 `ctx.layout` 必须在 inject 数组声明 `'layout'`，
   否则 cordis 以 `cannot get property "layout" without inject` 拒绝。

模式状态由两个命令共同驱动：`/autoresearch`（进入）与 `/autoresearch-off`
（退出），foldMode 对两个命令名都折叠。

## Windows 工具体验守卫（编码 / sleep）

两台实测教训固化为 `lib/windows-guard.js`（tools.guard，全局生效含双路 lane）：

1. **编码**：机器只有 PowerShell 5.1，管道输出默认 GBK 而 harness 按 UTF-8 解码
   —— 模型写的含中文 pwsh 命令结果全是乱码（实测 `echo '中文'` 返回乱码字节，
   `[Console]::OutputEncoding.WebName = gb2312`）。守卫在「命令含非 ASCII 且未含
   OutputEncoding」时拦截，拒绝消息直接给出修复模板
   （`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=...`
   前缀 + .ps1 须 UTF-8 with BOM）—— 实测加前缀后中文正确。PreToolDecision
   不允许改写输入（参数已入日志），所以是「拦截教学」而非静默改写。
2. **sleep 轮询**：拦截 >3 秒的 Start-Sleep/sleep/timeout/ping 空等，教正确做法：
   本地进程 -Wait/Wait-Process；远端任务用 autoresearch_remote_probe_job 逐次
   探测（每次都是重新评估的机会）；≤3 秒短暂等待放行。

彻底解法（可选）：安装 PowerShell 7（harness 优先使用 pwsh 7，重定向输出默认
UTF-8），守卫仍保留作为行为约束。
