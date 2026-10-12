# 出题实战教训（2026-10-07 一轮失败录 · MNO/NeurIPS2022）

> 来源：AutoRe0566（Learning Chaotic Dynamics in Dissipative Systems / neural-operator/markov_neural_operator）完整一轮出题实践。
> 结果：**未出成**（Re=500 全路线失败 → 转 Re=5000 → 首配置失败 → 半径扫描中）。
> 代价：~420 元 GPU + ~26h 墙钟。本文件只记**可复用的判断与流程改进**，不复述过程。
> 用法：这些条目在 P0/P1 阶段**强制**过一遍，作为 SOP §4.1 的补充检查项。

---

## L1 ★★★ 探针优先原则（本轮最贵的教训，约 200 元）

**错误做法**：选题确定后直接投入"完整协议"（全 seed × 全角色 × 官方超参），跑 12 小时才发现 B/R 无区分度。

**正确做法——三阶段递进，每阶段失败即止损**：

| 阶段 | 规模 | 耗时预算 | 通过条件 | 失败动作 |
|---|---|---|---|---|
| **P1.0 增益探针** | 1 seed × (B+R)，官方脚本原样 | **≤ 单跑耗时 × 2**（如 2h） | Δ 为正且量级足够（见 L2） | **立即停**，换切入点或换论文 |
| **P1.1 判定探针** | 2–3 seeds × (B+R) | ≤ 6h | Δ/σ_B ≥ 3 且 R_norm ∈ [0.15,0.8] | 调整协议（须记录）后重跑 P1.0 |
| P1.2 正式 B/R | 全 seed 集 | 1–2 天 | 全部门通过 | 返修 |

**硬规则**：
- **P1.0 未通过，禁止启动 P1.2**。不许以"再跑几个 seed 看看"为名扩大投入。
- P1.0 的 checkpoint 与日志**全部保留**（它可能就是 P1.2 的 seed 1，协议不变时可直接计入）。
- 探针阶段**必须用论文主打规模**（见 L3），不用"小一号"的替代设置。

## L2 ★★★ 判定条件必须"先算后跑"（本轮次贵的教训，约 150 元）

**错误做法**：跑完 B/R 才去算 R_norm 和 3σ_B，结果两者数学上**互斥**（R_norm 要求 B_mean 高 → seed 散布大 → 3σ 必挂）。

**正确做法**：在 P1.0 之前，用**已有数字**（1 个 seed 的 B/R + 真值侧地板 U）**预解**判定空间：

```
给定 U（真值侧地板，一次性算好）、B_1（首个 baseline seed）、R_1：
  ① R_norm 合规要求：B_mean ≥ (R_mean − 0.15·U)/0.85   （minimize 情形）
  ② 3σ 门要求：Δ = B_mean − R_mean ≥ 3σ_B，而 σ_B ≈ 由 seed 散布决定
  ③ 写出两个要求对"seed 散布"的依赖，检查是否存在**可行交集**
若不存在交集 → 该 (指标, 规模, 协议) 组合**结构性不可行**，立即改指标或改规模
```

**本轮实例**：`R_norm ≥ 0.15 需 B_mean ≥ 0.1475`（比 seed1 高 9%）；而达到这种 B_mean 需要 seed 间差异 ~0.012 → `3σ_B ≈ 0.035 > Δ ≈ 0.005–0.018` ✗ → **结构性死局**，跑之前就能算出来。

## L3 ★★ 指标必须直译论文的主张（根本性错误）

**错误做法**：论文的核心现象是**耗散性/稳定性**（Figure 1：无正则 baseline 崩坏、有正则回归吸引子），我却测"长期统计量离真值多近"——**两个不同的科学问题**。论文的主张**不蕴含**"MNO 的统计误差更小"。

**正确做法**——P1 阶段强制回答三个问题并写进协议：

| 问题 | 反例（本轮） |
|---|---|
| ① 论文的**一句话主张**是什么？ | "耗散性设计使学习的算子能留在吸引子上" |
| ② 我的指标是否**直接测量**该主张？ | ✗ 我测的是统计精度，不是稳定性/吸引力 |
| ③ 若论文的机制**完美实现**，我的指标会变好吗？ | ✗ 会变好一点，但不是论文主张的"量级差异" |

**推荐做法**：优先**复用论文自己的主图/主表指标**（如本轮的 Figure 1 是"rollout 是否崩坏"），而不是自造一个"看起来合理"的指标。自造指标须在协议里写明"与论文主张的映射关系"。

## L4 ★★ 参数标定：先数值反推，再动手（本轮 ~50 元）

**错误做法**：论文的 README 给了一句模糊表述（"内半径的**下界**应为 `norm(data).max()`"），我按字面取均值 86,204 → 球壳覆盖吸引子 → 过阻尼 → 参考解崩。

**正确做法——三段式标定**：

1. **数值反推官方常量**：拿官方在**已有规模**上的取值，与数据统计量对比，推断官方**真实意图**
   - 本轮：官方 Re=500 用 `156.25×64 = 10000`，而该数据 `norm×S` 的 **min = 13786** → **官方值比"下界"还小 0.73 倍** → 说明官方是"**吸引子内软约束**"，不是"球壳在吸引子外"
   - ⇒ 一句话：**用官方已给的数字做反推，胜过按文档字面新算一个值**
2. **若必须跨规模换算**：优先照抄**同一公式**（如 `156.25*S`），而不是"按文档描述重算"
3. **扫描要有界且有依据**：候选数 ≤ 3–4 个，每个候选必须能说出"它对应文档/代码的哪种读法"；扫描用**探针规模**（1 seed）

## L5 ★★ 失败后的第一反应：怀疑指标，而不是加密配置

**错误做法**：8:20 首次判定失败，我的第一反应是换配对（P1 等容量）、换基线架构（U-Net）——**多烧 4h 与两次无效训练**。

**正确做法**——失败诊断的**固定顺序**（成本从低到高）：

| 顺序 | 检查 | 成本 |
|---|---|---|
| 1 | **指标是否测对了论文主张**（L3） | 0（重读论文） |
| 2 | **判定条件是否结构性可行**（L2） | 0（纸面计算） |
| 3 | **超参标定是否正确**（L4 数值反推） | 30 min |
| 4 | 实现的容量/预算是否匹配（同参数量、同 epoch） | 1 探针 |
| 5 | 换配对/换架构/换数据集 | 贵，最后才做 |

## L6 ★ 失败必须区分"论文不成立"与"我配置错"

本轮诊断结论：**论文的主张未被推翻**，是（a）我的指标不对题（b）我的标定错。两者都**不是论文的错**。

**规则**：写失败归因时，必须给出**至少一条"论文主张仍然可能成立"的证据**；不能笼统写"论文不可复现"。同时**不能**因为"论文对"就无限追加试错（L1 的探针预算就是上限）。

## L7 ★ 交付物资产化的正收益

即使题目失败，以下资产**100% 可复用**（换题边际成本 ~1–2 天）：
- 双镜像（Dockerfile/test.sh/make_reward）——数据无关
- 冻结评分器框架（指标可换、质量门可换、anchor 机制保留）
- 自动化链（编排器/回填器/监测/参数化器/转换器/汇总器/finalize）——数据无关
- 数据管线（下载/派生/真值/地板）——只改路径
- 双轨环境（两台机器 + codex + 双模型 + 同步机制）
- 填表文字模板（c13/c16/c17/c19 + 成本四列）

**做法**：从第一轮起就把这些写成"与数据集解耦"的脚本（本轮做到了，所以换 Re5000 只花了 1 小时）。

## L8 ★ 环境与数据的易错点（本轮实测，可直接抄）

| 坑 | 症状 | 处理 |
|---|---|---|
| 官方脚本 `sys.path.append('../')` | `ModuleNotFoundError: utilities` | 按官方目录布局铺 `utilities.py`/`dissipative_utils.py`/`models/` 到父目录，**不要改脚本** |
| 官方脚本 `torch.save(model, path)` **无扩展名** | 按 `*.pt` 找 checkpoint 恒失败 | 用 `run.log` 的 `Weights saved` 判断完成；找文件按"最大的非 json/log 文件" |
| pickle 引用官方模块 | `No module named 'fno_2d'` | 转换时把官方仓 root 与 models/ 加进 `sys.path` |
| `domain_size` 硬编码 | rollout `shape invalid` | 转换器加 `--domain-size` **并做一次前向尺寸校验** |
| 生成脚本的 CRLF | bash `syntax error near '\r'` | `sed -i 's/\r$//'`，且**写入时用 LF** |
| SSH 门户不稳 | 长命令被掐 | 远端脚本 + `setsid nohup`；**短命令探测**；关键链路自驱动不依赖控制端 |
| 多实例并发 | 重复启动训练抢卡 | 全局 flock + 按 `/proc/*/cwd` 检测已运行任务 |
| 官方 stdout 块缓冲 | 中途看不到 epoch | 用 GPU 利用率 + 进程 cwd 判断在跑；ETL 用别的信号（如 `model/` 出现） |
| 论文 README 的模糊参数 | 参考解崩/无区分度 | 见 L4：**数值反推官方常量** |

## L9 ★ 成本与排期的诚实估算

- **单跑耗时要实测**（本轮 Re=500 估 3.5h 实测 8.7h；Re=5000 估 2h 实测 1.1h）→ 探针阶段顺手记录耗时，**不要用论文的 epoch 数 × 猜测的速度**。
- 预算要按**分支期望**报：`E[成本] = Σ 分支概率 × 分支成本`，而不是"最顺利路径"。
- 失败后的追加投入必须**有明确上限**（本轮设了"扫描 3 候选 + 1 轮探索，否则止损"）。

---

## L10 ★★★ 五道不可跳级里程碑（吸收自 autoresearch-skills v0.3.4 的 shift-left QA）

这是本仓库最重要的结构升级：把"检查"从"最后集中质检"改成**五道按序门禁，任一不过不进入下一阶段**。
依据：本项目 9 条题线的失败，全部可归入"问题在长跑/打包后才暴露"（新增计算只扩大返工面）。

