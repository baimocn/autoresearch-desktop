#!/usr/bin/env python3
"""dockerfile_preflight.py —— Dockerfile 构建前静态预检（只读，不构建、不改文件）

来源：2026-10-09 auto0340 实录（见 references/field-lessons.md L24）。
交付包的两个 Dockerfile **通过了 `docker_paths.inspect()` 与自写包检查器**，
但真机 `docker build` 直接失败，暴露三类"静态看不见"的缺陷：

  1. **行尾双反斜杠** `\\` ⇒ Docker 视为"转义后的字面反斜杠"，**不续行**，
     下一行被当成独立指令 ⇒ `dockerfile parse error ... unknown instruction: -e`。
  2. **基础镜像的 Python 版本与依赖闭包不匹配** ⇒ `ubuntu:22.04` 源里只有 `python3.10`，
     而 `torch==2.2.2+cu118` + `numpy==1.23.5` 要求 Python < 3.10；
     实测 `apt-cache policy python3.9` 返回 `Candidate: (none)`，构建必挂。
  3. **`--no-deps` 的两笔债**：本地为绕开依赖解析冲突而用 `--no-deps` 的变体
     **从未回写交付件**；且 `--no-deps` 会跳过该包的运行时依赖（实测 `tensordict` 缺 `orjson`
     ⇒ 评分脚本 import 阶段即崩）。

本工具覆盖 1、2 与 3 的可静态识别部分；**pip 依赖解析冲突本身需要真机跑 pip**，
本工具只做提醒，不假装能替代真机构建。

用法：
  python tools/dockerfile_preflight.py <Dockerfile> [<Dockerfile2> ...]
  python tools/dockerfile_preflight.py tests/Dockerfile environment/Dockerfile

退出码：0=通过 / 1=硬失败（按现有内容构建必挂）/ 2=需人工确认（本工具无法判定）
"""

import argparse
import re
import sys
from pathlib import Path

EXIT_OK, EXIT_FAIL, EXIT_MANUAL = 0, 1, 2

TWO_BS_LF = bytes([0x5C, 0x5C, 0x0A])        # `\` `\` LF
TWO_BS_CRLF = bytes([0x5C, 0x5C, 0x0D, 0x0A])  # `\` `\` CR LF

# 发行版默认 Python 小版本（用于"要装的版本低于发行版自带版本"判定）
DISTRO_PYTHON = {
    ("ubuntu", "20.04"): (3, 8),
    ("ubuntu", "22.04"): (3, 10),
    ("ubuntu", "24.04"): (3, 12),
    ("debian", "11"): (3, 9),
    ("debian", "12"): (3, 11),
}

FROM_RE = re.compile(r"^\s*FROM\s+(\S+)", re.I)
UBUNTU_RE = re.compile(r"ubuntu[:\-]?([0-9]+\.[0-9]+)", re.I)
DEBIAN_RE = re.compile(r"debian[:\-]?([0-9]+)", re.I)
PYVER_RE = re.compile(r"python3\.([0-9]+)")
APT_INSTALL_RE = re.compile(r"\bapt(-get)?\b.*\binstall\b", re.I)


