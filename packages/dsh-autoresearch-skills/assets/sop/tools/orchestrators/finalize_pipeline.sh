#!/bin/bash
# finalize_pipeline.sh —— 定稿管线（多 agent 评审设计：幂等阶段 + decision.json + 人工拍板点）
# 阶段 P0–P5 自动；P6（协议参数写入）人工执行 approve；红线：阈值只读自 proto-v1.1，无"按结果调规则"代码路径
set -u
cd /root/autodl-tmp/mno_p4
PY=/root/miniconda3/bin/python
R=/root/autodl-tmp/mno_p4/optimization_evidence
LOG=/root/autodl-tmp/mno_p4/finalize_$(date +%m%d_%H%M%S).log
exec > >(tee -a "$LOG") 2>&1
RUN_ID=mno_p4_$(date +%Y%m%dT%H%M)
mkdir -p /root/autodl-tmp/mno_p4/.done $R/../finalize
F=/root/autodl-tmp/mno_p4/finalize
echo "=== FINALIZE $RUN_ID START ==="

# P0 就绪
n=$($PY - <<'PYEOF'
import json, os, sys
sys.stdout.reconfigure(encoding="utf-8")
R="/root/autodl-tmp/mno_p4/optimization_evidence"
n=0
for s in (41,42,43):
    for r in ("baseline","reference"):
        p=f"{R}/{r}_runs/seed_{s}/result.json"
        if os.path.isfile(p) and json.load(open(p)).get("status") in ("VALID","INVALID"): n+=1
print(n)
PYEOF
)
[ "$n" = "6" ] || { echo "P0_INCOMPLETE n=$n"; exit 1; }
touch .done/P0 && echo "P0 OK (6 results present)"

# P1 汇总重算
$PY compare_br.py --root optimization_evidence --protocol proto-v1.1 --anchor data_assets/truth/floor_report.json || { echo P1_FAIL; exit 1; }
$PY -c "import json; d=json.load(open('$R/comparison_summary.json')); assert 'B_mean' in d and 'sigma_B' in d; assert d.get('pairing_complete')"
touch .done/P1 && echo "P1 OK"

# P3 耗时（从 execution_meta/run.log 取最大单轮耗时）
MAX_ELAPSED=$($PY - <<'PYEOF'
import json, os, sys
sys.stdout.reconfigure(encoding="utf-8")
R="/root/autodl-tmp/mno_p4/optimization_evidence"
mx=0
for s in (41,42,43):
    for r in ("baseline","reference"):
        p=f"{R}/{r}_runs/seed_{s}/execution_meta.json"
        if os.path.isfile(p):
            m=json.load(open(p)).get("elapsed_s") or 0
            mx=max(mx,float(m))
print(int(mx))
PYEOF
)
echo "P3 max_elapsed_s=$MAX_ELAPSED"
LIMIT=$(( (MAX_ELAPSED * 115 / 100 / 60 + 1) * 60 ))
echo "P3 proposed time_limit_seconds=$LIMIT"
touch .done/P3

# P4 判定 → decision.json
$PY - <<'PYEOF'
import json, os, sys, hashlib, datetime
sys.stdout.reconfigure(encoding="utf-8")
R="/root/autodl-tmp/mno_p4/optimization_evidence"
U=0.03656967585449946
d=json.load(open(f"{R}/comparison_summary.json"))
B=d["B_mean"]; S=d["sigma_B"]; Delta=d["Delta"]; rn=d["Reference_normalized"]
def j(id_, metric, value, thr, passed, ev, plan=None):
    return {"id":id_, "metric":metric, "value":value, "threshold":thr, "pass":passed,
            "evidence":ev, "fallback_plan":plan}
js=[
 j("D1","baseline_valid_count","{}/6".format(sum(1 for x in d["baseline"])),
   "==6", sum(1 for x in d["baseline"])==6, ["baseline_runs/*/result.json#status"], "PLAN_GATING_RELAX"),
 j("D2","Reference_normalized",round(rn,4),"in [0.15,0.8]", rn is not None and 0.15<=rn<=0.8,
   ["comparison_summary.json#Reference_normalized"], "PLAN_DEEPEN_EVAL"),
 j("G03a","Delta_positive",round(Delta,4),">0", Delta>0, ["comparison_summary.json#Delta"]),
 j("G03b","three_sigma",round(Delta/(S or 1e-12),2),">=3.0", (S or 0)>0 and Delta>=3*S,
   ["comparison_summary.json#sigma_ratios"], None if Delta>=3*S else "PLAN_MORE_SEEDS"),
 j("V09","reload_consistency","see v09_work","rel<1e-4 all", os.path.isfile("/root/autodl-tmp/mno_p4/V09_DONE"),
   ["v09_work/reload_*.json"]),
]
overall="GO" if all(x["pass"] for x in js) else "NEEDS_HUMAN"
dec={"run_id":os.environ.get("RUN_ID","mno_p4"),"policy_version":"proto-v1.1",
     "generated":datetime.datetime.now().isoformat(),
     "inputs":[],"judgments":js,"overall":overall,
     "proposals":[{"type":"time_limit_seconds","current":"unset","proposed":None,
                   "basis":"max_seed_elapsed*1.15","applied":False}]}
for s in (41,42,43):
    for r in ("baseline","reference"):
        p=f"{R}/{r}_runs/seed_{s}/result.json"
        dec["inputs"].append({"path":p.replace("/root/autodl-tmp/mno_p4/",""),"sha256":hashlib.sha256(open(p,'rb').read()).hexdigest()[:16]})
json.dump(dec, open("/root/autodl-tmp/mno_p4/finalize/decision.json","w"), indent=2, ensure_ascii=False)
print("DECISION:", overall)
for x in js: print(" ", x["id"], "PASS" if x["pass"] else "FAIL", x["value"])
PYEOF
touch .done/P4

# P5 回填提案（只生成不应用）
$PY - <<'PYEOF'
import json, sys
sys.stdout.reconfigure(encoding="utf-8")
d=json.load(open("/root/autodl-tmp/mno_p4/finalize/decision.json"))
R="/root/autodl-tmp/mno_p4/optimization_evidence"
c=json.load(open(f"{R}/comparison_summary.json"))
anchor_new={"B_mean": c["B_mean"], "U": 0.03656967585449946,
  "U_basis":"DevPublic split-half noise floor (v1.1), frozen 2026-10-06 before any model score",
  "B_seeds": [x["staterr"] for x in c["baseline"]],
  "anchor_status":"CALIBRATED",
  "protocol_version":"proto-v1.1",
  "max_abs_train": 68.06071472167969,
  "baseline_param_count": 18028225}
json.dump(anchor_new, open("/root/autodl-tmp/mno_p4/finalize/anchor.proposed.json","w"), indent=2)
print("anchor proposal written (NOT applied; apply via approve after human review)")
PYEOF
touch .done/P5
echo "=== FINALIZE P0-P5 COMPLETE: see finalize/decision.json (overall=$($PY -c "import json;print(json.load(open('/root/autodl-tmp/mno_p4/finalize/decision.json'))['overall']))") ==="