| 里程碑 | 进入下一阶段前必须已具备的证据 | 失败动作 | 本项目的对应事故 |
|---|---|---|---|
| **M1 selection** | 论文身份、许可边界、**方法级优化面**、题库权威状态 | **换题或补证；不写题面、不租卡** | 0565/1851/1430/1352 全在此该被拦 |
| **M2 pilot** | B/R **receipt**、独立复算、**效应/噪声结论** | 修协议或拒题；**不启动双轨** | 0566：无 pilot 直接全 seed，亏 ~480 元 |
| **M3 container** | Agent/Verifier 镜像 digest、Hidden 隔离、目标 Harness 完整 trial | 修构建与路径；**不计长跑时长** | 双镜像 V01–V05 已过（本阶段我做对了） |
| **M4 long_run** | 两条独立血缘、闭合有效时长、机外快照与恢复 probe | 补真实运行；**不得拼接旧轮次** | 2001 三会话互写权重（血缘污染） |
| **M5 release** | 两份独立 QA 报告、机器聚合共识、隐私报告、白名单 manifest | 任一失败即 **NOT READY** | 0340「备好≠已交」；EMERALD 无结论 |

**门禁语义（照抄其原则，不妥协）**：
- **不做总分补偿**：热度、引用数、新颖性不能抵消许可/评测/资源/交付失败
- 三态结论：`RECOMMEND`（全部硬门 PASS）/ `NEEDS_EVIDENCE`（有 UNKNOWN/REVIEW）/ `REJECT`（任一 FAIL）
- 非发布里程碑的检查器**只核对证据引用是否齐全**；`release` 门才重算 SHA256、核对两份 QA 同源不同会话

**最小返修循环**（也是他们的规则，非常实用）：
1. **只修当前最早失败的里程碑**，后续阶段暂停
2. 用**新 run/trial ID** 重跑最小证据，不改写旧 receipt
3. 比较修复前后冻结合同与来源哈希，确认没有换题/换分母/换 evaluator
4. 重跑本里程碑门禁 **及所有受影响的上游门禁**
5. 只有当前里程碑重新通过，才恢复下一阶段

**关键限定**（他们说得很清楚，我也认同）：这套流程**降低返修成本，但不保证零返修**。目标是让失败尽早、边界清楚、可重放。

---

## L11 ★★★ 原生 NOP Trial 是"环境类"事故的重灾区（2026-10-08 auto2768 实录）

> 来源：auto2768（DREAM / 图标签噪声）返修轮。此前包内只有"手工 Docker 模拟"被当成 NOP，
> 被平台判为**不能证明原生 Harbor NOP**，触发 H06/QA17 不通过。
> 修复后跑通原生 Trial 两次（首次 692.2s、缓存命中后 35.0s），本条只记**可复用的判断与操作**。

**核心认知**：NOP 的 0 分**不是失败**，它证明的是**链路**（镜像能建、容器能起、独立 Verifier 能执行并落地 reward）。
真正会失败的是**环境前提**，而且这些前提**在跑之前就能查**。

### 环境前提清单（跑 NOP 前逐条实测，不要假设）

| 前提 | 检查命令 | 典型失败 | 修法 |
|---|---|---|---|
| Docker 能申请 GPU | `docker run --rm --gpus all <img> nvidia-smi -L` | `invoking the NVIDIA Container Runtime Hook directly is not supported` | 见下"snap Docker 陷阱" |
| nvidia runtime 已注册 | `docker info --format '{{json .Runtimes}}'` | 只有 `runc`，无 `nvidia` | 装 `nvidia-container-toolkit` 并在 daemon.json 注册 |
| buildx 存在 | `docker buildx version` | `unknown flag: --file` | 装 buildx 插件到 `~/.docker/cli-plugins/` |
| compose v2 存在 | `docker compose version` | `docker: 'compose' is not a docker command` | 装 compose v2 插件 |
| 宿主容量 ≥ 题面声明 | `nproc`、`free -g` vs `task.toml` 的 `cpus`/`memory_mb` | `Range of CPUs is from 0.01 to 8.00` | 见下"资源施加方式" |
| 网络可达 GitHub/PyPI | `curl -sI https://github.com` | `early EOF`、`index-pack failed` | 用 codeload tarball 或代理 |

### ★ snap 版 Docker 的结构性陷阱（本项最隐蔽）

**症状**：`--gpus all` 报 `invoking the NVIDIA Container Runtime Hook directly is not supported`；
补装 toolkit 后变成 `mkdir /usr/bin/nvidia-cuda-mps-control: read-only file system`。

**根因**：snap 版 Docker 的 dockerd 跑在**只读挂载命名空间**里，CDI 规范要求逐个 bind mount 宿主文件，
被只读命名空间拒绝。这不是配置错误，是**包装方式的结构限制**。

**判定**：`snap list docker` 显示 `confinement: strict` + 挂载命名空间内 `/usr` 只读 ⇒ 必然失败。

**修法（已验证）**：起一个**私有 dockerd**（宿主命名空间），与 snap 版并存互不干扰：

```bash
cat > $B/daemon.json <<EOF
{ "runtimes": { "nvidia": { "path": "/usr/bin/nvidia-container-runtime", "runtimeArgs": [] } },
  "storage-driver": "overlay2", "log-level": "error", "default-runtime": "runc" }
EOF
nohup /usr/bin/dockerd --host unix:///$B/docker.sock --pidfile $B/dockerd.pid \
  --data-root $B/docker-data --exec-root $B/docker-exec \
  --config-file $B/daemon.json --containerd /run/containerd/containerd.sock \
  >> $B/logs/dockerd.log 2>&1 &
export DOCKER_HOST=unix:///$B/docker.sock
docker run --rm --gpus all <cuda-img> nvidia-smi -L      # 必须实测通过
```

**共享机器时的隔离纪律**：若目标机已有其他题线在用（如租用机上另一道题在跑），
必须使用**独立根目录 + 独立 dockerd + 独立镜像名**，不碰对方的 data-root / 镜像 / 工作树。
这是可复用的做法，不是"抢机器"。

### ★ 构建超时：镜像源是合法加速，不是"取巧"

**症状**：`timed out after 1800`（题面声明的 `build_timeout_sec`）。根因是从官方源拉 torch 约 0.5 MB/s。

**正确做法**：镜像源（清华/阿里）只是同一批 wheel 的不同 CDN，
`torch>=2.5.1` 这类**声明式版本约束**装出的版本与二进制完全一致。
**不要**把它当成"证据不干净"而拒绝——那是把"证据要干净"错误外推成"不能换下载源"。

**关键纪律**：加速必须走**试验层**（不改交付包字节），例如 Harbor 的
`environment.extra_docker_compose` 注入 `build.args.PIP_INDEX_URL`。
交付包的文件哈希必须仍与运行绑定一致（见 L13）。

### ★ 资源施加方式与"声明容量"的落差

题面声明 `cpus=16 / memory_mb=65536`，而租用机只有 8CPU/16GB ⇒ 按声明设限会触发
Compose 的 CPU 范围错误而**无法启动容器**。

**做法**：试验层设 `cpu_enforcement_policy: ignore` / `memory_enforcement_policy: ignore`，
**并把这一差异如实写进 evidence**（含宿主 `nproc`/`free` 实测值）。
**不得隐瞒**：GPU 数量、网络策略、Verifier 分离方式必须与交付题包完全一致，
差异只允许出现在"施加方式"上，且必须留痕。

### ★ NOP 结果的正确解读（判据）

```json
{"status":"INVALID","failure":"FORMAT_ERROR","hard_gate":false,
 "candidate_fault":true,"reward":0.0,
 "detail":"missing prediction file: /workspace/solution/artifacts/<ds>/test_pred.npy"}
```

- `hard_gate: false` ⇒ 未触发 LABEL_LEAK / QUALITY_GATE 等**非作弊硬约束**，这是预期分支。
- 该 0.0 是"没有提交物"的**正确值**，既不判失败，也不等于通过。
- NOP 要验证的四条链路：**镜像能构建 / 容器能起 / 独立 Verifier 在 separate 模式真实执行 / reward 正确落地**。

**通过判据（全部满足）**：`finished_at` 有值、`exception_info` 为空、
`verifier_environment_mode == "separate"`、`verifier_result.rewards` 为有限数值且与
`reward.txt`/`reward.json` 一致、同一次 Trial 的 config/result/日志/artifacts manifest 齐备。

### ★★ 语义纠偏：NOP = "Agent 不做任何操作"，**不是** "Hidden 不注入"（2026-10-09 auto0340 实录）

**我最初的错解**：把 NOP 做成"**不注入 Hidden 数据** ⇒ `test.sh` 的 fail-closed 提前 `exit 2`
⇒ 不产 reward"，并且认为"不产 reward"本身就是正确结果。

**为什么错**：官方 H06 自动校验要求 `verifier_result.rewards` **与 reward 文件一致、且为有限数值**；
**没有 reward 文件时校验器直接判"材料不完整"**（`H06 pass requires config.json, result.json, verifier/reward.*, and trial.log ...`）。
官方口径原话是「**0 分可能是预期，也可能来自错误早退，必须结合异常、退出状态与评分日志判断**」——
也就是说 **NOP 应当走完整条评分链路并产出一个（通常为 0 的）分数**，而不是提前退出。

**正确做法**：**注入 Hidden + Agent 设 nop + 跑完整评分**。为了在有限机时内跑完，
把单次预算压小、让评分器自己降级（实测 `VG_RUN_TIMEOUT=1500 VG_EVAL_EPISODES=2`
⇒ 内部 `plan_budget()` 把 100000 步自动缩到 3397 步，**并把降级写进 `reward.json::degradations`**，不静默改协议）。
实测结果：`Agent rc=0 / Verifier rc=0 / reward.txt=-0.000234`，四件套齐、判定 PASS。

⇒ **判据：NOP 里若"没有 reward 文件"，先怀疑是自己的 fail-closed 太靠前，而不是"这就是预期"。**

### ★★ reward 产物的命名与格式契约（同一次实录，可与 L12 对照）

| 约束 | 实测症状 / 做法 |
|---|---|
| `verifier/reward.txt` 必须是**单个数值** | 写 `NOT_PRODUCED` 之类字符串 ⇒ 校验器 `float()` 直接抛 `reward.txt must contain a single numeric value` |
| **评分产物不要占用 `verifier/reward.json` 这个名字** | 校验器优先读 `reward.json` 并当作"数值 map"解析；而评分产物是嵌套结构（`per_seed`/`degradations`/`anchors`）⇒ 报 `reward must be a nonempty numeric map with finite values, not status strings/bools`。**改名为 `reward_full.json`** 即可两全 |
| `config.json` 的 `agent.name` 与 `result.json` 的 `agent_info.name` 必须一致 | 不一致直接判失败（`H06 requires consistent config/result Agent names`） |
| 证据必须**同目录、同一次 Trial** | `config.json` + `result.json` + `verifier/reward.*` + `trial.log`（或 `verifier/test-stdout.txt`）缺一不可 |