def check_file(path: Path):
    """返回 (exit_code, [消息])；exit_code 取该文件最严重的一档。"""
    msgs = []
    worst = EXIT_OK

    def bump(code, msg):
        nonlocal worst
        msgs.append(msg)
        worst = max(worst, code)

    raw = path.read_bytes()
    text = raw.decode("utf-8", "replace")
    lines = text.splitlines()

    # ---- 检查 1：行尾双反斜杠 ----
    n_dbs = raw.count(TWO_BS_LF) + raw.count(TWO_BS_CRLF)
    if n_dbs:
        first = next((i + 1 for i, ln in enumerate(lines)
                      if ln.rstrip("\r").rstrip().endswith("\\\\")), "?")
        bump(EXIT_FAIL,
             f"[FAIL] 行尾双反斜杠 {n_dbs} 处（首个约在第 {first} 行）⇒ "
             f"不续行，下一行会被当成指令 ⇒ dockerfile parse error / unknown instruction。"
             f"修法：`\\\\`+LF → `\\`+LF")

    # ---- 检查 2：行尾 CR ----
    n_cr = raw.count(b"\r")
    if n_cr:
        bump(EXIT_MANUAL,
             f"[MANUAL] 文件含 {n_cr} 处 CR（CRLF 行尾）⇒ Dockerfile 的 `\\` 续行在 CRLF 下不可靠。"
             f"建议统一为 LF（`tr -d '\\r'`）；若已确认构建通过，可忽略本条")

    # ---- 解析 FROM 基础镜像 ----
    base = None
    for ln in lines:
        m = FROM_RE.match(ln)
        if m:
            base = m.group(1)
            break
    if base is None:
        bump(EXIT_FAIL, "[FAIL] 未找到 FROM 指令")
        return worst, msgs

    distro = None
    mu, md = UBUNTU_RE.search(base), DEBIAN_RE.search(base)
    if mu:
        distro = ("ubuntu", mu.group(1))
    elif md:
        distro = ("debian", md.group(1))
    msgs.append(f"[INFO] 基础镜像 = {base}" + (f"（识别为 {distro[0]}:{distro[1]}）" if distro else ""))

    # ---- 检查 3：要装的 python3.x 是否低于发行版自带版本 ----
    if distro and distro in DISTRO_PYTHON:
        have = DISTRO_PYTHON[distro]
        wanted = set()
        for ln in lines:
            if ln.lstrip().startswith("#"):        # 注释不算
                continue
            if not APT_INSTALL_RE.search(ln):
                continue
            for mm in PYVER_RE.finditer(ln):
                wanted.add(int(mm.group(1)))
        lower = sorted(v for v in wanted if v < have[1])
        if lower:
            has_ppa = any(("deadsnakes" in ln or "ppa:" in ln) and not ln.lstrip().startswith("#")
                          for ln in lines)
            if not has_ppa:
                bump(EXIT_FAIL,
                     f"[FAIL] {distro[0]}:{distro[1]} 自带 Python {have[0]}.{have[1]}，"
                     f"但 Dockerfile 要装 python3.{lower[0]} 且**未加 deadsnakes PPA** ⇒ "
                     f"`apt-cache policy python3.{lower[0]}` 会返回 `Candidate: (none)`，构建必挂。"
                     f"修法：加 deadsnakes，或换自带目标 Python 的基础镜像")
            else:
                bump(EXIT_MANUAL,
                     f"[MANUAL] 要装 python3.{lower[0]}（低于发行版自带 {have[0]}.{have[1]}），"
                     f"已见 deadsnakes/ppa ⇒ 请确认该 PPA 对 {distro[1]} 仍可用")

    # ---- 检查 4：--no-deps 的两笔债 ----
    nodeps_lines = [i + 1 for i, ln in enumerate(lines)
                    if "--no-deps" in ln and not ln.lstrip().startswith("#")]
    if nodeps_lines:
        has_import_check = any(re.search(r"python3?\s+-c\s+[\"']\s*import", ln)
                               for ln in lines if not ln.lstrip().startswith("#"))
        if not has_import_check:
            bump(EXIT_MANUAL,
                 f"[MANUAL] 第 {nodeps_lines} 行用了 `--no-deps` ⇒ 该包的运行时依赖会被跳过"
                 f"（实测缺 `orjson` 会让评分脚本 import 阶段直接崩），且本文件**没有构建期 import 自检**。"
                 f"修法：用 `pip show <pkg>` 的 Requires 显式补齐依赖，并加 "
                 f"`RUN python3 -c \"import <pkgs>\"`")
        else:
            msgs.append(f"[INFO] 第 {nodeps_lines} 行用了 `--no-deps`，已见构建期 import 自检（好）")

    return worst, msgs


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Dockerfile 构建前静态预检（只读）：行尾双反斜杠 / 基础镜像 Python 版本 / --no-deps 债务")
    ap.add_argument("dockerfiles", nargs="+", help="待检查的 Dockerfile 路径")
    args = ap.parse_args()

    overall = EXIT_OK
    for f in args.dockerfiles:
        p = Path(f)
        print("=" * 72)
        print(f"# {p}")
        if not p.is_file():
            print("  [FAIL] 文件不存在")
            overall = max(overall, EXIT_FAIL)
            continue
        code, msgs = check_file(p)
        for m in msgs:
            print("  " + m)
        print(f"  -> 本文件结论：{'通过' if code == 0 else '硬失败' if code == 1 else '需人工确认'}")
        overall = max(overall, code)

    print("=" * 72)
    print({EXIT_OK: "通过", EXIT_FAIL: "硬失败（按现有内容构建必挂）",
           EXIT_MANUAL: "需人工确认"}[overall])
    return overall


if __name__ == "__main__":
    sys.exit(main())
