# 远端执行与持久化

GPU 与 Docker 在租用的服务器上，而 SSH 连接不稳定。这套机制让长跑任务不依赖连接的存活。

## 依据

SOP 实战教训（`field-lessons.md` L8）已把这条写成正式结论：

> **SSH 门户不稳**｜长命令被掐｜远端脚本 + `setsid nohup`；**短命令探测**；关键链路自驱动不依赖控制端

编排器的三条硬规则同样适用（`tools/orchestrators/README.md`）：

1. **幂等** —— 每个阶段可重复执行，不产生重复任务
2. **缺证据不推进** —— 完成度看完成标记，不用文件扩展名猜测
3. **绝不静默成功** —— 失败写标志文件而非沉默退出

## 核心思路

**控制端只负责投递与查询，不负责持有进程。**

SSH 连接随时断开都不影响远端任务，因为：

| 机制 | 作用 |
|---|---|
| 脚本先落盘再启动 | 控制端断开不影响已在远端磁盘上的脚本 |
| `setsid nohup ... </dev/null` | 进程脱离控制端会话，成为独立会话首进程 |
| `flock -n 9` | 同名任务只有一个实例；链路抖动时可直接重投 |
| 完成/失败标记文件 | 重复投递时已完成的阶段直接跳过 |
| 状态写在文件里 | 每次查询都是重新读文件，与上次连接无关 |
| SSH 保活参数 | 抖动时尽快发现并重连，而不是挂死 |

## 三条纪律的落地

**幂等。** 每个任务脚本开头有两道守卫：

```bash
if [ -f "$DONE" ]; then say "SKIP: already done"; exit 0; fi
exec 9>"$LOCK"
if ! flock -n 9; then say "SKIP: another instance holds the lock"; exit 0; fi
```

因此投递失败可以直接重投，不会产生重复训练。

**缺证据不推进。** `phase` 只由标记文件决定：

| phase | 依据 |
|---|---|
| `complete` | `.done` 标记存在 |
| `failed` | `.fail` 标记存在 |
| `running` | 状态文件说 running **且** `kill -0 <pid>` 存活 |
| `stalled` | 状态文件说 running **但**进程已不在 |
| `pending` | 无任何标记 |
| `unknown` | 连接失败 |

`stalled` 是有价值的区分：机器被回收时进程消失但无失败标记，这提示需要在新实例上恢复快照，而不是重跑。

**绝不静默成功。** 查询失败返回 `unknown` 并标明是否可重试，**不猜测状态**。快照失败返回 `captured: false`，**不写清单**。

## 使用流程

### 1. 登记目标并探测能力

```
autoresearch_remote_target {
  id: "gpu-a", host: "1.2.3.4", user: "root",
  port: 22, identityFile: "~/.ssh/id_ed25519", remoteRoot: "/root/.autoresearch-remote"
}

autoresearch_remote_probe { target: "gpu-a" }
```

探测结果直接回答「哪些门禁能在这里真跑」：

```
可执行能力：
  训练 / CPU 任务：可（含 GPU）
  双镜像构建：可
  NOP Trial 全链路：可
```

缺 Docker 或 buildx 时会明确说明「双镜像构建与 Harbor 自验不能在本远端完成」；有 GPU 但 nvidia runtime 未注册时也会指出——这正是 SOP 规则 17 的第一项前提。

### 2. 投递任务

```
autoresearch_remote_submit {
  target: "gpu-a",
  jobId: "baseline-s41",
  workDir: "/root/work/baseline-s41",
  command: "python train.py --seed 41",
  kind: "train"
}
```

投递后立即返回，不等任务结束。任务在远端独立运行。

### 3. 查询（可以随时、反复、断线后继续）

```
autoresearch_remote_probe_job { target: "gpu-a", jobId: "baseline-s41" }
```

### 4. 采集机外快照

```
autoresearch_remote_snapshot {
  target: "gpu-a", jobId: "baseline-s41",
  paths: ["/root/work/baseline-s41/model.pt", "/root/work/baseline-s41/run.log"]
}
```

归档带回本地 `expert_evidence/remote-snapshots/`，附 SHA-256 清单。教程 M4 的 `snapshot_restore_probe` 要求机外快照——**机器可能被回收，证据必须在机外**。

### 5. 机器被回收后在新实例续接

```
autoresearch_remote_restore {
  target: "gpu-b",                        # 新实例
  archive: "expert_evidence/remote-snapshots/snapshot-2026-10-10T12-00-00-000Z.tar.gz",
  remoteDir: "/root/work"
}

autoresearch_remote_submit {
  target: "gpu-b", jobId: "baseline-s41",
  workDir: "/root/work/baseline-s41",
  command: "python train.py --seed 41"
}
```

恢复前会校验归档哈希与清单是否一致，**拒绝用损坏归档覆盖远端状态**。重新投递时脚本检测到完成标记会跳过已完成部分。

### 6. 体检

```
autoresearch_remote_status { refresh: true }
```

列出目标与任务、指出未完成/未知/长时间未探测的任务、报告快照数量。界面「远端执行」页签显示同一份数据。

## SSH 容错参数

| 参数 | 默认 | 作用 |
|---|---|---|
| `ServerAliveInterval` | 15 | 每 15 秒发一次保活 |
| `ServerAliveCountMax` | 3 | 3 次无响应即断开重连 |
| `TCPKeepAlive` | yes | 底层 TCP 保活 |
| `ConnectTimeout` | 20 | 连接建立超时 |
| `BatchMode` | yes | 不交互提示；认证失败立即报错而非挂起 |
| `retries` | 3 | 链路类失败重试次数（指数退避） |
| `retryBackoffMs` | 2000 | 退避基数 |

**可重试与不可重试的区分**（`isRetryableFailure`）：

- **可重试**：`ssh` 退出码 255、超时、`Connection reset`、`Broken pipe`、`kex_exchange_identification`、`Network is unreachable`
- **不可重试**：`Permission denied (publickey)`、`command not found`

前者重试有意义（链路是短暂的），后者重试只是浪费——直接报错让人修配置。

## 账本：缓存不是真相

本地 `.autoresearch-remote/ledger.json` 只记「任务叫什么、在哪、该看什么」。**真相在远端的状态文件与标记文件里**：

- 控制端重建、换机器、丢账本都不影响续接——重新探测即可恢复视图
- 探测只追加 `lastProbe`，不覆盖登记信息
- 连接失败时不写账本（连接失败不等于任务失败）

这条是刻意的：如果本地成为真相，就会出现「本地说完成了但远端还没跑完」这类静默错误。

## 界面

「远端执行」页签显示：

- 远端目标（连接串、远端根目录）
- 任务列表（状态徽章、类别、提交与探测时间）
- 未完成任务提示
- 机外快照列表（大小、时间），无快照时明确标注「机器被回收时它决定你能否续接」

## 已知限制

- **需要宿主的 `ssh` 客户端**（OpenSSH）。插件不接收也不存储密钥内容，凭据走 SSH 密钥或 ssh-agent。
- **控制端仍需在线投递与查询**。任务一旦投递即可离线，但无法在完全无网的环境下投递。
- **快照是整包传输**。大 checkpoint 会占用传输时间；建议只快照必需产物，而非整个工作目录。
- **远端环境能力如实报告，不做建议**。是否租什么规格、是否值得跑，由你的预算与平台规则决定——`gpu-budget.md` 与 `gpu_budget.py` 提供离线估算，但不报市场价、不下单。
