#!/usr/bin/env python3
"""paper_screen.py —— 选题期零成本筛查（P0 强制，30 分钟）

来源：2026-10-07 全项目 9 条题线 + 错误登记册 83 条事故的只读提炼
（见 references/failure-patterns.md）。项目的宏观结论是：
  「14 道题 7% 成功率，死因 100% 在选题」
所以本工具只做一件事：**在花钱之前，用静态判据把注定失败的题筛掉**。

它实现 §二 六类死因过滤器 + 玩具四判据 + 2001 同构标准，能自动查的自动查，
不能自动查的打印**人工核查指令**（给出具体命令，不是"要小心"）。

用法：
  python paper_screen.py --title "论文标题" --repo owner/name [--data url] [--paper-url url]
                         [--community-baseline 81.8] [--reported-baseline 58.0]
                         [--delta-percent 34] [--n-benchmarks 3] [--reports-sigma]
                         [--n-ablation 2] [--metric-type physical|llm-judge|winrate]
                         [--out screen_report.json]
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.request

sys.stdout.reconfigure(encoding="utf-8")


def run(cmd, timeout=60):
    try:
        p = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return p.stdout.strip(), p.returncode
    except Exception as e:
        return f"(error: {e})", -1


def gh_api(path):
    out, rc = run(f'curl -s --max-time 25 "https://api.github.com/{path}"')
    if rc != 0 or not out:
        return None
    try:
        return json.loads(out)
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser(description="选题期零成本筛查（P0）")
    ap.add_argument("--title", required=True)
    ap.add_argument("--repo", default=None, help="owner/name")
    ap.add_argument("--paper-url", default=None)
    ap.add_argument("--data", default=None, help="数据集下载 URL")
    # 人工提供的论文数字（用于判据判据 3/5 与玩具四判据）
    ap.add_argument("--community-baseline", type=float, default=None,
                    help="社区公认的 baseline 分数（如 81.8）")
    ap.add_argument("--reported-baseline", type=float, default=None,
                    help="论文报告的 baseline 分数（如 58.0）")
    ap.add_argument("--delta-percent", type=float, default=None,
                    help="论文声称的相对增益百分比（如 34 表示 +34%%）")
    ap.add_argument("--n-benchmarks", type=int, default=None, help="主表覆盖的 benchmark 数")
    ap.add_argument("--reports-sigma", action="store_true", help="论文是否报告 ±σ")
    ap.add_argument("--n-ablation", type=int, default=None, help="消融实验数量")
    ap.add_argument("--metric-type", choices=["physical", "llm-judge", "winrate"], default=None,
                    help="指标类型：物理量 / LLM 判定 / 胜率")
    ap.add_argument("--out", default=None, help="报告 JSON 输出路径")
    args = ap.parse_args()

    checks = []      # (判据名, 状态 PASS/FAIL/WARN/MANUAL, 说明, 机器证据)

    def add(name, status, note, evidence=""):
        checks.append({"check": name, "status": status, "note": note, "evidence": evidence})

    print("=" * 78)
    print(f"选题筛查：{args.title}")
    print("=" * 78)

    # ---------- 死因 1：官方仓存在且非空壳 ----------
    if args.repo:
        info = gh_api(f"repos/{args.repo}")
        if not info or info.get("message") == "Not Found":
            # 可能重定向
            info2 = gh_api(f"repos/{args.repo.split('/')[0]}/{args.repo.split('/')[-1]}")
            add("死因1 官方仓", "FAIL",
                "GitHub API 404（若为 PMLR 论文，须抓 PMLR 页面 HTML 确认代码链接）",
                f"repo={args.repo}")
            info = info2
        if info and info.get("full_name"):
            size_kb = info.get("size", 0)
            pushed = info.get("pushed_at", "?")
            default_branch = info.get("default_branch", "main")
            # 取文件树看是否有训练代码
            tree = gh_api(f"repos/{info['full_name']}/git/trees/{default_branch}?recursive=1")
            paths = [t["path"] for t in tree.get("tree", [])] if tree else []
            py_files = [p for p in paths if p.endswith(".py")]
            readme_only = len([p for p in paths if p.lower().startswith("readme")]) == 1 and len(paths) <= 3
            status = "FAIL" if (size_kb < 500 or readme_only) else "PASS"
            add("死因1 官方仓", status,
                f"size={size_kb}KB pushed={pushed} 文件数={len(paths)} py文件={len(py_files)}"
                + (" ← 疑似空壳（仅 README）" if readme_only else ""),
                f"full_name={info['full_name']}")
            # 死因 2：训练代码存在性
            if py_files:
                hits = [p for p in py_files if re.search(r"(train|run|main|fit)", p, re.I)]
                grep_out, _ = run(
                    f'gh api repos/{info["full_name"]}/contents --jq ".[].name" 2>/dev/null | head -20')
                add("死因2 训练代码", "PASS" if hits else "MANUAL",
                    f"疑似训练入口 {len(hits)} 个" + ("" if hits else
                    " ← 须手动：git clone --depth 1 --filter=blob:none --no-checkout 后 grep 'def main|Trainer('"),
                    f"candidates={hits[:5]}")
            else:
                add("死因2 训练代码", "FAIL", "仓库内无 .py 文件（HF 只有 safetensors = 只是训练产物）", "")
    else:
        add("死因1/2 官方仓", "MANUAL", "未提供 --repo；必须实查（GitHub API + PMLR 页面 HTML）", "")

    # ---------- 死因 3：baseline 口径不可比（1851 死因）----------
    if args.community_baseline is not None and args.reported_baseline is not None:
        gap = args.community_baseline - args.reported_baseline
        ratio = gap / max(abs(args.community_baseline), 1e-9)
        # 论文增益的可信部分：从社区 baseline 起算
        if args.delta_percent is not None:
            # 论文报告的绝对增益
            abs_gain = args.reported_baseline * args.delta_percent / 100.0
            gain_from_community = abs_gain - gap
            verdict = "FAIL" if gain_from_community <= 0 else "WARN"
            add("死因3 baseline 口径", verdict,
                f"社区 {args.community_baseline} vs 论文 {args.reported_baseline}（差 {gap:+.1f}）"
                f"；论文声称增益 {abs_gain:+.1f} → 扣除被低估部分后仅 {gain_from_community:+.1f}",
                "机制：论文 baseline 若为'原文献报告值'而非自跑，增益空间是虚的")
            if verdict == "FAIL":
                add("★ 直接弃题建议", "FAIL",
                    "扣除 baseline 低估后增益 ≤ 0 → 该题不可做（1851 同款死因）", "")
        else:
            add("死因3 baseline 口径", "WARN" if ratio > 0.15 else "PASS",
                f"社区 {args.community_baseline} vs 论文 {args.reported_baseline}"
                f"（论文低 {ratio*100:.0f}%）" + (" ← 须查是否作者自跑" if ratio > 0.15 else ""), "")
    else:
        add("死因3 baseline 口径", "MANUAL",
            "必须对照「社区公认值 vs 论文报告值」；差值>15% 时查论文 baseline 是否作者自跑", "")

    # ---------- 死因 5：trivial 基线（1430 死因）----------
    add("死因5 trivial 基线", "MANUAL",
        "必须先跑 persistence / 最近邻 这类 trivial 基线（1430：persistence 2.40 打败论文方法 2.69）", "")

    # ---------- 死因 6 + 玩具四判据 ----------
    if args.n_benchmarks is not None:
        add("死因6 广度", "PASS" if args.n_benchmarks >= 3 else "FAIL",
            f"主表 benchmark 数 = {args.n_benchmarks}（要求 ≥3）", "")
    else:
        add("死因6 广度", "MANUAL", "统计主表覆盖的 benchmark/数据集数（要求 ≥3）", "")
    if args.n_ablation is not None:
        add("玩具判据4 消融", "PASS" if args.n_ablation >= 1 else "WARN",
            f"消融实验 {args.n_ablation} 个（无消融=降权）", "")
    else:
        add("玩具判据4 消融", "MANUAL", "确认论文有消融（无消融 = 降权）", "")
    add("玩具判据3 ±σ", "PASS" if args.reports_sigma else "WARN",
        "论文报告 ±σ" if args.reports_sigma
        else "论文未报 ±σ → 3σ 判据没有分母（须自行估计 σ，成本上升）", "")
    if args.delta_percent is not None:
        add("2001 同构 增益幅度", "PASS" if args.delta_percent >= 10 else "WARN",
            f"论文声称增益 {args.delta_percent}%（2001 标准要求 ≥10%；+7% 级不够）", "")
    else:
        add("2001 同构 增益幅度", "MANUAL", "读取论文主图/主表的增益幅度（要求 ≥10%）", "")

    # ---------- 指标类型（U 可构造性）----------
    if args.metric_type:
        ok = args.metric_type == "physical"
        add("指标类型（U 可构造）", "PASS" if ok else "FAIL",
            {"physical": "物理量指标 → U 可零泄漏构造 ✓",
             "llm-judge": "LLM 判定 → U 无法零泄漏构造（官方严禁反推 U）✗",
             "winrate": "胜率 → U 无法零泄漏构造 ✗"}[args.metric_type], "")
    else:
        add("指标类型（U 可构造）", "MANUAL",
            "确认指标是物理量（reward/成功率/时间/仿真回报）；排除 LLM-judge / 人工评测 / win-rate", "")

    # ---------- 数据可得性 ----------
    if args.data:
        out, rc = run(f'curl -sI --max-time 25 "{args.data}" | head -3')
        code = re.search(r"HTTP/[\d.]+ (\d{3})", out or "")
        add("数据可得性", "PASS" if code and code.group(1) in ("200", "302", "206") else "WARN",
            f"HEAD {args.data} → {(code.group(1) if code else 'unknown')}", out.splitlines()[0] if out else "")

    # ---------- 输出 ----------
    print()
    icon = {"PASS": "✓", "FAIL": "✗", "WARN": "!", "MANUAL": "?"}
    for c in checks:
        print(f"  [{icon.get(c['status'],' ')}] {c['check']:26s} {c['note']}")
        if c["evidence"]:
            print(f"      └ {c['evidence']}")

    n_fail = sum(1 for c in checks if c["status"] == "FAIL")
    n_manual = sum(1 for c in checks if c["status"] == "MANUAL")
    n_warn = sum(1 for c in checks if c["status"] == "WARN")

    print("\n" + "=" * 78)
    print(f"汇总：FAIL={n_fail}  WARN={n_warn}  MANUAL={n_manual}  PASS="
          f"{sum(1 for c in checks if c['status']=='PASS')}")
    if n_fail:
        print("✗ 存在 FAIL 判据 → **弃题或换切入点**，不要进入 P1")
        rc = 1
    elif n_manual:
        print("? 仍有 MANUAL 项 → 逐条按提示实查（多为零成本静态检查）")
        print("  全部 MANUAL 清零后，再跑 tools/feasibility_gate.py --from-paper")
        rc = 2
    else:
        print("✓ 静态筛查通过 → 下一步：tools/feasibility_gate.py --from-paper（判定预解）")
        rc = 0

    if args.out:
        json.dump({"title": args.title, "checks": checks,
                   "summary": {"fail": n_fail, "warn": n_warn, "manual": n_manual}},
                  open(args.out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"报告已写入 {args.out}")
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
