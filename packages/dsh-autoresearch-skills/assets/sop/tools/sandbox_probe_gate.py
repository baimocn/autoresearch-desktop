#!/usr/bin/env python3
"""sandbox_probe_gate.py —— 隔离沙盒的实测自检门禁（只读探测；不改被判对象）

来源：2026-10-09 AutoRe0823 实战（见 references/sandbox-isolation.md）。
那次实现沙盒时连续撞上 11 类问题（BPF 偏移、clone3 必须 ENOSYS、clone 掩码含退出
信号位、RLIMIT_NPROC 跨容器共享 UID、site-packages 嵌在 stdlib 内、`-I` 忽略
PYTHONHOME……）。本文档把这些坑固化成**可执行探测**，回答一个问题：
    **这个沙盒现在真的隔离住了吗？**

它做两件事：
  A. 静态自检：对沙盒实现源码做可断言的判据（掩码低 8 位、自检是否用 PYTHONHOME 模拟等）
  B. 运行时探测：若给出 chroot 根目录，跑一次真实探针并逐项核对

用法：
  # 只做静态自检（不需要 chroot 权限）
  python sandbox_probe_gate.py --source <sandbox_readout.py>

  # 静态 + 运行时探测（需 root；根目录须已由构建脚本生成）
  python sandbox_probe_gate.py --source <sandbox_readout.py> --root /opt/readout_root

输出：逐项 PASS/FAIL/MANUAL + 修法。

退出码：0=全部通过；1=硬失败（隔离可能不成立）；2=需人工确认（缺环境，无法运行时验证）

实测（2026-10-09，四例）：
  · 真实沙盒实现               → PASS(0)，8/8 项通过
  · 掩码改回历史 bug 0x7E020080 → FAIL(1)，命中"clone 掩码低 8 位"
  · 删掉 clone3 的 ENOSYS 代码行 → FAIL(1)，命中"clone3 返回 ENOSYS"
  · 自检改用 PYTHONHOME         → FAIL(1)，同时命中"环境变量模拟"与"缺 LD_LIBRARY_PATH"
  ⚠ 第 3 例最初**漏判为 PASS**：正则匹配到了注释里的 "ENOSYS" 字样。
    已改为只看代码行（排除注释）后重测才 FAIL —— 这正是"门禁必须用破坏副本自证"的由来。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

EXIT_OK, EXIT_FAIL, EXIT_MANUAL = 0, 1, 2


class Report:
    def __init__(self) -> None:
        self.rows: list[tuple[str, str, str]] = []
        self.hard = self.manual = self.passed = 0

    def add(self, level: str, item: str, detail: str = "") -> None:
        self.rows.append((level, item, detail))
        if level == "FAIL":
            self.hard += 1
        elif level == "MANUAL":
            self.manual += 1
        else:
            self.passed += 1

    def emit(self) -> int:
        print("=" * 76)
        for level, item, detail in self.rows:
            mark = {"PASS": "✓", "FAIL": "✗", "MANUAL": "?"}.get(level, " ")
            print(f" {mark} [{level:6s}] {item}")
            for line in (detail or "").splitlines():
                print(f"            {line}")
        print("=" * 76)
        if self.hard:
            print(f"结论：不通过（{self.hard} 项硬失败 / {self.passed} 通过）"
                  "—— 隔离可能不成立，修好后重跑。")
            return EXIT_FAIL
        if self.manual:
            print(f"结论：需人工确认（{self.manual} 项无法静态判定 / {self.passed} 通过）"
                  "—— 请在目标环境补运行时探测。")
            return EXIT_MANUAL
        print(f"结论：通过（{self.passed} 项）。注意：本门禁只证明已实测项，"
              "不证明'不可能逃逸'。")
        return EXIT_OK


# --------------------------------------------------------------------------- #
# A. 静态判据
# --------------------------------------------------------------------------- #
def static_checks(src: Path, rep: Report) -> None:
    if not src.is_file():
        rep.add("MANUAL", "沙盒实现源码", f"{src} 不存在，跳过静态判据。")
        return
    text = src.read_text(encoding="utf-8", errors="replace")

    # A1: clone 掩码不得含低 8 位（退出信号位）
    m = re.search(r"_CLONE_NEW_MASK\s*=\s*(0x[0-9A-Fa-f]+)", text)
    if m:
        mask = int(m.group(1), 16)
        if mask & 0xFF:
            rep.add("FAIL", "clone 掩码低 8 位",
                    f"掩码 {m.group(1)} 含位 {mask & 0xFF:#x}；低 8 位是退出信号，"
                    "普通线程创建会被误判越权（实测症状：pthread_create EPERM）。\n"
                    "修法：掩码只保留 CLONE_NEW*（bit17、25–30）与 CLONE_IO（bit31），"
                    "例如 0xFE020000。")
        else:
            rep.add("PASS", "clone 掩码低 8 位", f"掩码 {m.group(1)}，低 8 位为 0。")
    else:
        rep.add("MANUAL", "clone 掩码", "未找到 _CLONE_NEW_MASK 常量，无法静态判定。")

    # A2: clone3 必须回 ENOSYS
    # 注意：只能看**代码行**。注释里出现 "clone3 必须回 ENOSYS" 这类说明会让朴素正则误判为 PASS
    # （实测踩过：把 ENOSYS 那行代码删掉后，门禁仍报 PASS，因为它匹配到了注释）。
    code_lines = [ln for ln in text.splitlines()
                  if "ENOSYS" in ln and not ln.lstrip().startswith("#")]
    has_clone3 = bool(re.search(r"clone3", text, re.I))
    enosys_in_code = any(
        ("errno.ENOSYS" in ln or "ENOSYS" in ln)
        and any(tok in ln for tok in ("_RET_K", "RET_ERRNO", "SECCOMP", "append", "return"))
        for ln in code_lines)
    if has_clone3 and enosys_in_code:
        rep.add("PASS", "clone3 返回 ENOSYS", f"代码行中检出 ENOSYS：{code_lines[0].strip()[:70]}")
    elif has_clone3:
        rep.add("FAIL", "clone3 返回 ENOSYS",
                "检出 clone3 但在**代码行**中未见 ENOSYS（注释里的字样不算）。"
                "glibc 只认 ENOSYS 才回落 clone，回 EPERM 会让 pthread_create 直接失败。\n"
                "修法：clone3 单独一条规则返回 ENOSYS，例如 "
                "`program.append(_stmt(_BPF_RET_K, _SECCOMP_RET_ERRNO | errno.ENOSYS))`")
    else:
        rep.add("MANUAL", "clone3", "未检出 clone3 处理，需人工确认内核/glibc 组合。")

    # A3: 自检不得用 PYTHONHOME 模拟
    if "PYTHONHOME" in text:
        rep.add("FAIL", "自检未用环境变量模拟",
                "出现 PYTHONHOME。`-I` 会忽略所有 PYTHON* 变量，用它模拟会探到宿主路径"
                "（实测症状：误报'根内含 torch'）。修法：改用真 chroot 探针。")
    else:
        rep.add("PASS", "自检未用环境变量模拟", "未使用 PYTHONHOME。")

    # A4: 库搜索路径必须显式给出（无 /proc 的 chroot 里 $ORIGIN 解析失败）
    if "LD_LIBRARY_PATH" in text:
        rep.add("PASS", "显式库搜索路径",
                "检出 LD_LIBRARY_PATH：无 /proc 的 chroot 里 $ORIGIN 无法解析，"
                "必须显式给出。")
    else:
        rep.add("FAIL", "显式库搜索路径",
                "未检出 LD_LIBRARY_PATH。chroot 后解释器会因找不到 libpython*.so 启动失败。")

    # A5: 进程组清场
    if "setsid" in text and "killpg" in text:
        rep.add("PASS", "进程组清场", "检出 setsid + killpg：超时/退出都清一次残留。")
    elif "killpg" in text or "setsid" in text:
        rep.add("FAIL", "进程组清场",
                "setsid 与 killpg 未同时出现。普通 fork 是放行的，无进程组清场会留残留子进程。")
    else:
        rep.add("MANUAL", "进程组清场", "未检出 setsid/killpg，需确认残留进程处理方式。")

    # A6: 沙盒不可用必须显式抛出（不得回落宿主）
    if re.search(r"class\s+SandboxUnavailable", text):
        rep.add("PASS", "不可用即阻断",
                "检出 SandboxUnavailable：沙盒建不起来时抛专门异常，"
                "调用方可判为基础设施故障而非候选失败。")
    else:
        rep.add("FAIL", "不可用即阻断",
                "未检出 SandboxUnavailable 类。缺它容易演变成'沙盒失败就宿主跑'，"
                "隔离形同虚设。")

    # A7: BLAS 线程数显式压低
    if re.search(r"OPENBLAS_NUM_THREADS|OMP_NUM_THREADS", text):
        rep.add("PASS", "BLAS 线程数受限", "显式设置线程上限，避免撞 RLIMIT_NPROC。")
    else:
        rep.add("MANUAL", "BLAS 线程数",
                "未显式设置。默认按 CPU 数开线程，在受限 UID 下易触发 pthread_create 失败。")

    # A8: 探针须检查 ctypes 返回 -1（不是只 catch OSError）
    if re.search(r"ctypes", text) and re.search(r"get_errno\(\)", text):
        rep.add("PASS", "ctypes 返回值检查", "检出 get_errno()：libc 返回 -1 不抛异常，须显式检查。")
    elif "ctypes" in text:
        rep.add("FAIL", "ctypes 返回值检查",
                "用了 ctypes 但未见 get_errno()。只 catch OSError 会把被拒的调用误报成 ALLOWED。")
    else:
        rep.add("PASS", "ctypes 返回值检查", "未使用 ctypes，不适用。")


# --------------------------------------------------------------------------- #
# B. 运行时探测
# --------------------------------------------------------------------------- #
PROBE = r'''
import ctypes, json, os, socket, sys
libc = ctypes.CDLL("libc.so.6", use_errno=True)
def p(call):
    try:
        r = call()
    except OSError as e:
        return f"blocked({e.errno})"
    if isinstance(r, int) and r == -1:
        return f"blocked({ctypes.get_errno()})"
    return f"ALLOWED(rc={r!r})"
out = {"uid": os.getuid()}
out["socket"]       = p(socket.socket)
out["unshare"]      = p(lambda: libc.unshare(0x10000000))
out["setns"]        = p(lambda: libc.setns(-1, 0))
out["mount"]        = p(lambda: libc.mount(0, 0, 0, 0, 0))
out["ptrace"]       = p(lambda: libc.ptrace(0, 0, 0, 0))
try:
    out["memfd_create"] = p(lambda: os.memfd_create("probe"))
except AttributeError:
    out["memfd_create"] = "n/a"
out["tests_private_visible"] = os.path.exists("/tests/private")
out["proc_visible"]          = os.path.exists("/proc/self/status")
try:
    import threading
    box = []
    t = threading.Thread(target=lambda: box.append(1)); t.start(); t.join()
    out["thread"] = "ok" if box else "no-run"
except Exception as e:
    out["thread"] = f"{type(e).__name__}:{e}"
try:
    import numpy
    out["numpy"] = numpy.__version__
except Exception as e:
    out["numpy"] = f"{type(e).__name__}"
try:
    open("/output/.probe", "w").write("x"); os.unlink("/output/.probe")
    out["output_writable"] = True
except Exception as e:
    out["output_writable"] = f"{type(e).__name__}:{e}"
print("PROBE" + json.dumps(out, sort_keys=True))
'''


def runtime_checks(root: Path, rep: Report) -> None:
    if os.geteuid() != 0:
        rep.add("MANUAL", "运行时探测", f"需要 root 才能 chroot（当前 euid={os.geteuid()}）。")
        return
    if not root.is_dir():
        rep.add("MANUAL", "运行时探测", f"根目录 {root} 不存在（先跑构建脚本）。")
        return
    interpreter = None
    for cand in ("/usr/local/bin/python3", "/usr/bin/python3"):
        if (root / cand.lstrip("/")).exists():
            interpreter = cand
            break
    if not interpreter:
        rep.add("FAIL", "运行时探测", f"根 {root} 内找不到解释器。")
        return

    probe_file = root / ".probe_sandbox.py"
    try:
        probe_file.write_text(PROBE, encoding="utf-8")
        env = {**os.environ, "LD_LIBRARY_PATH": "/usr/local/lib:/lib:/lib64:/usr/lib"}
        proc = subprocess.run(["chroot", str(root), interpreter, "-I", "-c", PROBE],
                              capture_output=True, text=True, timeout=120, env=env)
    except (OSError, subprocess.SubprocessError) as exc:
        rep.add("MANUAL", "运行时探测", f"无法执行 chroot 探针：{type(exc).__name__}: {exc}")
        return
    finally:
        try:
            probe_file.unlink()
        except OSError:
            pass

    line = next((l for l in proc.stdout.splitlines() if l.startswith("PROBE")), None)
    if not line:
        rep.add("FAIL", "运行时探测",
                f"探针无输出（rc={proc.returncode}）。\n"
                f"stdout={proc.stdout[-300:]!r}\nstderr={proc.stderr[-300:]!r}")
        return
    data = json.loads(line[5:])

    expect_blocked = ("socket", "unshare", "setns", "mount", "ptrace")
    bad = [k for k in expect_blocked if not str(data.get(k, "")).startswith("blocked")]
    if bad:
        rep.add("FAIL", "运行时·系统调用被拒",
                "以下应为 blocked 实际不是：" + ", ".join(f"{k}={data.get(k)}" for k in bad))
    else:
        rep.add("PASS", "运行时·系统调用被拒",
                "、".join(f"{k}={data[k]}" for k in expect_blocked))

    if data.get("uid") == 0:
        rep.add("FAIL", "运行时·降权", "uid=0，仍在 root 下运行。")
    else:
        rep.add("PASS", "运行时·降权", f"uid={data.get('uid')}")

    leak = [k for k in ("tests_private_visible", "proc_visible") if data.get(k)]
    if leak:
        rep.add("FAIL", "运行时·沙盒外不可见", f"以下应为 False 实际可见：{leak}")
    else:
        rep.add("PASS", "运行时·沙盒外不可见", "/tests/private 与 /proc 均不可见。")

    if data.get("thread") == "ok":
        rep.add("PASS", "运行时·线程可用", "threading 正常（BLAS 与 Python 都要起线程）。")
    else:
        rep.add("FAIL", "运行时·线程可用",
                f"thread={data.get('thread')}；检查 clone3 是否回 ENOSYS、"
                "clone 掩码是否含低 8 位、RLIMIT_NPROC 是否过小。")

    if str(data.get("numpy", "")).startswith(("1.", "2.")):
        rep.add("PASS", "运行时·库可用", f"numpy={data['numpy']}")
    else:
        rep.add("MANUAL", "运行时·库可用", f"numpy={data.get('numpy')}（可能未纳入，或导入失败）")

    if data.get("output_writable") is True:
        rep.add("PASS", "运行时·输出可写", "/output 以目标 uid 可写。")
    else:
        rep.add("FAIL", "运行时·输出可写",
                f"output_writable={data.get('output_writable')}；"
                "候选写不出结果会被误判成'没写结果'。")


def main() -> int:
    ap = argparse.ArgumentParser(
        description="隔离沙盒实测自检（只读；来源：AutoRe0823 沙盒实现 11 类实测坑）")
    ap.add_argument("--source", type=Path, help="沙盒实现源码（静态判据）")
    ap.add_argument("--root", type=Path, help="chroot 运行时根（运行时探测，需 root）")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    args = ap.parse_args()
    if not args.source and not args.root:
        ap.error("至少给一个 --source 或 --root")

    rep = Report()
    if args.source:
        static_checks(args.source, rep)
    if args.root:
        runtime_checks(args.root, rep)
    code = rep.emit()
    if args.json:
        print(json.dumps({"exit": code,
                          "rows": [{"level": l, "item": i, "detail": d} for l, i, d in rep.rows]},
                         ensure_ascii=False))
    return code


if __name__ == "__main__":
    sys.exit(main())
