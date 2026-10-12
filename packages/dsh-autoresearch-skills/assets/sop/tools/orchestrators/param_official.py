"""Generate parameterized copies of the OFFICIAL B/R scripts for a given dataset config.

Only these fields are touched (everything else stays byte-faithful to the repo):
  seed (torch/np), data path, frame slices (container-offset adaptation),
  S (grid size), ntrain/ntest, width, and the dissipativity radii.

Configs:
  re500  : S=64,  60x401x64x64-derived file, ntrain=900, ntest=100,
           radii as in the official script (156.25*S, 525*S + that)
  re5000 : S=128, 60x401x128x128-derived file, ntrain=60, ntest=20,
           radii from the official README rule (inner = mean||data[:,100:]||_2 * S,
           outer = 4.5 * inner) -> 87233.6 / 392551.4  (computed 2026-10-07)

Usage:
  python param_official.py --config re5000 --role baseline --seed 41 --out-dir <dir>
"""

import argparse
import os
import re
import sys

REPO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "research_notes", "official_repo", "scripts")

CONFIGS = {
    "re500": {
        "data": "/root/autodl-tmp/mno_p4/data_assets/train_re500.npy",
        "S": 64, "ntrain": 900, "ntest": 100,
        "width": {"baseline": 128, "reference": 64},
        "radii": None,                      # keep the official script's own values
    },
    "re5000": {
        "data": "/root/autodl-tmp/mno_p4/re5000/train_re5000.npy",
        "S": 128, "ntrain": 60, "ntest": 20,
        "width": {"baseline": 128, "reference": 64},
        "radii": (87233.6, 392551.4),       # README rule, computed from the Re=5000 data
    },
}

SCRIPTS = {"baseline": "NS_fno_baseline.py", "reference": "NS_mno_dissipative.py"}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True, choices=list(CONFIGS))
    ap.add_argument("--role", required=True, choices=list(SCRIPTS))
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--out-name", default=None)
    ap.add_argument("--width", type=int, default=0, help="0 = config default (matched-capacity override)")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    cfg = CONFIGS[args.config]
    src = os.path.join(REPO, SCRIPTS[args.role])
    code = open(src, encoding="utf-8").read()
    orig = code

    # --- seed ---
    assert "torch.manual_seed(0)" in code and "np.random.seed(0)" in code, "seed anchors missing"
    code = code.replace("torch.manual_seed(0)", f"torch.manual_seed({args.seed})")
    code = code.replace("np.random.seed(0)", f"np.random.seed({args.seed})")

    # --- data path ---
    n = len(re.findall(r"data = np\.load\('[^']*'\)", code))
    assert n == 1, f"expected 1 data load, found {n}"
    code = re.sub(r"data = np\.load\('[^']*'\)", f"data = np.load('{cfg['data']}')", code)

    # --- frame slices (pre-trimmed container: frames 99..499 = relative 0..400) ---
    slices = [("data[:ntrain,T_in-1:T_out-1]", "data[:ntrain,0:T]"),
              ("data[:ntrain,T_in:T_out]", "data[:ntrain,1:T+1]"),
              ("data[-ntest:,T_in-1:T_out-1]", "data[-ntest:,0:T]"),
              ("data[-ntest:,T_in:T_out]", "data[-ntest:,1:T+1]")]
    hits = 0
    for old, new in slices:
        if old in code:
            code = code.replace(old, new)
            hits += 1
    assert hits == 4, f"slice anchors incomplete ({hits}/4)"

    # --- ntrain / ntest ---
    code, k1 = re.subn(r"^ntrain = \d+", f"ntrain = {cfg['ntrain']}", code, flags=re.M)
    code, k2 = re.subn(r"^ntest = \d+", f"ntest = {cfg['ntest']}", code, flags=re.M)
    assert k1 == 1 and k2 == 1, f"ntrain/ntest anchors: {k1}/{k2}"

    # --- S ---
    code, k3 = re.subn(r"^S = 64$", f"S = {cfg['S']}", code, flags=re.M)
    assert k3 >= 1, "S anchor missing"

    # --- width ---
    w = args.width if args.width > 0 else cfg["width"][args.role]
    code, k4 = re.subn(r"^width = \d+$", f"width = {w}", code, flags=re.M)
    assert k4 == 1, f"width anchor: {k4}"

    # --- dissipativity radii (reference only) ---
    if args.role == "reference" and cfg["radii"] is not None:
        inner, outer = cfg["radii"]
        code, k5 = re.subn(r"^radius = [0-9.]+ \* S.*$",
                           f"radius = {inner}  # README rule: mean||data[:,100:]||_2 * S",
                           code, flags=re.M)
        code, k6 = re.subn(r"^radii = \(radius,.*$",
                           f"radii = ({inner}, {outer})  # outer = 4.5 * inner",
                           code, flags=re.M)
        assert k5 == 1 and k6 == 1, f"radii anchors: {k5}/{k6}"

    os.makedirs(args.out_dir, exist_ok=True)
    name = args.out_name or f"official_{SCRIPTS[args.role].replace('.py','')}_{args.config}_s{args.seed}.py"
    dst = os.path.join(args.out_dir, name)
    open(dst, "w", encoding="utf-8").write(code)

    # report the diff summary
    changed = [f"seed={args.seed}", f"S={cfg['S']}", f"ntrain={cfg['ntrain']}",
               f"ntest={cfg['ntest']}", f"width={w}", f"data={cfg['data'].split('/')[-1]}"]
    if args.role == "reference" and cfg["radii"]:
        changed.append(f"radii={cfg['radii']}")
    print(f"wrote {dst}")
    print("  changes:", ", ".join(changed))
    print(f"  bytes: {len(orig)} -> {len(code)}")


if __name__ == "__main__":
    main()
