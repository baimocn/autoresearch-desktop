# 隔离执行沙盒：实现判据与实测坑（2026-10-09 AutoRe0823 实录）

> 适用场景：Verifier 需要执行**候选提交的代码**（自定义读出、自定义评分片段、任意脚本），
> 且必须保证它读不到私有标签、连不了网、逃不出容器。
>
> 本题把它做成了 chroot + seccomp-BPF + 降权 + rlimit 的独立运行时根。
> 本文只记**可复用的判据与实测坑**，不含本题的数据、分数或私有材料。
> 全部数字来自 2026-10-09 那次实现，逐条实测，非推测。

---

## 一、先定架构：五条判据

做之前先把这五件事定死，否则后面每个坑都会重新冒出来。

| # | 判据 | 理由 |
|---|---|---|
| 1 | **运行时根必须与宿主/镜像解耦** | 候选代码不得看到 `/tests`、`/proc`、宿主工具链、其他题的材料 |
| 2 | **沙盒建不起来 ⇒ 判"基础设施故障"，不判候选失败** | 否则环境问题会被记成候选 0 分（第 一 类错误） |
| 3 | **绝不回落宿主执行** | "沙盒失败就本地跑一下"会让所有隔离形同虚设 |
| 4 | **镜像构建期做前置自检，不通过就让构建失败** | 把"缺沙盒"变成构建期错误，而不是运行期惊喜 |
| 5 | **契约里显式声明沙盒接口**（argv、输入路径、输出路径、限额） | 候选才能合规实现；否则它只能猜接口 |

### 判据 4 的具体形态（fail-closed 构建）

在 Dockerfile 里构建运行时根，并让它**自己检查自己**：

```dockerfile
RUN python /tests/build_readout_root.py /opt/readout_root \
 && python -c "import json;m=json.load(open('/opt/readout_root/.readout_root.json'));print(m)" \
 && rm -f /tests/build_readout_root.py
```

构建脚本内部做三项断言，任一不满足即 `raise SystemExit`：

1. 根内**不含**重型框架（本题是 torch）——它在 stdlib 内部时最容易漏进来（见 §二坑 4）
2. 根内**看不到** `/tests` 与 `/proc`
3. **真 chroot 探针**能导入目标库并打印版本（不是靠 `PYTHONHOME` 模拟）

---

## 二、实测坑（11 条，症状照抄）

按"症状 → 根因 → 修法"排列。序号沿用发现顺序，便于对照调试记录。

### 坑 1：chroot 后解释器起不来

**症状**

```
/usr/local/bin/python3: error while loading shared libraries:
libpython3.11.so.1.0: cannot open shared object file: No such file or directory
```

**根因**：解释器的 `DT_NEEDED` 通过 `$ORIGIN/../lib` 这类相对路径解析，
而**没有 `/proc` 的 chroot 里 `$ORIGIN` 无法解析**（glibc 靠 `/proc/self/exe` 求 `$ORIGIN`）。
文件其实都在根里，只是找不到。

**修法**：子进程环境显式给出库搜索路径（指向根内目录）：

```python
env = {"PATH": "/usr/bin:/bin", "HOME": "/output", "LC_ALL": "C.UTF-8",
       "LD_LIBRARY_PATH": "/usr/local/lib:/lib:/lib64:/usr/lib", ...}
os.execve(python, argv, env)
```

**判据**：chroot 内 `python -I -c "import numpy"` 能打印版本号即通过。

### 坑 2：BPF 跳转偏移少算 1 → 全系统调用被拒

**症状**：探针脚本在 chroot 里 **SIGSEGV（exit 139）且什么都不打印** —— 连 `print()` 第一行都没出。

**根因**：seccomp-BPF 的 `jt/jf` 偏移按"**跳转指令之后**"开始计数。
我把"跳过 N 条"写成了 `jf=N-1`，结果**所有系统调用**都落到 `RET_ERRNO|EPERM`，
解释器启动阶段就被拒（open/mmap 全失败）。

**修法**：把跳转数写对，并在**装过滤器之前**先打印一行（确认解释器已起来）：

```python
# 非 clone 的分支需要跳过 4 条：LD_W / AND / JEQ / RET-errno
program.append(_jump(_BPF_JMP_JEQ_K, clone_nr, 0, 4))
```

