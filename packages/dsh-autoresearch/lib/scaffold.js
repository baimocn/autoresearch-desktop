/**
 * 题包脚手架 —— 按《AutoResearch 专家线下标注教程V3》的必交结构生成真实文件骨架。
 *
 * 生成物分三类顶层目录（教程第 4 章「最终交付结构」）：
 *   workspace/               可执行题目
 *   expert_evidence/         专家标注、Agent 轨迹与最终方法
 *   optimization_evidence/   Baseline/Reference 与优化面的独立真实性证据
 *
 * 刻意只写「有内容可写」的文件：题面、task.toml、README、说明文档的骨架都带
 * 章节与占位标记，方便门禁识别未完成项；轨迹与证据 JSON 写为合法空结构，
 * 不预填任何看起来像真实结果的数字。
 *
 * @module dsh-autoresearch/scaffold
 */

import { mkdir, writeFile, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'

/** 不覆盖已存在文件，返回是否为新建。 */
async function writeIfAbsent(file, content) {
  try {
    await access(file)
    return false
  } catch {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content, 'utf8')
    return true
  }
}

/** 八章节题面骨架。占位符刻意显眼，便于人工与门禁共同识别未完成。 */
export function instructionTemplate(title) {
  return `# ${title}

## Goal
<!-- 2-4 句：给定 WHAT、产出 WHAT、优化哪个指标及方向；一句话定义合法提交。不得含方法提示。 -->
TODO

## Task Setting
<!-- 环境（sandbox、GPU 是否经 launched jobs）、starter/baseline 起点、public dev split、
     hidden test 如何隔离。可写 public dev baseline 数字。 -->
TODO

## Objective and Metrics
<!-- 精确确定性评分：主指标 + 公式、聚合、方向、非计分诊断、质量门。
     连续、不裁剪、不在 reference/baseline 处分段锚定。 -->
TODO

## Allowed Scope
<!-- Agent 可改/可加什么、平台接口脚本（launch_job / observe_job / stop_job / cleanup_jobs）、
     可读的 dev/data 位置。 -->
TODO

## Hard Boundaries
<!-- 受保护文件在 eval 时恢复、artifact/大小/时间/资源限制、禁止动作、
     提交须指向自身源自官方 scaffold 的运行；并发/GPU 上限。 -->
TODO

## Submission Instructions
<!-- 提交文件与其 schema、必填/可选字段、evaluator 解析什么；自报分数不受信任。
     若任务没有 submission JSON，不要虚构 JSON。 -->
TODO

## Workflow & Iteration
<!-- 声明为 anytime task：持续推性能，找到更好方案即（重）写提交；
     典型循环与单轮墙钟预算（应尽量不超过 2 小时）。 -->
TODO

## Completion Criteria
<!-- schema 合法提交指向自身成功运行、gates 通过、产出有效分数、
     未改受保护资产、未访问 hidden。 -->
TODO
`
}

/** task.toml 骨架，字段取值来自教程正文示例。 */
export function taskTomlTemplate(name, description) {
  return `schema_version = "1.3"

# 顶层字段：只移交候选及其运行必需产物。
# Harbor 自行管理 verifier 日志；导入 Agent 可写的 /logs 会让失败的 verifier 继承伪造 reward。
artifacts = ["/workspace/solution"]

[task]
name = "${name}"
description = "${description}"
authors = [{ name = "TODO" }]
keywords = ["TODO"]

[metadata]
difficulty = "TODO"
category = "TODO"
task_id = "TODO"
ext_id = "TODO-v1"
display_title = "${description}"
display_description = "TODO"
tags = ["TODO"]
language = "python"
languages = ["python"]

[agent]
timeout_sec = 43200             # 示例 12h；须容纳有效迭代要求及开销

[verifier]
timeout_sec = 3600
environment_mode = "separate"   # 必须显式声明
user = "root"

[verifier.environment]
network_mode = "no-network"
build_timeout_sec = 3600
cpus = 8
memory_mb = 32768
storage_mb = 32768
gpus = 0
mcp_servers = []

[environment]
network_mode = "no-network"
build_timeout_sec = 3600        # 默认 600s 装不下含 torch 的镜像
cpus = 16
memory_mb = 65536
storage_mb = 102400
gpus = 1
mcp_servers = []
`
}

