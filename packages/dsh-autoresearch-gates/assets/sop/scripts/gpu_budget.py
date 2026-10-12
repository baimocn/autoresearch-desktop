#!/usr/bin/env python3
"""Estimate an instance rental budget offline; all prices are per instance."""

from __future__ import annotations

import argparse
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_CEILING, ROUND_HALF_UP, localcontext
import json


def nonnegative_decimal(raw: str) -> Decimal:
    try:
        value = Decimal(raw)
    except InvalidOperation as exc:
        raise argparse.ArgumentTypeError("must be a decimal number") from exc
    if not value.is_finite() or value < 0:
        raise argparse.ArgumentTypeError("must be finite and >= 0")
    return value


def positive_decimal(raw: str) -> Decimal:
    value = nonnegative_decimal(raw)
    if value <= 0:
        raise argparse.ArgumentTypeError("must be > 0")
    return value


def nonnegative_integer(raw: str) -> int:
    try:
        value = int(raw)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if value < 0:
        raise argparse.ArgumentTypeError("must be >= 0")
    return value


def positive_integer(raw: str) -> int:
    value = nonnegative_integer(raw)
    if value <= 0:
        raise argparse.ArgumentTypeError("must be > 0")
    return value


def iso_date(raw: str) -> str:
    try:
        value = date.fromisoformat(raw)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be YYYY-MM-DD") from exc
    if value.isoformat() != raw:
        raise argparse.ArgumentTypeError("must be YYYY-MM-DD")
    return raw


def decimal_text(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return "0" if value.is_zero() else text


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(
        description=(
            "Offline rental estimate. Supply the whole-instance price, not a "
            "per-GPU price. Same duration/specification only; run separately "
            "for different instances. Decimal quantities are JSON strings."
        )
    )
    rates = cli.add_mutually_exclusive_group(required=True)
    rates.add_argument("--hourly-price", type=nonnegative_decimal, help="price per instance per hour")
    rates.add_argument("--daily-price", type=nonnegative_decimal, help="price per instance per 24 hours")
    cli.add_argument("--hours-per-instance", type=positive_decimal, required=True, help="continuous rental hours before buffer")
    cli.add_argument("--instances", type=positive_integer, default=1, help="identical instances with the same duration (default: 1)")
    cli.add_argument("--gpus-per-instance", type=nonnegative_integer, default=1, help="GPU count, for GPU-hours only; 0 for CPU (default: 1)")
    cli.add_argument("--buffer-percent", type=nonnegative_decimal, default=Decimal("0"), help="extra time percentage (default: 0)")
    cli.add_argument("--quote-source", help="source of the supplied price; not verified online")
    cli.add_argument("--quote-date", type=iso_date, help="quote date in YYYY-MM-DD")
    return cli


def estimate(args: argparse.Namespace) -> dict:
    hourly = args.hourly_price is not None
    price = args.hourly_price if hourly else args.daily_price
    numbers = (price, args.hours_per_instance, args.buffer_percent)
    # Enough precision for the input coefficients, fractional hours, counts,
    # and multiplication; avoid binary float and premature money rounding.
    precision = max(
        50,
        sum(len(n.as_tuple().digits) + abs(n.as_tuple().exponent) for n in numbers)
        + len(str(args.instances))
        + len(str(args.gpus_per_instance))
        + 30,
    )
    with localcontext() as ctx:
        ctx.prec = precision
        planned_hours = args.hours_per_instance * (Decimal("1") + args.buffer_percent / Decimal("100"))
        billable_days = None
        if hourly:
            billable_hours = planned_hours
            cost_per_instance = price * billable_hours
        else:
            days = (planned_hours / Decimal("24")).to_integral_value(rounding=ROUND_CEILING)
            billable_days = int(days)
            billable_hours = days * Decimal("24")
            cost_per_instance = price * days

        total_cost = cost_per_instance * args.instances
        return {
            "estimate_type": "offline_rental_budget",
            "billing_mode": "hourly" if hourly else "daily_24h_ceiling",
            "price_basis": "per_instance",
            "quoted_unit_price": decimal_text(price),
            "quote_source": args.quote_source,
            "quote_date": args.quote_date,
            "instances": args.instances,
            "gpus_per_instance": args.gpus_per_instance,
            "hours_per_instance_before_buffer": decimal_text(args.hours_per_instance),
            "buffer_percent": decimal_text(args.buffer_percent),
            "planned_hours_per_instance": decimal_text(planned_hours),
            "billable_days_per_instance": billable_days,
            "billable_hours_per_instance": decimal_text(billable_hours),
            "planned_total_instance_hours": decimal_text(planned_hours * args.instances),
            "planned_total_gpu_hours": decimal_text(planned_hours * args.instances * args.gpus_per_instance),
            "billable_total_instance_hours": decimal_text(billable_hours * args.instances),
            "billable_total_gpu_hours": decimal_text(billable_hours * args.instances * args.gpus_per_instance),
            "cost_per_instance": decimal_text(cost_per_instance),
            "total_cost": decimal_text(total_cost),
            "total_cost_rounded_2dp": format(total_cost.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP), "f"),
            "cost_scope": "rental_only; same currency as quoted price",
        }


def main() -> None:
    args = parser().parse_args()
    print(json.dumps(estimate(args), ensure_ascii=True, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
