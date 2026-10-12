#!/usr/bin/env python3
"""Reject result indexes that splice evidence across trials."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

SHA256 = re.compile(r"^[0-9a-f]{64}$")
FIELDS = (
    "run_id",
    "role",
    "training_seed",
    "replicate_id",
    "source_sha256",
    "config_sha256",
    "receipt_run_id",
    "artifact_run_id",
)


def validate(index: dict[str, object]) -> list[str]:
    runs = index.get("runs")
    if not isinstance(runs, list) or not runs:
        return ["runs must be a non-empty list"]
    errors: list[str] = []
    run_ids: set[str] = set()
    trial_keys: set[tuple[str, str, str]] = set()
    for position, run in enumerate(runs):
        prefix = f"runs[{position}]"
        if not isinstance(run, dict):
            errors.append(f"{prefix} must be an object")
            continue
        missing = [field for field in FIELDS if field not in run or run[field] in (None, "")]
        if missing:
            errors.append(f"{prefix} missing fields: {', '.join(missing)}")
            continue
        run_id = str(run["run_id"])
        if run_id in run_ids:
            errors.append(f"{prefix} duplicates run_id")
        run_ids.add(run_id)
        trial_key = (str(run["role"]), str(run["training_seed"]), str(run["replicate_id"]))
        if trial_key in trial_keys:
            errors.append(f"{prefix} duplicates role/seed/replicate")
        trial_keys.add(trial_key)
        for field in ("source_sha256", "config_sha256"):
            if not SHA256.fullmatch(str(run[field])):
                errors.append(f"{prefix}.{field} must be a lowercase SHA256")
        for field in ("receipt_run_id", "artifact_run_id"):
            if str(run[field]) != run_id:
                errors.append(f"{prefix}.{field} does not match run_id")
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("index", type=Path)
    args = parser.parse_args()
    errors = validate(json.loads(args.index.read_text(encoding="utf-8")))
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1
    print("PASS: result lineage is internally consistent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
