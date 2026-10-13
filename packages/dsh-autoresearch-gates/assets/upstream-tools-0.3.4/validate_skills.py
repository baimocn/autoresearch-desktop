#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def validate(skill: Path) -> list[str]:
    errors = []
    source = skill / "SKILL.md"
    if not source.is_file():
        return [f"{skill.name}: missing SKILL.md"]
    text = source.read_text(encoding="utf-8")
    match = re.match(r"\A---\n(.*?)\n---\n", text, re.DOTALL)
    if not match:
        return [f"{skill.name}: invalid YAML frontmatter boundary"]
    fields = {}
    for line in match.group(1).splitlines():
        field = re.match(r"^([a-zA-Z0-9_-]+):\s*(.+?)\s*$", line)
        if field:
            fields[field.group(1)] = field.group(2).strip("'\"")
    name = fields.get("name")
    description = fields.get("description")
    if name != skill.name or not isinstance(name, str) or not NAME_PATTERN.fullmatch(name):
        errors.append(f"{skill.name}: name must match its directory and use hyphen-case")
    if not isinstance(description, str) or not description.strip():
        errors.append(f"{skill.name}: description is required")
    if len(description or "") > 1024:
        errors.append(f"{skill.name}: description exceeds 1024 characters")
    if "[TODO:" in text:
        errors.append(f"{skill.name}: unfinished TODO placeholder")
    return errors


def main() -> int:
    skills = sorted(path for path in (ROOT / "skills").iterdir() if path.is_dir())
    errors = [error for skill in skills for error in validate(skill)]
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(f"validated {len(skills)} skills")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
