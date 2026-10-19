#!/usr/bin/env python3
"""feasibility_gate.py —— 出题可行性闸门（P0/P1 强制，零 GPU 成本）

来源：2026-10-07 AutoRe0566 实战（浪费 530 元）。本工具把那次事故的教训
固化成**可执行判定**，在投入正式协议之前拦住结构性不可行的题。

它回答一个问题：**按当前数字，这道题的判定门是否闭合？**

两道必须同时满足的门（SOP 通用口径）：
  ① Reference 归一化落在公开区间：R_norm = (B−R)/(B−U) ∈ [0.15, 0.8]  （minimize）
  ② 随机性显著性：Δ = B − R ≥ 3σ_B

用法（三选一，越早越好）：

  # A. 只有论文数字（P0 阶段，零实验）——最强拦截
  python feasibility_gate.py --from-paper --b 0.60 --r 0.65 --u-hint 0.5

  # B. 有 1 个 seed 的探针结果（P1 阶段，最省钱的实跑）
  python feasibility_gate.py --from-probe --b 0.1340 --r 0.1300 --u 0.0310

  # C. 有多个 seed（判定是否已闭合，含 σ_B）
  python feasibility_gate.py --from-probe --b 0.134,0.152,0.147 --r 0.106,0.081,0.204 --u 0.0310

  # D. 论文只报 "mean ± σ"（P0 最常见的情形）——用 --sigma-b 直接给 σ_B
  #    论文从不给原始 seed 值，只给离散度；没有本参数时门② 恒为「待补」，
  #    --from-paper 在自己的目标场景下无法出结论。
  python feasibility_gate.py --from-paper --b 45.4 --r 53.0 --sigma-b 1.6 --direction maximize

maximize 指标（balanced accuracy、准确率等越大越好）：加 --direction maximize，
公式切换为 R_norm=(R−B)/(U−B)、Δ=R−B。

输出：可行性结论 + 需要的 B 区间 + 需要的最小 Δ + 建议动作。
退出码：0=可行；1=不可行（结构性）；2=信息不足（需先做探针）。
"""

import argparse
import statistics
import sys

R_LO, R_HI = 0.15, 0.80
SIGMA_MULT = 3.0


def parse_list(s):
    if s is None:
        return None
    vals = []
    for part in str(s).split(","):
        part = part.strip()
        if part:
            vals.append(float(part))
    return vals or None


def fmt(x, nd=4):
    return "n/a" if x is None else f"{x:.{nd}f}"