## L12 ★★★ 质检 Skill 的契约字段必须一次性对齐（21 次报错的教训）

> 来源：auto2768 质检轮。同一份 review.json 撞了 **21 次 `inspection_error`**、13 种不同错误。

**错误做法**：改一处 → 重跑 → 撞下一个错 → 再改。高频重复项：`QA17.remediation` **6 次**、
`H06 requires config.json` **5 次**。

**正确做法**：动手写 review.json 前，**先把校验器的约束清单一次性列全**：

```bash
# 把 validator 里所有会 raise 的字段约束抓出来，对着清单改，不靠试错
grep -n "raise ValueError" <qa-skill>/scripts/*.py
```

**已实测的高频字段约束（照抄即可少走弯路）**：

| 约束 | 说明 |
|---|---|
| `harbor.path_contract.profile` + `profile_basis` | 必填；profile 取 `harbor-environment-v1`（当前默认）或 `teaching-task-root-v1` |
| `hidden_review.mode` | 必须是 `prebuilt` / `generated` / `injected`；prebuilt 还需 `asset_paths` 指向**真实非空文件** |
| H 项 `summary` | **≤220 字符**，超出即报 "concise summary and evidence array required" |
| 证据引用 | 必须是**文件**，不能是目录（`tests/private/` 这类目录引用会被拒） |
| H06 证据 | 必须同一次 Trial 的 config + result + reward + 日志**全在证据列表里** |
| G 门 | `status`、`summary`、`reason_code` **三者都非空**；fail/manual 还须 `remediation` 与 `acceptance_evidence` |
| QA17 | 状态由 H01–H06 **聚合**得出，不能手填覆盖；其 `remediation` 在非 pass 时强制非空 |
| overview 统计量 | 必须与 `paired_runs` **全精度**一致（脚本按 `rel_tol=1e-7` 比），写 4 位小数会被判"与逐 seed 重算不一致" |
| `duration_hours` | 必须 ≥ `effective_seconds/3600`；**浮点边界会咬人**：`11.0036×3600 = 39612.96 < 39613` |
| `duration_evidence` | 必须是 collector 生成的**原始候选串精确匹配**（前缀须等于 `source_path`） |
| `risk_notes` | 必须是字符串数组 |

**入口差异**：来源附件的 `audit_task.py` **不支持 `--review`**（传了也白传，报告会退回初稿状态），
必须用 `implementation_review.py`。且**输出目录必须新鲜**（已存在会被拒）。

**注意**：这些是**报告结构约束**，不是题目缺陷。撞它们不代表包有问题，但反复撞会掩盖真正该看的证据。

## L13 ★★★ 运行绑定的哈希必须与交付字节交叉验证

> 来源：auto2768。这是把"NOP 记录"从"一份日志"升级为"可验证证据"的关键一步。

**做法**：NOP/正式 Trial 运行**之前**，对题包树算全量 SHA-256 清单并随证据归档：

```
task-tree-hashes.json  ← {"files":[{"path":"...","sha256":"..."} , ...]}
```

**验证**：交付 zip 内对应文件逐个比对，**必须逐一相同**。

```python
rec  = {e['path']: e['sha256'] for e in load('task-tree-hashes.json')['files']}
ship = {n[len('workspace/harbor_task/'):]: sha256(read(zip, n)) for n in names if ...}
assert rec == ship        # 逐文件一致
```

**为什么重要**：没有这一步，"我跑过 NOP"只是自陈；有了它，才能证明**跑的就是交付的那份字节**，
而不是另一个副本。这是回应"哈希与交付文件不一致"类质控意见的唯一硬手段。

**连带纪律**：任何交付包内的字节改动（哪怕只是文档措辞）都会让绑定失效，
必须**重跑一次 NOP 并重新生成哈希清单**。代价已实测：缓存命中时**约 35 秒**（首次构建约 11.5 分钟）。

## L14 ★★ 同一事实的多个声明必须对齐（U/锚点类"双真源"）

> 来源：auto2768。包内对同一个上界 `U` 存在**两套互相排斥的声明**，比措辞问题严重得多。

**实测**：`tests/calibration.json`（生效）写 U=75.1333；而 `expert_annotation.json`、
`repair/protocol_decisions.json`、`专家作业说明文档.md` 三处写 U=100.0，
且 `protocol_decisions.json` 自称 `no_post_result_upper_bound_tuning: true`。

**时间线暴露真问题**：U 在正式 B/R 结果**之前**预登记为 100，在结果**之后**改为 75.1333
⇒ 与"不得见结果后调上界"的自我声明**直接冲突**。

**正确做法（已采用）**：
1. 把生效值统一为实际使用的锚点，其余作为**明确标注的口径对照**（两种口径下归一化 0.6528 / 0.2269 均在 [0.15,0.8]）。
2. 把 `no_post_result_upper_bound_tuning` 改为 `false`，**并写明变更发生在结果之后**。
3. 在公开协议里明确 `U` 与"数学上限 100"是**两个不同的量**（前者是奖励锚点，后者是资格分母用的天花板）。

**原则**：**宁可如实披露一次口径变更，也不要留一个自相矛盾的 `true`**。
审阅者能接受披露过的变更，不能接受被掩盖的矛盾。

## L15 ★★ 交付物消失/被覆盖的防护（快照与报告分离）

> 来源：auto2768 清理轮。交付前发现**桌面上的报告与改过的表格都不在磁盘上**，
> 只剩改动前备份，且工作目录里那份同名旧表的目标行是**另一道题**。

**教训**：
1. **交付物与工作快照分离**：交付报告不要只存在于会话结束时的隐式状态里，落盘后**立即回读校验**。
2. **改前先备份并命名带日期**：`<原名>.backup_<YYYYMMDD>.xlsx`，且**备份不能是"损坏版"**。
3. **同目录可能有同名异构文件**：改表前必须先确认**主键命中**（要查 `题号 == 目标` 的那一行），
   再动手；文件名相同**不代表**是同一份数据。
4. **报告与表格内容必须同源**：报告里的每列新值应当**直接从已写入的文件回读**，而不是从记忆重写。

## L16 ★★ 磁盘清理的安全顺序（先验证，再删除）

> 来源：auto2768 清理轮。D 盘 99% 满（剩 9.2G），回收约 15G。

**正确顺序**：
1. **先列出"必须保留"清单并逐一验证存在**（最终交付 zip、最终质检报告、工作树、NOP 证据）。
2. **再按"是否含最终版本引用"筛候选**：用最终 zip 名或版本号在所有候选目录里做内容检索，
   命中者为待核，未命中者才进删除列表。
3. **删除前打印确认列表**（路径 + 体积），确认无 `_final`/最新版本混入。
4. **删除后重新核对交付物**仍在。

**易误判**：`du` 可能给出**陈旧的元数据**（实测把 0 文件空目录报成 412M/710M）。
判断"是否真的释放"要用 `df` 前后对比，不要只信 `du`。

**典型的中间产物**（可安全回收）：`qa_final_*` 调试副本（保留最终一个）、
`_superseded*` 旧交付包、旧版扫描目录、旧版包的解压副本、空壳目录。
**不可回收**：最终交付包、最终质检报告、NOP 证据、工作树、带日期的备份。

---

## L17 ★★★ "集成方法的提交物只保存了 1/N 成员" —— 逐样本复算的结构性死结（2026-10-09 AutoRe0823 实录）

> 来源：AutoRe0823（长尾图像分类）QA05 整改轮。把 Verifier 从"读候选交的预测文件"改成
> **可信复算**（用候选权重按声明重算预测再比对）之后，双轨 best method 里有一条**永远无法复算**。
> 排查链路与最终判据如下，换成任何"集成/多模型"方法都适用。

### 症状（原文照抄）

```
{"reward": -1.0, "status": "INVALID", "rank_eligible": false,
 "failure_code": "PREDICTION_MISMATCH",
 "detail": "1151/10000 submitted predictions disagree with trusted fixed-backbone inference
            (tolerance 0.0500%)."}
```

注意**关键区别**：不是"全都错"，而是 **11.5% 不一致**。这种"分数接近、少量不一致"的失配模式
**不等于配置写错**——它往往意味着"我复算用的权重与产出那份预测的权重不是同一组"。

### 根因（代码层面自证，不靠推测）

该轨的方法源码里：

```python
models = []
for i in range(args.n_ensemble):
    model = train_one_model(...)
    models.append(model)                     # ← 只存在内存里
...
torch.save({"state_dict": models[0].state_dict(), ...})   # ← 只有第 1 个落盘
```

**5 个集成成员中，只有第 1 个被保存过；其余 4 个从未落盘**（不是"丢了"，是"从未写过磁盘"）。
而 `pred_test.npy` 是**5 成员集成 + TTA + 校准**的输出 ⇒
用单个 `model.pt` 复算，必然对不上；用"看起来同类的"成员替换，也必然对不上。

### 排查动作（可复制，按顺序做，避免瞎猜）

| 步 | 动作 | 判据 |
|---|---|---|
| 1 | 读方法源码里**保存**了哪些张量 | `grep -n "torch.save\|np.save" train.py`；若保存的是 `models[0]`/`state_dict()` 单个对象 → 立即判定"集成不可复算" |
| 2 | 不要用 `run_meta` 的字段**猜**推理配置 | 逐行读 `predict()`/`ensemble_predict()`，抄出视图集合、池化、减偏置的确切表达式 |
| 3 | 用**该轨自己的预测文件**做反推，而不是猜 | 固定视图只前向一次，在 τ 网格上扫 `(pooled − τ·log(counts)).argmax()`，看**失配数**：τ=0/0.5/1.0/1.5 全部 >0 ⇒ 不是配置问题，是权重不同 |
| 4 | 穷举候选成员目录 | `find / -name "*.pt" -not -path "*/miniconda3/*"`；对每个候选算 sha256 与提交权重比对 |
| 5 | 结论 | 找不到 ⇒ **如实记"不可逐样本复算"**，并把已排除的候选与失配数一并归档为证据 |

**实测数字（避免别人重跑）**：该题 10000 张测试图，单模型复算失配 2736 处；换成"另一组 5 成员"
后失配 1130 处；再换一组仍 1205 处。**三组候选全部失败**，耗时约 45 min/组（CPU 单机）。
⇒ 第 3 步的"扫 τ 看失配是否归零"能在**一次前向后**就给出结论，比反复试成员快得多。

