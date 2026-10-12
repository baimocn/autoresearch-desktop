"""stability_probe.py — 零 GPU：用已保存 rollout 判定"稳定性类"优化面是否可行。

背景：用户提问「能否用现有数据裁定优化面」。本脚本对**全部已存 rollout**（10 个）
计算 4 类候选指标，并从真值数据构造**长度匹配的噪声地板**，直接回答：
是否存在 (指标, B, R) 组合满足 Δ ≥ 3σ_B 与 R_norm ∈ [0.15, 0.8]。

指标（越接近 0 越"留在吸引子上"）：
  S1 能量趋势斜率   : 对 log(每步空间能量) 做线性拟合，斜率 × 1000（每千步的相对变化率）
  S2 幅度漂移       : 后 20% vs 前 20% 的幅度（100 步窗 max|u| 的中位数）比 − 1
  S3 谱漂移         : 前半 vs 后半 的径向能谱相对 L2 距离
  S4 范数偏离       : rollout 平均范数×S 相对真值平均范数×S 的相对偏差

地板（U）：从真值轨迹构造"完美模型"的等价序列（随机拼接 25 条轨迹 ≈ 10000 帧，
重复 30 次），得到每个指标的 |值| 分布 → 取中位数作为 U。
"""

import glob
import os
import sys

import numpy as np
import scipy.io as sio

sys.path.insert(0, "/root/autodl-tmp/mno_p4/grader_src")
import statistics as st  # noqa: E402

D = "/root/autodl-tmp/mno_p4"
R = f"{D}/optimization_evidence"
R5 = f"{D}/re5000"
DATA = {"re500": f"{D}/data_assets/train_re500.npy", "re5000": f"{R5}/train_re5000.npy"}

JOBS = [
    ("Re5000 FNO128 s41", "re5000", f"{R5}/base/pred/*.mat"),
    ("Re5000 FNO128 s42", "re5000", f"{R5}/b_s42/pred/*.mat"),
    ("Re5000 FNO128 s43", "re5000", f"{R5}/b_s43/pred/*.mat"),
    ("Re5000 MNO64 s41 r86204", "re5000", f"{R5}/ref/pred/*.mat"),
    ("Re500  FNO128 s41", "re500", f"{R}/baseline_runs/seed_41/pred/*.mat"),
    ("Re500  MNO64 s41", "re500", f"{R}/reference_runs/seed_41/pred/*.mat"),
    ("Re500  MNO64 s42", "re500", f"{R}/reference_runs/seed_42/pred/*.mat"),
    ("Re500  MNO64 s43", "re500", f"{R}/reference_runs/seed_43/pred/*.mat"),
]


def load_frames(path):
    m = sio.loadmat(path)
    keys = [k for k in m if not k.startswith("__")]
    fr = np.squeeze(np.asarray(m[keys[0]]))
    if fr.ndim != 3:
        return None
    if fr.shape[2] > fr.shape[0] and fr.shape[2] > fr.shape[1]:
        fr = np.transpose(fr, (2, 0, 1))          # (S,S,T) -> (T,S,S)
    return fr.astype(np.float32)


def energy_series(fr):
    return (fr.astype(np.float64) ** 2).mean(axis=(1, 2))


def amp_series(fr, win=100):
    T = fr.shape[0]
    a = np.abs(fr).reshape(T, -1)
    n = T // win
    return np.array([a[i * win:(i + 1) * win].max() for i in range(n)])


def s1_slope(e):
    t = np.arange(len(e), dtype=np.float64)
    le = np.log(np.maximum(e, 1e-12))
    k = np.polyfit(t, le, 1)[0]
    return k * 1000.0