def main() -> int:
    ap = argparse.ArgumentParser(description="出题可行性闸门（零 GPU）")
    ap.add_argument("--from-paper", action="store_true",
                    help="只用论文数字做纸面预解（最早期拦截）")
    ap.add_argument("--from-probe", action="store_true",
                    help="用探针/实验数字判定")
    ap.add_argument("--b", required=True, help="Baseline 指标（可逗号分隔多个 seed）")
    ap.add_argument("--r", required=True, help="Reference 指标（可逗号分隔多个 seed）")
    ap.add_argument("--u", default=None, help="U：指标的地板/下限（minimize 时是下限）")
    ap.add_argument("--u-hint", default=None,
                    help="P0 阶段 U 的估计值（可用完美模型的期望误差、或论文最优值）")
    # 方向：默认 minimize，与历史行为**逐字节一致**。
    #
    # 本脚本原先把 minimize 口径写死：R_norm=(B−R)/(B−U)、Δ=B−R、B≤U 即硬失败。
    # 对 maximize 指标（balanced accuracy、准确率、召回率等越高越好的量），
    # U 是 0-100 尺度上的可达上限，U>B 必然成立；原实现会把真实改善 R>B
    # 误报成「U 必须严格小于 B」的结构性失败 —— 符号全反的假阳性。
    #
    # 用显式开关扩展方向，**不改默认值**：未传 --direction 时走的仍是原来的
    # minimize 分支，因此其他 minimize 类题目的输出、判定与退出码都不变。
    ap.add_argument("--direction", default="minimize",
                    choices=("minimize", "maximize"),
                    help="指标优化方向；默认 minimize（与历史行为一致）")
    ap.add_argument("--sigma-mult", type=float, default=SIGMA_MULT)
    # σ_B 直供通道。
    #
    # 为什么需要：论文**从不**给出原始 seed 值，只报 "mean ± σ"。因此 P0 阶段的
    # --from-paper 预解永远拿不到多个 B 值，σ_B 恒为未知，门② 恒为「待补」——
    # 工具在自己的目标场景（最早期零成本拦截）下失效。
    #
    # 语义：显式给出的 σ_B 优先于由 --b 多个值算出的样本标准差，因为论文的 ±
    # 本身就是对多次独立运行的离散度估计，与 seed 样本标准差是同一口径。
    # 未传本参数时行为与旧版**逐字节相同**（连提示文案都不变）。
    ap.add_argument("--sigma-b", type=float, default=None,
                    help="直接给出 σ_B（论文只报 ±σ 时使用；须为同一口径的 "
                         "多次独立运行离散度）。不传则由 --b 的多个值计算")
    args = ap.parse_args()

    sys.stdout.reconfigure(encoding="utf-8")
    Bs, Rs = parse_list(args.b), parse_list(args.r)
    if not Bs or not Rs:
        print("ERROR: --b/--r 至少各需一个数值", file=sys.stderr)
        return 2
    if args.sigma_b is not None and not (args.sigma_b > 0):
        print("ERROR: --sigma-b 必须为正数（标准差不可能 ≤0）", file=sys.stderr)
        return 2

    U = float(args.u) if args.u is not None else (
        float(args.u_hint) if args.u_hint is not None else None)

    maximize = (args.direction == "maximize")
    # 只在显式传了 --direction 时才打印方向行。
    # 目的是让「未传 --direction」的输出与旧版**逐字节相同**——这是回归测试
    # 的硬要求，也是议会裁定的回退条件。多加一行提示看似无�害，但会让
    # 依赖 stdout 的既有比对失效。
    explicit_direction = ("--direction" in sys.argv)

    B_1 = Bs[0]
    R_mean = statistics.fmean(Rs)
    B_mean = statistics.fmean(Bs)
    sigma_from_seeds = statistics.stdev(Bs) if len(Bs) > 1 else None
    if args.sigma_b is not None:
        sigma_B = float(args.sigma_b)
        sigma_source = "由 --sigma-b 显式给出（论文 ±σ 口径）"
    else:
        sigma_B = sigma_from_seeds
        sigma_source = f"由 {len(Bs)} 个 seed 值算出的 n−1 样本标准差"
    # 只在显式传了 --sigma-b 时才打印来源行：保证未传时输出与旧版逐字节相同。
    explicit_sigma = (args.sigma_b is not None)

    print("=" * 72)
    print(f"输入：B={[fmt(x) for x in Bs]}  R={[fmt(x) for x in Rs]}  U={fmt(U)}  "
          f"({'论文数字预解' if args.from_paper else '探针/实验数字'})")
    if explicit_direction:
        print(f"方向：{'maximize（越大越好）' if maximize else 'minimize（越小越好）'}")
    print("=" * 72)

    if U is None:
        print("⚠ 未提供 U：无法计算 R_norm，只能检查 Δ。建议先用真值侧构造地板（见 L2）。")

    # ---- 门 ①：R_norm 区间 ----
    # maximize 时公式与提示文案一并切换；minimize 时保持原文案不变。
    if maximize:
        print("\n【门 ①】Reference 归一化 R_norm = (R−B)/(U−B) 需在 [0.15, 0.80]")
    else:
        print("\n【门 ①】Reference 归一化 R_norm = (B−R)/(B−U) 需在 [0.15, 0.80]")
    if U is not None:
        if maximize and B_1 >= U:
            print(f"  ✗ B={fmt(B_1)} ≥ U={fmt(U)}：maximize 下 U 必须严格大于 B（否则分母非正）")
            gate1 = False
        elif maximize:
            # 给定 R，求满足 R_norm∈[0.15,0.8] 的 B 区间
            # R_norm = (R−B)/(U−B) = k → B = (R − k·U)/(1 − k)
            def B_for_max(k):
                return (R_mean - k * U) / (1.0 - k)
            b_lo, b_hi = B_for_max(R_HI), B_for_max(R_LO)
            print(f"  R_mean = {fmt(R_mean)}（n={len(Rs)}）")
            print(f"  ⇒ 为使 R_norm∈[0.15,0.80]，需要 B_mean ∈ [{fmt(b_lo)}, {fmt(b_hi)}]")
            ok = b_lo <= B_1 <= b_hi
            print(f"  当前 B_1 = {fmt(B_1)} → {'✓ 在区间内' if ok else '✗ 不在区间内'}")
            if not ok:
                if B_1 > b_hi:
                    print("     B 已高于区间上限：R_norm 会 < 0.15（任务过弱/参考解不够强）")
                else:
                    print("     B 已低于区间下限：R_norm 会 > 0.80（参考解过强/容易完成）")
            gate1 = ok
        elif B_1 <= U:
            print(f"  ✗ B={fmt(B_1)} ≤ U={fmt(U)}：U 必须严格小于 B（否则分母非正）")
            gate1 = False
        else:
            # 给定 R，求满足 R_norm∈[0.15,0.8] 的 B 区间
            # R_norm = (B−R)/(B−U) → B = (R − k·U)/(1 − k)，k∈[0.15,0.8]
            def B_for(k):
                return (R_mean - k * U) / (1.0 - k)
            b_lo, b_hi = B_for(R_HI), B_for(R_LO)     # k 越大 B 越小
            print(f"  R_mean = {fmt(R_mean)}（n={len(Rs)}）")
            print(f"  ⇒ 为使 R_norm∈[0.15,0.80]，需要 B_mean ∈ [{fmt(b_lo)}, {fmt(b_hi)}]")
            ok = b_lo <= B_1 <= b_hi
            print(f"  当前 B_1 = {fmt(B_1)} → {'✓ 在区间内' if ok else '✗ 不在区间内'}")
            if not ok:
                if B_1 < b_lo:
                    gap = (b_lo - B_1) / max(abs(b_lo), 1e-12) * 100
                    print(f"     差距：需要 B 再高 {fmt(b_lo - B_1)}（相对 {gap:.0f}%）")
                    print("     ⚠ 若靠 让 Baseline 变差 来达标，会同时抬高 sigma_B → 触发门 ②（互斥风险，见 L2）")
                else:
                    print(f"     B 已高于区间上限：R_norm 会 < 0.15（任务过弱/参考解不够强）")
            gate1 = ok
    else:
        gate1 = None
        print("  ⟳ 待补 U 后再判")

    # ---- 门 ②：3σ_B ----
    # maximize 下改善量是 R−B；minimize 下是 B−R。符号取反，判据方向也随之取反。
    # minimize 分支的文案与算式与旧版完全一致（含 "Δ = B_mean − R_mean" 的写法）。
    if maximize:
        print(f"\n【门 ②】Δ = R_mean − B_mean 需 ≥ {args.sigma_mult}σ_B")
        delta = R_mean - B_mean
    else:
        print(f"\n【门 ②】Δ = B_mean − R_mean 需 ≥ {args.sigma_mult}σ_B")
        delta = B_mean - R_mean
    print(f"  B_mean={fmt(B_mean)}  R_mean={fmt(R_mean)}  Δ={delta:+.4f}")
    if sigma_B is None:
        print(f"  σ_B：未知（仅 1 个 seed）")
        print(f"  ⇒ 需要 Δ ≥ {args.sigma_mult}σ_B，但 σ_B 要用多个 seed 估计")
        print(f"     经验参考：同类混沌/湍流任务 σ_B 常达 |均值| 的 3–10% → 需 Δ ≈ "
              f"{args.sigma_mult * 0.03:.2f}–{args.sigma_mult * 0.10:.2f} 量级")
        gate2 = None
    else:
        need = args.sigma_mult * sigma_B
        gate2 = delta >= need
        if explicit_sigma:
            print(f"  σ_B = {fmt(sigma_B)}（{sigma_source}）  ⇒ 需要 Δ ≥ {fmt(need)}")
        else:
            print(f"  σ_B = {fmt(sigma_B)}（n={len(Bs)}）  ⇒ 需要 Δ ≥ {fmt(need)}")
        print(f"  当前 Δ = {delta:+.4f} → {'✓ 通过' if gate2 else '✗ 不足'} "
              f"（Δ/σ_B = {delta/sigma_B if sigma_B>0 else float('inf'):+.2f}）")

    # ---- 结论 ----
    print("\n" + "=" * 72)
    print("【结论】")
    if gate1 is False or gate2 is False:
        print("  ✗ 不可行（结构性）：当前设计下判定门无法闭合。")
        print("  建议动作（按成本排序）：")
        print("    1. 重做指标设计，使论文主张被直接测量（L3）——先回答：论文的一句话主张是什么、我的指标是否直接测它")
        print("    2. 检查跨规模/跨设置参数是否标定错误（L4：数值反推官方常量）")
        print("    3. 换切入规模（论文主战场往往差异最明显）")
        print("    4. 以上都不通 → 换论文（止损）")
        return 1
    if gate1 is None or gate2 is None:
        print("  ⟳ 信息不足：还不能判定。按 L1 先做增益探针（1 seed × B/R，"
              "≤2× 单跑耗时，用论文主打规模），补齐后再跑本工具。")
        print("  ⚠ 在门 ①/② 之一为未知时，禁止投入全 seed 正式协议。")
        return 2
    print("  ✓ 可行：两道门均闭合。可以进入正式 B/R（全 seed 集）。")
    print(f"  提示：正式协议请保留本次探针结果作为 seed 1（协议不变时可直接计入）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