const ENVIRONMENT_DOCKERFILE = `# Agent 镜像；build context = environment/。
# 只 COPY 本上下文的公开内容，包括 Public/Dev 评分入口。
# 不得复制最终 Verifier 的私有 tests/、Hidden 或 Reference。
FROM python:3.12.8-slim-bookworm

ENV PYTHONUNBUFFERED=1 \\
    PIP_NO_CACHE_DIR=1

WORKDIR /workspace

COPY requirements.txt /workspace/requirements.txt
RUN pip install --no-cache-dir -r /workspace/requirements.txt

# starter/ 同时初始化只读 /workspace/starter 与可写 /workspace/solution
COPY starter/ /workspace/starter/
COPY starter/ /workspace/solution/
COPY public_eval/ /workspace/public_eval/
COPY public_assets/ /workspace/public_assets/

RUN chmod -R a-w /workspace/starter /workspace/public_eval /workspace/public_assets

CMD ["/bin/bash"]
`

const TESTS_DOCKERFILE = `# 私有 Verifier 镜像；build context = tests/。
# 自带 /tests/test.sh、可信 grader、评分依赖与受保护评测资产。
# 正式评分不能依赖 Agent 容器里临时安装的包、缓存或未提交的文件。
FROM python:3.12.8-slim-bookworm

ENV PYTHONUNBUFFERED=1 \\
    PIP_NO_CACHE_DIR=1

COPY requirements.txt /tests/requirements.txt
RUN pip install --no-cache-dir -r /tests/requirements.txt

COPY . /tests
RUN chown -R root:root /tests \\
    && chmod -R go-rwx /tests \\
    && chmod 0700 /tests/test.sh

RUN mkdir -p /workspace/solution /logs/verifier
WORKDIR /workspace/solution

CMD ["/bin/bash"]
`

const TEST_SH = `#!/bin/bash
# 正式评分入口：在 Agent 结束后由独立 Verifier 执行。
# 读取 /workspace/solution，实际执行评分并写 /logs/verifier/reward.json。
set -euo pipefail

OUT="/logs/verifier"
mkdir -p "\${OUT}"
# Verifier 启动时清理 Agent 预写结果文件，由 trusted verifier 原子写入。
rm -f "\${OUT}/reward.json" "\${OUT}/reward.txt" "\${OUT}/reward_detail.json"

# 从 root 拥有的 tests 目录运行，避免候选在 cwd 放置同名模块劫持评分器。
cd /tests
export PYTHONSAFEPATH=1

python3 -m grader --submission /workspace/solution --out "\${OUT}/reward_detail.json"

python3 - "\${OUT}/reward_detail.json" "\${OUT}/reward.json" <<'PY'
import json, math, os, sys, tempfile
from pathlib import Path

with open(sys.argv[1]) as source:
    detail = json.load(source)
reward = detail["reward"]
if isinstance(reward, bool) or not isinstance(reward, (int, float)) or not math.isfinite(reward):
    raise ValueError("reward must be a finite JSON number")

output = Path(sys.argv[2])
fd, temporary = tempfile.mkstemp(prefix=".reward.", suffix=".tmp", dir=output.parent)
try:
    with os.fdopen(fd, "w") as destination:
        json.dump({"reward": reward}, destination, allow_nan=False)
        destination.flush()
        os.fsync(destination.fileno())
    os.replace(temporary, output)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
print(f"[test.sh] reward = {reward:.4f}")
PY
`

const GRADER_PY = `"""可信正式评分实现。由 /tests/test.sh 调用；不信任候选自报分数。

候选代码进入 Verifier 后仍是不可信代码：可访问私有标签，但必须限制文件、用户与进程权限。
不得把 Python 候选直接 import 到拥有全部私有权限的 grader 进程。
"""

import argparse
import json


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--submission", required=True)
    parser.add_argument("--out", required=True)
    return parser.parse_args()


def grade(submission_dir):
    """返回 {"reward": <有限数值>, "raw": {...}, "gates": {...}}。

    TODO 实现：校验候选 -> 执行本题推理或必要计算 -> 计算原始指标与归一化分数。
    归一化：maximize 用 (x-B)/(U-B)；minimize 用 (B-x)/(B-U)。
    连续、单调、不裁剪；baseline = 0、预计可达上限 = 1。
    非作弊的硬约束违反返回 -1；格式错误/超时/资源超限/基础设施错误分开标记。
    """
    raise NotImplementedError("grader 尚未实现")


def main():
    args = parse_args()
    try:
        detail = grade(args.submission)
    except NotImplementedError as error:
        detail = {"reward": None, "status": "NOT_IMPLEMENTED", "error": str(error)}
    with open(args.out, "w", encoding="utf-8") as destination:
        json.dump(detail, destination, ensure_ascii=False, indent=2)
    print(f"[grader] status={detail.get('status', 'OK')} reward={detail.get('reward')}")


if __name__ == "__main__":
    main()
`

