#!/usr/bin/env python3
"""nop_preflight.py —— 原生 NOP Trial 的环境预检门禁（零模型、零 Trial 成本）

来源：2026-10-08 auto2768 实战。此前包内把"手工 Docker 模拟"当作 NOP 提交，
被平台判为不能证明原生 Harbor NOP，触发 H06/QA17 不通过。修复过程中先后撞上
6 类环境前提失败（GPU 直通、snap Docker 只读命名空间、缺 buildx/compose、
宿主容量不足、构建超时、git 断流），全部可以在跑 Trial 之前用几条命令查出来。

本工具把那些前提固化成**一次性预检**，回答一个问题：
    **这台机器现在能不能跑通目标题包的原生 NOP Trial？**

它只做只读探测 + 可选的本机环境修正建议，不启动 Trial、不训练、不读取私有标签。

用法：
  # 本机预检（默认：题包在当前工作区，自动找 task.toml）
  python nop_preflight.py --task <harbor_task 目录>

  # 指定 DAEMON 与镜像
  python nop_preflight.py --task <dir> --docker-host unix:///run/docker.sock \\
      --cuda-image nvidia/cuda:11.8.0-cudnn8-devel-ubuntu20.04

  # 只查"声明容量 vs 宿主容量"的落差（不探测 Docker）
  python nop_preflight.py --task <dir> --capacity-only

输出：逐项 PASS/FAIL/WARN + 需要的修法；末尾给出总体结论与下一步。
退出码：0=全部前提就绪；1=存在硬前提不满足（不要启动 Trial）；2=探测不完整（需人工确认）。
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

PASS, FAIL, WARN, UNK = "PASS", "FAIL", "WARN", "UNKNOWN"

# 已知的 GPU 直通失败特征 -> 根因与修法
GPU_SIGNATURES = [
    (r"invoking the NVIDIA Container Runtime Hook directly is not supported",
     "snap 版 Docker 的 nvidia runtime 处于 CDI 模式，拒绝直接 hook 调用",
     "改用宿主命名空间的私有 dockerd（见下），或改用非 snap 的 docker-ce"),
    (r"read-only file system",
     "dockerd 的挂载命名空间内 /usr 只读 —— snap 版 Docker 的结构性限制，CDI 挂载必然失败",
     "起私有 dockerd（宿主命名空间）；这不是配置能修的"),
    (r"could not select device driver.*nvidia",
     "nvidia-container-toolkit 未安装或未注册 runtime",
     "装 nvidia-container-toolkit 并在 daemon.json 的 runtimes 里注册 nvidia"),
    (r"No such file or directory.*libnvidia-ml",
     "容器内找不到驱动库，runtime 未正确挂载",
     "确认 nvidia-container-cli 存在且 config.toml 中 ldconfig 路径正确"),
    (r"failed to create task for container.*nvidia",
     "runtime 调用链在容器创建阶段失败",
     "逐条核对：toolkit 安装 / runtime 注册 / CDI 或 legacy 模式"),
]


def run(cmd, timeout=60, env=None):
    """执行命令并返回 (rc, stdout, stderr)。绝不抛异常。"""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           shell=isinstance(cmd, str), env=env)
        return p.returncode, (p.stdout or ""), (p.stderr or "")
    except FileNotFoundError:
        return 127, "", "command not found"
    except subprocess.TimeoutExpired:
        return 124, "", f"timeout after {timeout}s"
    except Exception as exc:                                  # noqa: BLE001
        return 1, "", f"{type(exc).__name__}: {exc}"


def docker_env(host):
    env = dict(os.environ)
    if host:
        env["DOCKER_HOST"] = host
    return env


def read_task_decl(task_dir):
    """从 task.toml 读声明的 cpus / memory_mb / build_timeout_sec / gpus / network_mode。

    优先用 tomllib（Python 3.11+）；3.10 及以下退化为正则抽取，并在结果里标注
    parser 来源，避免"没解析到"被误读成"题面没声明"。
    """
    cfg = {"cpus": None, "memory_mb": None, "build_timeout_sec": None,
           "gpus": None, "gpu_types": None,
           "env_network": None, "verifier_mode": None, "artifacts": None,
           "schema_version": None, "_parser": None}
    toml_path = Path(task_dir) / "task.toml"
    if not toml_path.is_file():
        return None, f"task.toml 不存在: {toml_path}"
    text = toml_path.read_text(encoding="utf-8", errors="replace")
    data = None
    try:
        import tomllib
        try:
            data = tomllib.loads(text)
            cfg["_parser"] = "tomllib"
        except Exception as exc:                               # noqa: BLE001
            return None, f"task.toml 解析失败: {type(exc).__name__}: {exc}"
    except ImportError:
        cfg["_parser"] = "regex"

    if data is not None:
        env = data.get("environment") or {}
        ver = data.get("verifier") or {}
        cfg["cpus"] = env.get("cpus")
        cfg["memory_mb"] = env.get("memory_mb")
        cfg["build_timeout_sec"] = env.get("build_timeout_sec")
        cfg["gpus"] = env.get("gpus")
        cfg["gpu_types"] = env.get("gpu_types")
        cfg["env_network"] = env.get("network_mode")
        cfg["verifier_mode"] = ver.get("environment_mode")
        cfg["artifacts"] = data.get("artifacts")
        cfg["schema_version"] = data.get("schema_version")
    else:
        # 退化：正则抽取。仅用于预检提示，不作为 schema 判定依据。
        # 注意要按 section 定位，不能全局搜 —— [environment] 与 [verifier] 都有 network_mode。
        for key, pat in (("cpus", r"^\s*cpus\s*=\s*(\d+)"),
                         ("memory_mb", r"^\s*memory_mb\s*=\s*(\d+)"),
                         ("build_timeout_sec", r"^\s*build_timeout_sec\s*=\s*(\d+)"),
                         ("gpus", r"^\s*gpus\s*=\s*(\d+)")):
            m = re.search(pat, text, re.M)
            if m:
                cfg[key] = int(m.group(1))
        m = re.search(r"^\s*schema_version\s*=\s*[\"']([^\"']+)[\"']", text, re.M)
        if m:
            cfg["schema_version"] = m.group(1)
        m = re.search(r"^\s*environment_mode\s*=\s*[\"']([^\"']+)[\"']", text, re.M)
        if m:
            cfg["verifier_mode"] = m.group(1)
        m = re.search(r"^\s*artifacts\s*=\s*(\[[^\]]*\])", text, re.M)
        if m:
            cfg["artifacts"] = m.group(1)
    return cfg, None


def check_host_capacity(cfg):
    rows = []
    # CPU
    cpus = os.cpu_count()
    need = cfg.get("cpus")
    if need and cpus and cpus < need:
        rows.append((FAIL, "宿主 CPU", f"题面声明 cpus={need}，宿主仅 {cpus}",
                     "按声明设限会触发 Compose 的 CPU 范围错误；"
                     "SOP 做法：trial 层设 cpu_enforcement_policy=ignore 并如实记录差异"))
    else:
        rows.append((PASS, "宿主 CPU", f"声明 {need} / 宿主 {cpus}", ""))
    # 内存
    need_mb = cfg.get("memory_mb")
    host_mb = None
    try:
        if sys.platform.startswith("linux"):
            with open("/proc/meminfo") as fh:
                for line in fh:
                    if line.startswith("MemTotal:"):
                        host_mb = int(line.split()[1]) // 1024
                        break
    except Exception:                                          # noqa: BLE001
        pass
    if host_mb is None:
        rows.append((UNK, "宿主内存", "无法在本平台读取", "人工核对 free -m / 任务管理器"))
    elif need_mb and host_mb < need_mb:
        rows.append((FAIL, "宿主内存", f"题面声明 memory_mb={need_mb}，宿主约 {host_mb}",
                     "同上：trial 层设 memory_enforcement_policy=ignore 并记录差异"))
    else:
        rows.append((PASS, "宿主内存", f"声明 {need_mb} / 宿主约 {host_mb}", ""))
    return rows


def check_docker(host, cuda_image, check_gpu=True):
    rows = []
    env = docker_env(host)
    tag = f" (DOCKER_HOST={host})" if host else ""

    rc, out, err = run(["docker", "version", "--format", "{{.Server.Version}}"], env=env)
    if rc != 0:
        rows.append((FAIL, f"docker daemon{tag}", (err or out).strip()[:160],
                     "确认 daemon 在运行、当前用户有权限；指定 --docker-host 指向私有 socket"))
        return rows
    rows.append((PASS, f"docker daemon{tag}", f"server {out.strip()}", ""))

    # runtime 注册
    rc, out, err = run(["docker", "info", "--format", "{{json .Runtimes}}"], env=env)
    if rc == 0:
        try:
            rts = json.loads(out.strip())
        except Exception:                                      # noqa: BLE001
            rts = {}
        if "nvidia" in rts:
            rows.append((PASS, "nvidia runtime 已注册", f"path={rts['nvidia'].get('path')}", ""))
        else:
            rows.append((FAIL, "nvidia runtime 未注册", f"现有: {sorted(rts)}",
                         "装 nvidia-container-toolkit，并在 daemon.json 的 runtimes 注册 nvidia"))
    else:
        rows.append((UNK, "runtime 探测", (err or out).strip()[:120], "人工核对 docker info"))

    # buildx
    rc, out, err = run(["docker", "buildx", "version"], env=env)
    if rc == 0:
        rows.append((PASS, "buildx", out.strip()[:90], ""))
    else:
        rows.append((FAIL, "buildx 缺失", "Harbor 的侧车/镜像构建调用 docker buildx build",
                     "把 buildx 装到 ~/.docker/cli-plugins/docker-buildx"))
    # compose v2
    rc, out, err = run(["docker", "compose", "version"], env=env)
    if rc == 0:
        rows.append((PASS, "compose v2", out.strip()[:90], ""))
    else:
        rows.append((FAIL, "compose v2 缺失",
                     "docker: 'compose' is not a docker command",
                     "把 compose v2 装到 ~/.docker/cli-plugins/docker-compose"))

    if not check_gpu:
        return rows
    if not cuda_image:
        rows.append((UNK, "GPU 直通实测", "未提供 --cuda-image，跳过实测",
                     "强烈建议实测：docker run --rm --gpus all <cuda-img> nvidia-smi -L"))
        return rows

    rc, out, err = run(["docker", "run", "--rm", "--gpus", "all", cuda_image,
                        "nvidia-smi", "-L"], timeout=300, env=env)
    blob = (out or "") + (err or "")
    if rc == 0 and "GPU" in blob:
        rows.append((PASS, "GPU 直通实测", blob.strip().splitlines()[0][:110], ""))
        return rows

    cause, fix = None, None
    for pat, c, f in GPU_SIGNATURES:
        if re.search(pat, blob, re.I):
            cause, fix = c, f
            break
    detail = (cause or blob.strip()[:160] or f"rc={rc}")
    rows.append((FAIL, "GPU 直通实测", detail,
                 fix or "按报错逐条核对；snap 版 Docker 需改用宿主命名空间的私有 dockerd"))
    return rows


def print_rows(rows):
    marks = {PASS: "  OK ", FAIL: "  !! ", WARN: "  ~  ", UNK: "  ?  "}
    for status, name, detail, fix in rows:
        print(f"{marks.get(status, '  ?  ')} {name}: {detail}")
        if fix and status in (FAIL, WARN, UNK):
            print(f"       -> {fix}")


def main():
    ap = argparse.ArgumentParser(description="原生 NOP Trial 环境预检（只读，不启动 Trial）")
    ap.add_argument("--task", required=True, help="harbor_task 目录（含 task.toml）")
    ap.add_argument("--docker-host", default=os.environ.get("DOCKER_HOST"),
                    help="DOCKER_HOST；指定私有 dockerd 的 unix socket")
    ap.add_argument("--cuda-image", default="nvidia/cuda:11.8.0-cudnn8-devel-ubuntu20.04",
                    help="用于实测 GPU 直通的镜像（本地已有才不拉取）")
    ap.add_argument("--capacity-only", action="store_true", help="只对比声明容量与宿主容量")
    ap.add_argument("--no-gpu", action="store_true", help="跳过 GPU 实测")
    args = ap.parse_args()

    task_dir = Path(args.task).expanduser().resolve()
    print("=" * 74)
    print("原生 NOP Trial 环境预检（只读；不启动 Trial、不训练、不读私有标签）")
    print(f"题包: {task_dir}")
    print("=" * 74)

    cfg, err = read_task_decl(task_dir)
    if err:
        print(f"  声明读取失败: {err}")
        return 2

    print("\n-- 题面声明的运行前提 --")
    print(f"     (声明解析器: {cfg.get('_parser')})")
    for k in ("schema_version", "gpus", "gpu_types", "cpus", "memory_mb",
              "build_timeout_sec", "env_network", "verifier_mode", "artifacts"):
        print(f"     {k:18} = {cfg.get(k)!r}")
    if cfg.get("_parser") == "regex":
        print("     注意: 当前 Python 无 tomllib（需 3.11+），以上为**正则近似**。")
        print("           预检提示可用；若要严格判定 schema，请用 Python 3.11+ 或安装 tomli。")

    # 硬前提：separate verifier
    hard = []
    if cfg.get("verifier_mode") != "separate":
        detail = (f"当前 {cfg.get('verifier_mode')!r}，原生 NOP 要求 separate"
                  if cfg.get("verifier_mode")
                  else "未从 task.toml 读到 environment_mode（若为 3.11+ 解析则确属缺失）")
        hard.append((FAIL, "[verifier] environment_mode", detail,
                     "在 task.toml 显式设置 [verifier] environment_mode = \"separate\""))

    print("\n-- 宿主容量 vs 声明 --")
    cap_rows = check_host_capacity(cfg)
    print_rows(cap_rows)

    if args.capacity_only:
        rows = hard + cap_rows
    else:
        print("\n-- Docker 环境前提 --")
        dk_rows = check_docker(args.docker_host, args.cuda_image,
                               check_gpu=not args.no_gpu)
        print_rows(dk_rows)
        rows = hard + cap_rows + dk_rows

    fails = [r for r in rows if r[0] == FAIL]
    unks = [r for r in rows if r[0] == UNK]

    print("\n" + "=" * 74)
    if fails:
        print(f"结论：存在 {len(fails)} 项硬前提不满足 —— **不要启动 Trial**，先修环境。")
        for _, n, d, f in fails:
            print(f"   · {n}: {d}")
            if f:
                print(f"     修法: {f}")
        print("\n备注：这些检查全部只读，本身不产生任何 Trial 成本。")
        return 1
    if unks:
        print(f"结论：无硬前提失败，但有 {len(unks)} 项无法确认 —— 需人工核对后再启动。")
        return 2
    print("结论：环境前提就绪。可启动原生 NOP Trial。")
    print("\n启动后必须核对（L11 通过判据）：")
    print("   finished_at 有值 / exception_info 为空 / verifier_environment_mode=separate")
    print("   rewards 为有限数值且与 reward.txt|json 一致 / 同次 Trial 的 config+日志+artifacts 齐备")
    print("   运行绑定的题包哈希清单与交付 zip 逐文件一致（L13 交叉验证）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
