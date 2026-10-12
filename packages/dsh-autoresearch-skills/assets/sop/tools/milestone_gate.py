#!/usr/bin/env python3
"""milestone_gate.py —— 五道不可跳级里程碑门禁（M1–M5）

结构吸收自 autoresearch-skills v0.3.4 的 shift-left QA（`references/shift-left-qa.md`），
判据与代价数据来自本项目 9 条题线的实测（`references/failure-patterns.md`）。

与上游的差别：上游的 `authoring_gate.py` 只核对"证据引用是否齐全"；
本脚本对 M1/M2 做**真实数据判定**（因为它要拦的是"题能不能做"，不是"文件有没有"）。

用法：
  # M1 selection：静态筛查（零成本）——调用 paper_screen.py 的判据
  python milestone_gate.py --milestone M1 --title "..." --repo owner/name ...

  # M2 pilot：拿到 pilot 数字后判定
  python milestone_gate.py --milestone M2 --b 0.1340 --r 0.1300 --u 0.0310 \
      --reference-recomputed yes --receipts pilot_receipt.json

  # M3–M5：核对证据引用（文件/摘要是否齐全）
  python milestone_gate.py --milestone M3 --evidence-dir ./expert_evidence

exit: 0=RECOMMEND  2=NEEDS_EVIDENCE  1=REJECT
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys

sys.stdout.reconfigure(encoding="utf-8")

MILESTONES = {
    "M1": "selection   —— 论文身份/许可/方法级优化面/题库状态（不写题面、不租卡）",
    "M2": "pilot       —— B/R receipt/独立复算/效应与噪声结论（不启动双轨）",
    "M3": "container   —— 双镜像 digest/Hidden 隔离/目标 Harness 完整 trial（不计长跑时长）",
    "M4": "long_run    —— 两条独立血缘/闭合有效时长/机外快照与恢复 probe（不拼接旧轮次）",
    "M5": "release     —— 两份独立 QA/聚合共识/隐私报告/白名单 manifest（任一失败即 NOT READY）",
}

# 每个里程碑的必需证据（文件名匹配，宽松：任一命中即算）
REQUIRED = {
    "M1": [("论文身份与许可边界", ("source", "license", "paper", "身份", "许可")),
           ("方法级优化面定义", ("surface", "优化面", "protocol", "协议")),
           ("题库权威状态（查重/难度）", ("dedup", "查重", "difficulty", "难度", "venue"))],
    "M2": [("Baseline receipt（原始分数+命令+时间）", ("baseline", "b_receipt", "b_")),
           ("Reference receipt", ("reference", "r_receipt", "r_")),
           ("独立复算记录（evaluator 从产物复算）", ("recompute", "复算", "reload", "independent")),
           ("效应与噪声结论", ("effect", "noise", "effect_noise", "效应", "sigma"))],
    "M3": [("Agent 镜像 digest", ("agent", "environment")),
           ("Verifier 镜像 digest", ("verifier", "tests")),
           ("Hidden 隔离证据", ("hidden", "isolation", "隔离")),
           ("目标 Harness 完整 trial 记录", ("trial", "harbor", "nop"))],
    "M4": [("两条独立轨迹血缘", ("trajectory", "codex", "seed_traj", "rounds")),
           ("有效时长台账", ("effective", "时长", "run_summary", "hours")),
           ("机外快照/恢复 probe", ("snapshot", "recovery", "resume", "恢复", "checkpoint"))],
    "M5": [("两份独立 QA 报告", ("qa", "review", "review.json", "implementation_review")),
           ("聚合共识", ("consensus", "共识", "aggregate")),
           ("隐私/泄漏报告", ("privacy", "泄漏", "exposure", "泄露")),
           ("白名单 manifest", ("manifest", "whitelist", "白名单", "pack"))],
}


def sha256_file(path, limit=None):
    h = hashlib.sha256()
    n = 0
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
            n += len(chunk)
            if limit and n >= limit:
                break
    return h.hexdigest()


def scan_evidence(ev_dir):
    """返回目录内所有文件的（相对路径, 大小）"""
    found = []
    for root, _, files in os.walk(ev_dir):
        for f in files:
            p = os.path.join(root, f)
            rel = os.path.relpath(p, ev_dir).replace("\\", "/")
            try:
                found.append((rel.lower(), os.path.getsize(p), rel))
            except OSError:
                pass
    return found


def check_m1(args):
    """M1：静态筛查（委派给 paper_screen.py 的真实判据）"""
    script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "paper_screen.py")
    if not os.path.isfile(script):
        return "NEEDS_EVIDENCE", ["未找到 paper_screen.py；M1 须跑静态筛查（六类死因过滤器）"]
    cmd = [sys.executable, script, "--title", args.title or "(unnamed)"]
    if args.repo:
        cmd += ["--repo", args.repo]
    if args.community_baseline is not None:
        cmd += ["--community-baseline", str(args.community_baseline)]
    if args.reported_baseline is not None:
        cmd += ["--reported-baseline", str(args.reported_baseline)]
    if args.delta_percent is not None:
        cmd += ["--delta-percent", str(args.delta_percent)]
    if args.n_benchmarks is not None:
        cmd += ["--n-benchmarks", str(args.n_benchmarks)]
    if args.n_ablation is not None:
        cmd += ["--n-ablation", str(args.n_ablation)]
    if args.metric_type:
        cmd += ["--metric-type", args.metric_type]
    if args.paper_url:
        cmd += ["--paper-url", args.paper_url]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    tail = (p.stdout or "").strip().splitlines()[-8:]
    if p.returncode == 1:
        return "REJECT", ["M1 静态筛查出现 FAIL 判据（详见 paper_screen 输出）"] + tail
    if p.returncode == 2:
        return "NEEDS_EVIDENCE", ["M1 有 MANUAL 项未清零"] + tail
    return "RECOMMEND", tail


def check_m2(args):
    """M2：pilot 判定——必须同时满足判定门闭合 + 独立复算 + receipt 存在"""
    reasons = []
    status = "RECOMMEND"

    # (a) 判定门（调用 feasibility_gate.py）
    fg = os.path.join(os.path.dirname(os.path.abspath(__file__)), "feasibility_gate.py")
    if args.b and args.r:
        cmd = [sys.executable, fg, "--from-probe", "--b", args.b, "--r", args.r]
        if args.u is not None:
            cmd += ["--u", str(args.u)]
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
        tail = (p.stdout or "").strip().splitlines()[-6:]
        if p.returncode == 1:
            return "REJECT", ["M2 判定门不可闭合（结构性）"] + tail
        if p.returncode == 2:
            status = "NEEDS_EVIDENCE"
            reasons += ["M2 判定门信息不足"] + tail
        else:
            reasons += ["M2 判定门闭合 ✓"] + tail[-2:]
    else:
        status = "NEEDS_EVIDENCE"
        reasons.append("M2 缺少 pilot 的 B/R 数字（--b/--r）")

    # (b) 独立复算必须显式声明是（evaluator 从产物复算，不是候选自报）
    if args.reference_recomputed == "yes":
        reasons.append("独立复算：已声明 ✓")
    else:
        status = "NEEDS_EVIDENCE" if status != "REJECT" else status
        reasons.append("独立复算：未声明（--reference-recomputed yes）——上游要求 evaluator 能从候选产物独立复算主指标")

    # (c) receipt 存在且可哈希
    for f in (args.receipts or []):
        if not os.path.isfile(f):
            status = "NEEDS_EVIDENCE" if status != "REJECT" else status
            reasons.append(f"receipt 缺失：{f}")
        else:
            reasons.append(f"receipt ✓ {os.path.basename(f)} sha256={sha256_file(f)[:16]}")
    return status, reasons


def check_evidence_milestone(args, ms):
    """M3–M5：核对证据引用是否齐全（上游语义：只查引用齐全）"""
    if not args.evidence_dir or not os.path.isdir(args.evidence_dir):
        return "NEEDS_EVIDENCE", [f"{ms} 需要 --evidence-dir（含该里程碑证据的目录）"]
    files = scan_evidence(args.evidence_dir)
    blob = " ".join(x[0] for x in files)
    reasons, missing = [], []
    for label, keys in REQUIRED[ms]:
        hit = [k for k in keys if k in blob]
        if hit:
            reasons.append(f"✓ {label}（命中 {hit[0]}）")
        else:
            missing.append(label)
    if missing:
        return "NEEDS_EVIDENCE", reasons + [f"缺失：{'、'.join(missing)}"]
    return "RECOMMEND", reasons + [f"证据文件 {len(files)} 个"]


def main() -> int:
    ap = argparse.ArgumentParser(description="五道不可跳级里程碑门禁")
    ap.add_argument("--milestone", required=True, choices=list(MILESTONES))
    # M1
    ap.add_argument("--title"); ap.add_argument("--repo"); ap.add_argument("--paper-url")
    ap.add_argument("--community-baseline", type=float); ap.add_argument("--reported-baseline", type=float)
    ap.add_argument("--delta-percent", type=float); ap.add_argument("--n-benchmarks", type=int)
    ap.add_argument("--n-ablation", type=int); ap.add_argument("--metric-type")
    # M2
    ap.add_argument("--b"); ap.add_argument("--r"); ap.add_argument("--u", type=float)
    ap.add_argument("--reference-recomputed", choices=["yes", "no"])
    ap.add_argument("--receipts", nargs="*")
    # M3–M5
    ap.add_argument("--evidence-dir")
    args = ap.parse_args()

    ms = args.milestone
    print("=" * 78)
    print(f"{ms}: {MILESTONES[ms]}")
    print("=" * 78)

    if ms == "M1":
        status, reasons = check_m1(args)
    elif ms == "M2":
        status, reasons = check_m2(args)
    else:
        status, reasons = check_evidence_milestone(args, ms)

    for r in reasons:
        print(f"  {r}")
    print("\n" + "-" * 78)
    verdict = {"RECOMMEND": ("RECOMMEND", 0), "NEEDS_EVIDENCE": ("NEEDS_EVIDENCE", 2),
               "REJECT": ("REJECT", 1)}[status]
    print(f"门禁结论：{verdict[0]}")
    if status == "REJECT":
        print("  ✗ 有硬门槛 FAIL → **不得进入下一里程碑**（按最小返修循环：只修当前最早失败项）")
    elif status == "NEEDS_EVIDENCE":
        print("  ? 有 UNKNOWN/REVIEW → 补证后才能前进；不得声明通过")
    else:
        if ms != "M5":
            nxt = {"M1": "M2(pilot)", "M2": "M3(container)", "M3": "M4(long_run)", "M4": "M5(release)"}[ms]
            print(f"  ✓ 可以进入 {nxt}")
        else:
            print("  ✓ 全部里程碑通过（release 门仍须两份独立 QA 同源不同会话，本脚本不能替代）")
    print("\n注：本脚本对 M1/M2 做真实数据判定；M3–M5 只核对证据引用是否齐全"
          "（发布门禁的完整语义见上游 shift-left-qa.md：重算 SHA256、核对两份 QA 同源、"
          "以及 clean_context 属可追责声明而非自动取证）。")
    return verdict[1]


if __name__ == "__main__":
    raise SystemExit(main())