### 修法（分两种情形，不要混）

- **情形 A：权重可找回** ⇒ 补齐全部成员 + 在推理清单里显式声明多成员
  （`models: [{checkpoint, views, pool, weight}, ...]`），再复算。
- **情形 B：权重不可找回** ⇒ **不要伪造**。分两件事如实分别记录：
  1. **方法可复现性**：用恢复的真实源码**独立重训**，比对 τ 扫描曲线与分组指标。
     实测该轨重训的 10 档 τ 扫描值与专家侧记录**逐位一致**（
     `0.50→80.46 0.75→83.52 0.90→84.70 1.00→84.90 1.05→85.08 1.10→85.00
     1.15→84.98 1.20→84.90 1.30→84.42 1.50→80.88`；用时 1095.8s vs 记录 1089s）
     ⇒ **方法可复现 = PASS**。
  2. **逐样本复算**：明确写"原提交因成员未落盘不可复算"，并给出代码行号作为证据。
  **两者是不同判据，不能用"重训分数接近"冒充"逐样本复算通过"。**

### 对出题人的前置要求（写进交付纪律）

**凡方法含集成/多模型/多检查点，交付的 `model.pt` 契约必须显式覆盖全部成员**，
否则该提交在"可信复算"类 Verifier 下**必然失分**。这是一条**可在打包前静态检查**的规则：

```bash
# 若源码出现集成，但只 save 了一个对象 → 直接报警
grep -n "n_ensemble\|ensemble_predict\|models\." train.py | head
grep -n "torch.save" train.py
```

## L18 ★★★ 版本身份误判：同名文件 ≠ 同一版本（2026-10-09 AutoRe0823 实录）

> 来源：同一轮。我在复验双轨 best method 时**连续两次报错结论**，
> 根因都是"拿了一个同名但不同版本的副本当权威"。这是本仓库 L14（双真源）的**执行层补充**。

### 症状（我犯的错，原文照抄我的原话）

1. 第一次：我从工作目录 `_selftest/bm/track_gpt56/` 取权重复验，得到"失配 0、隐藏 82.38%"，
   遂宣布"gpt56 复验通过"。**后来发现那是打包流程的中间副本**，
   而**最终版**是另一组字节：方法名不同（`..._cutout_shift_hflip_tta_logit_adjust` vs
   `..._probability_tta_validation_affine_pairwise_top1_refined`）、
   `model.pt` 大小不同（11,154,050 B vs 11,155,266 B）、
   Dev 不同（83.48 vs 86.54）、且最终版含**非单位阵的校准矩阵**（中间副本没有）。
2. 第二次：我断言"包内 `best_method/train.py`（16,407 B）留错版本，应为 12,596 B"。
   实际是**我把两处目录搞混了**：`expert_evidence/best_method/` 本来就是"最终唯一最佳方法"
   （= gpt56 轨，16,407 B 正确）；12,596 B 是**另一条轨**的源码。

### 根因

- **同名不同版本**：工作区里同时存在 `_selftest/`（打包中间产物）、`tracks/`（轨迹输出）、
  `best_method/`（最终交付）三处同名文件；文件名与目录结构**都相同**，只有字节不同。
- **权威性靠的是哈希，不是路径**：我按"路径看起来像最终产物"选源，
  而不是按"哈希与包内 `run_meta`/清单绑定一致"选源。

### 修法（可复制判据，任何"取回历史产物"的场景都适用）

**取回任何历史产物前，先做三方对账**：

```bash
# 1) 候选源文件的哈希
sha256sum <candidate>/model.pt

# 2) 包内记录的绑定哈希（run_meta / artifact.json / 清单）
python -c "import json;d=json.load(open('run_meta.json'));print(d.get('checkpoint_sha256'), d.get('method'))"

# 3) 二者不一致 ⇒ 这个候选不是最终版，继续找；一致 ⇒ 才用它复验
```

**三条可执行纪律**：

1. **凡"取回权重/源码"的动作，产出必须带 sha256**，并与包内绑定字段对账后才可使用。
2. **方法名字段是最便宜的版本指纹**：比对 `method` 字符串比比对文件大小更早发现版本漂移
   （本例 83.48/86.54 两次运行的 `method` 完全不同）。
3. **报结论前先自问"我这份字节凭什么是最新"**；答不上来就先去对账。
   我在这一轮**连续两次**发出错误结论并撤回，根因都是跳过这一步。

---

## L19 ★★★ task.toml 必须先过“原生契约预检”再送检（2026-10-09 auto2001 实录）

> 来源：auto2001 原生 NOP 轮。`harbor run --path ./harbor_task --agent nop` 任务根本起不来；
> 改用该版本自带的 `TaskConfig` 加载，一次报出 3 个 schema 错误，另有 1 项默认值不足会土建筑阶段超时。

### 症状（原文照拄）

```
3 validation errors for TaskConfig
task.name
  Field required [type=missing, input_value={'title': '...', 'version': '1.0.0'}, input_type=dict]
verifier.network_mode
  Input should be 'no-network', 'public' or 'allowlist' [type=enum, input_value='none', input_type=str]
agent.network_mode
  Input should be 'no-network', 'public' or 'allowlist' [type=enum, input_value='none', input_type=str]
```

同一份包在 CLI 层的报错是 `Either datasets or tasks must be provided`（缺 `[task].name` 的后果）——
**极易被误判成“命令行用法问题”而去折腾参数**，真实原因是清单字段不合法。

第 4 项不报错但同样阻断：`[environment] build_timeout_sec` 缺省 = 600s，
而含 torch 的镜像**首次构建实测 1578s（约 26 分钟）**，最终以
`Environment start timed out after 600.0 seconds` 收场。

### 根因

- `[task].name` 在目标版本里是**必填**；教程示例片段不含它，照抄必缺。
- `network_mode` 是**枚举**（`no-network` / `public` / `allowlist`），历史稿里的 `"none"` 是常见误写。
- `build_timeout_sec` 默认值与“装 torch 要多久”无关，必须显式声明。

### 修法（可复制）

```bash
python tools/harbor_task_contract.py --task <harbor_task 目录>
# exit 0=通过 / 1=硬失败（原生必挂）/ 2=需人工确认
```

- 补 `[task] name = "<owner>/<slug>"`。
- 两处 `network_mode` 一律写合法枚举（本流程固定 `"no-network"`）。
- 显式写 `[environment] build_timeout_sec = 3600`（≥ 实测 1578s 且留余量）。

### 判据：用目标版本真加载，而不是“TOML 能解析”

```python
import tomllib
from harbor.models.task.config import TaskConfig          # 目标 Harbor 版本
TaskConfig.model_validate(tomllib.load(open(path, "rb"))) # 不抛异常才算过
```

修复前后实测：旧版 → 工具 exit 1（原样回放 3 个 schema 错误）；修复版 → exit 0（原生加载 pass）。
**“能解析”与“原生接受”是两件事。**

---

## L20 ★★★ 交付物一旦被质检锚定就不许再改；更不许“改完自查通过”（2026-10-09 auto2001 实录）

> 来源：auto2001 原生 NOP 轮。质检自查（H01–H06 全通过）之后，又改了
> `workspace/harbor_task/task.toml` 三行以修掉 L19 的缺陷，然后重新打包、重新自查、报告 PASS。
> 审阅方一句“跑完双轨不能动了”点破了问题。

### 症状

- 质检结论按**被检对象的 SHA-256** 锚定；对象一变，锚点即失效。
- 表面“新包也 PASS”，实际是**自己给自己发合格证**——旧结论失效这件事没人声明。

### 根因

把“把东西修好”和“让结论有效”混为一谈。修好只解决技术缺陷，**不解决证据链**：
审阅者拿旧哈希的报告去核新包，第一步就对不上。

### 修法（二选一，没有第三条）

1. **送检前发现** → 修完再送检（同步更新所有引用旧哈希的字段）。
2. **送检后才发现** → 走返修：**主动上报**“哪个文件、旧哈希→新哈希、原因、其余证据未动”，
   由平台按新哈希重跑/复核；**不得自行宣布通过**。

配套动作（防“改了没登记”）：对原始文件建**基线清单（path → sha256）**，把有意改动写进清单的
`intentional_changes`（旧值→新值→原因→证据），改完跑只读校验器，**未登记改动数必须为 0**。

实测口径：返修后核对 **156 个原始文件**，出现 **23 个内容变化**，其中只有 **1 个**（task.toml）
在本轮登记，**22 个是上一轮补证产物却从未登记** ⇒ 审阅者无法区分“有意改动”与“意外损坏”。

**单次观察，待复验。**

---

## L21 ★★ 拉不下来的基础镜像：用官方二进制重建“等价镜像”并按内容寻址名预置（2026-10-09 auto2001 实录）

> 来源：auto2001 原生 NOP 轮。题包声明 `no-network` ⇒ Harbor 需要 egress 控制边车，
> 其基础镜像固定为 `gogost/gost:3.2.7-nightly.20260602@sha256:afc0137758ab…`；
> 本机 Docker Hub 与试过的 6 个镜像源全部不可达，而 **GitHub 可达**。

### 症状（原文照拄）

```
failed to copy: httpReadSeeker: failed open: failed to do request:
Get "https://mirror.ccs.tencentyun.com/v2/gogost/gost/blobs/sha256:8c78889592b1658885fb6eb574701c21539e28bcfea8c8e9ebbb3dee38c9fe36?ns=docker.io":
dial tcp: lookup mirror.ccs.tencentyun.com on 10.255.255.254:53: no such host
```

其余源：白名单 403（daocloud）、`read: connection reset by peer`（1ms.run）。

### 根因

边车镜像名是**内容寻址**的：Harbor 对 Dockerfile+构建上下文算
`blake2b(digest_size=8)`（`harbor.utils.container_cache.docker_build_context_hash`），
拼成 `harbor-prebuilt:harbor-docker-egress-control-sidecar--<hash>`；
构建前先 `docker image inspect`，**命中即跳过构建**。所以只要把等价镜像打上同一个名字，
Harbor 就会直接复用——不需要访问 Docker Hub。

### 修法（四步，均已实测）

1. **用 Harbor 自己的函数算出它期望的镜像名**（不要手拼）：
   `docker_build_context_hash(context=<sidecar 目录>, dockerfile_path=<...>/Dockerfile, build_args={}, platform='linux/amd64')`
   得到 `harbor-prebuilt:harbor-docker-egress-control-sidecar--<hash>`。
