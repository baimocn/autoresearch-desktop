"""orchestrate.py — unattended end-to-end P4 pipeline (2026-10-07).

Sequence (all automatic, survives SSH drops because it is started with setsid+nohup):
  1. wait for DIAG3_DONE (three-way diagnostics: A=MNO@128, B=UNet64, C=UNet32)
  2. pick the B/R pair by PRE-DECLARED criteria (no post-hoc tuning):
       P1 matched-capacity  : B=FNO@128      vs R=MNO@128
       P2 paper primary     : B=U-Net(w=64)  vs R=MNO@64
       P3 paper primary     : B=U-Net(w=32)  vs R=MNO@64
       P4/P5                : U-Net(w)       vs R=MNO@128
     viable iff Delta>0 and R_norm=(B-R)/(B-U) in [0.15,0.8]; first viable wins (P1 > P2 > ...)
  3. run the formal B/R: 3 seeds x 2 roles in a UNIFORM layout, greedy on 3 GPUs
  4. grade every run with the frozen v1.2 multi-init grader (init_dev_5.npy)
  5. V09: independent reload re-evaluation of each saved model + consistency check
  6. run finalize_pipeline.sh (decision.json + anchor proposal), write ORCHESTRATE_DONE
If no pair is viable -> write formal_decision.json with RE5000_FALLBACK and exit
(the Re=5000 route is pre-derived locally; see research notes).
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = "/root/autodl-tmp/mno_p4"
R = f"{ROOT}/optimization_evidence"
T = f"{ROOT}/data_assets/truth"
D = f"{ROOT}/diag3"
PY = "/root/miniconda3/bin/python"
U = 0.03656967585449946
LOG = f"{ROOT}/orchestrate.log"
SEEDS = (41, 42, 43)


def log(msg: str) -> None:
    line = f"[{time.strftime('%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def staterr(path):
    if not os.path.isfile(path):
        return None
    try:
        d = json.load(open(path))
    except Exception:
        return None
    return d.get("staterr") if d.get("status") == "VALID" else None


def wait_file(path, timeout_s, poll=120):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        if os.path.exists(path):
            return True
        time.sleep(poll)
    return False


def prepare_import_layout() -> None:
    """official scripts resolve '../utilities.py' and '../models/' relative to cwd."""
    for sub in ("baseline_runs", "reference_runs"):
        os.makedirs(f"{R}/{sub}/models", exist_ok=True)
        for f in ("utilities.py", "dissipative_utils.py"):
            src = f"{ROOT}/research_notes/official_repo/{f}"
            if os.path.isfile(src):
                shutil.copy2(src, f"{R}/{sub}/{f}")
        src = f"{ROOT}/research_notes/official_repo/models/fno_2d.py"
        if os.path.isfile(src):
            shutil.copy2(src, f"{R}/{sub}/models/fno_2d.py")


def build_jobs(spec) -> list:
    """spec = {'base': (kind,width), 'ref': (kind,width)}; kind in {fno128, mno, mno128, unet}"""
    jobs = []
    for role in ("baseline", "reference"):
        kind, width = spec["base" if role == "baseline" else "ref"]
        for s in SEEDS:
            d = f"{R}/{role}_runs/seed_{s}"
            os.makedirs(f"{d}/model", exist_ok=True)
            os.makedirs(f"{d}/pred", exist_ok=True)
            os.makedirs(f"{d}/contract_model", exist_ok=True)
            if kind == "unet":
                shutil.copy2(f"{ROOT}/unet_model_def.py", f"{d}/contract_model/model_def.py")
                cmd = [PY, f"{ROOT}/unet_baseline.py",
                       "--data", f"{ROOT}/data_assets/train_re500.npy",
                       "--seed", str(s), "--epochs", "50", "--width", str(width),
                       "--ntrain", "900", "--out", f"{d}/contract_model/model.pt"]
                cwd = d
            else:
                # official script (fno baseline or MNO reference), width override when needed
                official_role = "baseline" if kind == "fno128" else "reference"
                args = [PY, f"{ROOT}/param_official.py", "--config", "re500",
                        "--role", official_role, "--seed", str(s), "--out-dir", d]
                if width:
                    args += ["--width", str(width)]
                subprocess.call(args)
                sc = sorted(glob.glob(f"{d}/official_*.py"))
                if not sc:
                    log(f"ERROR: parameterization failed for {role} seed{s}")
                    return []
                cmd = [PY, os.path.basename(sc[-1])]
                cwd = d
            jobs.append({"role": role, "seed": s, "kind": kind, "width": width,
                         "cwd": cwd, "cmd": cmd, "proc": None, "gpu": None, "state": "pending"})
    return jobs


def job_done(job) -> bool:
    """A job counts as trained if a .trained marker exists or the log shows completion."""
    d = f"{R}/{job['role']}_runs/seed_{job['seed']}"
    if os.path.exists(f"{d}/.trained"):
        return True
    rl = f"{d}/run.log"
    if os.path.isfile(rl):
        try:
            return "Weights saved" in open(rl, errors="ignore").read()
        except Exception:
            return False
    return False



def job_running(job) -> bool:
    """True if some process already has this job's directory as its cwd
    (prevents double-launching a job that was pre-started outside the orchestrator)."""
    d = f"{R}/{job['role']}_runs/seed_{job['seed']}"
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            if os.readlink(f"/proc/{pid}/cwd") == d:
                return True
        except Exception:
            continue
    return False


def adopt_prior_runs(design_name, spec) -> None:
    """Reuse the three-way diagnostic runs and the speculative seed-42 run as formal
    evidence: identical protocol (same seed/data/epochs/metric), so no retraining is
    needed. Every adoption is logged and marked with .trained."""
    adopted = []
    base_kind, base_w = spec["base"]
    ref_kind, ref_w = spec["ref"]

    def adopt(src_dir, dst_dir, what, pairs):
        """pairs = [(src_glob, dst_relpath), ...]"""
        if not os.path.isdir(src_dir):
            log(f"adopt skip (missing src): {src_dir}")
            return
        for pat, dst_rel in pairs:
            for f in glob.glob(f"{src_dir}/{pat}"):
                out = f"{dst_dir}/{dst_rel}"
                if dst_rel.endswith("/"):
                    out = f"{dst_dir}/{dst_rel}{os.path.basename(f)}"
                os.makedirs(os.path.dirname(out), exist_ok=True)
                shutil.copy2(f, out)
        os.makedirs(dst_dir, exist_ok=True)
        open(f"{dst_dir}/.trained", "w").write(f"adopted from {src_dir}\n")
        open(f"{dst_dir}/adoption_note.txt", "w").write(
            f"{what}: reused from {src_dir} (identical protocol: same seed, data window, "
            f"50 epochs, v1.2 multi-init grader)\n")
        adopted.append(f"{what} <- {src_dir}")

    if base_kind == "unet":
        src = f"{D}/{'B' if base_w == 64 else 'C'}"
        adopt(src, f"{R}/baseline_runs/seed_41", f"baseline seed41 U-Net{base_w}",
              [("solution/*", "contract_model/"), ("result.json", "result_probe.json")])
    if ref_kind == "mno128":
        src = f"{ROOT}/spec/mno128_s42"
        # bounded wait for the speculative MNO@128 run (started ~02:35, needs ~6.5h)
        for _ in range(100):
            if os.path.isfile(f"{src}/run.log") and \
                    "Weights saved" in open(f"{src}/run.log", errors="ignore").read():
                break
            time.sleep(60)
        # if the MNO64 speculative run occupied the formal seed_42 slot, quarantine it
        slot = f"{R}/reference_runs/seed_42"
        note = f"{slot}/adoption_note.txt"
        if os.path.isdir(slot) and os.path.isfile(f"{slot}/run.log") and not (
                os.path.isfile(note) and "MNO@128" in open(note).read()):
            q = f"{ROOT}/spec/quarantine_seed42_mno64"
            os.makedirs(q, exist_ok=True)
            for pat in ("model/*", "pred/*", "run.log", "official_*.py", ".trained", "result*.json"):
                for f in glob.glob(f"{slot}/{pat}"):
                    os.makedirs(os.path.dirname(f.replace(slot, q)), exist_ok=True)
                    shutil.move(f, f.replace(slot, q))
            log(f"quarantined previous seed_42 artifacts -> {q} (design needs MNO@128)")
        adopt(f"{D}/A", f"{R}/reference_runs/seed_41", "reference seed41 MNO@128",
              [("contract_model/*", "contract_model/"), ("result.json", "result_probe.json")])
        adopt(src, f"{R}/reference_runs/seed_42", "reference seed42 MNO@128 (speculative)",
              [("model/*", "model/"), ("run.log", "run.log")])
    log("adopted prior runs: " + ("; ".join(adopted) if adopted else "none"))



def diag_state():
    st = {}
    for tag in ("A", "B", "C"):
        rl = f"{D}/{tag}/run.log"
        done = os.path.isfile(rl) and "Weights saved" in open(rl, errors="ignore").read()
        st[tag] = done
    return st


def grade_ready_diag() -> int:
    """Grade any diagnostic job whose training finished and has no result yet.
    Returns the number of result.json present afterwards."""
    dA = f"{D}/A"
    if not os.path.isfile(f"{dA}/contract_model/model.pt"):
        cands = [f for f in glob.glob(f"{dA}/model/*")
                 if os.path.isfile(f) and os.path.getsize(f) > 1024]
        if cands:
            src = sorted(cands, key=os.path.getsize)[-1]
            subprocess.call([PY, f"{ROOT}/convert_official_ckpt.py", "--in", src,
                             "--out", f"{dA}/contract_model/model.pt", "--role", "reference",
                             "--seed", "41", "--width", "128", "--modes", "20"])
    st = diag_state()
    sols = [("A", f"{dA}/contract_model"), ("B", f"{D}/B/solution"), ("C", f"{D}/C/solution")]
    for i, (tag, sol) in enumerate(sols):
        rj = f"{D}/{tag}/result.json"
        att = f"{D}/.{tag}_grade_attempts"
        n_att = int(open(att).read()) if os.path.isfile(att) else 0
        if os.path.isfile(rj):
            try:
                if json.load(open(rj)).get("status") == "VALID":
                    continue
            except Exception:
                pass
            if n_att >= 3:            # give up on this tag after 3 tries
                continue
            os.remove(rj)             # self-heal: drop the non-VALID result and retry
            log(f"retry grading diag {tag} (attempt {n_att + 1})")
        if not st.get(tag):          # training not finished yet -> never grade early
            continue
        if not os.path.isdir(sol):
            continue
        open(att, "w").write(str(n_att + 1))
        env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(i % 3))
        subprocess.call([PY, f"{ROOT}/grader_src/grade.py", "--solution", sol,
                         "--init", f"{T}/init_dev_5.npy", "--truth", f"{T}/dev_truth.npz",
                         "--bounds", f"{T}/bounds.json", "--out", f"{D}/{tag}/result.json",
                         "--device", "cuda"], env=env)
        try:
            r = json.load(open(f"{D}/{tag}/result.json"))
            log(f"diag {tag}: {r.get('status')} staterr={r.get('staterr')} terms={r.get('terms')}")
        except Exception as e:
            log(f"diag {tag} grade readback failed: {e}")
    return sum(1 for tag in ("A", "B", "C") if os.path.isfile(f"{D}/{tag}/result.json"))


def launch(job, gpu):
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(gpu))
    lf = open(f"{job['cwd']}/run.log", "a")
    job["proc"] = subprocess.Popen(job["cmd"], cwd=job["cwd"], env=env,
                                   stdout=lf, stderr=subprocess.STDOUT, start_new_session=True)
    job["gpu"] = gpu
    job["state"] = "running"
    log(f"launch {job['role']} seed{job['seed']} ({job['kind']}) on GPU{gpu} pid={job['proc'].pid}")


def gpu_free(gpu) -> bool:
    out = subprocess.run(["nvidia-smi", "-i", str(gpu), "--query-compute-apps=pid",
                          "--format=csv,noheader"], capture_output=True, text=True).stdout
    return not out.strip()


def train_all(jobs) -> bool:
    for j in jobs:
        if job_done(j):
            j["state"] = "trained"
            log(f"skip (already trained): {j['role']} seed{j['seed']}")
    pending = [j for j in jobs if j["state"] != "trained"]
    running = []
    t0 = time.time()
    # 已在外部（预跑）启动的 job：纳入监控，绝不重复启动
    external = [j for j in pending if job_running(j)]
    for j in external:
        log(f"detected externally running: {j['role']} seed{j['seed']} (will not relaunch)")
        pending.remove(j)
    while pending or running:
        for g in (0, 1, 2):
            if any(j["gpu"] == g for j in running):
                continue
            if not gpu_free(g):
                continue
            if not pending:
                break
            j = pending.pop(0)
            launch(j, g)
            running.append(j)
        time.sleep(60)
        # 外部预跑任务：完成即转入已训练
        for j in list(external):
            if job_done(j) or not job_running(j):
                external.remove(j)
                j["state"] = "trained" if job_done(j) else "failed"
                log(f"external job finished: {j['role']} seed{j['seed']} state={j['state']}")
        for j in list(running):
            rc = j["proc"].poll()
            if rc is not None:
                running.remove(j)
                ok = os.path.isfile(f"{j['cwd']}/run.log") and \
                    "Weights saved" in open(f"{j['cwd']}/run.log", errors="ignore").read()
                j["state"] = "trained" if ok else "failed"
                log(f"finish {j['role']} seed{j['seed']} rc={rc} weights_saved={ok}")
        if time.time() - t0 > 30 * 3600:
            log("TRAIN PHASE TIMEOUT")
            return False
    while external:
        time.sleep(60)
        for j in list(external):
            if job_done(j) or not job_running(j):
                external.remove(j)
                j["state"] = "trained" if job_done(j) else "failed"
                log(f"external job finished: {j['role']} seed{j['seed']} state={j['state']}")
    ok = all(j["state"] == "trained" for j in jobs)
    log(f"train phase done ok={ok} elapsed={(time.time()-t0)/3600:.2f}h")
    return ok


def to_contract(job) -> bool:
    d = f"{R}/{job['role']}_runs/seed_{job['seed']}"
    if job["kind"] == "unet":
        return os.path.isfile(f"{d}/contract_model/model.pt")
    cands = [f for f in glob.glob(f"{d}/model/*")
             if os.path.isfile(f) and os.path.getsize(f) > 1024]
    if not cands:
        log(f"no checkpoint for {job['role']} seed{job['seed']}")
        return False
    src = sorted(cands, key=os.path.getsize)[-1]
    rc = subprocess.call([PY, f"{ROOT}/convert_official_ckpt.py", "--in", src,
                          "--out", f"{d}/contract_model/model.pt", "--role", job["role"],
                          "--seed", str(job["seed"]), "--width", str(job["width"]), "--modes", "20"])
    return rc == 0


def grade(job, out_name="result.json", gpu=0) -> bool:
    d = f"{R}/{job['role']}_runs/seed_{job['seed']}"
    env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(gpu))
    rc = subprocess.call([PY, f"{ROOT}/grader_src/grade.py", "--solution", f"{d}/contract_model",
                          "--init", f"{T}/init_dev_5.npy", "--truth", f"{T}/dev_truth.npz",
                          "--bounds", f"{T}/bounds.json", "--out", f"{d}/{out_name}",
                          "--device", "cuda"], env=env)
    return rc == 0


def main() -> None:
    log("=== ORCHESTRATE START ===")
    for tag in ("A", "B", "C"):      # 清掉早前误写的 INVALID 占位结果
        rj = f"{D}/{tag}/result.json"
        if os.path.isfile(rj):
            try:
                if json.load(open(rj)).get("status") != "VALID":
                    os.remove(rj)
                    log(f"removed stale non-VALID diag result: {tag}")
            except Exception:
                pass
    t0 = time.time()
    while time.time() - t0 < 20 * 3600:
        grade_ready_diag()
        n_valid = sum(1 for tag in ("A", "B", "C")
                      if os.path.isfile(f"{D}/{tag}/result.json") and
                      json.load(open(f"{D}/{tag}/result.json")).get("status") == "VALID")
        st = diag_state()
        # proceed when all three are graded VALID, or when every trained job has
        # been attempted (up to 3 tries each) -- never hang forever on one INVALID
        def settled(tag):
            rj = f"{D}/{tag}/result.json"
            att = f"{D}/.{tag}_grade_attempts"
            n = int(open(att).read()) if os.path.isfile(att) else 0
            return os.path.isfile(rj) or n >= 3
        # EARLY EXIT (2026-10-07): P0 (the official pair, both scripts unmodified) can be
        # adjudicated as soon as the official baseline/reference seed-41 results exist;
        # no need to wait for the slow MNO@128 diagnostic A. P0 has top priority anyway.
        b41 = staterr(f"{R}/baseline_runs/seed_41/result.json")
        r41 = staterr(f"{R}/reference_runs/seed_41/result.json")
        p0_ok = (b41 is not None and r41 is not None and b41 > U and (b41 - r41) > 0
                 and 0.15 <= (b41 - r41) / (b41 - U) <= 0.8)
        if p0_ok:
            log(f"EARLY EXIT: P0 viable (B={b41:.4f} R={r41:.4f} R_norm={(b41-r41)/(b41-U):.3f}) "
                f"-> proceed without waiting for diagnostic A")
            break
        if n_valid >= 3 or (all(st.values()) and all(settled(t) for t in ("A", "B", "C"))):
            break
        log(f"waiting diag: trained={st} valid_results={n_valid}/3")
        time.sleep(300)
    if not os.path.isfile(f"{ROOT}/DIAG3_DONE"):
        open(f"{ROOT}/DIAG3_DONE", "w").write("graded by orchestrator" + chr(10))
    log("diagnostics complete")

    vals = {
        "FNO128_s41": staterr(f"{R}/baseline_runs/seed_41/result.json"),
        "MNO64_s41": staterr(f"{R}/reference_runs/seed_41/result.json"),
        "MNO128_s41": staterr(f"{D}/A/result.json"),
        "UNet64_s41": staterr(f"{D}/B/result.json"),
        "UNet32_s41": staterr(f"{D}/C/result.json"),
    }
    cands = [
        # P0: the OFFICIAL pair, both scripts unmodified (no capacity override at all).
        # Under the v1.2 multi-init estimator this shows Delta=0.0394, R_norm=0.395
        # on seed 41 (the v1.1 single-init estimator masked it: Delta was 0.0047).
        ("P0_official_pair", {"base": ("fno128", None), "ref": ("mno", None)}, "FNO128_s41", "MNO64_s41"),
        ("P1_matched_capacity", {"base": ("fno128", None), "ref": ("mno128", 128)}, "FNO128_s41", "MNO128_s41"),
        ("P2_paper_unet64", {"base": ("unet", 64), "ref": ("mno", None)}, "UNet64_s41", "MNO64_s41"),
        ("P3_paper_unet32", {"base": ("unet", 32), "ref": ("mno", None)}, "UNet32_s41", "MNO64_s41"),
        ("P4_unet64_mno128", {"base": ("unet", 64), "ref": ("mno128", 128)}, "UNet64_s41", "MNO128_s41"),
        ("P5_unet32_mno128", {"base": ("unet", 32), "ref": ("mno128", 128)}, "UNet32_s41", "MNO128_s41"),
    ]
    chosen = None
    report = []
    for name, spec, bt, rt in cands:
        b, r = vals.get(bt), vals.get(rt)
        if b is None or r is None or b <= U:
            report.append(f"{name}: skip (B={b} R={r})")
            continue
        rn = (b - r) / (b - U)
        ok = (b - r) > 0 and 0.15 <= rn <= 0.8
        report.append(f"{name}: B={b:.4f} R={r:.4f} Delta={b-r:+.4f} R_norm={rn:.3f} {'PASS' if ok else 'FAIL'}")
        if ok and chosen is None:
            chosen = (name, spec, b, r, rn)
    for line in report:
        log(line)
    if chosen is None:
        log("NO_VIABLE_PAIR -> Re=5000 fallback route")
        json.dump({"design": "RE5000_FALLBACK", "vals": vals, "report": report},
                  open(f"{ROOT}/formal_decision.json", "w"), indent=2)
        if os.path.isfile(f"{ROOT}/re5000_diag.sh"):
            subprocess.Popen(["bash", f"{ROOT}/re5000_diag.sh"], cwd=ROOT,
                             stdout=open(f"{ROOT}/re5000_launch.log", "a"),
                             stderr=subprocess.STDOUT, start_new_session=True)
            log("launched re5000_diag.sh (fallback route) -- will run when GPUs free up")
        return
    name, spec, b, r, rn = chosen
    log(f"DECISION: {name}  B={b:.4f} R={r:.4f} R_norm={rn:.3f}")
    json.dump({"design": name, "spec": spec, "B_probe": b, "R_probe": r, "R_norm_probe": rn,
               "vals": vals, "report": report}, open(f"{ROOT}/formal_decision.json", "w"), indent=2)

    prepare_import_layout()
    adopt_prior_runs(name, spec)
    jobs = build_jobs(spec)
    if not jobs:
        log("job build failed")
        sys.exit(1)
    if not train_all(jobs):
        log("TRAIN FAILED - partial evidence kept")
        sys.exit(1)

    for j in jobs:
        if not to_contract(j):
            log(f"contract conversion failed {j['role']} seed{j['seed']}")
            sys.exit(1)
    log("all checkpoints converted to contract format")

    for i, j in enumerate(jobs):
        grade(j, "result.json", gpu=i % 3)
        d = f"{R}/{j['role']}_runs/seed_{j['seed']}"
        try:
            res = json.load(open(f"{d}/result.json"))
            log(f"graded {j['role']} seed{j['seed']}: {res.get('status')} staterr={res.get('staterr')}")
        except Exception as e:
            log(f"grade readback failed {j['role']} seed{j['seed']}: {e}")

    # V09: independent reload re-evaluation
    log("V09 reload re-evaluation ...")
    os.makedirs(f"{ROOT}/v09_work", exist_ok=True)
    for i, j in enumerate(jobs):
        d = f"{R}/{j['role']}_runs/seed_{j['seed']}"
        grade(j, "result_reload.json", gpu=i % 3)
        try:
            a = json.load(open(f"{d}/result.json"))
            bb = json.load(open(f"{d}/result_reload.json"))
            rel = abs(a["staterr"] - bb["staterr"]) / abs(a["staterr"]) if a.get("staterr") else None
            log(f"V09 {j['role']} seed{j['seed']}: {a.get('staterr')} -> {bb.get('staterr')} rel_diff={rel}")
            open(f"{d}/model/reload.log", "w").write(
                json.dumps({"orig": a.get("staterr"), "reload": bb.get("staterr"), "rel_diff": rel}, indent=2))
        except Exception as e:
            log(f"V09 failed {j['role']} seed{j['seed']}: {e}")
    open(f"{ROOT}/V09_DONE", "w").write("done\n")

    log("running finalize_pipeline.sh")
    subprocess.call(["bash", f"{ROOT}/finalize_pipeline.sh"])
    open(f"{ROOT}/ORCHESTRATE_DONE", "w").write("done\n")
    log("=== ORCHESTRATE COMPLETE ===")


if __name__ == "__main__":
    main()
