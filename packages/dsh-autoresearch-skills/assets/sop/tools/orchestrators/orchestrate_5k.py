"""orchestrate_5k.py — Re=5000 正式 B/R 全自动收尾（半径扫描完成后触发）

流程：
  1. 等 RADII_SCAN_DONE
  2. 从三个半径候选里按**预定规则**选最佳（R_norm∈[0.15,0.8] 优先，其次 Delta>0，再按 StatErr 最小）
  3. 建 formal/ 标准结构：baseline seed41/42/43（复用 base/b_s42/b_s43）+ reference seed41（复用选中候选）
  4. 补 reference seed42/43（用选中半径，2 卡并行）
  5. 全部转换（--domain-size 128）+ 冻结评分器评分
  6. V09：每个模型独立二次重载复评 + 一致性判定
  7. compare_br.py 出 comparison_summary（B_mean/R_mean/σ_B/Δ/R_norm/gates）
  8. anchor 提案（Re5000 的 B_mean/U）
  9. 写 FORMAL_5K_DONE
若无候选达标 → 写 PLAN_B_NEEDED 并退出（由专家决定启用 part_unity_post_process）
"""

import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")

D = "/root/autodl-tmp/mno_p4"
R5 = f"{D}/re5000"
F = f"{R5}/formal"
PY = "/root/miniconda3/bin/python"
GR = f"{D}/grader_src/grade.py"
LOG = f"{R5}/formal.log"
RADII = {"rsmall": 25000.0, "rofficial_rel": 44000.0, "rreadme_max": 121138.7}
SRC_MNO = f"{D}/research_notes/official_repo/scripts/NS_mno_dissipative.py"
BASE_SRC = {"41": "base", "42": "b_s42", "43": "b_s43"}


def log(msg):
    line = f"[{time.strftime('%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    open(LOG, "a").write(line + "\n")


def wait_for(path, hours=6.0):
    t0 = time.time()
    while time.time() - t0 < hours * 3600:
        if os.path.exists(path):
            return True
        time.sleep(120)
    return False


def staterr(p):
    if not os.path.isfile(p):
        return None
    d = json.load(open(p))
    return d.get("staterr") if d.get("status") == "VALID" else None


def make_mno_script(seed, inner, out_dir):
    outer = 525 * 128 + inner
    code = open(SRC_MNO, encoding="utf-8").read()
    code = code.replace("torch.manual_seed(0)", f"torch.manual_seed({seed})")
    code = code.replace("np.random.seed(0)", f"np.random.seed({seed})")
    code = re.sub(r"data = np\.load\('[^']*'\)", f"data = np.load('{R5}/train_re5000.npy')", code)
    for a, b in (("data[:ntrain,T_in-1:T_out-1]", "data[:ntrain,0:T]"),
                 ("data[:ntrain,T_in:T_out]", "data[:ntrain,1:T+1]"),
                 ("data[-ntest:,T_in-1:T_out-1]", "data[-ntest:,0:T]"),
                 ("data[-ntest:,T_in:T_out]", "data[-ntest:,1:T+1]")):
        code = code.replace(a, b)
    code = re.sub(r"^ntrain = \d+", "ntrain = 60", code, flags=re.M)
    code = re.sub(r"^ntest = \d+", "ntest = 20", code, flags=re.M)
    code = re.sub(r"^S = 64$", "S = 128", code, flags=re.M)
    code = re.sub(r"^width = \d+$", "width = 64", code, flags=re.M)
    code = re.sub(r"^radius = [0-9.]+ \* S.*$", f"radius = {inner:.1f}", code, flags=re.M)
    code = re.sub(r"^radii = \(radius,.*$", f"radii = ({inner:.1f}, {outer:.1f})", code, flags=re.M)
    os.makedirs(f"{out_dir}/model", exist_ok=True)
    os.makedirs(f"{out_dir}/pred", exist_ok=True)
    p = f"{out_dir}/official_mno_s{seed}.py"
    open(p, "w", encoding="utf-8").write(code)
    return p


def launch(script, cwd, gpu, tag):
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(gpu))
    lf = open(f"{cwd}/run.log", "a")
    p = subprocess.Popen([PY, script], cwd=cwd, env=env, stdout=lf,
                         stderr=subprocess.STDOUT, start_new_session=True)
    log(f"launch {tag} on GPU{gpu} pid={p.pid}")
    return p


