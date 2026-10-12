"""surface_probe.py — 零 GPU 成本：从已保存的 rollout 裁定量化面候选。

背景：官方脚本（NS_fno_baseline.py / NS_mno_dissipative.py）跑完会把 10000 步
rollout 存到 pred/<name>.mat。这些文件已在磁盘上 → 可以直接用 CPU 计算**多种指标**，
不必重训任何模型。

候选指标（都对应论文的不同主张）：
  M1 StatErr        : 与真值统计的差距（我原来的指标，"统计精度"主张）
  M2 平稳性 drift    : rollout 前半 vs 后半的统计漂移（"留在吸引子上"主张，论文 Figure 1）
  M3 能量漂移        : E_last/E_first − 1（"能量守恒/不崩坏"）
  M4 幅度漂移        : max|u| 后段/前段 − 1（"不爆炸"）

输出：每个运行的四个指标 + 按数据集分组的 B/R 对比表。
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

JOBS = [
    # (tag, dataset, path-to-pred-file-glob)
    ("Re5000 FNO128 s41", "re5000", f"{R5}/base/pred/*.mat"),
    ("Re5000 FNO128 s42", "re5000", f"{R5}/b_s42/pred/*.mat"),
    ("Re5000 FNO128 s43", "re5000", f"{R5}/b_s43/pred/*.mat"),
    ("Re5000 MNO64 s41 (r=86204)", "re5000", f"{R5}/ref/pred/*.mat"),
    ("Re500  FNO128 s41", "re500", f"{R}/baseline_runs/seed_41/pred/*.mat"),
    ("Re500  FNO128 s42", "re500", f"{R}/baseline_runs/seed_42/pred/*.mat"),
    ("Re500  FNO128 s43", "re500", f"{R}/baseline_runs/seed_43/pred/*.mat"),
    ("Re500  MNO64 s41", "re500", f"{R}/reference_runs/seed_41/pred/*.mat"),
    ("Re500  MNO64 s42", "re500", f"{R}/reference_runs/seed_42/pred/*.mat"),
    ("Re500  MNO64 s43", "re500", f"{R}/reference_runs/seed_43/pred/*.mat"),
]


def load_frames(path):
    m = sio.loadmat(path)
    keys = [k for k in m if not k.startswith("__")]
    fr = np.asarray(m[keys[0]])
    fr = np.squeeze(fr)
    if fr.ndim != 3:
        return None
    # 官方存的是 (S,S,T)；统一成 (T,S,S)
    if fr.shape[2] > fr.shape[0] and fr.shape[2] > fr.shape[1]:
        fr = np.transpose(fr, (2, 0, 1))
    return fr.astype(np.float32)


def metrics(frames, truth=None):
    T = frames.shape[0]
    h = T // 2
    stride = max(1, h // 2000)          # 子采样到 ~2000 帧/半，省 CPU
    f1 = frames[0:h:stride]
    f2 = frames[h::stride]
    # M2 平稳性：两半的统计差异
    s1 = st.compute_statistics(f1)
    s2 = st.compute_statistics(f2)
    sc = float(np.linalg.norm(s2["sigma"]))
    m2_spec = float(np.linalg.norm(s2["spectrum"] - s1["spectrum"]) / np.linalg.norm(s1["spectrum"]))
    m2_mu = float(np.linalg.norm(s2["mu"] - s1["mu"]) / sc)
    m2_sig = float(np.linalg.norm(s2["sigma"] - s1["sigma"]) / sc)
    m2 = 0.5 * m2_spec + 0.25 * 0.5 * (m2_mu + m2_sig) + 0.25 * (abs(s2["tau"] - s1["tau"]) / max(s1["tau"], 1e-9))
    # M3 能量漂移
    e = (frames.astype(np.float64) ** 2).mean(axis=(1, 2))
    m3 = float(e[-1000:].mean() / max(e[:1000].mean(), 1e-12) - 1.0)
    # M4 幅度漂移
    a = np.abs(frames).reshape(T, -1).max(axis=1)
    m4 = float(a[-1000:].max() / max(a[:1000].max(), 1e-12) - 1.0)
    out = {"M2_drift": m2, "M3_energy": m3, "M4_amp": m4,
           "M2_spec": m2_spec, "tau_1st_half": s1["tau"], "tau_2nd_half": s2["tau"]}
    if truth is not None:
        sfull = st.compute_statistics(frames[::max(1, T // 5000)])   # 全窗（子采样）
        out["M1_StatErr"] = float(st.staterr(sfull, truth)[0])
    return out


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    truth = {}
    for ds, p in (("re5000", f"{R5}/dev_truth.npz"), ("re500", f"{D}/data_assets/truth/dev_truth.npz")):
        if os.path.isfile(p):
            z = np.load(p)
            truth[ds] = {k: z[k] for k in ("spectrum", "mu", "sigma", "tau")}
    print(f"{'run':30s} {'StatErr':>8s} {'M2drift':>8s} {'M3energy':>9s} {'M4amp':>7s}")
    print("-" * 70)
    rows = {}
    for tag, ds, pat in JOBS:
        fs = glob.glob(pat)
        if not fs:
            print(f"{tag:30s} (no pred file)")
            continue
        try:
            fr = load_frames(sorted(fs)[0])
            if fr is None:
                print(f"{tag:30s} (bad shape)")
                continue
            m = metrics(fr, truth.get(ds))
            rows[tag] = m
            print(f"{tag:30s} {m.get('M1_StatErr', float('nan')):8.4f} {m['M2_drift']:8.4f} "
                  f"{m['M3_energy']:+9.4f} {m['M4_amp']:+7.4f}")
        except Exception as ex:
            print(f"{tag:30s} ERROR {ex}")
    # 分离度小结
    print("\n=== 分离度（B 差、R 好 → 该指标可用）===")
    for ds, btags, rtags in (("re5000", ["Re5000 FNO128 s41"], ["Re5000 MNO64 s41 (r=86204)"]),
                             ("re500", [t for t in rows if t.startswith("Re500  FNO128")],
                              [t for t in rows if t.startswith("Re500  MNO64")])):
        for key in ("M1_StatErr", "M2_drift", "M3_energy", "M4_amp"):
            b = [rows[t][key] for t in btags if t in rows and key in rows[t]]
            r = [rows[t][key] for t in rtags if t in rows and key in rows[t]]
            if not b or not r:
                continue
            bm, rm = float(np.mean(b)), float(np.mean(r))
            sb = float(np.std(b, ddof=1)) if len(b) > 1 else 0.0
            print(f"{ds:7s} {key:11s} B_mean={bm:+8.4f} R_mean={rm:+8.4f} "
                  f"B−R={bm-rm:+8.4f}  σ_B={sb:.4f}  (B−R)/σ_B={(bm-rm)/sb if sb>0 else float('nan'):+7.2f}")


if __name__ == "__main__":
    main()