const PUBLIC_GRADER_PY = `"""Agent 可见的 Public/Dev 评分入口；每轮迭代据此得到反馈。

指标定义与约束同正式评分保持一致，数据切分及对应 B/U 标定按协议分别固定。
不把 Dev 分数当成 Hidden 分数。
"""

import argparse
import json


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--submission", required=True)
    parser.add_argument("--repeats", type=int, default=3)
    return parser.parse_args()


def main():
    args = parse_args()
    # TODO 实现：读取 public_assets/dev 下公开用例，执行候选，输出
    # {"status": ..., "score": <有限数值或 null>, "cases": [...], "diagnostics": {...}}
    # 失败返回分类状态与 score=null，不要返回 0 冒充有效分数。
    print(json.dumps({
        "status": "NOT_IMPLEMENTED",
        "score": None,
        "repeats": args.repeats,
        "cases": [],
        "diagnostics": {"note": "实现 public_eval/grader.py 后此处返回真实代理分数"},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
`

const TRAJECTORY_TEMPLATE = `{
  "rounds": []
}
`

const EXPERT_ANNOTATION_TEMPLATE = `{
  "task_id": "TODO",
  "task_type": "TODO",
  "research_direction": "TODO",
  "optimization_surface": "TODO",
  "score_contract": {
    "metric": "TODO",
    "direction": "maximize",
    "split": "dev",
    "protocol": "TODO",
    "baseline": { "raw_value": null, "normalized_score": 0.0 },
    "reference": { "raw_value": null, "normalized_score": null },
    "upper_bound": { "raw_value": null, "source": "estimated_attainable_upper_bound" }
  },
  "isolation": {
    "reference_visible_to_agent": false,
    "hidden_assets_visible_to_agent": false
  }
}
`

const RUN_SUMMARY_TEMPLATE = `{
  "task_id": "TODO",
  "status": "pilot_required",
  "image": "TODO",
  "agent_execution": [
    {
      "runtime": "Codex",
      "model": "GPT-5.6 Sol",
      "duration_hours": null,
      "effective_rounds": null,
      "typical_round_minutes": null
    },
    {
      "runtime": "Codex",
      "model": "Seed 2.1 Turbo",
      "duration_hours": null,
      "effective_rounds": null,
      "typical_round_minutes": null
    }
  ],
  "fast_iteration_exception": {
    "used": false,
    "non_training": null,
    "short_iterations": null,
    "rollable_proved": false,
    "evidence": ""
  },
  "validation": {
    "baseline_passed": false,
    "reference_passed": false,
    "optimization_evidence_complete": false,
    "best_method_rerun_passed": false
  }
}
`

const COMPARISON_SUMMARY_TEMPLATE = `{
  "schema_version": "autoresearch-comparison-summary.v2",
  "status": "NOT_RUN",
  "metric": { "name": "TODO", "direction": "maximize" },
  "seeds": [],
  "paired_results": {},
  "statistics": {
    "paired_run_count": null,
    "baseline_mean": null,
    "baseline_sample_std": null,
    "reference_mean": null,
    "reference_sample_std": null,
    "mean_paired_improvement": null,
    "relative_improvement": null,
    "baseline_sigma_multiple": null
  },
  "significance_rule": { "required_baseline_sigma_multiple": 3.0, "passed": false },
  "validity": {
    "same_protocol": false,
    "same_seed_set": false,
    "all_quality_gates_passed": false,
    "all_checkpoints_reload_and_rescore_passed": false
  }
}
`

