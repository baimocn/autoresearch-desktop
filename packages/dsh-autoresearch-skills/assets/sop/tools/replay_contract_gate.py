#!/usr/bin/env python3
"""replay_contract_gate.py —— 提交物"可复算契约"预检门禁（打包前，只读，零 GPU）

来源：2026-10-09 AutoRe0823 实战（见 references/field-lessons.md L17）。

背景：把 Verifier 从"读候选交的预测文件"改成**可信复算**（用候选权重按声明重算预测再比对）后，
发现该题一条 best method 的原提交**永远无法复算**——它的方法源码是 5 模型集成，但只保存了
第 1 个成员（`torch.save({"state_dict": models[0].state_dict()})`），其余 4 个从未落盘。
表现是 `PREDICTION_MISMATCH`，且失配率是 **10%+ 而不是 100%**（因为第 1 个成员本身也是有效模型）。

本工具把那次事故的判据固化成**打包前的静态预检**，回答一个问题：
    **这份提交物够不够被独立复算？**

它只读文件、不加载模型、不运行训练、不接触私有材料。

用法：
  # 检查一个提交目录（含 train.py / model.pt / inference.json / pred_test.npy 中的若干）
  python replay_contract_gate.py --solution <目录>

  # 也可只检查单个源码文件（判断集成成员是否全部落盘）
  python replay_contract_gate.py --source <train.py 路径>

输出：逐项 PASS / FAIL / MANUAL + 修法；末尾给总体结论。

退出码：0=通过；1=硬失败（不可复算的确定性缺陷）；2=需人工确认（静态判不了）

实测（2026-10-09，四例，判据与退出码均符合预期）：
  · 真实失败案例（AutoRe0823 seed 轨 train.py，集成只存 models[0]）
      → FAIL，退出码 1，命中 `torch.save({"state_dict": models[0].state_dict(),`
  · 单模型源码（gpt56 轨 train.py）           → PASS，退出码 0
  · 完整目录缺 inference.json                 → MANUAL，退出码 2
  · 清单指向不存在的成员 `missing_m2.pt`      → FAIL，退出码 1
  · pred_test.npy 为 int32 而非 int64          → FAIL，退出码 1
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

EXIT_OK, EXIT_FAIL, EXIT_MANUAL = 0, 1, 2

# 集成特征：源码里出现这些，说明方法由多个模型组成
ENSEMBLE_HINTS = (
    r"\bn_ensemble\b",
    r"\bensemble_predict\b",
    r"\bmodels\.append\b",
    r"\bmodel_list\b",
    r"\bswa\b",
    r"\bcheckpoint_ensemble\b",
)
# 只保存单个对象的写法（危险信号）
SINGLE_SAVE = (
    r"torch\.save\(\s*\{\s*\"state_dict\"\s*:\s*models\[0\]",
    r"torch\.save\(\s*models\[0\]",
    r"torch\.save\(\s*\{\s*'state_dict'\s*:\s*models\[0\]",
)
SUPPORTED_POOLS = {"mean_logits", "mean_probabilities", "log_mean_probabilities"}
SUPPORTED_READOUTS = {"logits", "affine", "custom"}


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str]] = []   # (level, item, detail)
        self.hard = 0
        self.manual = 0

    def add(self, level: str, item: str, detail: str) -> None:
        self.rows.append((level, item, detail))
        if level == "FAIL":
            self.hard += 1
        elif level == "MANUAL":
            self.manual += 1

    def emit(self) -> int:
        print("=" * 72)
        for level, item, detail in self.rows:
            mark = {"PASS": "✓", "FAIL": "✗", "MANUAL": "?"}.get(level, " ")
            print(f" {mark} [{level:6s}] {item}")
            if detail:
                for line in detail.splitlines():
                    print(f"            {line}")
        print("=" * 72)
        if self.hard:
            print(f"结论：不通过（{self.hard} 项硬失败）—— 修好后重跑本门禁。")
            return EXIT_FAIL
        if self.manual:
            print(f"结论：需人工确认（{self.manual} 项静态判不了）—— 请按提示补充证据。")
            return EXIT_MANUAL
        print("结论：通过（静态契约自洽）。注意本门禁不替代真实复算。")
        return EXIT_OK


def check_source(path: Path, rep: Report) -> None:
    """源码级：集成方法是否全部落盘。"""
    if not path.is_file():
        rep.add("MANUAL", f"源码 {path.name}", "文件不存在，跳过源码级判据。")
        return
    text = path.read_text(encoding="utf-8", errors="replace")
    has_ensemble = any(re.search(p, text, re.I) for p in ENSEMBLE_HINTS)
    single_save = any(re.search(p, text, re.I) for p in SINGLE_SAVE)
    saves = re.findall(r"torch\.save\([^\n]*", text)

    if has_ensemble and single_save:
        rep.add("FAIL", f"集成契约（{path.name}）",
                "源码含集成特征，却只保存单个成员（匹配到 `torch.save({... models[0] ...})`）。\n"
                "后果：其余成员从未落盘 ⇒ 原提交在可信复算下必然 PREDICTION_MISMATCH（失配率约 10%+）。\n"
                "修法：保存全部成员并在推理清单里逐个声明；或改用单模型方法。\n"
                f"该文件的 save 调用：{saves[:3] if saves else '（未匹配到）'}")
    elif has_ensemble:
        rep.add("PASS", f"集成契约（{path.name}）",
                f"检出集成特征且未发现\"只存 models[0]\"的写法；save 调用 {len(saves)} 处。")
    else:
        rep.add("PASS", f"单模型契约（{path.name}）", "未检出集成特征，单模型保存不构成复算障碍。")


def check_manifest(sol: Path, rep: Report) -> bool:
    """清单级：inference.json 的成员是否都真实存在。"""
    man = sol / "inference.json"
    if not man.is_file():
        rep.add("MANUAL", "推理清单", "无 inference.json：无法静态判定读出方式（默认单模型单视图）。")
        return False
    try:
        spec = json.loads(man.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        rep.add("FAIL", "推理清单", f"inference.json 无法解析：{type(exc).__name__}")
        return False

    if not isinstance(spec, dict) or spec.get("schema_version") != 1:
        rep.add("FAIL", "推理清单", "schema_version 必须为 1。")
        return False

    models = spec.get("models")
    if not isinstance(models, list) or not models:
        rep.add("FAIL", "推理清单", "models 必须是非空数组。")
        return False

    missing, bad_pool, bad_view = [], [], []
    for idx, m in enumerate(models):
        if not isinstance(m, dict):
            rep.add("FAIL", "推理清单", f"models[{idx}] 不是对象。")
            return False
        ckpt = m.get("checkpoint")
        if not isinstance(ckpt, str) or not ckpt:
            missing.append(f"models[{idx}].checkpoint 缺失")
        elif not (sol / ckpt).is_file():
            missing.append(f"models[{idx}].checkpoint 指向的文件不存在：{ckpt}")
        pool = m.get("pool", "mean_logits")
        if pool not in SUPPORTED_POOLS:
            bad_pool.append(f"models[{idx}].pool={pool!r}")
        views = m.get("views", [{}])
        if not isinstance(views, list) or not views:
            bad_view.append(f"models[{idx}].views 空或非数组")

    readout = spec.get("readout", {"type": "logits"})
    rtype = readout.get("type", "logits") if isinstance(readout, dict) else None

    if missing:
        rep.add("FAIL", "推理清单·成员文件", "\n".join(missing) +
                "\n修法：补齐成员权重，或从清单里删除不存在的成员。")
    if bad_pool:
        rep.add("FAIL", "推理清单·池化", f"不支持的 pool：{bad_pool}；支持 {sorted(SUPPORTED_POOLS)}")
    if bad_view:
        rep.add("FAIL", "推理清单·视图", "\n".join(bad_view))
    if rtype not in SUPPORTED_READOUTS:
        rep.add("FAIL", "推理清单·读出", f"不支持的 readout.type={rtype!r}；支持 {sorted(SUPPORTED_READOUTS)}")

    if not (missing or bad_pool or bad_view) and rtype in SUPPORTED_READOUTS:
        rep.add("PASS", "推理清单",
                f"{len(models)} 个成员、读出 {rtype}；全部 checkpoint 文件存在。")
    if rtype == "custom":
        rep.add("MANUAL", "推理清单·自定义读出",
                "custom 读出需在隔离沙箱内执行才能判定可复算性；静态只能确认清单结构。")
    return True


def check_predictions(sol: Path, rep: Report) -> None:
    """产物级：预测文件的基本契约。"""
    import struct
    pred = sol / "pred_test.npy"
    if not pred.is_file():
        rep.add("MANUAL", "预测产物", "无 pred_test.npy（候选可能未产出）。")
        return
    try:
        with open(pred, "rb") as fh:
            magic = fh.read(6)
            if magic != b"\x93NUMPY":
                rep.add("FAIL", "预测产物", "pred_test.npy 不是 NPY 格式。")
                return
            fh.read(2)                                   # version
            hlen = struct.unpack("<H", fh.read(2))[0]
            header = fh.read(hlen).decode("latin1")
    except OSError as exc:
        rep.add("FAIL", "预测产物", f"无法读取 pred_test.npy：{type(exc).__name__}")
        return
    if "'i8'" not in header and "'<i8'" not in header:
        rep.add("FAIL", "预测产物",
                "pred_test.npy 的 dtype 不是 int64（'<i8'）—— 可信复算采用不做 dtype 兜底的口径，"
                "会被判 FORMAT_ERROR。")
    elif "True" in header and "descr" in header:
        rep.add("MANUAL", "预测产物", "头部含对象/非常规字段，建议人工确认。")
    else:
        rep.add("PASS", "预测产物", f"NPY 格式、int64；header={header.strip()[:70]}")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="提交物可复算契约预检（只读；来源：AutoRe0823 集成成员未落盘事故）")
    ap.add_argument("--solution", type=Path, help="候选提交目录")
    ap.add_argument("--source", type=Path, help="只检查某个训练脚本源码")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出（便于流水线消费）")
    args = ap.parse_args()

    if not args.solution and not args.source:
        ap.error("至少给一个 --solution 或 --source")

    rep = Report()
    if args.source:
        check_source(args.source, rep)
    if args.solution:
        sol = args.solution
        if not sol.is_dir():
            rep.add("FAIL", "提交目录", f"{sol} 不是目录。")
        else:
            src = sol / "train.py"
            check_source(src, rep)
            check_manifest(sol, rep)
            check_predictions(sol, rep)

    code = rep.emit()
    if args.json:
        print(json.dumps({"exit": code,
                          "rows": [{"level": l, "item": i, "detail": d} for l, i, d in rep.rows]},
                         ensure_ascii=False))
    return code


if __name__ == "__main__":
    sys.exit(main())