**判据**：装完过滤器后立刻跑一次 `os.getpid()` 与 `print`，两者都成功才算偏移正确。
**别用 SIGSEGV 反推** —— 定位成本远高于加这一行探针。

### 坑 3：`clone3` 必须回 ENOSYS，不能回 EPERM

**症状**

```
OpenBLAS blas_thread_init: pthread_create failed for thread 1 of 4: Operation not permitted
OpenBLAS blas_thread_init: RLIMIT_NPROC 1024 current, 1024 max
```

（注意：报的是 `RLIMIT_NPROC`，但**真正原因不是 rlimit** —— 这是最容易带偏排查方向的一点。）

**根因**：glibc 创建线程时先试 `clone3`；**只认 `ENOSYS` 才回落到 `clone`**。
我把 `clone3` 放进了"统一回 EPERM"的黑名单，glibc 拿到 EPERM 后直接 `abort`/失败。

**修法**：`clone3` 单独一条规则，返回 **ENOSYS**：

```python
program.append(_jump(_BPF_JMP_JEQ_K, clone3_nr, 0, 1))
program.append(_stmt(_BPF_RET_K, _SECCOMP_RET_ERRNO | errno.ENOSYS))
```

**判据**：`python -c "import threading; threading.Thread(target=lambda:None).start()"` 成功。

### 坑 4：`clone` 掩码不能含低 8 位（退出信号位）

**症状**：修好 `clone3` 后**仍然** `pthread_create failed ... Operation not permitted`。

**根因**：我给 `clone` 做了"带 `CLONE_NEW*` 就拒"的掩码，掩码写成 `0x7E020080` ——
其中 **bit 7 是"退出信号"字节**（`CSIGNAL`），普通线程创建也会带上，
于是**每次线程创建都被判成命名空间越权**。

**修法**：掩码只保留真正的命名空间位与 `CLONE_IO`：

```python
_CLONE_NEW_MASK = 0xFE020000   # CLONE_NEW*（bit 17、25–30）| CLONE_IO（bit 31）
```

**判据**：掩码 & `0xFF` 必须为 0。**这条可以用静态断言写进代码**：

```python
assert _CLONE_NEW_MASK & 0xFF == 0, "clone 掩码不得包含退出信号位"
```

### 坑 5：`RLIMIT_NPROC` 按真实 UID 在内核级计数

**症状**：同上那行 `RLIMIT_NPROC 1024 current, 1024 max` 即使把上限调到 1024 仍失败。

**根因**：`RLIMIT_NPROC` 统计的是**该真实 UID 在整个内核上的进程/线程数**，
而 `65534`（nobody）被同宿主上**其他容器/服务共享**。
给小值会误杀本沙盒的 BLAS 线程。

**修法**：上限放宽（本题用 1024），并**显式压低 BLAS 线程数**；
真正的资源约束交给 CPU / 地址空间 / 墙钟超时：

```python
env.update({"OMP_NUM_THREADS": "4", "OPENBLAS_NUM_THREADS": "4",
            "MKL_NUM_THREADS": "4", "NUMEXPR_NUM_THREADS": "4"})
resource.setrlimit(resource.RLIMIT_NPROC, (1024, 1024))
```

**判据**：**不要**用 `RLIMIT_NPROC` 做"防 fork 炸弹"的主要手段（它按 UID 共享计数、不可靠）；
用 CPU 时间 + 地址空间 + 墙钟超时三者组合。

### 坑 6：`/output` 权限导致候选"写不出结果"

**症状**：`readout produced no pred.npy (exit 99); stdout=''`

**根因**：沙盒内候选以 `uid 65534` 运行，而我用 root 建的 `/output` 是 `0700`，
候选**没有写权限** —— 于是被误判成"候选没写结果"。

**修法**：输入只读、输出可写，权限显式设定：

```python
os.chmod(inp, 0o755)            # /input 可读可进入
for f in inp.glob("*.npy"): os.chmod(f, 0o444)   # 输入文件只读
os.chmod(out, 0o777)            # /output 可写
```

**判据**：**判据只能落在"它写了什么"，不能落在"它有没有权限写"**。
沙盒自检里加一条"以目标 uid 往 `/output` 写一个字节并读回"。

### 坑 7：stdlib 的 `site-packages` 在内部 → 重型框架泄进沙盒