2. **用官方发布二进制补齐基础镜像里的工具**：`go-gost/gost` 的 GitHub release（实测 3.2.6 stable 可取，9679136 B / 4.7s）。
3. **按原 Dockerfile 的结构重建等价镜像**（实测：alpine + nftables + gost + 原冠脚本，35MB / 内容 14.3MB），打上第 1 步算出的名字。
4. **真实验证策略生效**（不能只看“构建成功”）：`command -v wget 不在也行，但必须看到 `Network unreachable`）。

```bash
# 阶段验证：建一个同网络的临时容器，确认出口真被拦
docker run --rm --entrypoint sh <镜像> -c '\
  /opt/egress-sidecar/entrypoint.sh & sleep 4; \
  network-policy show; \
  wget -q -O- http://example.com || echo UNREACHABLE'
```

实测结果：`network-policy show` 输出 `mode: controlled egress`；
`wget` 报 `Network unreachable`；而 DNS 仍可解析（设计如此）。

**边界**：该做法只修复本地基础设施，**不得改动交付题包的任何字节**；
平台侧照旧用官方镜像。

**单次观察，待复验**：该技巧依赖 Harbor 实现（内容寻址命名 + inspect 命中即跳过），换 Harbor 大版本需重验。

---

## L22 ★★ 结构化交付文件（xlsx 类）不要用库回写；绕不开就加全表 diff 断言（2026-10-09 auto2001 实录）

> 来源：auto2001 出题表格改动轮。用 openpyxl 打开、改 7 个单元格、整表 `save`，
> 结果把同表**其他题目的行**一起改坏了，而且脚本不报错。

### 症状（结构损伤完全静默：脚本退出码 0，文件能打开）

| 类型 | 改前 | 改后 |
|---|---|---|
| 日期格式 | `datetime` + `yyyy-MM-dd HH:mm` | 裸浮点（如 `46299.6105208333`）+ `General` |
| 超链接公式 | `=HYPERLINK("...","...")` | 被包成 `ArrayFormula` |
| 列宽 | 19 | 13 |

**发现方式（也是最好的自检）**：把“我实际改的列”与“文件实际变化的列”做差集——
本例中实际变化的 4 列（D/J/R/AK）**全不是**我想改的列，这一反常即是证据。

### 根因

openpyxl 的 round-trip 没有保留全部 OOXML 语义：它只保留自己建模过的部分，
未建模的属性（日期序列值、数字格式、列宽、ArrayFormula 包装）在回写时被重算成默认值。
不是下载/版本问题，而是**库不声明的信息丢失**。

### 修法

首选：**人工粘贴**。交付改动报告，格式 = “列名 + 该列**完整新内容**”，由出题人/质检员直接整格替换；
这样不引入任何库风险，且内容可逐行审阅。

不得已而用库改时，加三道防护：

1. **改前先备份**（带日期）；
2. **改后立即回读**目标单元格，确认写入生效（防“保存不等于落盘”，参见 L15）；
3. **全表 diff 断言**：逐单元格比对备份与新版，断言差异集 **恰等于**意图修改集（列 × 行）。
   超出一个就停下、从备份重来。本例正是这一步抳回了“改坏别人行”。

**单次观察，待复验**。

---

---

## L23 ★★★ `core.autocrlf=true` + `.gitattributes(eol=lf)` 让 git 合并被永久拒绝，且伪造出 200+ 行"幻影差异"（2026-10-09 AutoRe0823 实录）

> 来源：本仓库自身的维护事故。给仓库回流经验时，`git merge --ff-only origin/master`
> **连续被拒 4 次**，报"local changes would be overwritten"，而实际上**我什么都没改**。
> 定位与绕行方式如下；任何在 Windows 上维护该仓库、或用 `.gitattributes` 规范行尾的仓库都会踩。

### 症状（原文照抄）

```
error: Your local changes to the following files would be overwritten by merge:
	SKILL.md
	references/failure-patterns.md
	references/field-lessons.md
Please commit your changes or stash them before you merge.
Aborting
warning: in the working copy of 'references/failure-patterns.md', CRLF will be replaced by LF the next time Git touches it
```

**反直觉之处**：`git status` 一直把这些文件列为 ` M`（已修改），
但我用 `diff --strip-trailing-cr <(git show HEAD:file) file` 核对，**真实差异是 0 行**。
而且 `git checkout -- <file>`、`git stash push -- <file>` **都清不掉这个状态**。

### 根因（两层叠加）

1. 本机 `core.autocrlf=true`（Windows 默认习惯）⇒ 检出时把 LF 写成 CRLF；
2. 仓库 `.gitattributes` 规定 `*.md text eol=lf`、`*.sh text eol=lf`、`*.py text eol=lf`
   ⇒ git 认为工作树**必须**是 LF。

两者互斥：**每次读取比较都会发现"内容不一致"，于是文件永远处于"已修改"状态**。
`git checkout` 按 autocrlf 规则再写一遍 CRLF，`git stash` 把改动收走后重放又变回 CRLF ——
所以这两个命令都没用。`git merge` 出于安全拒绝覆盖"看起来有未提交改动"的文件。

**幻影差异的规模（实测）**：

```
$ git diff --stat -- SKILL.md references/failure-patterns.md
 SKILL.md                       | 168 ++++++++++++------------
 references/failure-patterns.md | 290 +++++++++++++++++++++--------------------
 2 files changed, 236 insertions(+), 222 deletions(-)

$ git diff --ignore-cr-at-eol --stat -- SKILL.md references/failure-patterns.md
 SKILL.md                       | 8 ++++++++
 references/failure-patterns.md | 6 ++++++
 2 files changed, 14 insertions(+)
```

同一个文件，**普通 diff 报 236 行改动，忽略行尾后只有 14 行**（那 14 行才是真实新增）。
`references/production-sop.md` 更夸张：普通 diff 报 1644 行，真实差异 **22 行**。

### 判据（一眼识别是行尾问题而不是真改动）

```bash
# 真实差异 = 忽略行尾后的差异。若远小于普通 diff ⇒ 是行尾噪音
diff --strip-trailing-cr <(git show "HEAD:<file>") "<file>" | grep -c "^[<>]"
git diff --ignore-cr-at-eol --stat -- "<file>"
```

**结论口径**：`git diff --stat` 的插入/删除行数**不能**用来判断"我改了多少"，
在 CRLF 仓库里它会放大 10–70 倍（实测 236/14、1644/22）。

### 修法（按"能不能动本机 git 配置"分两种）

**修法 A：先统一行尾（推荐，一次性根治）**

```bash
# 让工作树与 .gitattributes 一致：检出为 LF，不再来回转换
git -c core.autocrlf=false checkout -- .
# 或永久设置（本仓库场景）
git config core.autocrlf false
git config core.eol lf
```

**修法 B：不改配置，直接绕开本地 git 走 API 提交（本次实际采用）**

本仓库已有 `tools/push_via_api.py`（走 GitHub Git Data API）。它**不读本地索引**，
因此完全不受行尾状态影响：

```bash
# 1) 用 gh api 取远端最新内容（★ 实测拿到的仍是 CRLF，见本节末"更正"）
gh api "repos/<owner>/<repo>/contents/<path>?ref=master" --jq '.content' | base64 -d \
  | tr -d '\r' > <path>          # 显式归一化，否则会把 CRLF 再推回去
# 2) 在本地把新内容合并进这份"远端最新版"
# 3) 用 API 工具提交（内部是 base_tree + compare-and-swap，并发安全）
python tools/push_via_api.py --repo <owner>/<repo> --branch master     --message-file msg.txt --verify <files...>
```

**为什么修法 B 更稳**：它把"本地 git 状态是否正确"这个前置条件整个去掉了。
代价是**必须先取远端最新版再合并**，否则会用旧内容覆盖别人的提交 ——
这一点在并发回流场景下尤其重要（本仓库同时有多个会话在推）。

### 连带纪律

1. **并发回流时，每次提交前必须重新核对远端 HEAD 与关键计数**
   （如"规则条数""L 编号最大值"），确认自己的改动是**接续**而不是覆盖：
   ```bash
   gh api repos/<owner>/<repo>/commits/master --jq '.sha[0:8] + " | " + (.commit.message | split("
")[0])'
   gh api "repos/<owner>/<repo>/contents/SKILL.md?ref=master" --jq '.content' | base64 -d | grep -cE "^[0-9]+\. \*\*"
   ```
   实测本仓库在一次会话期间**被其他会话推进了 4 次**（L17→L22、规则 19→24）。
2. **编辑器/工具写文件时必须写 LF**（与 L8 表格里"生成脚本的 CRLF"同源纪律，
   但那条讲的是"脚本跑不动"，本条讲的是"版本控制被污染"）。

### ★ 更正（2026-10-09，实测）

上节修法 B 第 1 步写「用 gh api 取远端最新内容（**拿到的就是 LF 版本**）」——
**这句是错的**。实测本仓库远端 blob 本身就是 CRLF：

```
$ gh api "repos/<owner>/<repo>/contents/SKILL.md?ref=master" --jq '.content' | base64 -d | tr -cd '\r' | wc -c
89
$ gh api "repos/<owner>/<repo>/contents/references/field-lessons.md?ref=master" --jq '.content' | base64 -d | tr -cd '\r' | wc -c
771
```

**根因**：本仓库的提交走 Git Data API（`tools/push_via_api.py`），**绕过了 git 的
`core.autocrlf` / `.gitattributes` 归一化** ⇒ 谁写进去什么字节，远端就存什么字节。
近期几次回流把 CRLF 原样推了上去，于是 `.gitattributes(eol=lf)` 与实际内容**不一致**。

⇒ **取回后必须显式归一化**，否则会把 CRLF 再推回去：

```bash
gh api "repos/<owner>/<repo>/contents/<path>?ref=master" --jq '.content' \
  | base64 -d | tr -d '\r' > <path>
```

**提交前自查本仓库的行尾混杂情况**（0=LF 干净，>0=CRLF）：

```bash
for f in $(git ls-files '*.md' '*.py'); do
  n=$(git show "origin/master:$f" | tr -cd '\r' | wc -c)
  [ "$n" -gt 0 ] && printf "%-46s CR=%s\n" "$f" "$n"
