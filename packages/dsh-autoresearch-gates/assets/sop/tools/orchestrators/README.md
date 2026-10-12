# 编排器与工具脚本

这些是从 AutoRe0566 实战中沉淀的**可复用自动化脚本**。它们默认含该案例的**绝对路径**（如 `/root/autodl-tmp/mno_p4`），复用时请先替换为你的项目路径。

| 脚本 | 作用 | 复用要点 |
|---|---|---|
| `param_official.py` | 一键生成**官方训练脚本的参数化副本**（seed/数据路径/S/ntrain/width/耗散半径/切片适配） | 改 `CONFIGS` 字典即适配新数据集；是本仓库最高频复用的脚本 |
| `convert_official_ckpt.py` | 官方 `torch.save(model)` pickle → 合同格式 `{"state_dict","config"}`；**带前向尺寸校验** | 加 `--domain-size` 避免尺寸静默错配（本次踩过） |
| `orchestrate.py` | 全自动 B/R 编排：等探针 → 按**预定判据**选配对 → 训练 → 评分 → V09 重载复评 → 定稿 | 判据（P0/P1/…）与候选表在脚本内，需按新题改写 |
| `orchestrate_5k.py` | 同上但面向"数据集已定、只差补 seed"的场景（含半径选择逻辑） | 半径候选表需替换 |
| `backfill.sh` | 每小时巡检：空闲卡回填 + 异常自愈（幂等，规则 R1–R5 预先声明） | **规则要预先写死，不即兴发挥** |
| `v09_reload.sh` | V09 模型独立重载复评 + 一致性判定（训练型必交） | 数据无关 |
| `finalize_pipeline.sh` | P0–P5 定稿管线（decision.json + anchor 提案，人工拍板 P6） | 阈值只读自协议文件，**不含"按结果调阈值"路径** |

## 三条硬规则（脚本里已实现，改脚本时不要破坏）

1. **幂等**：每个阶段可重复执行，不产生重复任务（用 flock + `/proc/*/cwd` 检测）
2. **缺证据不推进**：训练完成度用 `run.log` 的完成标记判断，**不用文件扩展名猜测**
3. **绝不静默成功**：评分结果必须回读断言（`status=VALID`），失败要写标志文件而非沉默退出

## 已知环境易错点（详见 references/field-lessons.md L8）

- 官方脚本用 `sys.path.append('../')` → 按官方目录布局铺依赖，**不改官方脚本**
- 官方 checkpoint **无扩展名** → 用 `Weights saved` 判断完成
- pickle 引用官方模块 → 转换时把官方仓 root 与 `models/` 加入 `sys.path`
- 网格尺寸常被硬编码 → 显式传参 + **前向尺寸校验**
- Windows 生成的脚本带 CRLF → 写入用 LF，部署时 `sed -i 's/\r$//'`
- 官方 stdout 块缓冲 → 用 GPU 利用率与进程 cwd 判断"是否在跑"，不要只看日志
