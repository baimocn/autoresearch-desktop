#!/usr/bin/env python3
"""validate_skills.py —— 技能结构自检（机制吸收自 autoresearch-skills v0.3.4）

为什么需要：技能文档是人（和模型）读的契约，格式漂移会静默降低可用性。
本脚本在提交前核对**结构硬要求**，与上游 `scripts/validate_skills.py` 同一思路。

检查项：
  1. SKILL.md 存在且 YAML frontmatter 边界正确（`---` 开头结尾）
  2. `name` 字段 = 目录名，且为 hyphen-case
  3. `description` 非空且 ≤1024 字符
  4. 无未完成的 TODO 占位
  5. references/ 中每个文件都被 SKILL.md 或 production-sop 引用（防"写了没人读"）
  6. tools/ 下每个 .py 可 ast.parse，.sh 存在且首行是 shebang
  7. 文档中不含本机绝对路径/密钥模式（可移植性 + 脱敏）

用法：
  python scripts/validate_skills.py                 # 校验仓库
  python scripts/validate_skills.py --skill-dir <path-to-skill-root>   # 校验已安装的 skill

退出码：0=全部通过；1=有错误
"""

import argparse
import ast
import os
import re
import sys

sys.stdout.reconfigure(encoding="utf-8")

NAME_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"ark-[A-Za-z0-9-]{20,}"),
    re.compile(r"ghp_[A-Za-z0-9]{20,}"),
    re.compile(r"password\s*[:=]\s*['\"][^'\"]+['\"]", re.I),
]
LOCAL_PATH = re.compile(r"[A-Z]:\\\\?Users\\\\?[A-Za-z0-9_]+|/Users/[A-Za-z0-9_]+/")


def read(p):
    try:
        return open(p, encoding="utf-8").read()
    except Exception:
        return ""


def check_frontmatter(skill_dir, errors):
    src = os.path.join(skill_dir, "SKILL.md")
    if not os.path.isfile(src):
        errors.append(f"{os.path.basename(skill_dir)}: missing SKILL.md")
        return ""
    text = read(src)
    m = re.match(r"\A---\n(.*?)\n---\n", text, re.DOTALL)
    if not m:
        errors.append(f"{os.path.basename(skill_dir)}: invalid YAML frontmatter boundary")
        return text
    fields = {}
    for line in m.group(1).splitlines():
        f = re.match(r"^([a-zA-Z0-9_-]+):\s*(.+?)\s*$", line)
        if f:
            fields[f.group(1)] = f.group(2).strip("'\"")
    name = fields.get("name")
    desc = fields.get("description")
    base = os.path.basename(skill_dir)
    # 两种合法情形：① 目录名=skill 名（安装态 skills/<name>/）；
    # ② 仓库根目录（如 autoresearch-sop）内含 SKILL.md，其 name 可为另一个 hyphen-case 标识
    is_repo_root = os.path.isfile(os.path.join(skill_dir, "README.md")) and         os.path.isdir(os.path.join(skill_dir, "references"))
    if name != base and not is_repo_root:
        errors.append(f"{base}: name field '{name}' must match directory name"
                      f"（仓库根目录可豁免：需同时有 README.md 与 references/）")
    if not name or not NAME_PATTERN.fullmatch(str(name)):
        errors.append(f"{base}: name must be hyphen-case")
    if not desc or not str(desc).strip():
        errors.append(f"{base}: description is required")
    elif len(desc) > 1024:
        errors.append(f"{base}: description exceeds 1024 chars ({len(desc)})")
    if "[TODO:" in text:
        errors.append(f"{base}: unfinished TODO placeholder")
    return text


def check_references(skill_dir, text, errors):
    ref_dir = os.path.join(skill_dir, "references")
    if not os.path.isdir(ref_dir):
        return
    production = read(os.path.join(ref_dir, "production-sop.md"))
    corpus = text + production
    for f in sorted(os.listdir(ref_dir)):
        if not f.endswith(".md"):
            continue
        # 被 SKILL.md 或 production-sop 引用（链接形式）
        if f in corpus:
            continue
        errors.append(f"{os.path.basename(skill_dir)}: references/{f} 未被 SKILL.md 或 "
                      f"production-sop 引用（写了没人读）")


def check_tools(skill_dir, errors):
    tools = os.path.join(skill_dir, "tools")
    if not os.path.isdir(tools):
        return
    for root, _, files in os.walk(tools):
        for f in files:
            p = os.path.join(root, f)
            rel = os.path.relpath(p, skill_dir)
            if f.endswith(".py"):
                try:
                    ast.parse(read(p))
                except SyntaxError as e:
                    errors.append(f"{rel}: Python 语法错误 → {e}")
            elif f.endswith(".sh"):
                first = read(p).splitlines()[:1]
                if not first or not first[0].startswith("#!"):
                    errors.append(f"{rel}: shell 脚本缺 shebang")


def check_secrets_and_paths(skill_dir, errors):
    for root, dirs, files in os.walk(skill_dir):
        dirs[:] = [d for d in dirs if d not in (".git", "__pycache__")]
        for f in files:
            if not f.endswith((".md", ".py", ".sh", ".json", ".toml", ".yml", ".yaml")):
                continue
            p = os.path.join(root, f)
            rel = os.path.relpath(p, skill_dir)
            txt = read(p)
            for pat in SECRET_PATTERNS:
                if pat.search(txt):
                    errors.append(f"{rel}: 疑似密钥（模式 {pat.pattern[:20]}）")
            m = LOCAL_PATH.search(txt)
            if m:
                errors.append(f"{rel}: 含本机绝对路径（{m.group(0)[:30]}）→ 影响可移植性")


def main() -> int:
    ap = argparse.ArgumentParser(description="技能结构自检")
    ap.add_argument("--skill-dir", default=None,
                    help="技能根目录（默认=本仓库根）")
    args = ap.parse_args()

    root = args.skill_dir or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if not os.path.isdir(root):
        print(f"ERROR: 目录不存在 {root}", file=sys.stderr)
        return 1

    # 若传入的是 skills 容器目录（含多个 skill 子目录），逐个校验
    targets = []
    if os.path.isfile(os.path.join(root, "SKILL.md")):
        targets = [root]
    else:
        sub = os.path.join(root, "skills")
        if os.path.isdir(sub):
            targets = [os.path.join(sub, d) for d in sorted(os.listdir(sub))
                       if os.path.isdir(os.path.join(sub, d))]
        if not targets:
            targets = [root]

    errors = []
    for t in targets:
        text = check_frontmatter(t, errors)
        check_references(t, text, errors)
        check_tools(t, errors)
        check_secrets_and_paths(t, errors)

    if errors:
        print("\n".join(f"  ✗ {e}" for e in errors), file=sys.stderr)
        print(f"\n校验失败：{len(errors)} 项", file=sys.stderr)
        return 1
    print(f"✓ 校验通过：{len(targets)} 个技能，无结构/脱敏问题")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