def s2_amp_drift(a):
    n = len(a)
    h = max(1, n // 5)
    return float(np.median(a[-h:]) / max(np.median(a[:h]), 1e-12) - 1.0)


def s3_spec_drift(fr, stride=5):
    T = fr.shape[0]
    h = T // 2
    sp1 = st.radial_spectrum(fr[:h:stride])
    sp2 = st.radial_spectrum(fr[h::stride])
    return float(np.linalg.norm(sp2 - sp1) / np.linalg.norm(sp1))


def s4_norm_dev(fr, ref_norm):
    S = fr.shape[-1]
    step = max(1, fr.shape[0] // 500)
    n = np.linalg.norm(fr[::step].reshape(-1, S * S), axis=1) * S
    return float(np.mean(n) / ref_norm - 1.0)


def truth_floor(ds, n_rep=30, seg_frames=400, make_series=25):
    """构造"完美模型"等价序列：随机拼接真值轨迹（同尺度），算指标 |值| 分布中位数。"""
    d = np.load(DATA[ds], mmap_mode="r")
    n_tr, T, S, _ = d.shape
    rng = np.random.default_rng(0)
    vals = {"S1": [], "S2": [], "S3": [], "S4": []}
    ref_norm = float(np.mean(np.linalg.norm(
        np.asarray(d[:, :, :, :], dtype=np.float32)[:10, ::40].reshape(10, -1, S * S), axis=2) * S))
    for _ in range(n_rep):
        idx = rng.integers(0, n_tr, size=make_series * 16)      # 25*16=400 帧
        fr = np.concatenate([np.asarray(d[i], dtype=np.float32) for i in idx], axis=0)
        vals["S1"].append(abs(s1_slope(energy_series(fr))))
        vals["S2"].append(abs(s2_amp_drift(amp_series(fr))))
        vals["S3"].append(s3_spec_drift(fr))
        vals["S4"].append(abs(s4_norm_dev(fr, ref_norm)))
    return {k: float(np.median(v)) for k, v in vals.items()}, ref_norm


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    floors = {}
    for ds in ("re500", "re5000"):
        f, ref_norm = truth_floor(ds)
        floors[ds] = f
        print(f"[floor {ds}] S1={f['S1']:.4f} S2={f['S2']:.4f} S3={f['S3']:.4f} S4={f['S4']:.4f} "
              f"(ref_norm={ref_norm:.0f})", flush=True)

    print(f"\n{'run':26s} {'S1_energy':>10s} {'S2_amp':>8s} {'S3_spec':>8s} {'S4_norm':>8s}")
    print("-" * 66)
    rows = {}
    for tag, ds, pat in JOBS:
        fs = glob.glob(pat)
        if not fs:
            print(f"{tag:26s} (no pred)")
            continue
        try:
            fr = load_frames(sorted(fs)[0])
            if fr is None:
                print(f"{tag:26s} (bad shape)")
                continue
            d = np.load(DATA[ds], mmap_mode="r")
            S = fr.shape[-1]
            ref_norm = float(np.mean(np.linalg.norm(
                np.asarray(d[:10, ::40], dtype=np.float32).reshape(10, -1, S * S), axis=2) * S))
            m = {"S1": abs(s1_slope(energy_series(fr))),
                 "S2": abs(s2_amp_drift(amp_series(fr))),
                 "S3": s3_spec_drift(fr),
                 "S4": abs(s4_norm_dev(fr, ref_norm))}
            rows[tag] = (ds, m)
            print(f"{tag:26s} {m['S1']:10.4f} {m['S2']:8.4f} {m['S3']:8.4f} {m['S4']:8.4f}", flush=True)
        except Exception as ex:
            print(f"{tag:26s} ERROR {ex}")

    print("\n=== 判别力检查（对每个候选指标：B 组 vs R 组，是否 Δ≥3σ_B 且 R_norm∈[0.15,0.8]）===")
    groups = {
        "re5000": (["Re5000 FNO128 s41", "Re5000 FNO128 s42", "Re5000 FNO128 s43"],
                   ["Re5000 MNO64 s41 r86204"]),
        "re500": (["Re500  FNO128 s41"],
                  ["Re500  MNO64 s41", "Re500  MNO64 s42", "Re500  MNO64 s43"]),
    }
    for ds, (bt, rt) in groups.items():
        U = floors[ds]
        print(f"\n-- {ds} (U: {U}) --")
        for key in ("S1", "S2", "S3", "S4"):
            b = [rows[t][1][key] for t in bt if t in rows]
            r = [rows[t][1][key] for t in rt if t in rows]
            if len(b) < 2 or len(r) < 1:
                print(f"  {key}: 样本不足 (B={len(b)}, R={len(r)})")
                continue
            bm, rm = float(np.mean(b)), float(np.mean(r))
            sb = float(np.std(b, ddof=1))
            rn = (bm - rm) / (bm - U[key]) if bm > U[key] else float("nan")
            ok3 = (bm - rm) >= 3 * sb
            okr = 0.15 <= rn <= 0.8 if rn == rn else False
            print(f"  {key}: B={bm:.4f}±{sb:.4f}  R={rm:.4f}  Δ={bm-rm:+.4f}  "
                  f"Δ/σ_B={(bm-rm)/sb if sb>0 else float('nan'):+.2f}  U={U[key]:.4f}  R_norm={rn:+.3f}  "
                  f"{'*** PASS ***' if (ok3 and okr) else 'fail'}")


if __name__ == "__main__":
    main()