**症状**：构建期自检报"根内含 torch"（本题禁止沙盒里有 torch）。

**根因**：官方 `python:3.11-slim` 镜像里 `site-packages` **位于 stdlib 目录内部**
（`/usr/local/lib/python3.11/site-packages`），整树复制 stdlib 就把 torch 一起带进去了。

**修法**：复制 stdlib 时**排除** `site-packages`/`dist-packages`，再按白名单单独放需要的库：

```python
STDLIB_SKIP = SKIP_DIRS | {"site-packages", "dist-packages"}
KEEP_SITE_PREFIXES = ("numpy",)     # 白名单，只放沙盒要用的
```

**判据**：构建脚本自检 `importlib.util.find_spec("torch") is None`，非空即让构建失败。

### 坑 8：自检用 `-I` 会忽略 `PYTHONHOME` → 误判

**症状**：自检报"根内有 torch"，但我明明已排除；实际探到的是**镜像自己的** `site-packages`。

**根因**：自检当时用 `PYTHONHOME=<root>` + 镜像解释器来"模拟"，而 **`-I` 会忽略所有 `PYTHON*` 环境变量**
（隔离模式的定义）⇒ `PYTHONHOME` 没生效，探的是宿主路径。

**修法**：自检改成**真 chroot 探针**，不要用环境变量模拟：

```python
subprocess.run(["chroot", str(root), "/usr/local/bin/python3", "-I", "-c", probe],
               env={**os.environ, "LD_LIBRARY_PATH": "/usr/local/lib:/lib:/lib64:/usr/lib"})
```

**判据**：自检脚本里**禁止**出现 `PYTHONHOME`；出现即为错误模拟。

### 坑 9：运行时根必须保持与源镜像相同的前缀布局

**症状**：早期把解释器复制到 `<root>/usr/bin/python3`，stdlib 在别处 → chroot 后找不到 stdlib。

**根因**：CPython 从**解释器的编译期前缀**推导 `sys.prefix`，
把解释器搬离原路径会破坏这个推导。

**修法**：保持原前缀布局（`/usr/local/bin/python3.11` 就放回同位置），
只补 `/usr/bin/python3`、`/bin/python3` 作为别名符号链接 —— 且**别名不能指向自己**：

```python
aliases = {Path("/usr/local/bin/python3"), Path("/usr/bin/python3"), Path("/bin/python3")}
for alias in sorted(aliases):
    if str(alias) != str(interpreter):      # ← 漏了这行会把解释器变成指向自己的坏链接
        _make_symlink(str(alias), str(interpreter), root)
```

**实测**：漏掉这个判断后，`ls -la` 显示 `python3.11 -> /usr/local/bin/python3.11`（自指），
chroot 报 `failed to run command '/usr/local/bin/python3': No such file or directory`。

### 坑 10：子进程残留（候选可以 fork）

**症状**：沙盒主进程正常退出，但仍有子进程在写文件 / 占资源。

**根因**：seccomp 只拦了"带 `CLONE_NEW*` 的 clone"，**普通 `fork` 是放行的**（有意为之：
Python 与 BLAS 需要线程）。于是候选能留下后台子进程。

**修法**：`setsid()` 建独立进程组，**超时与正常退出都按进程组清场**：

```python
os.setsid()                       # 子进程：独立进程组
...
_kill_group(pid)                  # 父进程：无论超时还是正常退出都清一次
def _kill_group(pid):
    try: os.killpg(pid, signal.SIGKILL)
    except OSError:
        try: os.kill(pid, signal.SIGKILL)
        except OSError: pass
```

### 坑 11：探针用 `ctypes` 调 libc 不抛异常 → 误判"ALLOWED"

**症状**：隔离探针把 `mount` / `ptrace` 报告成 `ALLOWED`，看起来像"seccomp 没生效"。

**根因**：`ctypes` 调 libc 返回 **-1 并设置 errno**，**不抛 `OSError`**。
探针里写 `try: libc.mount(...) except OSError: blocked` ⇒ 永远走不到 except。

**修法**：显式检查返回值：

```python
def probe(call):
    try: result = call()
    except OSError as exc: return f"blocked({exc.errno})"
    if isinstance(result, int) and result == -1:
        return f"blocked({ctypes.get_errno()})"     # ← 关键
    return f"ALLOWED(rc={result!r})"
```

