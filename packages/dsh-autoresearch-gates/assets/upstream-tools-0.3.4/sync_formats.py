#!/usr/bin/env python3
"""Derive AGENTS.md and CLAUDE.md from each skill's SKILL.md."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def render(source: str) -> str:
    lines = source.splitlines()
    if not lines or lines[0] != "---":
        raise ValueError("SKILL.md must start with YAML frontmatter")
    try:
        end = lines.index("---", 1)
    except ValueError as exc:
        raise ValueError("SKILL.md frontmatter is not closed") from exc
    metadata: dict[str, str] = {}
    for line in lines[1:end]:
        if ":" in line:
            key, value = line.split(":", 1)
            metadata[key.strip()] = value.strip().strip('"\'')
    description = metadata.get("description")
    if not description:
        raise ValueError("SKILL.md frontmatter requires description")
    body = "\n".join(lines[end + 1 :]).strip()
    body_lines = body.splitlines()
    if not body_lines or not body_lines[0].startswith("# "):
        raise ValueError("SKILL.md body must start with one H1")
    remainder = body_lines[1:]
    while remainder and not remainder[0].strip():
        remainder.pop(0)
    rendered = [body_lines[0], "", f"> {description}", "", *remainder]
    return "\n".join(rendered).rstrip() + "\n"


def synchronize(skills_dir: Path, check: bool) -> list[Path]:
    drift: list[Path] = []
    for source_path in sorted(skills_dir.glob("*/SKILL.md")):
        expected = render(source_path.read_text(encoding="utf-8"))
        for name in ("AGENTS.md", "CLAUDE.md"):
            target = source_path.with_name(name)
            current = target.read_text(encoding="utf-8") if target.exists() else None
            if current == expected:
                continue
            drift.append(target)
            if not check:
                target.write_text(expected, encoding="utf-8")
    return drift


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="report drift without writing")
    parser.add_argument("--skills-dir", type=Path, default=Path(__file__).resolve().parents[1] / "skills")
    args = parser.parse_args()
    try:
        drift = synchronize(args.skills_dir, args.check)
    except ValueError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    if args.check and drift:
        for path in drift:
            print(f"DRIFT: {path.relative_to(args.skills_dir.parent)}")
        return 1
    action = "updated" if drift else "verified"
    print(f"PASS: {action} derived formats for {len(list(args.skills_dir.glob('*/SKILL.md')))} skills")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