done
```

---

## L24 ★★★ 交付包"静态检查全绿、真机必挂"的三类结构性缺陷（2026-10-09 auto0340 实录）

> 来源：auto0340（IQ-MPC / TD-MPC2 离线 RL）NOP Trial 真机构建轮。
> 这三类缺陷**全部通过了 `docker_paths.inspect()` 与自写包检查器**，
> 只有真机 `docker build` 才暴露；一次 NOP Trial 把它们全部抓出。
> 这是"静态通过 ≠ 可运行"最贵的一次实证。

### 24.1 Dockerfile 行尾双反斜杠 ⇒ 整个镜像建不出来

**症状（原文照抄）**：
```
ERROR: failed to solve: dockerfile parse error on line 31: unknown instruction: -e
```

**根因**：行尾写成了 `\\`（**两个反斜杠**）。Dockerfile 里行尾 `\` 是续行符，
而 `\\` 是"转义后的字面反斜杠" ⇒ **不续行** ⇒ 下一行 `-e 's|...|...|g'` 被当成一条独立指令，
Docker 拿它当指令名解析，报 `unknown instruction: -e`。

**字节级判据（不要用 `grep $'\r'`，那是假阳性）**：
```bash
# 行尾"双反斜杠 + LF"计数，必须为 0；92='\'，10=LF
python3 -c "
raw = open('tests/Dockerfile','rb').read()
print('行尾双反斜杠 =', raw.count(bytes([92,92,10])))"
```

**修法**：`\\`+LF → `\`+LF，并固化成构建前置断言
（`check_dockerfile_gate.py`：CR=0 / 行尾双反斜杠=0 / `FROM` 含期望基础镜像）。

**★ 我自己的误判（比原缺陷更贵）**：先用 `grep -c $'\r'` 数行尾，报 CR=41/39，
据此判成"CRLF 污染"，**方向完全错**；用 `tr -cd '\r' | wc -c` 实测 CR=**0**。
⇒ **字节属性一律用 `tr`/Python 数，禁用 `grep $'\r'`**（Git Bash 下会把 `\r` 当正则，产生假阳性）。

### 24.2 基础镜像的 Python 版本与依赖闭包不匹配

**症状**：容器内 `apt-cache policy python3.9` → **`Candidate: (none)`**；`python3.9-dev` 查询为空。

**根因**：Dockerfile 用 `ubuntu:22.04`，而 22.04 官方源只有 `python3.10`；
requirements 钉 `torch==2.2.2+cu118` + `numpy==1.23.5`，**两者都要求 Python < 3.10**。
⇒ **组合自相矛盾，按包内 Dockerfile 构建必失败，正式评分同样失败**。

**判据（构建前一条命令，零成本）**：
```bash
docker run --rm ubuntu:22.04 bash -c 'apt-get update -qq && apt-cache policy python3.9 | head -3'
# 出现 Candidate: (none) ⇒ 立刻换基础镜像
```

**修法**：换 `ubuntu:20.04` + deadsnakes（或直接用自带目标 Python 的官方镜像）。
**教训**：基础镜像的"发行版年份"必须与"Python 版本 / 依赖闭包"一起选，不能只看 OS 顺手。

### 24.3 pip 依赖解析冲突：本地 `--no-deps` 绕过**从未回写交付包**

**症状（原文照抄）**：
```
ERROR: Cannot install -r /tmp/requirements.txt (line 27) and torch==2.2.2+cu118
  The user requested torch==2.2.2+cu118
  torchrl 0.6.0 depends on torch>=2.5.0
ERROR: ResolutionImpossible
```

**根因（两层，第二层才是真问题）**：
1. `torchrl==0.6.0` 的 METADATA 声明 `torch>=2.5.0`，与题面钉死的 `torch==2.2.2+cu118` 冲突
   ⇒ pip 全量解析直接拒绝；
2. **为什么一直没发现**：本地为绕过它生成了一个 `--no-deps` 的 Dockerfile **变体**，
   用它构建"成功"过 —— **但那个变体从未回写进交付包**。包里始终是**未经真机验证的原写法**。

**运行时真相**：torch 2.2.2 + torchrl 0.6.0 在采集机上实跑 12h 正常出分
⇒ 属**上游 METADATA 过严**，不是真实不兼容。

**修法（可复制）**：把冲突包从全量解析里摘出来单独 `--no-deps` 装，并在构建期自检：
```dockerfile
RUN grep -vE '^(torchrl|tensordict)==' /tmp/requirements.txt > /tmp/req_core.txt \
 && pip install --no-cache-dir -r /tmp/req_core.txt \
 && pip install --no-cache-dir --no-deps "torchrl==0.6.0" "tensordict==0.6.0" \
 && python3 -c "import torch, torchrl, tensordict; print('deps OK')"
```

**★ `--no-deps` 的两笔债，必须显式偿还**：
1. **绕过没回写**：本地变体建成功 ≠ 交付包能建。**任何本地绕过都必须回写进交付件**，否则等于没修。
2. **运行时依赖被跳过**：实测 `tensordict` 缺 `orjson`，评分脚本在 import 阶段直接崩：
   ```
   File "tensordict/_lazy.py", line 33, in <module>
     import orjson as json
   ModuleNotFoundError: No module named 'orjson'
   ```
   **修法**：用 `pip show <pkg>` 的 `Requires` 字段列全依赖，逐个显式钉版本写进 requirements
   （实测需补 `orjson` / `cloudpickle` / `packaging`，且**要与离线 wheel 源里实际存在的版本对齐**，
   否则离线构建又挂）。

### 24.4 为什么静态检查器抓不到（元教训）

| 检查器 | 看什么 | 对上述三类 |
|---|---|---|
| `docker_paths.inspect()` | COPY 源、路径契约、profile | ❌ 全 PASS（不解析 Dockerfile 指令语义，也不跑 pip） |
| 自写包检查器（文件数/大小/JSON 可解析） | 结构与完整性 | ❌ 全 PASS |
| **真机 `docker build` + 跑一次评分链路** | 指令解析、apt 源真实内容、pip 依赖图 | ✅ 三类全暴露 |

⇒ **纪律：交付前必须在真机（或可丢弃环境）完成一次完整构建 + 一次评分链路实跑。**
静态检查全绿**不构成**"可构建"的证据。这也是 NOP Trial 不可替代的实证理由。

---

## L25 ★★★ 工作区由 `starter/` 复制而来 ⇒ hard_gate 必需件必须在 starter 内（2026-10-09 auto0340 实录）

**症状（原文照抄）**：
```
[hard-gate] FAIL [G5] 缺少 submission.json
[verify] HARD-GATE 违规（rc=1），reward 记为 -1
__EXIT__=4
```

**根因**：`environment/Dockerfile` 的工作区是用
`RUN cp -a /workspace/starter/. /workspace/solution/` **从 starter 复制**出来的；
而 `submission.json` 只存在于**源码层** `solution/`，**没有进 `starter/`**。
但 `tests/hard_gate.py` 的 G5 要求"必须能解析出 submission.json"。

⇒ **后果是这一类里最严重的**：**任何 Agent 提交都会被判违规** ——
"不改就交"和"改了再交"**两种死法**，reward 恒为 −1，整道题的评分链路彻底不可用。

**为什么静态检查看不见**：源码树里 `solution/submission.json` **确实存在**，
检查器看的是源码树，**不看镜像内复制后的实际布局**。

**判据（构建后一条命令）**：
```bash
docker run --rm --entrypoint /bin/bash <agent-img> -lc 'ls -la /workspace/solution/'
# 必须与 hard_gate / test.sh 的必需件清单逐项对齐
```

**修法**：把占位 `submission.json` **纳入 `starter/`**（与 `solution/` 内容一致、md5 相同）。

**★ 推广（真正可复用的部分）**：
> 只要工作区是"从某个只读模板复制"而来，**该题所有 hard_gate / 入口脚本要求的必需件，
> 都必须存在于那个模板里**。构建后立刻用一条 `ls` 对照必需件清单，不要等 NOP 才发现。

---

## L26 ★★ 远端取回证据的静默失败：`o.read()` 返回空串 ≠ 文件为空（2026-10-09 auto0340 实录）

**症状**：用 paramiko 批量取回远端台账，**写出了 12 个 0 字节文件，全程没有任何报错**。

**根因**：同一 `exec_command` 通道在循环里**逐次 `o.read()`** 时，
后续读取会**静默返回空串**（通道已耗尽），而不是抛异常。

**判据**：取回后**必须校验字节数**，不能只看"命令退出码 0"：
```python
assert raw, f"{name} 取回 0 字节"      # 空串即失败
```

**修法（可靠做法）**：一次 exec 输出「分隔符 + `base64 -w0`」，**一次性读完**再本地切分：
```bash
# 远端
for f in $FILES; do echo "### FILE $f"; base64 -w0 "$f"; echo; done
```
```python
raw = stdout.read()                     # 只读一次
for chunk in raw.split("### FILE ")[1:]: ...
```

**连带三个坑（同一次踩全）**：
1. 同一连接上「`exec_command` 读管道」与「`sftp.get`」**混用** ⇒ 通道状态错乱，
   `sftp.get` 报 `No such file`（**文件其实存在**，`stat` 正常）。
2. Windows 上 `os.path.join(dst, 远端全路径)` 会造非法目录 ⇒ 只取 `os.path.basename`。
3. **时效性证据要先落盘再分析**：机器随时可能释放，顺序反了就有永久丢失风险。

---

## L27 ★★ 改动/产出"用户要交出去的东西"时的两条纪律（2026-10-09 auto0340 实录）

### 27.1 先确认**目标载体形态**，不要自己发明格式

**症状**：把"填表用的自检结论"写成了 Markdown 文档，用户原话：
> 「这俩是表格的文字描述填写，你的输出让我咋填」

**根因**：按"文档"的默认习惯输出，**没有确认这份东西最终要放进哪里**。

**纪律**：产出任何"要填进某个表 / 交给某个角色"的材料前，先问清载体：
**表格列号 / 纯文本（含行尾） / Word / JSON**；有官方模板就**严格按模板版式**输出
（段号、`[OK]/[FAIL]/[NEED]/[OPEN]` 标记、`SUMMARY` 统计块），**不要自己发明结构**。

### 27.2 改动分类：**"修文字"可自主，"改判断"必须先问**

**症状**：用户质问「你凭啥越权审」。回看，我改的是**性质完全不同的两类**东西：

| 类别 | 例子 | 可否自主 |
|---|---|---|
| **修文字** | 删草稿残留（"…算子学习**一句话**"）、去重复串（`reload.log、reload.log`）、修语句不通 | ✅ 可自主（不改变事实与结论） |
| **改判断** | 把自检结论 `[ OK ]` 改成 `[FAIL]`；把"U **未定**"改成"U **已定 = X**" | ❌ **必须先问** |

**根因**：把"证据很足"当成了"我有权改"。但**"我认为是笔误" ≠ "我有权替用户给他的结论定性"**。

**★ 最硬的信号**：当子代理/他人明确写出「**因涉及你的结论定性，未擅自改**」或
「**改法取决于你是否采纳，需你定夺**」时，**那句话就是我不能碰的地方**；
把它当"待办"顺手做掉，就是越权。

**纪律**：改动**用户署名/提交**的产物前先分类 —— **改判断 ⇒ 只报告 + 给建议改法，等确认**。

---

## 快速检查清单（P0/P1 阶段强制过）

- [ ] 论文的**一句话主张**写下来了吗？指标**直接测量**它吗？（L3）
- [ ] 用 1 seed 的 B/R + U **预解**过 R_norm 与 3σ 的**可行交集**吗？（L2）
- [ ] 探针规模 ≤ 2×单跑耗时，且**通过前不启动正式 B/R**？（L1）
- [ ] 所有跨规模的超参都做了**数值反推**（而非按文档字面重算）吗？（L4）
- [ ] 失败诊断按"指标 → 判定 → 标定 → 容量 → 换题"顺序走吗？（L5）
- [ ] 资产与数据集**解耦**了吗（换题只需 1–2 天）？（L7）
- [ ] 跑 NOP 前实测过 GPU/buildx/compose/容量/网络**五项前提**吗？（L11）
- [ ] NOP 是"Agent 不操作 + Hidden 正常注入 + 跑完整评分"吗？（**不是**"Hidden 不注入 ⇒ 提前退出"，L11）
- [ ] 交付字节与运行绑定哈希**交叉验证过**逐文件一致吗？（L13）
- [ ] 同一事实（锚点/口径/U）在包内**只有一套生效声明**吗？变更有披露吗？（L14）
- [ ] 写 review.json 前**一次性列全**校验器字段约束了吗？（L12）
- [ ] 清理前先列"必须保留"清单并验证存在了吗？（L16）
- [ ] 方法含集成/多模型时，`model.pt` 契约**覆盖全部成员**了吗？（只 save `models[0]` ⇒ 可信复算必然失分）（L17）
- [ ] 取回的权重/源码做过 **sha256 对账**了吗？（同名≠同版本，L18）
- [ ] 提交前核对过**远端最新 HEAD 与编号**了吗？（并发回流会被覆盖，L23）
- [ ] `git diff` 的行数是否被行尾噪音放大？（用 `--ignore-cr-at-eol` 复核，L23）
- [ ] 送检前用目标版本 `TaskConfig` **真加载**过 task.toml 吗？（四项契约，L19）
- [ ] 改过被质检锚定的交付物吗？改了就**上报重检**，别自查通过（L20）
- [ ] 结构化表格是人工改的、还是库回写的？回写后做过**全表 diff 断言**吗？（L22）
- [ ] 要执行候选代码时，隔离沙盒建不起来**判基础设施故障**且**不回落宿主**吗？构建期做了 fail-closed 自检吗？（见 [隔离执行沙盒](references/sandbox-isolation.md)）
- [ ] 交付前在真机完成过一次**完整构建 + 评分链路实跑**吗？（静态全绿 ≠ 可构建，L24）
- [ ] Dockerfile 的行尾有 `\\`（双反斜杠）吗？基础镜像的 Python 版本与 torch/依赖闭包匹配吗？（`tools/dockerfile_preflight.py` 一条命令即查，L24.1/L24.2）
- [ ] 用过 `--no-deps` 吗？**本地绕过回写交付件了吗**？它跳过的运行时依赖补齐了吗？（L24.3）
- [ ] 工作区是从 `starter/` 复制的吗？hard_gate 必需件**都在 starter 里**吗？（L25）
- [ ] 远端取回的证据**校验过字节数**吗？（空串 ≠ 空文件，L26）
- [ ] 要改的是"文字"还是"判断"？改判断先问；产出填表件先确认**载体形态**（L27）

---

## L28 ★★★ 只跑过"我熟悉的方法族"就宣布"全部失败"，会漏掉唯一能成的那个（2026-10-07 AutoRe0565 实录）

> 来源：给 `al4pde` 出题。为判断"选点策略是否是可优化的开放面"，我连续做了 **6 次**
> 策略对照实验，全部显示"选点反而比随机更差"，于是得出"该优化面不可行、需换切入点"的结论。
> **但我从头到尾没有跑过 `config/acquisition/` 里已经存在的三个策略：
> `bait` / `lcmd` / `coreset_maxdist`。** 补测后发现 **`lcmd` 是唯一优于随机的方法**（−10.5%）。

### 症状（不是报错，是判断错误）

```
第 1–6 次实验: power +58%(4seed) / top_k +10% / top_k +126%(小数据) /
               max_dist 退化 / 换 PDE 后 +247% / 降预算后 +150%