**判据**：任何用 `ctypes` 写的隔离探针，都必须同时检查"异常"与"返回 -1"两条路径。

---

## 二点五、写这类门禁工具本身的两个坑（实测踩到）

### 坑 A：正则匹配到注释 → 门禁变成"假通过"

**症状**：我写 `sandbox_probe_gate.py` 检查"clone3 是否返回 ENOSYS"时，
**把 `ENOSYS` 那行代码删掉**造了一个破坏副本，门禁**仍报 PASS**（退出码 0）。

**根因**：判定用的是 `clone3` 与 `ENOSYS` 在文本里"距离近"的正则，
而**注释里正好写着"clone3 必须回 ENOSYS"** —— 匹配到了注释文字，不是代码。

**修法**：静态判据只看**代码行**，显式排除注释：

```python
code_lines = [ln for ln in text.splitlines()
              if "ENOSYS" in ln and not ln.lstrip().startswith("#")]
```

**通用纪律**：**任何静态门禁都必须用一个"故意破坏的副本"验证它真的会 FAIL**。
只跑一次"通过案例"的门禁，无法区分"检查逻辑正确"与"检查逻辑根本没生效"。

### 坑 B：`ctypes` 探针的"假 ALLOWED"（同源问题的另一种表现）

见坑 11：`libc` 返回 −1 且设 errno、**不抛异常**。
探针只 `except OSError` ⇒ 被拒的调用被报告成 `ALLOWED`，看起来"隔离没生效"。
**同一个道理**：判据的实现方式本身会骗人，必须用反向案例自证。

---

## 三、可复制的自检清单（沙盒实现后逐条实测）

| # | 检查 | 期望输出 |
|---|---|---|
| 1 | `uid` | `65534`（非 root） |
| 2 | 建 socket | `blocked(1)`（EPERM） |
| 3 | `unshare` / `setns` / `mount` / `ptrace` | 全部 `blocked(1)` |
| 4 | `memfd_create` / `mknod` | `blocked(1)` |
| 5 | `/tests/private` 可见性 | `False` |
| 6 | `/proc/self/status` 可见性 | `False` |
| 7 | 线程创建 | `ok`（BLAS 与 Python 都要能起线程） |
| 8 | 导入沙盒内允许的库 | 打印版本号 |
| 9 | 子进程握手 | 收到 magic 字符串（用来区分"沙盒没起来"与"候选跑失败"） |
| 10 | 往 `/output` 写 | 成功 |
| 11 | 退出后进程组 | 无残留（`pgrep` 查不到） |

**门禁自证要求**：本节的 11 条判据若做成脚本，必须额外用**破坏副本**验证它会 FAIL（见二点五坑 A）。

**握手是关键设计**：父进程先收到 `jail-ready` 才认为隔离建立成功；
没收到 ⇒ 抛 `SandboxUnavailable` ⇒ 判**基础设施故障**（而不是候选失败）。
这样"环境坏了"与"候选写错了"永远不会混淆。

---

## 四、能力边界（不要夸大）

必须在外发材料里如实声明，否则会被当成"不可逃逸"的承诺：

- 本方案是 **chroot + seccomp-BPF + 降权（uid 65534）+ rlimit**，
  **不是内核级强隔离**（未使用 user namespace、未使用 gVisor / Kata 等）。
- seccomp 是**黑名单**式：未列出的系统调用默认放行（`RET_ALLOW` 兜底）。
  新增内核特性可能引入新调用面，需定期复核。
- 只声明**已实测**的项（上文第三节 11 条），**不声明"不可能逃逸"**。
- `RLIMIT_NPROC` 因跨容器共享 UID 而不可靠，防 fork 炸弹的真正手段是
  CPU 时间 + 地址空间 + 墙钟超时。

---

## 五、与仓库其他条目的关系

- **L11**（原生 NOP Trial 的环境前提）：解决"这台机器能不能跑 NOP"；
  本文解决"NOP/评分要执行候选代码时，那个执行面怎么隔离"。两者互补。
- **L17**（集成方法复算契约）：可信复算需要在隔离面内执行候选读出时，
  先过 L17 的静态判据，再用本文的沙盒跑。
- **规则 5**（双镜像与信息边界）：本文是"Verifier 内候选仍须受限"这一条的实现细节。