/** 生成题包骨架；返回新建文件清单。 */
export async function scaffoldTaskPackage(taskRoot, options) {
  const title = options.title ?? 'AutoResearch 任务'
  const taskName = options.taskName ?? 'TODO/task-name'
  const created = []

  const files = [
    // workspace/ 可执行题目
    ['workspace/harbor_task/instruction.md', instructionTemplate(title)],
    ['workspace/harbor_task/task.toml', taskTomlTemplate(taskName, title)],
    ['workspace/harbor_task/environment/Dockerfile', ENVIRONMENT_DOCKERFILE],
    ['workspace/harbor_task/environment/requirements.txt', '# 固定实际依赖及版本；只保留运行必需项。\n'],
    ['workspace/harbor_task/environment/public_eval/grader.py', PUBLIC_GRADER_PY],
    ['workspace/harbor_task/environment/public_eval/README.md', '# public_eval\n\nAgent 可见的 Public/Dev 评分入口。每轮迭代据此得到反馈。\n'],
    ['workspace/harbor_task/environment/public_assets/dev/README.md', '# public_assets/dev\n\n公开 Dev 数据目录，用于每轮检测，不用于训练。\n'],
    ['workspace/harbor_task/environment/starter/README.md', '# starter\n\n起始实现。构建时从 starter/ 初始化只读 /workspace/starter 与可写 /workspace/solution。\n'],
    ['workspace/harbor_task/tests/Dockerfile', TESTS_DOCKERFILE],
    ['workspace/harbor_task/tests/test.sh', TEST_SH],
    ['workspace/harbor_task/tests/grader.py', GRADER_PY],
    ['workspace/harbor_task/tests/requirements.txt', '# 评分依赖，按需提供；Verifier 依赖须在自己的镜像准备好。\n'],
    ['workspace/harbor_task/tests/hidden_assets/README.md',
      '# hidden_assets\n\nHidden 评测材料必需；目录名只是示例。可私有侧预置，或由平台在评分时安全注入，\n也可在 Verifier 内按固定私有规则生成。具体方式须声明并验证；空目录或一句「平台会注入」不算完成。\n'],
    ['workspace/reference/README.md',
      '# reference\n\n专家侧可执行参考解，对 Agent 不可见，只用于证明可解和难度标定。\n不映射到固定分数，也不封顶。与 Baseline 使用同一数据、协议、资源口径和完整正式 seed 集合。\n'],

    // expert_evidence/
    ['expert_evidence/README.md', expertEvidenceReadme()],
    ['expert_evidence/专家作业说明文档.md', expertReportTemplate()],
    ['expert_evidence/expert_annotation.json', EXPERT_ANNOTATION_TEMPLATE],
    ['expert_evidence/run_summary.json', RUN_SUMMARY_TEMPLATE],
    ['expert_evidence/trajectory_codex.json', TRAJECTORY_TEMPLATE],
    ['expert_evidence/trajectory_seed.json', TRAJECTORY_TEMPLATE],
    ['expert_evidence/best_method/README.md',
      '# best_method\n\n两条专家 Agent 轨迹中按相同 Public/Dev 口径选出的唯一最终方法。\n' +
      '仅保留最终最佳方法，不保留历史快照或两份候选方法；不含 Reference、Hidden 数据、\n评分日志、运行 ID、审核材料或密钥。已在干净任务快照中重新运行并成功出分。\n'],
    ['expert_evidence/nop_selfcheck/README.md',
      '# nop_selfcheck\n\n同一次 NOP Trial 的 config.json、result.json、reward.txt 或 reward.json，以及运行日志。\n' +
      '平台已提供同版本任务的完整自检记录时，可直接引用，无需重复执行。\n'],

    // optimization_evidence/
    ['optimization_evidence/README.md', optimizationEvidenceReadme()],
    ['optimization_evidence/训练证据说明.md', trainingEvidenceTemplate()],
    ['optimization_evidence/baseline_runs/README.md',
      '# baseline_runs\n\n逐 seed 目录：seed_<真实seed>/{result.json, run.log, model/}。\n' +
      'model/ 仅训练型任务存在；不训练模型的任务不建空 model/，在 result.json 标记 NOT_APPLICABLE。\n'],
    ['optimization_evidence/reference_runs/README.md',
      '# reference_runs\n\n与 Baseline 同 seed 一一配对；已跑五个 seed 就交五组，不抽样、不改名。\n'],
    ['optimization_evidence/comparison_summary.json', COMPARISON_SUMMARY_TEMPLATE],
  ]

  for (const [relativePath, content] of files) {
    if (await writeIfAbsent(join(taskRoot, relativePath), content)) created.push(relativePath)
  }

  return { created, skipped: files.length - created.length }
}

function expertEvidenceReadme() {
  return `# expert_evidence

专家标注、Agent 轨迹与最终方法。只交平台，不挂载给 Agent。

| 交付物 | 唯一用途 |
|---|---|
| \`专家作业说明文档.md\` | 让平台和复现人员理解任务、运行、评分、隔离、专家过程和已知限制 |
| \`best_method/\` | 两条轨迹中选出的唯一最终方法代码，不放训练 checkpoint |
| \`expert_annotation.json\` | 题目类型、优化面、指标方向、B/R/U 和隔离关系的精简机读标注 |
| \`run_summary.json\` | 专家自验状态、两种 Agent 模型组合的有效时长、复测和选优依据 |
| \`trajectory_seed.json\` / \`trajectory_codex.json\` | 分别保存两种 Agent 模型的逐轮完整迭代记录（八字段） |
| \`nop_selfcheck/\` | 同一次 NOP Trial 的 config/result/reward/日志 |

三个顶层目录职责不重复：\`workspace/\` 是可执行题目；\`expert_evidence/\` 是专家标注、
Agent 轨迹和最终方法；\`optimization_evidence/\` 是 Baseline、Reference 与优化面的
独立真实性证据。
`
}

