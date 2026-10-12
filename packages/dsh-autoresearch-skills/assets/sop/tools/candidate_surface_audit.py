#!/usr/bin/env python3
"""candidate_surface_audit.py —— 候选改动空间「枚举-勾选」审计（只读，零成本）

来源：2026-10-07 AutoRe0565 实战事故（见 references/field-lessons.md L28 / E84）。
给 al4pde 出题时，为判断"选点策略是否是可优化的开放面"，连续做了 6 次策略对照
全部劣于随机，于是得出"该优化面不可行"。**但从未跑过仓库里已存在的
bait / lcmd / coreset_maxdist 三个配置**；补测后发现 lcmd 恰是唯一优于随机的
（−10.5%）。等发现时服务器算力已耗尽，题目最终未能交付。
本工具把"宣布某类方法全部失败前必须枚举-勾选"这条纪律固化成可执行判定。

它回答一个问题：**你对某个候选空间的覆盖声明，与磁盘上实际存在的候选一致吗？**

设计原则（刻意的）：
  - 只读：不写、不改、不执行候选；只列目录 + 比对你的声明。
  - 三态退出码：0=覆盖完整 / 1=有未覆盖（硬失败）/ 2=信息不足或声明文件格式错。
  - 不猜语义：它不知道"哪个候选重要"，只负责把"存在但没被你点名"的暴露出来。

用法：

  # A. 最简单：只看这个空间里有哪些候选（列清单，不判定）
  python candidate_surface_audit.py --surface config/acquisition --pattern "*.yaml"

  # B. 带上你的"已测声明"，让工具判覆盖是否完整
  #    声明文件为纯文本，每行一个候选名（可用 # 注释、可用 glob）
  python candidate_surface_audit.py --surface config/acquisition --pattern "*.yaml" \\
      --declared tested.txt

  # C. 直接把已测项写在命令行（逗号分隔），无需文件
  python candidate_surface_audit.py --surface config/acquisition --pattern "*.yaml" \\
      --declared-inline "random,pool_random,power,top_k,max_dist"

  # D. 也检查"我声明测过的，磁盘上是否真的存在"（反向核对，防虚报）
  python candidate_surface_audit.py --surface config/acquisition --pattern "*.yaml" \\
      --declared-inline "random,ghost_method" --check-phantom

退出码：0=覆盖完整；1=存在未声明候选（或声明了不存在的候选且开了 --check-phantom）；
        2=信息不足（目录不存在 / 无候选 / 声明文件格式错）。
"""

import argparse
import fnmatch
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_INSUFFICIENT = 2


def list_candidates(surface, pattern):
    """返回磁盘上实际存在的候选名（不含扩展名），按字典序。"""
    if not os.path.isdir(surface):
        return None
    names = []
    for fn in os.listdir(surface):
        full = os.path.join(surface, fn)
        if os.path.isfile(full) and fnmatch.fnmatch(fn, pattern):
            names.append(os.path.splitext(fn)[0])
        elif os.path.isdir(full) and pattern in ("*", "*/"):
            names.append(fn)
    return sorted(set(names))


def parse_declared(inline, path):
    """解析声明：支持 inline 逗号分隔，或文件（每行一个，# 注释）。"""
    items = []
    if inline:
        items += [x.strip() for x in inline.split(",") if x.strip()]
    if path:
        if not os.path.isfile(path):
            return None
        for line in open(path, encoding="utf-8"):
            line = line.split("#", 1)[0].strip()
            if line:
                items += [x.strip() for x in line.split(",") if x.strip()]
    return items


def matches(declared_item, candidate):
    """声明项匹配候选：精确 或 glob（如 'lar*'）。"""
    if declared_item == candidate:
        return True
    if any(ch in declared_item for ch in "*?["):
        return fnmatch.fnmatch(candidate, declared_item)
    return False


def main() -> int:
    ap = argparse.ArgumentParser(
        description="候选改动空间「枚举-勾选」审计（只读；来源：AutoRe0565 事故见 L28/E84）")
    ap.add_argument("--surface", required=True,
                    help="候选空间目录，如 config/acquisition")
    ap.add_argument("--pattern", default="*",
                    help="候选文件名 glob，如 '*.yaml'（默认 *）")
    ap.add_argument("--declared", default=None,
                    help="已测声明文件（每行一个候选名，# 注释）")
    ap.add_argument("--declared-inline", default=None,
                    help="已测声明，逗号分隔")
    ap.add_argument("--check-phantom", action="store_true",
                    help="同时检查：声明里有没有磁盘上不存在的候选（防虚报）")
    args = ap.parse_args()

    cands = list_candidates(args.surface, args.pattern)
    if cands is None:
        print("[insufficient] 目录不存在: %s" % args.surface)
        return EXIT_INSUFFICIENT
    if not cands:
        print("[insufficient] 在 %s 下用 pattern=%r 未找到任何候选"
              % (args.surface, args.pattern))
        return EXIT_INSUFFICIENT

    print("候选空间: %s  (pattern=%s)" % (args.surface, args.pattern))
    print("磁盘上实际存在 %d 个候选:" % len(cands))
    for c in cands:
        print("  - %s" % c)

    declared = parse_declared(args.declared_inline, args.declared)
    if declared is None:
        print("[insufficient] 声明文件不存在: %s" % args.declared)
        return EXIT_INSUFFICIENT

    if not declared:
        print("")
        print("[insufficient] 未提供 --declared / --declared-inline。")
        print("  仅完成『枚举』；要做『覆盖判定』请给出已测声明。")
        print("  ★ 纪律（L28/E84）: 只要还有未声明的候选，就不允许写"
              "『某类方法全部失败』。")
        return EXIT_INSUFFICIENT

    print("")
    print("已声明（已测/已覆盖）%d 项: %s" % (len(declared), ", ".join(declared)))

    uncovered = [c for c in cands if not any(matches(d, c) for d in declared)]
    phantom = [d for d in declared if not any(matches(d, c) for c in cands)]

    bad = False
    if uncovered:
        bad = True
        print("")
        print("[FAIL] 存在【未声明】的候选 %d 个 —— 这些就是「未测就被算进全败」的风险点:"
              % len(uncovered))
        for c in uncovered:
            print("  ! %s" % c)
        print("  ⇒ 处理：把它们补测，或在交付/结论里显式写『未测』。"
              "不得直接宣布『全部失败』。")
    if args.check_phantom and phantom:
        bad = True
        print("")
        print("[FAIL] 声明里存在【磁盘上找不到】的候选 %d 个（可能虚报或路径写错）:"
              % len(phantom))
        for d in phantom:
            print("  ! %s" % d)

    print("")
    if bad:
        print("[FAIL] 覆盖声明与磁盘不一致。")
        return EXIT_FAIL
    print("[OK] 覆盖完整：磁盘上的每个候选都被声明覆盖。")
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
