#!/usr/bin/env python3
"""harbor_task_contract.py —— 题包 task.toml 的 Harbor 原生契约预检（只读，零成本）

来源：2026-10-08 auto2001 实战（见 references/field-lessons.md L19）。
把交付包放到 Harbor 0.24.0 上做原生验证时，`harbor run --path <task>` 直接失败；
用该版本自带的 TaskConfig 加载，一次报出 3 个错：

    3 validation errors for TaskConfig
    task.name
      Field required [type=missing, input_value={'title': 'APAVA 脑电...', 'version': '1.0.0'}, input_type=dict]
    verifier.network_mode
      Input should be 'no-network', 'public' or 'allowlist' [type=enum, input_value='none', input_type=str]
    agent.network_mode
      Input should be 'no-network', 'public' or 'allowlist' [type=enum, input_value='none', input_type=str]

另外还有一处**不会报错但会阻断运行**的缺失：`[environment] build_timeout_sec` 默认 600s，
而含 torch 的镜像首次构建实测约 26 分钟（1578s）⇒ `Environment start timed out after 600.0 seconds`。

本工具把这三类判据固化成**打包前/送检前的静态预检**，回答一个问题：
    **这份 task.toml 能不能被目标 Harbor 版本原生加载并启动？**

设计要点：
  * **只读**：不修改任何被检查文件；不改包、不构建镜像、不跑 Trial。
  * **三态退出码**：0=通过 / 1=硬失败（原生必挂）/ 2=需人工确认（有警告或无法判定）。
  * 不依赖 Harbor 是否安装：优先用 `harbor` 包做真加载；不可用时退回**内置判据**（同样能查出上述四类问题）。

用法：
  python harbor_task_contract.py --task <harbor_task 目录>
  python harbor_task_contract.py --task <dir> --build-timeout-floor 3600
  python harbor_task_contract.py --task <dir> --json          # 机读输出

退出码：0=通过；1=硬失败；2=需人工确认。
"""

import argparse
import json
import re
import sys
from pathlib import Path

EXIT_OK, EXIT_FAIL, EXIT_MANUAL = 0, 1, 2

VALID_NETWORK_MODES = {"no-network", "public", "allowlist"}
VALID_ENV_MODES = {"separate", "shared"}

# 已知的"看起来合法、实际非法"值 —— 这些是最容易踩的（教程旧稿 / 直觉写法）
KNOWN_BAD_NETWORK = {"none", "no_network", "noNetwork", "disabled", "off", "false", "isolated"}


def read(p):
    try:
        return p.read_text(encoding="utf-8")
    except Exception:
        return ""


def load_toml(path):
    """返回 (cfg, err)。Python 3.11+ 用 tomllib；不可用则返回 (None, 原因)。"""
    try:
        import tomllib
    except ModuleNotFoundError:
        return None, "no-tomllib (Python < 3.11)"
    try:
        with path.open("rb") as f:
            return tomllib.load(f), None
    except Exception as e:
        return None, f"{type(e).__name__}: {e}"


def check_with_harbor(path):
    """若本机装了 harbor，用其 TaskConfig 做**真加载**（最权威的判据）。"""
    try:
        import tomllib
        from harbor.models.task.config import TaskConfig  # type: ignore
    except Exception:
        return None
    try:
        with path.open("rb") as f:
            TaskConfig.model_validate(tomllib.load(f))
        return []
    except Exception as e:
        return [ln.strip() for ln in str(e).splitlines() if ln.strip()][:40]