function expertReportTemplate() {
  return `# 专家作业说明文档

按以下顺序填写；只陈述专家自验事实，不写「审核通过」或官方 Hidden 结果。

## 1. 题目身份
Task ID、题目名称、S1/S2/S3、研究方向和变体编号。

TODO

## 2. 问题定义
输入、输出、搜索空间、允许修改范围和固定内容。

TODO

## 3. 构建与运行
两套 Dockerfile、各自 context、构建命令与镜像标识，以及 Public/Dev 和最终 Verifier 入口；
记录目标 Harbor 版本、实际启动命令、artifacts 提交路径、评分输出格式与平台侧结果位置，
并附 separate/artifacts 生效及候选移交自验证据。

TODO

## 4. 评分设计
原始指标、方向、B/R/U、归一化公式、随机评测口径和资源；B/R 必须使用多次训练均值，
并引用 \`optimization_evidence/comparison_summary.json\` 的 3σ/5σ 证据。

TODO

## 5. 隔离设计
Agent 可见、可写和不可见内容；Hidden 预置、生成或安全注入方式，以及候选在 Verifier 中的
受限执行方式。明确是否已获授权实跑 Hidden。

TODO

## 6. 自迭代简要结论
Codex + GPT-5.6 Sol 和 Codex + Seed 2.1 Turbo 的实际有效时长、尝试的方法方向，
以及最终选择 \`best_method/\` 的理由。若使用 7 小时例外，先说明任务不涉及训练、
单轮迭代很短的依据，再写明每条轨迹至少 3 轮有效闭环等可持续 Roll 证据。

TODO

## 7. 已知限制与风险

TODO
`
}

function optimizationEvidenceReadme() {
  return `# optimization_evidence

只保存 Baseline/Reference 的全部正式 seed 结果、原始日志、训练型模型与统计汇总。
只交平台，不进入 Agent 工作区。

| 文件或目录 | 必填内容 |
|---|---|
| \`训练证据说明.md\` | 中文说明 Baseline/Reference、优化面、正式 seed、固定协议、质量门、复现方式、汇总结论和已知记录缺口 |
| \`baseline_runs/seed_<真实seed>/result.json\` | 一轮主记录：状态、角色、真实 seed、方法与依赖哈希、协议、训练设置、执行信息、指标、质量门和产物索引 |
| \`baseline_runs/seed_<真实seed>/run.log\` | 原始 stdout/stderr，包括 warning 和失败信息；不得改写成只剩最终分数的人工摘要 |
| \`baseline_runs/seed_<真实seed>/model/\` | 仅训练型任务：真实 checkpoint、artifact.json（格式/大小/SHA-256/来源/重载结论）、reload.log |
| \`comparison_summary.json\` | 逐 seed 成对值、两组均值与样本标准差、改善方向、显著性判定、聚合质量门、模型完整性和源结果路径 |

不再作为最小必交项：\`data_manifest.json\`、\`experiment_plan.json\`、\`surface_validation.json\`、
\`surface_diff.patch\`、\`integrity_manifest.json\`、\`train_config.yaml\`、\`ablation/\`
和额外的 \`runs/\` 中间层。

隔离要求：JSON 内路径统一相对提交包根目录；缺失的命令、时间或退出码必须写 \`null\` 并解释，
不能反推或伪造。客观上不训练模型的任务不建空 \`model/\`，在 \`result.json\` 标记 \`NOT_APPLICABLE\`。
`
}

function trainingEvidenceTemplate() {
  return `# 训练证据说明

## 1. 角色与方法
Baseline 与 Reference 各自的方法、来源与关键差异。

TODO

## 2. 优化面
Reference 的实际代码变化只位于题面允许的优化面内；说明关键差异。

TODO

## 3. 正式 seed
声明完整正式 seed 集合；Baseline 与 Reference 必须使用完全相同的 seed 集合。

TODO

## 4. 固定协议
相同 seed、数据切分、预处理、资源预算、指标和评测协议。

TODO

## 5. 质量门
质量门定义与逐 seed 通过情况。

TODO

## 6. 复现方式
命令、环境、依赖版本与执行顺序。

TODO

## 7. 汇总结论
引用 \`comparison_summary.json\` 的均值、样本标准差与 σ 倍数。

TODO

## 8. 已知记录缺口
缺失的命令、时间或退出码写 null 并解释。

TODO
`
}