结论（当时写的）: "未找到任何能优于随机的策略 ⇒ 出题前提不成立"
第 7 次实验（补测未测过的三个）:
  bait           0.02130  (+12.1% 劣)
  lcmd           0.01700  (-10.5% ★唯一优于基线)
  coreset_maxdist  崩溃
```

### 根因

**把"我测过的策略族"当成了"全部策略族"。**
`config/acquisition/` 下实际有 9 个可用配置（`random` / `pool_random` / `power` /
`top_k` / `max_dist` / `coreset_maxdist` / `lcmd` / `bait` / `data_schedule`），
我先验地挑了 3 个"看起来像主力方法"的去测（不确定性类），失败后就归纳为"整类失败"。
**没有做"枚举—勾选"这一步，于是把"未测"静默算进了"全败"。**

### 判据（可执行，动手前 30 秒）

```bash
# 打开一个"候选改动空间"目录时，先把可用配置全部列出并逐条勾选状态
ls config/acquisition/*.yaml            # 或对应的策略/模型/损失注册表
# 对每一个写: 已测(结果) / 未测 / 不可用(原因)
# ★ 只要还有"未测"，就不允许写出"某类方法全部失败"
```

**一句话规则**：**"全部失败"是一个需要清单背书的结论，不是一个可以凭印象下的结论。**

### 可执行门禁

`tools/candidate_surface_audit.py`（只读、三态退出码）：列出候选空间全部候选，
与你的已测声明做差集，报出未声明项。

```bash
python tools/candidate_surface_audit.py --surface config/acquisition --pattern '*.yaml' \
    --declared-inline "random,pool_random,power,top_k,max_dist"
# ⇒ [FAIL] 存在未声明的候选 4 个: bait / coreset_maxdist / data_schedule / lcmd  (退出码 1)
```

★ 本工具在 0565 的候选空间上**真跑过一次**，输出与事故完全一致（把 `lcmd` 标为未覆盖）。

### 实测代价

```
漏测三个策略 ⇒ 差点把"可做"的题判成"不可行"
发现 lcmd 有正信号时，服务器算力（成本）已耗尽，5-seed 验证未跑完
⇒ 最终仍未拿到合法 R 臂 ⇒ 题目无法交付
★ 真正的损失不是"这题做不出来"，而是"我测漏了，且补救的算力已用尽"
```

---

## L29 ★★★ 从训练日志里取"官方指标"必须按评测调用点去重，取错一个会静默污染全部对照（2026-10-07 AutoRe0565 实录）

> 来源：`al4pde` 的 `end_of_al_iter_plots()` 每个 AL 轮会**连着打两次**评测，
> 且两次的日志行**都以同一个键开头**（`{'al_iter': N, ...}`），肉眼与正则都分不出来。
> 我因此一度在**错误的口径上**做跨实验比较。

### 症状（两次评测的日志行长得一样）

```python
# al4pde/evaluation/visualization.py:327
prob_model.evaluate(al_iter, prob_model.val_loader, prefix="al/",     time_step_name="al_iter")   # ← 官方 val 指标
# :330-331
if not last:
    eval_on_new(task, prob_model, al_iter)        # → al4pde/evaluation/analysis.py:132
    # prob_model.evaluate(al_iter, data_loader,  prefix="al_new_data/", time_step_name="al_iter") # ← 新选数据的指标
```

两次输出的裸 dict 只差 `prefix`（在 wandb 里区分），**stdout 上是同一形状**：

```
{'al_iter': 0, 'loss_avg': tensor(...), ..., 'nRMSE': tensor(0.0497), ...}   # al/        ← 官方
{'al_iter': 0, 'loss_avg': tensor(...), ..., 'nRMSE': tensor(0.0909), ...}   # al_new_data/ ← 非官方
```

**反直觉之处**：两条都带 `'al_iter': 0`，直接 grep `al_iter` 会拿到两条，
取首/取尾会得到**不同结论**，而脚本不会报任何错。

### 根因

日志里**没有印出 `prefix`**，而 `time_step_name="al_iter"` 对两次调用是同一个值。
⇒ 键名不足以区分，只能靠**调用顺序**区分。

### 判据 + 修法

```bash
# 1) 先确认该 runner 每个 al_iter 打几次评测、顺序如何
grep -n "evaluate(" <runner.py> <evaluation/*.py>
# 2) 官方口径 = 每个 al_iter 的【第一个】评测（val）；末轮因 `if not last` 只有一个
#    用 Python 按 al_iter 分组取首个，而不是 tail -1
grep -E "^\{'al_iter':" run.log | \
  sed -E "s/.*'al_iter': ([0-9]+).*'nRMSE': tensor\(([0-9.eE+-]+).*/\1:\2/" | sort -t: -k1,1n -u
```

```python
# 推荐：分组取首个
first = {}
for line in log.splitlines():
    if not line.startswith("{'al_iter':"): continue
    k = int(re.search(r"'al_iter':\s*(\d+)", line).group(1))
    v = float(re.search(r"'nRMSE':\s*tensor\(\s*([0-9.eE+-]+)", line).group(1))
    first.setdefault(k, v)          # ★ 只留第一个
```

**交叉验证法（必须做一次）**：用 SOP V09 的独立重载脚本，**只喂 val_loader** 复评一个
已知 checkpoint，若复现值 == 日志里按上述规则取的终值（本例 `0.0153 == 0.0153`，
rel_diff 0.000%），说明口径取对了。**这一步把"口径正确"从假设变成证据。**

### 实测规模

```
误取会导致的偏差（同一 run、同一次训练）:
  al_iter0 官方 0.0497 vs 非官方 0.0909     (差 83%)
  al_iter1 官方 0.0295 vs 非官方 0.0324
