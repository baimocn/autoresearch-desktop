#!/usr/bin/env python3
"""numeric_backsolve.py —— 跨规模参数标定的数值反推（L4，零 GPU 成本）

来源：2026-10-07 AutoRe0566 实战。论文 README 说耗散球壳"内半径的下界应为
norm(data).max()*S"，我按字面取均值 → 球壳覆盖吸引子 → 过阻尼 → 参考解崩。
正确做法：**用官方在已有规模的取值反推它的真实意图**。

本工具做这件事：
  1. 读官方的两个数：官方脚本里硬编码的参数值、官方数据在该规模下的统计量
  2. 判断官方取值落在"数据统计量的哪个位置"（远低于最小值 / 区间内 / 高于最大值）
  3. 由此判定官方意图属于哪一类，并给出跨规模换算的建议公式与候选

用法：
  python numeric_backsolve.py --official-value 10000 \
      --data-stats "min=13786,mean=19096,max=30455" --scale-field S --official-S 64 --target-S 128
"""

import argparse
import sys

sys.stdout.reconfigure(encoding="utf-8")


def parse_kv(s):
    out = {}
    for part in s.split(","):
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = float(v.strip())
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="跨规模参数标定的数值反推")
    ap.add_argument("--official-value", type=float, required=True,
                    help="官方在已有规模上使用的参数值（如 radius=10000）")
    ap.add_argument("--data-stats", required=True,
                    help="官方规模下数据统计量，如 min=13786,mean=19096,max=30455")
    ap.add_argument("--scale-field", default="S", help="随规模线性缩放的字段名（默认 S）")
    ap.add_argument("--official-S", type=float, required=True, help="官方规模的尺度参数（如 64）")
    ap.add_argument("--target-S", type=float, required=True, help="目标规模的尺度参数（如 128）")
    args = ap.parse_args()

    st = parse_kv(args.data_stats)
    ov = args.official_value
    lo, mu, hi = st.get("min"), st.get("mean"), st.get("max")

    print("=" * 72)
    print(f"官方值 = {ov}   官方规模 {args.scale_field} = {args.official_S}   "
          f"目标规模 {args.scale_field} = {args.target_S}")
    if lo is not None and mu is not None and hi is not None:
        print(f"官方数据统计量：min={lo:.1f}  mean={mu:.1f}  max={hi:.1f}")
    print("=" * 72)

    # ---- 反推官方意图 ----
    ratio_to_S = ov / args.official_S
    print(f"\n【反推】官方值 / 官方规模 = {ratio_to_S:.4f}  "
          f"（即官方用的公式可写成 {ratio_to_S:.4f} × {args.scale_field}）")

    intent = "unknown"
    if lo is not None:
        if ov < lo:
            intent = "inside_attractor"
            print(f"  ⇒ 官方值 {ov:.1f} **小于**数据统计量最小值 {lo:.1f}"
                  f"（{ov/lo:.2f}×）")
            print("  ⇒ 判定：官方参数**落在吸引子内部**（软约束路线）——"
                  "球壳与真实状态重叠，靠小权重（如 loss_weight=0.01*S²）温和牵引")
            print("  ⇒ 换算建议：**照抄官方公式**（"
                  f"{ratio_to_S:.4f} × {args.scale_field} = "
                  f"{ratio_to_S * args.target_S:.1f}），不要按文档字面重新标定")
        elif ov > hi:
            intent = "outside_attractor"
            print(f"  ⇒ 官方值 {ov:.1f} **大于**数据统计量最大值 {hi:.1f}")
            print("  ⇒ 判定：官方参数**在吸引子外部**（硬约束路线）——"
                  "目标是拦截跑飞的状态")
            print(f"  ⇒ 换算建议：同样按比例缩放（"
                  f"{ratio_to_S * args.target_S:.1f}），或按新数据的 max 取")
        else:
            intent = "within_range"
            print(f"  ⇒ 官方值落在数据统计量区间内（{lo:.1f}–{hi:.1f}）")
            print("  ⇒ 判定：**尺度敏感**——必须按新数据的同位置分位数标定，"
                  "不能只按规模线性换算")
            frac = (ov - lo) / max(hi - lo, 1e-12)
            print(f"     官方值位于区间的 {frac*100:.0f}% 分位 → "
                  f"目标规模可用：{lo:.0f} + {frac:.2f}×(max−min)（需先在目标数据上算这四个统计量）")

    # ---- 候选与扫描建议 ----
    print("\n【候选】跨规模换算的三个候选（按顺序探针，单候选 1 seed）")
    lin = ratio_to_S * args.target_S
    print(f"  ① 照抄公式（官方意图等价）：{lin:.1f}")
    if lo is not None:
        print(f"  ② 目标数据同位置（若有目标规模的数据统计量，用同分位）")
    print(f"  ③ 官方公式 ±50% 作为兜底扫描：{lin*0.5:.1f} / {lin*1.5:.1f}")
    print("\n【强制】扫描必须用**探针规模**（1 seed × B/R），候选 ≤4 个，"
          "每个候选能说明它对应文档/代码的哪种读法；跑完立即用 feasibility_gate.py 判定。")

    if intent == "inside_attractor":
        print("\n【警告（本次事故的直接教训）】")
        print("  若按文档字面为新规模重新标定（而不是照抄公式），很可能把参数推高到"
              "吸引子尺度之上 → 过阻尼 → 参考解崩溃。")
        print("  本次事故：官方 Re=500 用 10000（0.73× 数据最小值），"
              "我却按 README 字面在 Re=5000 算了 86204（1.0× 均值）→ 参考解 StatErr 0.53（baseline 0.15）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
