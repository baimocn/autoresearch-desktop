#!/usr/bin/env python3
"""Rank feasible paper candidates without letting soft preferences offset hard gates."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


HARD_GATES = (
    "provenance_license",
    "optimization_surface",
    "baseline_evaluation",
    "effect_noise",
    "resources_recovery",
    "harness_delivery",
    "duplicate_registry",
)
MODES = {"pool", "expert_self_selection"}


def classify(candidate: dict[str, object]) -> dict[str, object]:
    candidate_id = str(candidate.get("candidate_id", "")).strip()
    mode = candidate.get("selection_mode")
    gates = candidate.get("gates")
    errors: list[str] = []
    if not candidate_id:
        errors.append("candidate_id is required")
    if mode not in MODES:
        errors.append("selection_mode must be pool or expert_self_selection")
    if not isinstance(gates, dict):
        errors.append("gates must be an object")
        gates = {}
    statuses = {name: gates.get(name, "UNKNOWN") for name in HARD_GATES}
    invalid = {name: value for name, value in statuses.items() if value not in {"PASS", "FAIL", "UNKNOWN", "REVIEW"}}
    if invalid:
        errors.append("gate values must be PASS, FAIL, UNKNOWN or REVIEW")

    failed = sorted(name for name, value in statuses.items() if value == "FAIL")
    unresolved = sorted(name for name, value in statuses.items() if value in {"UNKNOWN", "REVIEW"})
    if errors or failed:
        decision = "REJECT"
    elif unresolved:
        decision = "NEEDS_EVIDENCE"
    else:
        decision = "RECOMMEND"

    resources = candidate.get("resources")
    if not isinstance(resources, dict):
        resources = {}
        errors.append("resources must be an object")
    requires_gpu = resources.get("requires_gpu")
    if not isinstance(requires_gpu, bool):
        errors.append("requires_gpu must be boolean")
        decision = "REJECT"
    pilot_cost = resources.get("pilot_cost_upper_bound")
    pilot_hours = resources.get("pilot_hours_upper_bound")
    for name, value in (("pilot_cost_upper_bound", pilot_cost), ("pilot_hours_upper_bound", pilot_hours)):
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
            errors.append(f"{name} must be a non-negative number")
            decision = "REJECT"

    bucket = {"RECOMMEND": 0, "NEEDS_EVIDENCE": 1, "REJECT": 2}[decision]
    sort_key = [
        bucket,
        1 if requires_gpu is not False else 0,
        pilot_cost if isinstance(pilot_cost, (int, float)) else 10**30,
        pilot_hours if isinstance(pilot_hours, (int, float)) else 10**30,
        len(unresolved),
        candidate_id,
    ]
    return {
        "candidate_id": candidate_id,
        "selection_mode": mode,
        "decision": decision,
        "failed_gates": failed,
        "unresolved_gates": unresolved,
        "errors": errors,
        "sort_key": sort_key,
    }


def rank(candidates: list[dict[str, object]]) -> list[dict[str, object]]:
    return sorted((classify(candidate) for candidate in candidates), key=lambda item: item["sort_key"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ledger", type=Path)
    args = parser.parse_args()
    payload = json.loads(args.ledger.read_text(encoding="utf-8"))
    if not isinstance(payload, list):
        parser.error("ledger must be a JSON array")
    print(json.dumps(rank(payload), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
