"""perturb_probe.py — 低成本决定性实验：论文 Figure 1 的主张（扰动鲁棒性）是否复现。

假设：论文 Figure 1 的对照不是"干净初值下的统计精度"，而是"**初值被扰动后，rollout 是否回归吸引子**"。
  baseline（无耗散正则）→ 扰动后漂离/爆炸
  reference（有耗散正则）→ 扰动后回归吸引子

做法：用已训练的 checkpoint（无需重训），从（a）干净初值（b）按比例放大的扰动初值出发，
各跑 3000 步 rollout，记录：
  - max|u| 的时间序列（是否爆炸）
  - 每步空间能量（是否漂移）
  - 与真值统计的距离（是否回归：用后 1/3 帧算 StatErr）

模型：
  - baseline  : Re5000 FNO128 s41（re5000/base/contract，已评分）
  - reference : Re5000 MNO64 s41 r=86204（re5000/ref/contract，已评分）
  - 也测 Re500 的官方配对（对照）
"""

import json
import os
import sys

import numpy as np
import torch

sys.path.insert(0, "/root/autodl-tmp/mno_p4/grader_src")
import statistics as st          # noqa: E402
import rollout as rl             # noqa: E402
import starter_model             # noqa: E402
from model_api import load_solution_model   # noqa: E402

D = "/root/autodl-tmp/mno_p4"
U5 = json.load(open(f"{D}/re5000/floor_report.json"))["F_staterr"]
U500 = json.load(open(f"{D}/data_assets/truth/floor_report.json"))["F_staterr"]

CASES = [
    # (tag, contract-dir, init-file, truth-file, bounds-file, U)
    ("Re5000 B(FNO128) s41", f"{D}/re5000/base/contract",
     f"{D}/re5000/init_dev_5.npy", f"{D}/re5000/dev_truth.npz", f"{D}/re5000/bounds.json", U5),
    ("Re5000 R(MNO64 r86204) s41", f"{D}/re5000/ref/contract",
     f"{D}/re5000/init_dev_5.npy", f"{D}/re5000/dev_truth.npz", f"{D}/re5000/bounds.json", U5),
    ("Re500 B(FNO128) s41", f"{D}/optimization_evidence/baseline_runs/seed_41/contract_model",
     f"{D}/data_assets/truth/init_dev_5.npy", f"{D}/data_assets/truth/dev_truth.npz",
     f"{D}/data_assets/truth/bounds.json", U500),
    ("Re500 R(MNO64) s41", f"{D}/optimization_evidence/reference_runs/seed_41/contract_model",
     f"{D}/data_assets/truth/init_dev_5.npy", f"{D}/data_assets/truth/dev_truth.npz",
     f"{D}/data_assets/truth/bounds.json", U500),
]

STEPS = 3000
PERTURB = (1.0, 1.15, 1.35, 1.6)      # 初值的幅度缩放（1.0 = 干净）


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    dev = "cuda"
    fs = open(f"{D}/perturb_probe.log", "w")
    def out(s):
        print(s, flush=True)
        fs.write(s + "\n"); fs.flush()

    out(f"{'case':28s} {'perturb':>7s} {'max|u|_end':>10s} {'E_end/E_start':>13s} "
        f"{'StatErr(2nd half)':>17s} {'gate':>8s}")
    out("-" * 92)
    for tag, cdir, ifile, tfile, bfile, U in CASES:
        if not os.path.isdir(cdir):
            out(f"{tag:28s} (no contract model)")
            continue
        model, info = load_solution_model(cdir, starter_model.build_model, torch)
        model = model.to(dev).eval()
        inits = np.load(ifile)
        truth_z = np.load(tfile)
        T = {k: truth_z[k] for k in ("spectrum", "mu", "sigma", "tau")}
        bounds = json.load(open(bfile))
        max_abs_tr = float(bounds["max_abs_train"])
        var_floor = float(truth_z["var_floor"])
        init = inits[0]                     # 用第 1 个初值做扰动实验
        for p in PERTURB:
            x0 = (init * p).astype(np.float32)
            frames, gate = rl.rollout(model, x0, n_steps=STEPS, torch=torch, device=dev,
                                      max_abs_train=max_abs_tr * 3.0,   # 放宽门以观察"爆炸"
                                      var_floor=var_floor * 0.05)
            n = frames.shape[0]
            if n < 100:
                out(f"{tag:28s} {p:7.2f} {'EARLY-STOP':>10s} {gate['reason'][:40]}")
                continue
            e = (frames.astype(np.float64) ** 2).mean(axis=(1, 2))
            a = np.abs(frames).max(axis=(1, 2))
            seg = frames[n // 2:]
            try:
                s = st.compute_statistics(seg)
                err = st.staterr(s, T)[0]
            except Exception:
                err = float("nan")
            out(f"{tag:28s} {p:7.2f} {a[-1]:10.2f} {e[-100:].mean()/max(e[:100].mean(),1e-12):13.3f} "
                f"{err:17.4f} {str(gate['ok']):>8s}")
    out("\n说明：max|u|_end 显著超出训练数据范围（Re5000 max≈68 / Re500 max≈68）或 E 比值远离 1 → 漂离；")
    out("      StatErr(2nd half) 用后半段统计与真值比较，越小表示越接近回归吸引子。")
    fs.close()
    open(f"{D}/PERTURB_PROBE_DONE", "w").write("done\n")


if __name__ == "__main__":
    main()
