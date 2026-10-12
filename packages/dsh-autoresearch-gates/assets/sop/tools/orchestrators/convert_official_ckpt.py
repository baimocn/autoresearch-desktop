#!/usr/bin/env python3
"""Convert an official-script full-model pickle into the frozen contract format.

Protocol §7 keeps official scripts byte-faithful; their torch.save(model)
checkpoints are converted (NOT retrained) to {"state_dict","config"} so the
frozen grader can score them. Records both hashes + role/seed binding.

Usage:
  python convert_official_ckpt.py --in <official_model.pt> --out <model.pt> \
      --role baseline|reference --seed 41 --width 128 --modes 20
"""

import argparse
import hashlib
import json
import os
import sys

import torch

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(_HERE, "grader_src"))
# The official scripts save with torch.save(model, ...), so the pickle references
# the module that defined the class ("fno_2d", which itself imports "utilities").
# Both the vendored repo root and its models/ dir must be importable for the
# unpickler to resolve them (fixed 2026-10-06: grading failed with
# ModuleNotFoundError: No module named 'fno_2d').
for _cand in (os.path.join(_HERE, "research_notes", "official_repo", "models"),
              os.path.join(_HERE, "research_notes", "official_repo"),
              os.path.join(_HERE, "models"), _HERE):
    if os.path.isdir(_cand) and _cand not in sys.path:
        sys.path.insert(0, _cand)
import starter_model  # noqa: E402


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--role", required=True, choices=["baseline", "reference"])
    ap.add_argument("--seed", type=int, required=True)
    ap.add_argument("--width", type=int, required=True)
    ap.add_argument("--modes", type=int, default=20)
    ap.add_argument("--domain-size", type=int, default=64,
                    help="grid size of the trained model (64 for Re=500, 128 for Re=5000)")
    args = ap.parse_args()

    in_sha = sha256_file(args.inp)
    model = torch.load(args.inp, map_location="cpu", weights_only=False)
    assert isinstance(model, torch.nn.Module), "official checkpoint is not a full model pickle"
    config = {"in_dim": 1, "out_dim": 1, "domain_size": args.domain_size,
              "modes": args.modes, "width": args.width}
    # verify the declared config matches the pickle's real architecture shape
    rebuilt = starter_model.build_model(config)
    try:
        rebuilt.load_state_dict(model.state_dict())
    except Exception as e:
        raise SystemExit(f"config mismatch with checkpoint tensors: {e}")
    # runtime shape check: domain_size is not a parameter, so a wrong value only
    # shows up at inference time (bug found 2026-10-07 on the Re=5000 baseline).
    import torch as _t
    with _t.no_grad():
        probe = _t.zeros(1, args.domain_size, args.domain_size, 1)
        out = rebuilt(probe)
    assert tuple(out.shape) == (1, args.domain_size, args.domain_size, 1),         f"domain_size={args.domain_size} inconsistent with checkpoint: forward gave {tuple(out.shape)}"
    print(f"forward check OK at {args.domain_size}x{args.domain_size}")
    contract = {"state_dict": model.state_dict(), "config": config}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    torch.save(contract, args.out)

    report = {
        "role": args.role, "seed": args.seed,
        "official_ckpt_sha256": in_sha, "official_ckpt_path": os.path.abspath(args.inp),
        "contract_model_sha256": sha256_file(args.out), "contract_model_path": os.path.abspath(args.out),
        "config": config, "params": sum(p.numel() for p in model.parameters()),
    }
    print(json.dumps(report, indent=2))
    sidecar = args.out + ".conversion.json"
    with open(sidecar, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)


if __name__ == "__main__":
    main()
