#!/bin/bash
# backfill.sh —— 空闲算力回填 + 异常自愈（幂等，每小时可调用）
# 预先声明的规则（顺序执行，不即兴发挥）：
#   R1 全部完成（ORCHESTRATE_DONE）→ 不启动任何新任务
#   R2 Re5000 兜底已出结果 → 不启动新任务（等白天决策）
#   R3 决策为 RE5000_FALLBACK → 确保 re5000_diag.sh 在跑
#   R4 诊断未完成 → 确保 A/B/C 三个训练在跑（缺哪个补哪个），并确保 orchestrate.py 存活
#   R5 已决策、正式 B/R 阶段 → 确保 orchestrate.py 存活；若空闲卡存在且其日志 >20min 无更新 → 重启它
set -u
cd /root/autodl-tmp/mno_p4
PY=/root/miniconda3/bin/python
LOG=/root/autodl-tmp/mno_p4/backfill.log
R=/root/autodl-tmp/mno_p4/optimization_evidence
D=/root/autodl-tmp/mno_p4/diag3
T=/root/autodl-tmp/mno_p4/data_assets/truth
say(){ echo "[$(date +%F_%T)] $*" | tee -a "$LOG"; }

idle=""
for g in 0 1 2; do
  nvidia-smi -i $g --query-compute-apps=pid --format=csv,noheader 2>/dev/null | grep -q . || idle="$idle $g"
done
running=$(for pid in $(pgrep -f "official_(NS|mno)|unet_baseline" 2>/dev/null); do readlink /proc/$pid/cwd 2>/dev/null; done | sort -u | tr '\n' ' ')
say "state: idle_gpus=[$idle] running=[$running]"

# R0 布局自愈：官方脚本按 cwd 解析 '../utilities.py' 与 '../models/'
heal_layout(){
  local parent
  for parent in "$R/baseline_runs" "$R/reference_runs" "$ROOT/spec" "$D" "$ROOT/re5000" "$ROOT/re5000/base" "$ROOT/re5000/ref"; do
    [ -d "$parent" ] || continue
    [ -f "$parent/utilities.py" ] || cp -f "$ROOT/research_notes/official_repo/utilities.py" "$parent/" 2>/dev/null
    [ -f "$parent/dissipative_utils.py" ] || cp -f "$ROOT/research_notes/official_repo/dissipative_utils.py" "$parent/" 2>/dev/null
    mkdir -p "$parent/models" 2>/dev/null
    [ -f "$parent/models/fno_2d.py" ] || cp -f "$ROOT/research_notes/official_repo/models/fno_2d.py" "$parent/models/" 2>/dev/null
  done
}
heal_layout

# R0b spec2 补发：SPEC_DONE 已置但 spec/mno128_s42 未训练且无进程
if [ -f SPEC_DONE ] && [ ! -f ORCHESTRATE_DONE ]; then
  sp="$ROOT/spec/mno128_s42"
  if [ -d "$sp" ] && [ ! -f "$sp/.abandoned" ] && ! grep -q "Weights saved" "$sp/run.log" 2>/dev/null && ! echo "$running" | grep -q "$sp"; then
    if [ -n "$idle" ]; then
      g=$(echo $idle | awk '{print $1}')
      say "R0b relaunching spec2 (MNO128 s42) on GPU$g"
      ( cd "$sp" && CUDA_VISIBLE_DEVICES=$g setsid nohup $PY ./official_NS_mno_dissipative_re500_s42.py >> run.log 2>&1 & )
    fi
  fi
fi


# R1
if [ -f ORCHESTRATE_DONE ]; then say "R1 all done"; exit 0; fi
# R2
if [ -f re5000/RE5000_DIAG_DONE ]; then say "R2 re5000 diag finished"; exit 0; fi

# R3
if [ -f formal_decision.json ] && grep -q RE5000_FALLBACK formal_decision.json 2>/dev/null; then
  if pgrep -f re5000_diag.sh >/dev/null; then say "R3 re5000 diag running"; else
    say "R3 launching re5000_diag.sh"; setsid nohup bash re5000_diag.sh > /dev/null 2>&1 &
  fi
  exit 0
fi

# R4 诊断阶段
if [ ! -f DIAG3_DONE ]; then
  for j in A B C; do
    case $j in A) dir=$D/A;; B) dir=$D/B;; C) dir=$D/C;; esac
    if [ -f $dir/result.json ]; then say "R4 diag $j graded"; continue; fi
    if echo "$running" | grep -q "$dir"; then say "R4 diag $j running"; continue; fi
    if grep -q "Weights saved" $dir/run.log 2>/dev/null; then say "R4 diag $j trained (awaiting grade)"; continue; fi
    say "R4 diag $j NOT running -> relaunch"
    case $j in
      A) ( cd $dir && CUDA_VISIBLE_DEVICES=0 setsid nohup $PY ./official_mno_w128.py >> run.log 2>&1 & ) ;;
      B) ( cd $dir && CUDA_VISIBLE_DEVICES=1 setsid nohup $PY /root/autodl-tmp/mno_p4/unet_baseline.py \
            --data /root/autodl-tmp/mno_p4/data_assets/train_re500.npy --seed 41 --epochs 50 \
            --width 64 --ntrain 900 --out $dir/solution/model.pt >> run.log 2>&1 & ) ;;
      C) ( cd $dir && CUDA_VISIBLE_DEVICES=2 setsid nohup $PY /root/autodl-tmp/mno_p4/unet_baseline.py \
            --data /root/autodl-tmp/mno_p4/data_assets/train_re500.npy --seed 41 --epochs 50 \
            --width 32 --ntrain 900 --out $dir/solution/model.pt >> run.log 2>&1 & ) ;;
    esac
  done
  # spec 预跑也要在（若尚未完成）
  if [ ! -f SPEC_DONE ]; then
    pgrep -f spec_launch.sh >/dev/null || { say "R4 spec_launch dead -> restart"; setsid nohup bash spec_launch.sh > /dev/null 2>&1 & }
  fi
  pgrep -f orchestrate.py >/dev/null || { say "R4 orchestrator dead -> restart"; setsid nohup $PY orchestrate.py >> orchestrate_stdout.log 2>&1 & }
  exit 0
fi

# R5 正式 B/R 阶段
if pgrep -f orchestrate.py >/dev/null; then
  if [ -n "$idle" ]; then
    last=$(stat -c %Y orchestrate.log 2>/dev/null || echo 0); now=$(date +%s)
    age=$(( (now - last) / 60 ))
    if [ "$age" -gt 20 ]; then
      say "R5 idle GPUs + orchestrator log stale (${age}min) -> restart"
      for p in $(pgrep -f orchestrate.py); do kill -TERM $p 2>/dev/null; done
      sleep 2
      setsid nohup $PY orchestrate.py >> orchestrate_stdout.log 2>&1 &
    else
      say "R5 idle GPUs, orchestrator progressing (log age ${age}min)"
    fi
  else
    say "R5 all GPUs busy"
  fi
else
  say "R5 orchestrator dead -> restart"
  setsid nohup $PY orchestrate.py >> orchestrate_stdout.log 2>&1 &
fi
exit 0
