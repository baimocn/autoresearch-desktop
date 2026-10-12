#!/usr/bin/env python3
"""Compare GPU rental and model-API plans with explicit uncertainty."""

from __future__ import annotations

import argparse
import json
import math


def estimate(
    hourly_price: float,
    daily_price: float,
    pilot_hours: float,
    formal_hours: float,
    api_cost: float,
    storage_cost: float,
    reacquire_probability: float,
    reacquire_impact: float,
) -> dict[str, object]:
    for name, value in {
        "hourly_price": hourly_price,
        "daily_price": daily_price,
        "pilot_hours": pilot_hours,
        "formal_hours": formal_hours,
        "api_cost": api_cost,
        "storage_cost": storage_cost,
        "reacquire_impact": reacquire_impact,
    }.items():
        if value < 0:
            raise ValueError(f"{name} must be non-negative")
    if not 0 <= reacquire_probability <= 1:
        raise ValueError("reacquire_probability must be between 0 and 1")

    expected_risk = reacquire_probability * reacquire_impact
    fixed = api_cost + storage_cost
    hourly = hourly_price * (pilot_hours + formal_hours) + fixed + expected_risk
    daily_days = math.ceil((pilot_hours + formal_hours) / 24)
    formal_days = math.ceil(formal_hours / 24)
    daily = daily_price * daily_days + fixed
    hybrid = hourly_price * pilot_hours + daily_price * formal_days + fixed
    totals = {"hourly": hourly, "daily": daily, "hybrid": hybrid}
    recommendation = min(totals, key=totals.get)
    hourly_without_risk = hourly - expected_risk
    risk_break_even_probability = None
    if reacquire_impact > 0:
        risk_break_even_probability = max(
            0.0,
            min(1.0, (min(daily, hybrid) - hourly_without_risk) / reacquire_impact),
        )
    return {
        "expected_reacquisition_loss": round(expected_risk, 2),
        "hourly_reacquisition_break_even_probability": (
            None if risk_break_even_probability is None else round(risk_break_even_probability, 4)
        ),
        "charged_days": {"daily": daily_days, "hybrid_formal": formal_days},
        "totals": {key: round(value, 2) for key, value in totals.items()},
        "arithmetic_recommendation": recommendation,
        "decision_note": (
            "Use the arithmetic result only after the end-to-end pilot passes; "
            "capacity continuity and the experiment stop-loss remain hard gates."
        ),
    }


def estimate_api_mode(
    expected_units: float,
    payg_price_per_unit: float,
    plan_price: float,
    plan_included_units: float,
    plan_overage_price_per_unit: float,
    plan_fit: bool,
) -> dict[str, object]:
    """Compare a subscription plan with metered API usage.

    ``plan_fit`` is deliberately a hard gate: a cheaper plan is unusable when it
    does not cover the required model, region, quota window or concurrency.
    """
    for name, value in {
        "expected_units": expected_units,
        "payg_price_per_unit": payg_price_per_unit,
        "plan_price": plan_price,
        "plan_included_units": plan_included_units,
        "plan_overage_price_per_unit": plan_overage_price_per_unit,
    }.items():
        if value < 0:
            raise ValueError(f"{name} must be non-negative")

    payg = expected_units * payg_price_per_unit
    plan = plan_price + max(0.0, expected_units - plan_included_units) * plan_overage_price_per_unit
    if not plan_fit:
        recommendation = "payg"
        reason = "plan is ineligible for the required model, region, quota window or concurrency"
    else:
        recommendation = "plan" if plan < payg else "payg"
        reason = "lower projected cost among eligible options"
    return {
        "totals": {"payg": round(payg, 2), "plan": round(plan, 2)},
        "plan_fit": plan_fit,
        "arithmetic_recommendation": recommendation,
        "decision_note": reason,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hourly-price", type=float, required=True)
    parser.add_argument("--daily-price", type=float, required=True)
    parser.add_argument("--pilot-hours", type=float, required=True)
    parser.add_argument("--formal-hours", type=float, required=True)
    parser.add_argument("--api-cost", type=float, default=0)
    parser.add_argument("--storage-cost", type=float, default=0)
    parser.add_argument("--reacquire-probability", type=float, default=0)
    parser.add_argument("--reacquire-impact", type=float, default=0)
    parser.add_argument("--api-expected-units", type=float)
    parser.add_argument("--api-payg-price-per-unit", type=float)
    parser.add_argument("--api-plan-price", type=float)
    parser.add_argument("--api-plan-included-units", type=float)
    parser.add_argument("--api-plan-overage-price-per-unit", type=float)
    parser.add_argument("--api-plan-fit", action=argparse.BooleanOptionalAction, default=None)
    args = parser.parse_args()
    try:
        capacity = {
            key: getattr(args, key)
            for key in (
                "hourly_price", "daily_price", "pilot_hours", "formal_hours",
                "api_cost", "storage_cost", "reacquire_probability", "reacquire_impact",
            )
        }
        result = estimate(**capacity)
        api_values = (
            args.api_expected_units,
            args.api_payg_price_per_unit,
            args.api_plan_price,
            args.api_plan_included_units,
            args.api_plan_overage_price_per_unit,
            args.api_plan_fit,
        )
        if any(value is not None for value in api_values):
            if any(value is None for value in api_values):
                parser.error("all API comparison arguments are required when any is provided")
            result["api_mode"] = estimate_api_mode(*api_values)
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