def static_checks(cfg, floor):
    """不依赖 harbor 的内置判据：四类会阻断原生运行的契约问题。"""
    fail, warn = [], []
    if cfg is None:
        return fail, warn

    task = cfg.get("task")
    if not isinstance(task, dict) or not str(task.get("name", "")).strip():
        fail.append("`[task].name` 缺失或为空 —— Harbor 原生解析报 "
                    "`task.name Field required`；`harbor run --path` 直接报 "
                    "`Either datasets or tasks must be provided`。")

    for section in ("agent", "verifier"):
        sec = cfg.get(section)
        if not isinstance(sec, dict):
            continue
        mode = sec.get("network_mode")
        if mode is None:
            continue
        if mode not in VALID_NETWORK_MODES:
            hint = ""
            if str(mode) in KNOWN_BAD_NETWORK:
                hint = f"（'{mode}' 是常见误写，合法值为 {' / '.join(sorted(VALID_NETWORK_MODES))}）"
            fail.append(f"`[{section}].network_mode = \"{mode}\"` 不是合法枚举值{hint} —— "
                        f"Harbor 原生报 `Input should be 'no-network', 'public' or 'allowlist'`。")

    verifier = cfg.get("verifier")
    if isinstance(verifier, dict):
        mode = verifier.get("environment_mode")
        if mode is None:
            fail.append("`[verifier].environment_mode` 未声明 —— 独立评分要求显式 "
                        "`environment_mode = \"separate\"`。")
        elif mode not in VALID_ENV_MODES:
            fail.append(f"`[verifier].environment_mode = \"{mode}\"` 非法，合法值为 "
                        f"{' / '.join(sorted(VALID_ENV_MODES))}。")
        elif mode != "separate":
            warn.append(f"`[verifier].environment_mode = \"{mode}\"`：本题流程要求独立评分"
                        "（separate），请确认这是有意为之。")

    env = cfg.get("environment")
    if isinstance(env, dict) and "build_timeout_sec" in env:
        bt = env.get("build_timeout_sec")
        try:
            bt_val = float(bt)
        except (TypeError, ValueError):
            fail.append(f"`[environment].build_timeout_sec = {bt!r}` 不是数值。")
        else:
            if bt_val < floor:
                warn.append(f"`[environment].build_timeout_sec = {bt_val:g}` 低于本机实测的"
                            f"含 torch 镜像首次构建耗时上界（建议 ≥{floor:g}）；"
                            f"低于该值时有超时风险。")
    else:
        warn.append(f"`[environment]` 未声明 `build_timeout_sec` —— Harbor 默认 600s，"
                    f"而含 torch 的镜像首次构建实测约 1578s（26 分钟），会报 "
                    f"`Environment start timed out after 600.0 seconds`；建议显式声明 {floor:g}。")

    # 顶层字段位置（历史高发：误放进 [task] 表内）
    top = str(cfg.get("schema_version", ""))
    if not top.strip():
        warn.append("顶层 `schema_version` 缺失（裸键若写在 `[task]` 之下会归属该表）。")
    if "artifacts" not in cfg:
        warn.append("顶层 `artifacts` 缺失 —— 提交物移交依赖它（本流程统一 "
                    "`artifacts = [\"/workspace/solution\"]`）。")
    return fail, warn


def main() -> int:
    ap = argparse.ArgumentParser(
        description="题包 task.toml 的 Harbor 原生契约预检（只读，零成本）")
    ap.add_argument("--task", required=True,
                    help="harbor_task 目录（含 task.toml），或直接指向 task.toml")
    ap.add_argument("--build-timeout-floor", type=float, default=3600.0,
                    help="build_timeout_sec 的建议下限（默认 3600，实测首次构建 1578s）")
    ap.add_argument("--json", action="store_true", help="机读输出")
    args = ap.parse_args()

    p = Path(args.task)
    toml_path = p / "task.toml" if p.is_dir() else p
    if not toml_path.is_file():
        print(f"!! 找不到 task.toml: {toml_path}", file=sys.stderr)
        return EXIT_MANUAL

    cfg, err = load_toml(toml_path)
    fail, warn, note = [], [], []
    real = None

    if err:
        warn.append(f"无法用 tomllib 解析（{err}）—— 退回文本判据。")
        text = read(toml_path)
        if re.search(r"^\s*network_mode\s*=\s*[\"']none[\"']", text, re.M):
            fail.append("文本中发现 `network_mode = \"none\"`（非法枚举）。")
    else:
        fail, warn = static_checks(cfg, args.build_timeout_floor)
        real = check_with_harbor(toml_path)

    if real is not None:
        if real:
            fail = fail + [f"harbor 原生加载：{m}" for m in real]
        else:
            note.append("harbor 包可用且原生加载通过（最权威判据）。")

    report = {"task_toml": str(toml_path), "failures": fail, "warnings": warn,
              "notes": note,
              "harbor_native_load": ("pass" if real == [] else
                                     "fail" if real else "unavailable")}

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print("=" * 66)
        print(f"task.toml 契约预检：{toml_path}")
        print("=" * 66)
        for f in fail:
            print(f"  [FAIL] {f}")
        for w in warn:
            print(f"  [WARN] {w}")
        for n in note:
            print(f"  [note] {n}")
        if not fail and not warn:
            print("  [ OK ] 未发现问题。")
        print("-" * 66)
        print(f"  结论：{'硬失败' if fail else ('需人工确认' if warn else '通过')}"
              f"（原生加载={report['harbor_native_load']}）")

    if fail:
        return EXIT_FAIL
    if warn:
        return EXIT_MANUAL
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