def train_done(d):
    rl = f"{d}/run.log"
    return os.path.isfile(rl) and "Weights saved" in open(rl, errors="ignore").read()


def convert(src_dir, dst_dir, role, seed, width):
    os.makedirs(dst_dir, exist_ok=True)
    cands = [f for f in glob.glob(f"{src_dir}/model/*")
             if os.path.isfile(f) and os.path.getsize(f) > 1024]
    if not cands:
        log(f"convert: no checkpoint in {src_dir}")
        return False
    src = sorted(cands, key=os.path.getsize)[-1]
    rc = subprocess.call([PY, f"{D}/convert_official_ckpt.py", "--in", src,
                          "--out", f"{dst_dir}/model.pt", "--role", role, "--seed", str(seed),
                          "--width", str(width), "--modes", "20", "--domain-size", "128"])
    return rc == 0


def grade(contract_dir, out_json, gpu):
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(gpu))
    return subprocess.call([PY, GR, "--solution", contract_dir,
                            "--init", f"{R5}/init_dev_5.npy", "--truth", f"{R5}/dev_truth.npz",
                            "--bounds", f"{R5}/bounds.json", "--out", out_json,
                            "--device", "cuda"], env=env)


def main():
    log("=== ORCHESTRATE_5K START ===")
    if not wait_for(f"{R5}/RADII_SCAN_DONE", 6.0):
        log("TIMEOUT waiting RADII_SCAN_DONE")
        return
    U = json.load(open(f"{R5}/floor_report.json"))["F_staterr"]
    Bs = {s: staterr(f"{R5}/{src}/result.json") for s, src in BASE_SRC.items()}
    log(f"U={U:.4f} baselines={Bs}")

    cands = []
    for tag in RADII:
        r = staterr(f"{R5}/{tag}/result.json")
        if r is None or Bs["41"] is None:
            continue
        rn = (Bs["41"] - r) / (Bs["41"] - U)
        cands.append((tag, r, rn))
        log(f"candidate {tag}: StatErr={r:.4f} R_norm={rn:+.3f} "
            f"{'PASS' if 0.15 <= rn <= 0.8 else 'fail'}")
    passing = [c for c in cands if 0.15 <= c[2] <= 0.8]
    positive = [c for c in cands if c[1] < Bs["41"]]
    pick = min(passing, key=lambda c: c[1]) if passing else (min(positive, key=lambda c: c[1]) if positive else None)
    if pick is None or not passing:
        log(f"NO USABLE CANDIDATE (best={pick}) -> PLAN_B_NEEDED")
        open(f"{R5}/PLAN_B_NEEDED", "w").write(json.dumps(
            {"candidates": [{"tag": t, "staterr": r, "R_norm": rn} for t, r, rn in cands],
             "baselines": Bs, "U": U}, indent=2))
        return
    tag, r41, rn41 = pick
    inner = RADII[tag]
    log(f"CHOSEN: {tag} (inner radius {inner}) R_norm={rn41:+.3f}")
    json.dump({"tag": tag, "inner_radius": inner, "R_norm_seed41": rn41, "U": U, "baselines": Bs},
              open(f"{R5}/formal_decision_5k.json", "w"), indent=2)

    # --- formal 结构 ---
    os.makedirs(f"{F}/baseline_runs", exist_ok=True)
    os.makedirs(f"{F}/reference_runs", exist_ok=True)
    W = {"baseline": 128, "reference": 64}
    for role, srcs in (("baseline", BASE_SRC), ("reference", {"41": tag, "42": f"r_s42_{tag}", "43": f"r_s43_{tag}"})):
        for seed, src in srcs.items():
            d = f"{F}/{role}_runs/seed_{seed}"
            os.makedirs(d, exist_ok=True)
            if os.path.isfile(f"{R5}/{src}/run.log"):
                shutil.copy2(f"{R5}/{src}/run.log", f"{d}/run.log")

    # --- 补 reference seed42/43（用选中半径，2 卡并行） ---
    procs = {}
    for seed, gpu in (("42", 1), ("43", 2)):
        sdir = f"{R5}/r_s{seed}_{tag}"
        if not train_done(sdir):
            scr = make_mno_script(int(seed), inner, sdir)
            procs[seed] = launch(scr, sdir, gpu, f"ref seed{seed} ({tag})")
        else:
            log(f"ref seed{seed} already trained")
    t0 = time.time()
    while procs and time.time() - t0 < 4 * 3600:
        time.sleep(120)
        for seed in list(procs):
            if procs[seed].poll() is not None or train_done(f"{R5}/r_s{seed}_{tag}"):
                log(f"ref seed{seed} training finished")
                procs.pop(seed)
    if procs:
        log("TIMEOUT on ref seed42/43")
        return

    # --- 转换 + 评分（含 baseline 42/43） ---
    jobs = []
    for seed, src in BASE_SRC.items():
        jobs.append(("baseline", seed, f"{R5}/{src}", f"{F}/baseline_runs/seed_{seed}"))
    for seed, src in (("41", tag), ("42", f"r_s42_{tag}"), ("43", f"r_s43_{tag}")):
        jobs.append(("reference", seed, f"{R5}/{src}", f"{F}/reference_runs/seed_{seed}"))
    for i, (role, seed, src_dir, dst) in enumerate(jobs):
        if not convert(src_dir, f"{dst}/contract_model", role, int(seed), W[role]):
            log(f"CONVERT FAILED {role} seed{seed}")
            continue
        rc = grade(f"{dst}/contract_model", f"{dst}/result.json", i % 3)
        try:
            d = json.load(open(f"{dst}/result.json"))
            d["role"] = role
            d["seed"] = int(seed)
            json.dump(d, open(f"{dst}/result.json", "w"), indent=2)
            log(f"graded {role} seed{seed}: rc={rc} {d.get('status')} staterr={d.get('staterr')}")
        except Exception as e:
            log(f"grade readback failed {role} seed{seed}: {e}")

    # --- V09 独立重载复评 ---
    log("V09 reload re-evaluation ...")
    for i, (role, seed, src_dir, dst) in enumerate(jobs):
        if not os.path.isdir(f"{dst}/contract_model"):
            continue
        grade(f"{dst}/contract_model", f"{dst}/result_reload.json", i % 3)
        try:
            a = json.load(open(f"{dst}/result.json"))
            b = json.load(open(f"{dst}/result_reload.json"))
            rel = abs(a["staterr"] - b["staterr"]) / abs(a["staterr"]) if a.get("staterr") else None
            os.makedirs(f"{dst}/model", exist_ok=True)
            open(f"{dst}/model/reload.log", "w").write(json.dumps(
                {"orig": a.get("staterr"), "reload": b.get("staterr"), "rel_diff": rel}, indent=2))
            log(f"V09 {role} seed{seed}: {a.get('staterr')} -> {b.get('staterr')} rel_diff={rel}")
        except Exception as e:
            log(f"V09 failed {role} seed{seed}: {e}")
    open(f"{R5}/V09_DONE", "w").write("done\n")

    # --- 汇总 + anchor 提案 ---
    subprocess.call([PY, f"{D}/compare_br.py", "--root", F, "--protocol", "proto-v1.3",
                     "--anchor", f"{R5}/floor_report.json"])
    try:
        c = json.load(open(f"{F}/comparison_summary.json"))
        anchor = {"B_mean": c.get("B_mean"), "U": U, "protocol_version": "proto-v1.3",
                  "dataset": "Kolmogorov flow Re=5000 (128x128, 60 train traj)",
                  "reference_radius_inner": inner, "reference_radius_tag": tag,
                  "B_seeds": [x["staterr"] for x in c.get("baseline", [])],
                  "R_seeds": [x["staterr"] for x in c.get("reference", [])],
                  "anchor_status": "CALIBRATED" if c.get("B_mean") else "INCOMPLETE"}
        json.dump(anchor, open(f"{R5}/anchor.proposed.json", "w"), indent=2)
        log("comparison + anchor proposal written")
    except Exception as e:
        log(f"summary failed: {e}")
    open(f"{R5}/FORMAL_5K_DONE", "w").write("done\n")
    log("=== ORCHESTRATE_5K COMPLETE ===")


if __name__ == "__main__":
    main()