★ 取错口径，7 次跨实验对照的结论会整体不可信，且不会触发任何报错
```

---

## L30 ★★ 仓库里"存在但从未端到端跑过"的配置是批量雷区：静态存在 ≠ 可用（2026-10-07 AutoRe0565 实录）

> 来源：`al4pde` 依赖一个仓库自带的评测配置体系。有两个配置**写得像模像样、
> 有完整注释、被文档引用**，但**从来没被跑通过**——它们一遇真实数据就崩。
> 教训：把"仓库里有这个配置"当成"这条路径可用"，会让排期与选题判断整体失真。

### 症状（原文照抄）

```
# 配置 A：ufull.yaml（"全量数据上界"专用调度，注释详尽、被 SKILL 引用）
RuntimeError: torch.cat(): expected a non-empty list of Tensors
  at al4pde/acquisition/batch_selection.py:61  ic_params = torch.cat(ic_params, dim=0)
  ── 触发条件：FixedSchedule(batch_num_per_iter=[0, 0]) ⇒ 每轮新增 0 个点，
     但 generate() 仍被调用 ⇒ 空选择列表 ⇒ torch.cat 崩溃

# 配置 B：coreset_maxdist.yaml
TypeError: expected Tensor as element 0 in argument 0, but got list
  ── 触发条件：use_latent_space: true 这条 latent 分支有代码缺陷
```

### 根因

这两个配置**从来没有被任何一次真实运行覆盖过**：它们的存在只是"作者写下了配置"。
`batch_selection.generate()` 没有对"空选择"做防御；
`use_latent_space=true` 分支的类型契约与调用方不一致。
**注释越详尽越有欺骗性**——注释描述的是作者意图，不是实际行为。

### 判据（把它变成一次 60 秒的 smoke）

```bash
# 对每一个"打算依赖"的仓库配置，先做最小化合成 + 单步运行，而不是只读 YAML
python -m <runner> --cfg job --resolve <你的 overrides>       # 1) 配置能否合成
# 2) 用最小规模真跑一遍（epochs=1~2, iter=1, pool 调小）
# 3) 看退出码 + 关键阶段痕迹（selection / simulate / eval）是否都出现
```

**一句话规则**：**依赖一个仓库配置之前，先让它跑出过一次退出码 0；注释不算证据。**

### 实测代价

```
ufull.yaml: 4 个 seed 全部 "AL Crashed"，才发现从未跑通 ⇒ 用来定锚点 U 的计划落空
coreset:   一个完整 run（约 1.5h）跑到 80 epoch 时崩溃，白费
★ 二者都不是"难实现"，是"没人跑过" —— 属于最廉价可拦的一类损失

---

## L31 ★★ `subprocess(text=True)` 不写 `encoding` ⇒ Windows 上按 cp936 解码 UTF-8，异常被吞后误报环境不通（2026-10-07 本仓库自身实录）

> 来源：用 `tools/push_via_api.py --selftest` 自检时，工具报 **"gh 未登录或凭据失效"**，
> 但 `gh auth status` 手工执行明明显示已登录。定位后发现是**同一个 bug** 把真实异常吞掉了。

### 症状（工具报的是"环境问题"，真因是解码）

```
$ python tools/push_via_api.py --repo baimocn/autoresearch-sop --branch master --selftest
  !! gh 未登录或凭据失效 —— 请先 `gh auth login`
（但 `gh auth status` 手工跑：✓ Logged in to github.com account baimocn）
```

真实异常被 `except` 吞掉，若不打日志实际抛出的是：

```
UnicodeDecodeError: 'gbk' codec can't decode byte 0x93 in position 15: illegal multibyte sequence
  File ".../subprocess.py", line 1614, in _readerthread
    buffer.append(fh.read())
```

### 根因

```python
# 出错写法（push_via_api.py 原第 104 行）
p = subprocess.run(["gh", "auth", "status"], capture_output=True, text=True)
#                                                                 ^^^^^^^^^ 缺 encoding
```

`text=True` 只开启"文本模式"，编码取 **`locale.getpreferredencoding()`**。
本机实测 `cp936`（GBK）；而 `gh` 输出含 UTF-8 的 `✓`（字节 `\xe2\x9c\x93`）
⇒ GBK 解不出来 ⇒ 读线程抛 `UnicodeDecodeError` ⇒ 因 returncode 不可达/被捕获，
判定落到"未登录"分支 ⇒ **误报环境不通**。

**关键点**：文件里**另一个** `subprocess.run(..., text=True, encoding="utf-8")`（第 86 行）
写对了 —— **同一个文件里两种写法并存，只有漏写的那处会炸**。

### 判据 + 修法（一条 grep 全扫）

```bash
# 找出所有 text=True 但没有同段 encoding 的调用点
grep -rn "text=True\|universal_newlines=True" --include="*.py" tools/ scripts/ \
  | grep -v "encoding=" | grep -v "errors="
```

```python
# 修法：凡 text=True 必配 encoding + errors（防御性）
subprocess.run(cmd, capture_output=True, text=True,
               encoding="utf-8", errors="replace")
```

**配套纪律**：**工具自检的失败分支不能只说"某某不通"，必须打印原始异常（或 `repr(stderr)`）**——
本例把"编码 bug"伪装成"凭据问题"，会把人引到完全错误的排查方向。

### 实测数字

```
修复前：push_via_api.py --selftest → 退出码 2、误报"gh 未登录"
修复后：同一命令 → 退出码 0、"OK gh 已登录 / OK 仓库可达"
本机 locale.getpreferredencoding() = cp936；gh 输出首字节观测 = b'github.com\n  \xe2\x9c\x93 ...'
```

---

## L32 ★★★ Git Data API 建树用「绝对路径」当 entry 名 ⇒ 建出幽灵子树 `D:`，提交"成功"但目标文件纹丝不动（2026-10-07 本仓库自身实录）

> 来源：用本仓库 `tools/push_via_api.py` 回流 6 个文件，工具打印
> `5/5 commit = ... -> master 已更新`、`--verify` 全部 `OK`，**退出码 0**。
> 但用 `gh api` 独立回读发现：**6 个文件的 blob 都还是旧版**，而仓库里多出一棵
> 名字叫 `D:` 的子树。这是本次最危险的一类失败——**静默假成功**。

### 症状（工具说成功，远端没变）

```
$ python tools/push_via_api.py ... --verify
  5/5 commit    = 3024b513  ->  master 已更新
  OK 远端 HEAD = 3024b513 | 回流：候选空间枚举纪律 ...
  OK SKILL.md                    本地   21269 / 远端 21269     ← 全是 OK
  完成。

# 但独立回读：
$ gh api repos/<owner>/<repo>/git/trees/<tree>?recursive=1 --jq '.tree[].path' | head
  D:
  D:/Desktop/<...>/autoresearch-sop/SKILL.md      ← 我的文件跑进了这里
  SKILL.md                                        ← 真实位置仍是旧 blob
```

git 把 Windows 盘符当成了目录名，建出一条 `D:/Desktop/.../SKILL.md` 的路径。
`git clone` 出来会看到一个字面量目录 `D:`。

### 根因

```python
# 出错写法（push_via_api.py 原第 207/225 行）
items = [(Path(f).as_posix(), Path(f).read_bytes()) for f in args.files]
#          ^^^^^^^^^^^^^^^^^^^^ 绝对路径直接当成了 git tree 的 entry path
...
entries.append({"path": name, "mode": "100644", "type": "blob", "sha": sha})
#                      ^^^^ 传给 POST git/trees
```

`POST /git/trees` 的 `path` 必须是**仓库相对路径**；传绝对路径时 git 不报错，
而是把它当作一条普通路径写进树。配合 `base_tree`，**真实文件继承旧 blob、
新 blob 挂在幽灵路径下** ⇒ 看起来"提交成功"。

**为什么 `--verify` 没拦住**：它用**同一个错误的名字**去查远端
（`GET /contents/{name}`），拿到的其实是……同名的旧文件；或按错误路径查而
"恰好"通过。**自校验与写入共享同一个 bug ⇒ 双重确认了错误。**

### 判据（三条，缺一不可）

```bash
# ① 推送后不要只看工具输出，独立回读「tree 顶层」是否混进盘符/绝对路径
gh api repos/<o>/<r>/git/trees/<tree>?recursive=1 --jq '.tree[].path' | grep -E '^[A-Za-z]:' 
#    有输出 ⇒ 中招

# ② 逐文件比对要拿「仓库相对路径」查，且比对 **blob sha**（大小相同也算不准）
gh api repos/<o>/<r>/contents/<relative-path>?ref=<branch> --jq '.sha'   # 与本地 git hash-object 比

# ③ 顶层 path 集合应等于仓库已知根条目，多出来的任何一项都要解释
```

### 修法（已改进 push_via_api.py）

```bash
# 加 --repo-root，文件路径一律换算为仓库相对路径；越界直接拒绝
python tools/push_via_api.py --repo o/r --branch master --repo-root /path/to/repo \
    --message-file /tmp/msg.txt repo/SKILL.md repo/tools/x.py --verify
```

代码层面的两条硬约束（已在工具内实现）：
1. `to_repo_paths()`：把绝对路径 `relative_to(repo_root)`；**不在 root 内则抛错**，绝不静默写绝对路径。
2. 建树前自检：`entry.path` 若匹配 `^[A-Za-z]:/` 或以 `/` 开头 ⇒ 直接 `EXIT_FAIL`。

**清理遗留**：幽灵子树无法用 `sha:null` 删除（API 要求 sha 或 content）。须
**递归取全树、显式重建顶层条目（跳过 `D:`）**，再建 commit。注意条目名是
`D:`（带冒号），用 `p=="D"` 过滤会漏。

### 实测数字

```
本次 6 文件：blobs 上传正确（ab2bca6d / 879ed2ee / 99d05fa2 …），
             但 tree 顶层出现 `D:`，6 个真实文件 blob 全为旧值
修复后重推：HEAD 6dbc5ef1，顶层 10 项无 `D:`，6/6 文件 size 与本地一致（21269/72020/15550/65936/6988/16668）
★ 教训：**"退出码 0 + 自校验 OK" 不等于远端真的变了**——自校验必须用
  独立于写入路径的口径（此处用 blob sha 与顶层 path 集合）。
