#!/bin/bash
# v09_reload.sh —— V09 模型独立重载复评（训练型硬要求）
# 对 6 个合同 checkpoint 各自：干净进程加载 → 同协议重评 → reload.log + 一致性判定
# 由 watcher 在 CHAIN3_DONE 后自动调用；也可手动执行。
set -u
cd /root/autodl-tmp/mno_p4
PY=/root/miniconda3/bin/python
R=/root/autodl-tmp/mno_p4/optimization_evidence
LOG=/root/autodl-tmp/mno_p4/v09_$(date +%m%d_%H%M%S).log
exec > >(tee -a "$LOG") 2>&1
echo "=== V09 RELOAD START $(date '+%F %T') ==="

GPU=${GPU_ID:-0}
mkdir -p /root/autodl-tmp/mno_p4/v09_work
declare -A WIDTHS=( [baseline]=128 [reference]=64 )

for seed in 41 42 43; do
  for role in baseline reference; do
    d=$R/${role}_runs/seed_$seed
    ck=$d/contract_model/model.pt
    [ -f "$ck" ] || { echo "V09_SKIP_${role}_$seed: no contract checkpoint"; continue; }
    orig=$(cat $d/result.json | $PY -c "import json,sys; print(json.load(sys.stdin).get('staterr'))" 2>/dev/null)
    # 干净进程重载复评：输出到独立目录，不读取任何训练态
    CUDA_VISIBLE_DEVICES=$GPU $PY grader_src/grade.py \
      --solution $d/contract_model \
      --init data_assets/truth/init_dev.npy \
      --truth data_assets/truth/dev_truth.npz \
      --bounds data_assets/truth/bounds.json \
      --out /root/autodl-tmp/mno_p4/v09_work/reload_${role}_$seed.json \
      --device cuda > $d/model/reload.log 2>&1
    rl=$(cat /root/autodl-tmp/mno_p4/v09_work/reload_${role}_$seed.json | $PY -c "import json,sys; d=json.load(sys.stdin); print(d.get('status'), d.get('staterr'))" 2>/dev/null)
    echo "V09 ${role} seed$seed: orig_staterr=$orig reload=[$rl]"
    echo "reload.log written to $d/model/reload.log"
  done
done

# 一致性汇总
$PY - <<'PYEOF'
import json, sys, glob, os
sys.stdout.reconfigure(encoding="utf-8")
R = "/root/autodl-tmp/mno_p4/optimization_evidence"
W = "/root/autodl-tmp/mno_p4/v09_work"
ok = True
for seed in (41, 42, 43):
    for role in ("baseline", "reference"):
        orig_p = f"{R}/{role}_runs/seed_{seed}/result.json"
        rl_p = f"{W}/reload_{role}_{seed}.json"
        if not (os.path.isfile(orig_p) and os.path.isfile(rl_p)):
            continue
        o = json.load(open(orig_p)); r = json.load(open(rl_p))
        if o.get("status") != "VALID" or r.get("status") != "VALID":
            print(f"{role}{seed}: status orig={o.get('status')} reload={r.get('status')} (non-VALID pairs skipped)")
            continue
        a, b = o["staterr"], r["staterr"]
        rel = abs(a - b) / abs(a) if a else float("inf")
        verdict = "MATCH" if rel < 1e-4 else "DRIFT"
        if rel >= 1e-4: ok = False
        print(f"{role} seed{seed}: orig={a:.6f} reload={b:.6f} rel_diff={rel:.2e} -> {verdict}")
print("V09_OVERALL:", "PASS" if ok else "INVESTIGATE")
PYEOF
touch /root/autodl-tmp/mno_p4/V09_DONE
echo "=== V09 DONE $(date '+%F %T') ==="
