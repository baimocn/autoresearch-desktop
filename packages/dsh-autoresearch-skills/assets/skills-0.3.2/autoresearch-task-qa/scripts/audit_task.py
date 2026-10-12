#!/usr/bin/env python3
"""Static, non-executing AutoResearch delivery auditor.

The package under review is untrusted. This script never imports or executes its
Python/shell files. ZIP extraction accepts regular files and directories only.
"""

from __future__ import annotations

import argparse
import ast
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import statistics
import sys
import tempfile
import unicodedata
import zipfile

try:  # Python 3.11+
    import tomllib  # type: ignore
except ModuleNotFoundError:  # Python 3.9/3.10 in older task images
    tomllib = None  # type: ignore


MAX_ARCHIVE_FILES = 20_000
MAX_ARCHIVE_BYTES = 8 * 1024**3
MAX_ARCHIVE_MEMBER_BYTES = 2 * 1024**3
MAX_COMPRESSION_RATIO = 250.0
MAX_TEXT_BYTES = 4 * 1024**2

REQUIRED_SECTIONS = (
    "Goal",
    "Task Setting",
    "Objective and Metrics",
    "Allowed Scope",
    "Hard Boundaries",
    "Submission Instructions",
    "Workflow & Iteration",
    "Completion Criteria",
)

CHECK_TITLES = {
    "QA01": "题面八章节、无方法提示与来源泄露",
    "QA02": "连续单调不裁剪评分与 0/1 锚点",
    "QA03": "参考解分数区间与可复现性",
    "QA04": "参考解与 Baseline 的 3σ 可分辨性",
    "QA05": "题面约束均被环境或 verifier 强制",
    "QA06": "Verifier 单命令、标量分数与错误分类",
    "QA07": "Hidden 数据及派生信息物理隔离",
    "QA08": "参考解代码、结果与历史隔离",
    "QA09": "结果文件启动清理与可信原子写入",
    "QA10": "Evaluator/guard/metric/baseline/reference 冻结恢复",
    "QA11": "instruction.md 八章节内容完整",
    "QA12": "Git remotes/tags/reflog/对象清理",
    "QA13": "Baseline 非平凡且参考解可提升",
    "QA14": "保留未提示改进方向且参考方法未饱和",
    "QA15": "单次评分、GPU 与 CPU 资源上限",
    "QA16": "容器 12 小时稳定性",
    "QA17": "依赖和数据预构建、无 Volume Mount",
    "QA18": "Agent 轨迹、执行日志与 trajectory analysis",
    "QA19": "随机性、seed、replicate 与有效提升阈值",
    "QA20": "可修改范围、网络与工具策略",
    "QA21": "trajectory/annotation/run_summary 填写规范",
}

EXTRA_TITLES = {
    "EX01": "Baseline sandbagging / 资源不对等",
    "EX02": "事后调锚点或挑选弱参考解",
    "EX03": "Hidden test 作为自适应 oracle",
    "EX04": "伪造、陈旧或不可追溯证据",
    "EX05": "INIT_PROMPT/公开资产/文件名侧信道提示",
    "EX06": "Docker 构建层与构建上下文泄露",
    "EX07": "Verifier 接管、路径与导入劫持面",
    "EX08": "计时、缓存、异步与基线污染作弊",
    "EX09": "压缩包路径穿越、特殊文件与压缩炸弹",
    "EX10": "依赖、镜像、模型供应链漂移",
    "EX11": "Public/Hidden 数据污染与重复",
    "EX12": "超时子进程、FD/PID/磁盘/GPU 资源逃逸",
    "EX13": "空洞测试、重复测试名与自证式断言",
    "EX14": "Agent 最终可见面未被证明",
    "EX15": "Hidden 诊断、逐 case 与高精度反馈泄露",
    "EX16": "可选停止、挑窗口与统计口径操纵",
}

# In authoring-time precheck mode, only an archive that cannot be inspected
# safely remains a hard stop. All content/compliance findings stay visible but
# become advisory. Strict mode is unchanged and remains the release gate.
PRECHECK_HARD_FAIL_IDS = frozenset({"EX09"})


@dataclass
class Check:
    id: str
    title: str
    status: str
    severity: str
    summary: str
    evidence: list[str]
    remediation: str


@dataclass
class ArchiveFacts:
    kind: str
    sha256: str | None
    file_count: int
    uncompressed_bytes: int
    unsafe_entries: list[str]
    suspicious_entries: list[str]


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_simple_toml(text: str) -> dict:
    """Parse the task.toml subset needed by the auditor on Python < 3.11.

    The fallback tolerates multiline strings and arrays so one descriptive
    value cannot cause all later resource/entrypoint fields to disappear.
    """
    document: dict = {}
    current = document
    raw_lines = text.splitlines()
    index = 0
    while index < len(raw_lines):
        raw_line = raw_lines[index]
        index += 1
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = document
            for part in line[1:-1].split("."):
                current = current.setdefault(part.strip(), {})
            continue
        if "=" not in line:
            continue
        key, raw_value = (part.strip() for part in line.split("=", 1))
        if raw_value.startswith(('"""', "'''")):
            delimiter = raw_value[:3]
            while raw_value.count(delimiter) < 2 and index < len(raw_lines):
                raw_value += "\n" + raw_lines[index]
                index += 1
        elif raw_value.startswith("["):
            depth = raw_value.count("[") - raw_value.count("]")
            while depth > 0 and index < len(raw_lines):
                next_line = raw_lines[index]
                index += 1
                raw_value += "\n" + next_line
                depth += next_line.count("[") - next_line.count("]")
        else:
            raw_value = re.split(r"\s+#", raw_value, maxsplit=1)[0].strip()
        if raw_value.lower() in ("true", "false"):
            value: object = raw_value.lower() == "true"
        else:
            try:
                value = ast.literal_eval(raw_value)
            except (ValueError, SyntaxError):
                try:
                    value = float(raw_value) if "." in raw_value else int(raw_value)
                except ValueError:
                    value = raw_value.strip().strip('"').strip("'")
        current[key] = value
    return document


def normalized_zip_name(name: str) -> str:
    return unicodedata.normalize("NFC", name).casefold().rstrip("/")


def decoded_zip_name(info: zipfile.ZipInfo) -> str:
    """Recover UTF-8 names from common macOS ZIPs missing the UTF-8 flag.

    zipfile has already decoded unflagged bytes as CP437. Some macOS archive
    tools nevertheless stored UTF-8 bytes without setting bit 11, producing
    mojibake such as the Chinese training-evidence filename in otherwise valid
    submissions. ASCII remains unchanged and genuine CP437 names fall back to
    zipfile's value when the byte sequence is not valid UTF-8.
    """
    name = info.filename
    if info.flag_bits & 0x800:
        return name
    try:
        repaired = name.encode("cp437").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return name
    return repaired


def zip_member_problem(info: zipfile.ZipInfo, name: str | None = None) -> str | None:
    name = decoded_zip_name(info) if name is None else name
    if not name or "\x00" in name or "\\" in name:
        return "empty/NUL/backslash path"
    pure = PurePosixPath(name)
    if pure.is_absolute() or any(part in ("", ".", "..") for part in pure.parts):
        return "absolute, empty, dot, or parent path component"
    mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(mode)
    if file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
        return "symlink or special file"
    if info.flag_bits & 0x1:
        return "encrypted member"
    if info.file_size > MAX_ARCHIVE_MEMBER_BYTES:
        return "member exceeds size limit"
    ratio = info.file_size / max(info.compress_size, 1)
    if info.file_size > 1024 * 1024 and ratio > MAX_COMPRESSION_RATIO:
        return "suspicious compression ratio"
    return None


def safe_extract_zip(source: Path, destination: Path) -> ArchiveFacts:
    unsafe: list[str] = []
    suspicious: list[str] = []
    total = 0
    seen: dict[str, str] = {}
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        if len(infos) > MAX_ARCHIVE_FILES:
            unsafe.append(f"file count {len(infos)} exceeds {MAX_ARCHIVE_FILES}")
        for info in infos:
            decoded_name = decoded_zip_name(info)
            total += info.file_size
            problem = zip_member_problem(info, decoded_name)
            if problem:
                unsafe.append(f"{decoded_name!r}: {problem}")
            key = normalized_zip_name(decoded_name)
            if key in seen:
                unsafe.append(
                    f"duplicate/case/Unicode-colliding entries: {seen[key]!r}, {decoded_name!r}"
                )
            elif key:
                seen[key] = decoded_name.rstrip("/")
            suffix = PurePosixPath(decoded_name).suffix.lower()
            if suffix in {".zip", ".tar", ".tgz", ".gz", ".bz2", ".xz", ".7z"}:
                suspicious.append(f"nested archive: {decoded_name}")
        if total > MAX_ARCHIVE_BYTES:
            unsafe.append(f"expanded size {total} exceeds {MAX_ARCHIVE_BYTES}")
        if unsafe:
            return ArchiveFacts(
                "zip", sha256_file(source), len(infos), total, unsafe, suspicious
            )
        for info in infos:
            decoded_name = decoded_zip_name(info)
            pure = PurePosixPath(decoded_name)
            target = destination.joinpath(*pure.parts)
            if info.is_dir() or decoded_name.endswith("/"):
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(info, "r") as src, target.open("xb") as dst:
                shutil.copyfileobj(src, dst, length=1024 * 1024)
    return ArchiveFacts("zip", sha256_file(source), len(infos), total, [], suspicious)


def directory_facts(source: Path) -> ArchiveFacts:
    unsafe: list[str] = []
    suspicious: list[str] = []
    count = 0
    total = 0
    seen: dict[str, str] = {}
    for base, dirs, files in os.walk(source, followlinks=False):
        base_path = Path(base)
        for name in list(dirs) + files:
            path = base_path / name
            rel = path.relative_to(source).as_posix()
            try:
                metadata = path.lstat()
            except OSError as exc:
                unsafe.append(f"{rel}: cannot stat: {exc}")
                continue
            if stat.S_ISLNK(metadata.st_mode):
                unsafe.append(f"{rel}: symlink")
                if name in dirs:
                    dirs.remove(name)
                continue
            if not (stat.S_ISREG(metadata.st_mode) or stat.S_ISDIR(metadata.st_mode)):
                unsafe.append(f"{rel}: special file")
                continue
            key = normalized_zip_name(rel)
            if key in seen and seen[key] != rel:
                unsafe.append(f"case/Unicode collision: {seen[key]}, {rel}")
            seen[key] = rel
            if stat.S_ISREG(metadata.st_mode):
                count += 1
                total += metadata.st_size
                if path.suffix.lower() in {".zip", ".tar", ".tgz", ".7z"}:
                    suspicious.append(f"nested archive: {rel}")
                if metadata.st_nlink > 1:
                    suspicious.append(f"hard-linked file: {rel}")
    return ArchiveFacts("directory", None, count, total, unsafe, suspicious)


def locate_workspace(root: Path) -> Path:
    if (root / "harbor_task").is_dir():
        return root
    candidates = [
        path.parent
        for path in root.rglob("harbor_task")
        if path.is_dir()
        and len(path.relative_to(root).parts) <= 3
        and "__MACOSX" not in path.relative_to(root).parts
        and not any(part.startswith("._") for part in path.relative_to(root).parts)
    ]
    unique = sorted(set(candidates))
    if len(unique) == 1:
        return unique[0]
    raise ValueError(
        "could not identify a unique workspace root containing harbor_task/"
    )


class Auditor:
    def __init__(
        self,
        root: Path,
        source_path: Path,
        facts: ArchiveFacts,
        policy: str = "precheck",
    ):
        self.root = root
        self.source_path = source_path
        self.facts = facts
        self.policy = policy
        self.policy_adjustments: list[dict[str, str]] = []
        self.checks: list[Check] = []
        self.extra: list[Check] = []
        self.files = self._inventory()
        self.text_cache: dict[str, str] = {}
        self.task_config: dict = {}
        self.json_docs: dict[str, object] = {}
        self.assumptions = [
            "未找到可信 exposure manifest 时，保守视 INIT_PROMPT.md 与整个 harbor_task/ 为 Agent 可见。",
            "仅执行静态审计；未导入或执行待检包中的 Python、Shell、Dockerfile 或 verifier。",
            "包内 passed/root-owned/uploaded 等字段仅是声明，除非有原始证据可复算。",
        ]
        self.limitations = [
            "静态包不能证明最终镜像历史层中无泄露。",
            "静态包不能证明实际挂载、UID 权限、环境变量、/proc、IPC 与日志隔离。",
            "静态包不能证明 GPU 时序正确、调度器/cgroup 资源限制或 hidden/public 数据去重。",
            "静态包不能代替 baseline/reference 的干净环境复跑和 12 小时稳定性测试。",
        ]

    def apply_policy(self) -> None:
        """Apply the selected reporting policy after strict checks run."""
        if self.policy == "strict":
            return
        for item in self.checks + self.extra:
            if item.status == "fail" and item.id not in PRECHECK_HARD_FAIL_IDS:
                original_severity = item.severity
                adjusted_severity = "high" if item.severity == "blocker" else item.severity
                self.policy_adjustments.append(
                    {
                        "id": item.id,
                        "from": "fail",
                        "to": "warn",
                        "from_severity": original_severity,
                        "to_severity": adjusted_severity,
                        "reason": "precheck 宽松预检将内容和合规问题作为建议项；该项在 strict 终审中仍为 FAIL。",
                    }
                )
                item.status = "warn"
                item.severity = adjusted_severity

    def _inventory(self) -> list[str]:
        result: list[str] = []
        for base, dirs, files in os.walk(self.root, followlinks=False):
            dirs[:] = [name for name in dirs if not (Path(base) / name).is_symlink()]
            for name in files:
                path = Path(base) / name
                if path.is_file() and not path.is_symlink():
                    result.append(path.relative_to(self.root).as_posix())
        return sorted(result)

    def path(self, rel: str) -> Path:
        return self.root / rel

    def text(self, rel: str) -> str:
        if rel in self.text_cache:
            return self.text_cache[rel]
        path = self.path(rel)
        if not path.is_file() or path.stat().st_size > MAX_TEXT_BYTES:
            self.text_cache[rel] = ""
            return ""
        try:
            value = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            value = ""
        self.text_cache[rel] = value
        return value

    def line_refs(self, rel: str, pattern: str, limit: int = 8) -> list[str]:
        regex = re.compile(pattern, re.IGNORECASE)
        refs: list[str] = []
        for number, line in enumerate(self.text(rel).splitlines(), 1):
            if regex.search(line):
                refs.append(f"{rel}:{number}")
                if len(refs) >= limit:
                    break
        return refs

    def add(
        self,
        check_id: str,
        status: str,
        severity: str,
        summary: str,
        evidence: list[str] | None = None,
        remediation: str = "",
    ) -> None:
        target = self.checks if check_id.startswith("QA") else self.extra
        titles = CHECK_TITLES if check_id.startswith("QA") else EXTRA_TITLES
        target.append(
            Check(
                check_id,
                titles[check_id],
                status,
                severity,
                summary,
                evidence or [],
                remediation,
            )
        )

    def load_json(self, rel: str) -> object | None:
        if rel in self.json_docs:
            return self.json_docs[rel]
        try:
            value = json.loads(self.path(rel).read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            value = None
        self.json_docs[rel] = value
        return value

    def candidate_json_docs(self) -> dict[str, object]:
        patterns = (
            "expert_evidence/expert_annotation.json",
            "expert_evidence/run_summary.json",
            "expert_evidence/h20_anchor_runs.json",
        )
        result: dict[str, object] = {}
        for rel in self.files:
            if rel in patterns or (
                "hidden_assets/reference_evidence/" in rel
                and rel.endswith(("run_summary.json", "expert_annotation.json"))
            ):
                value = self.load_json(rel)
                if value is not None:
                    result[rel] = value
        return result

    @staticmethod
    def nested(document: object, *keys: str) -> object | None:
        current = document
        for key in keys:
            if not isinstance(current, dict) or key not in current:
                return None
            current = current[key]
        return current

    @staticmethod
    def finite_number(value: object) -> float | None:
        if isinstance(value, bool):
            return None
        try:
            result = float(value)
        except (TypeError, ValueError):
            return None
        return result if math.isfinite(result) else None

    def parse_task(self) -> None:
        rel = "harbor_task/task.toml"
        try:
            if tomllib is not None:
                with self.path(rel).open("rb") as stream:
                    self.task_config = tomllib.load(stream)
            else:
                self.task_config = parse_simple_toml(
                    self.path(rel).read_text(encoding="utf-8")
                )
        except (OSError, ValueError):
            self.task_config = {}

    def instruction_sections(self) -> tuple[str, dict[str, str], list[str]]:
        rel = "harbor_task/instruction.md"
        text = self.text(rel)
        headings = list(re.finditer(r"(?m)^##\s+(.+?)\s*$", text))
        sections: dict[str, str] = {}
        duplicates: list[str] = []
        for index, match in enumerate(headings):
            title = match.group(1).strip()
            end = headings[index + 1].start() if index + 1 < len(headings) else len(text)
            if title in sections:
                duplicates.append(title)
            sections[title] = text[match.end() : end].strip()
        return text, sections, duplicates

    def score_evidence(self, docs: dict[str, object]) -> tuple[list[float], list[float]]:
        baseline: list[float] = []
        reference: list[float] = []
        for document in docs.values():
            for keys in (
                ("baseline", "score"),
                ("baseline_score", "mean"),
                ("baseline", "public_score_mean"),
            ):
                value = self.finite_number(self.nested(document, *keys))
                if value is not None:
                    baseline.append(value)
            for keys in (
                ("reference", "score"),
                ("reference_score", "mean"),
                ("reference_solution", "public_score_mean"),
                ("best_run", "mean_score"),
            ):
                value = self.finite_number(self.nested(document, *keys))
                if value is not None:
                    reference.append(value)
        return baseline, reference

    def find_series_pairs(
        self, docs: dict[str, object]
    ) -> list[tuple[str, str, list[float], list[float]]]:
        pairs: list[tuple[str, str, list[float], list[float]]] = []

        def numbers(value: object) -> list[float] | None:
            if not isinstance(value, list) or len(value) < 2:
                return None
            parsed = [self.finite_number(item) for item in value]
            return [item for item in parsed if item is not None] if all(
                item is not None for item in parsed
            ) else None

        def visit(rel: str, value: object, trail: str = "") -> None:
            if isinstance(value, dict):
                if isinstance(value.get("baseline"), dict) and isinstance(
                    value.get("reference"), dict
                ):
                    left = value["baseline"]
                    right = value["reference"]
                    for key in ("scores", "hidden_ppl_values", "values"):
                        b_values = numbers(left.get(key))
                        r_values = numbers(right.get(key))
                        if b_values and r_values:
                            direction = "minimize" if "ppl" in key else self.metric_direction()
                            pairs.append((rel, direction, b_values, r_values))
                for key, child in value.items():
                    visit(rel, child, f"{trail}.{key}" if trail else key)
            elif isinstance(value, list):
                for child in value:
                    visit(rel, child, trail)

        for rel, document in docs.items():
            visit(rel, document)
        unique: list[tuple[str, str, list[float], list[float]]] = []
        seen: set[tuple] = set()
        for pair in pairs:
            key = (pair[0], pair[1], tuple(pair[2]), tuple(pair[3]))
            if key not in seen:
                unique.append(pair)
                seen.add(key)
        return unique

    def metric_direction(self) -> str:
        value = self.nested(self.task_config, "task", "metric_direction")
        return value if value in ("maximize", "minimize") else "maximize"

    def evaluation_is_deterministic(self, docs: dict[str, object], instruction: str) -> bool:
        declared = self.nested(self.task_config, "scoring", "deterministic")
        if declared is True:
            return True
        serialized = json.dumps(docs, ensure_ascii=False)
        return bool(
            re.search(r'"deterministic"\s*:\s*true', serialized, re.I)
            or re.search(r"deterministic|zero variance|\u96f6\u65b9\u5dee|\u65e0\u968f\u673a", instruction, re.I)
        )

    def run(self) -> dict:
        self.parse_task()
        docs = self.candidate_json_docs()
        instruction, sections, duplicate_sections = self.instruction_sections()
        self.audit_archive()
        self.audit_instruction(instruction, sections, duplicate_sections)
        self.audit_score(docs, instruction)
        self.audit_constraints_and_verifier(instruction)
        self.audit_isolation(instruction)
        self.audit_git()
        self.audit_baseline_headroom(docs, instruction)
        self.audit_resources(docs, instruction)
        self.audit_evidence(docs, instruction)
        self.audit_expert_cheating(docs, instruction)
        ids = {item.id for item in self.checks}
        missing = sorted(set(CHECK_TITLES) - ids)
        if missing:
            raise RuntimeError(f"internal error: missing checks {missing}")
        self.apply_policy()
        all_checks = self.checks + self.extra
        counts = {
            status_name: sum(item.status == status_name for item in all_checks)
            for status_name in ("pass", "fail", "warn", "manual", "not_applicable")
        }
        blockers = sum(
            item.status == "fail" and item.severity == "blocker" for item in all_checks
        )
        if counts["fail"]:
            decision = "NO-GO"
        elif self.policy == "precheck":
            decision = "PRECHECK-PASS"
        elif counts["warn"] or counts["manual"]:
            decision = "REVIEW"
        else:
            decision = "GO-STATIC-ONLY"
        return {
            "schema_version": 1,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "source": {
                "path": str(self.source_path),
                "kind": self.facts.kind,
                "sha256": self.facts.sha256,
                "file_count": self.facts.file_count,
                "uncompressed_bytes": self.facts.uncompressed_bytes,
            },
            "workspace_root": str(self.root),
            "policy": {
                "name": self.policy,
                "strict_release_certification": self.policy == "strict",
                "adjustments": self.policy_adjustments,
            },
            "assumptions": self.assumptions,
            "summary": {"decision": decision, "counts": counts, "blockers": blockers},
            "checks": [asdict(item) for item in sorted(self.checks, key=lambda x: x.id)],
            "extra_checks": [asdict(item) for item in sorted(self.extra, key=lambda x: x.id)],
            "limitations": self.limitations,
        }

    def audit_archive(self) -> None:
        if self.facts.unsafe_entries:
            self.add(
                "EX09",
                "fail",
                "blocker",
                "包包含不安全路径、特殊文件或超限成员。",
                self.facts.unsafe_entries[:20],
                "重建只含普通文件/目录的压缩包，消除冲突路径并限制展开体积。",
            )
        elif self.facts.suspicious_entries:
            self.add(
                "EX09",
                "warn",
                "high",
                "基础包安全检查通过，但存在嵌套压缩包或硬链接，需递归审计。",
                self.facts.suspicious_entries[:20],
                "展开并递归审计嵌套包；移除非必要硬链接。",
            )
        else:
            self.add(
                "EX09",
                "pass",
                "blocker",
                "未发现路径穿越、符号链接、特殊文件、重名冲突或压缩炸弹特征。",
                [f"files={self.facts.file_count}", f"bytes={self.facts.uncompressed_bytes}"],
            )

    def audit_instruction(
        self, instruction: str, sections: dict[str, str], duplicates: list[str]
    ) -> None:
        rel = "harbor_task/instruction.md"
        missing = [name for name in REQUIRED_SECTIONS if name not in sections]
        leakage_patterns = {
            "arXiv": r"arxiv(?:\.org|\s*:?)\s*(?:abs/)?\d{4}\.\d{4,5}",
            "repository URL": r"https?://[^\s)>]*(?:github|gitlab|gitee)\.[^\s)>]+",
            "paper/DOI": r"\bdoi\s*:|https?://doi\.org/|论文[《\"]",
        }
        leaks: list[str] = []
        for label, pattern in leakage_patterns.items():
            refs = self.line_refs(rel, pattern)
            leaks.extend(f"{item} ({label})" for item in refs)
        hint_pattern = (
            r"sensitivity (?:profile|statistics)|cpu (?:proxy|prefilter)|dynamic program|"
            r"fused unpack|tensor[- ]core|tile size|warp scheduling|shared[- ]memory staging|"
            r"敏感度(?:画像|统计)|动态规划|融合解包|张量核"
        )
        hints = self.line_refs(rel, hint_pattern)
        if not instruction or missing or duplicates or leaks or hints:
            reasons = []
            if not instruction:
                reasons.append("instruction.md 缺失或不可读")
            if missing:
                reasons.append(f"缺少章节: {', '.join(missing)}")
            if duplicates:
                reasons.append(f"重复章节: {', '.join(sorted(set(duplicates)))}")
            if leaks:
                reasons.append("检测到论文/仓库来源标识")
            if hints:
                reasons.append("检测到具体优化提示")
            self.add(
                "QA01",
                "fail",
                "high",
                "；".join(reasons),
                leaks + hints,
                "补齐八章节并删除来源标识和具体优化路线；同时检查 INIT_PROMPT。",
            )
        else:
            self.add(
                "QA01",
                "pass",
                "high",
                "八个章节齐全，未命中高置信来源泄露或方法提示模式。",
                [rel],
                "仍需专家人工检查无法用模式识别的论文标题、repo 名称和隐性提示。",
            )

        requirements = {
            "Goal": (r"submission|提交", r"optimi|minimi|maximi|指标|优化"),
            "Task Setting": (r"public|公开", r"hidden|隐藏", r"baseline|基线"),
            "Objective and Metrics": (r"score|评分", r"continuous|连续", r"clip|裁剪"),
            "Allowed Scope": (r"modify|修改", r"read|读取|可读|script|command|命令"),
            "Hard Boundaries": (r"hidden|隐藏", r"forbid|禁止|must not|不得|limit|上限"),
            "Submission Instructions": (r"json|schema|格式", r"submission|提交"),
            "Workflow & Iteration": (r"anytime|迭代", r"scor|评分|评估"),
            "Completion Criteria": (r"scor|评分|evaluator|评估", r"valid|有效|pass|通过|success|succeed|ready"),
        }
        incomplete: list[str] = []
        for name, patterns in requirements.items():
            body = sections.get(name, "")
            if not body or any(not re.search(pattern, body, re.I) for pattern in patterns):
                incomplete.append(name)
        goal = sections.get("Goal", "")
        goal_sentences = len(re.findall(r"[.!?。！？](?=\s|$)", goal))
        if goal.strip() and goal_sentences == 0:
            goal_sentences = 1
        if goal and not 2 <= goal_sentences <= 4:
            incomplete.append(f"Goal(句子数≈{goal_sentences}，要求2–4)")
        if missing or incomplete:
            self.add(
                "QA11",
                "fail",
                "high",
                "八章节内容字段不完整。",
                [rel, *(f"incomplete={name}" for name in incomplete)],
                "按教程逐节补充输入/输出/公式/边界/schema/迭代/完成条件。",
            )
        else:
            self.add(
                "QA11",
                "pass",
                "high",
                "八章节及核心内容关键词完整。",
                [rel],
                "人工核对各字段是否精确且互不矛盾。",
            )

    def audit_score(self, docs: dict[str, object], instruction: str) -> None:
        score_files = [
            rel
            for rel in self.files
            if rel.startswith("harbor_task/")
            and rel.endswith(".py")
            and re.search(r"scor|grad|metric|test", rel, re.I)
        ]
        score_text = "\n".join(self.text(rel) for rel in score_files)
        formula_claim = bool(re.search(r"score\s*\(|score\s*=|评分", instruction, re.I))
        properties_claim = all(
            re.search(pattern, instruction, re.I)
            for pattern in (
                r"continuous|连续",
                r"monotonic|单调|lower\s+is\s+better|higher\s+is\s+better|越低越好|越高越好",
                r"not clipped|unclipped|not\s*\n?\s*clipped|不.*裁剪",
            )
        )
        clipping = bool(
            re.search(
                r"(?:np\.)?clip\s*\(|torch\.clamp\s*\(|score\s*=\s*(?:min|max)\s*\(",
                score_text,
                re.I,
            )
        )
        baseline_scores, reference_scores = self.score_evidence(docs)
        baseline_zero = any(abs(value) <= 1e-9 for value in baseline_scores) or bool(
            re.search(
                r"ratio\s*[=:]\s*1(?:\.0)?[\s\S]{0,120}(?:approx\s*\(?\s*0|==\s*0)",
                score_text,
                re.I,
            )
        )
        upper_evidence = []
        for document in docs.values():
            for keys in (("attainable", "score"), ("upper", "score"), ("upper_bound", "score")):
                value = self.finite_number(self.nested(document, *keys))
                if value is not None:
                    upper_evidence.append(value)
        upper_one = bool(
            re.search(r"(?:maps? to|映射为|normalized_score[^\n]*[:=])\s*`?1(?:\.0)?`?", instruction, re.I)
            or re.search(r"upper_bound[\s\S]{0,200}normalized_score[\s\S]{0,40}1\.0", json.dumps(docs))
            or any(abs(value - 1.0) <= 1e-9 for value in upper_evidence)
        )
        tests_property = bool(re.search(r"monotonic|unclipped|continuous", score_text, re.I))
        if not formula_claim or not properties_claim or clipping or not baseline_zero or not upper_one:
            problems = []
            if not formula_claim:
                problems.append("题面无明确 score 公式")
            if not properties_claim:
                problems.append("题面未同时声明连续/单调/不裁剪")
            if clipping:
                problems.append("评分代码疑似裁剪 score")
            if not baseline_zero:
                problems.append("证据中未找到 hidden baseline=0")
            if not upper_one:
                problems.append("未找到预计可达上限=1")
            self.add(
                "QA02",
                "fail",
                "high",
                "；".join(problems),
                ["harbor_task/instruction.md", *score_files[:8]],
                "使用单一仿射归一化公式，补充越界点/NaN/Inf/锚点合同测试和可信运行证据。",
            )
        elif not tests_property:
            self.add(
                "QA02",
                "warn",
                "high",
                "题面与锚点证据满足，但未识别出连续/单调/不裁剪合同测试。",
                ["harbor_task/instruction.md"],
                "增加 baseline、upper、优于 upper、劣于 baseline 与 NaN/Inf 的测试。",
            )
        else:
            self.add(
                "QA02",
                "pass",
                "high",
                "题面声明与静态评分测试支持连续、单调、不裁剪和 0/1 锚点。",
                ["harbor_task/instruction.md", *score_files[:8]],
                "正式 hidden 环境仍需复跑 baseline 验证精确为 0。",
            )

        reference = [value for value in reference_scores if 0.15 <= value <= 0.8]
        pairs = self.find_series_pairs(docs)
        replicates = max((min(len(pair[2]), len(pair[3])) for pair in pairs), default=0)
        deterministic = self.evaluation_is_deterministic(docs, instruction)
        required_replicates = 1 if deterministic else 3
        serialized_docs = json.dumps(docs, ensure_ascii=False).lower()
        hidden_not_run = bool(
            re.search(r"hidden.{0,160}not_run", serialized_docs)
            or '"status": "pilot_required"' in serialized_docs
        )
        run_logs = [
            rel
            for rel in self.files
            if re.search(r"(?:^|/)expert_evidence/", rel)
            and (
                rel.endswith(("run.json", "stderr.log", "stdout.jsonl", "trajectory.json", "stability.tsv"))
                or re.search(r"/trajectory_[^/]+\.json$", rel)
            )
        ]
        reproducible = bool(run_logs) and (deterministic or replicates >= required_replicates)
        if not reference or not reproducible or hidden_not_run:
            self.add(
                "QA03",
                "fail",
                "high",
                f"参考分数区间证据={bool(reference)}，deterministic={deterministic}，可复算 replicates={replicates}，运行日志={len(run_logs)}，hidden 未完成={hidden_not_run}。",
                list(docs) + run_logs[:8],
                "保留至少 3 次可信原始复跑、日志和固定 digest，并确保参考归一化分数在 [0.15,0.8]。",
            )
        else:
            self.add(
                "QA03",
                "pass",
                "high",
                "发现区间内参考分数和确定性运行证据。"
                if deterministic
                else f"发现区间内参考分数、{replicates} 次以上原始 replicate 与运行日志。",
                list(docs) + run_logs[:6],
            )

        if deterministic:
            self.add(
                "QA04",
                "not_applicable",
                "info",
                "任务声明为确定性评估；3σ 波动性门槛不适用。",
                ["harbor_task/task.toml"],
                "若后续观测到非零波动，再启用 replicate 与 3σ 检查。",
            )
        elif hidden_not_run:
            self.add(
                "QA04",
                "fail",
                "high",
                "只有 public/锚点重复结果，正式 hidden 评分明确未运行，无法完成正式协议的 3σ 验证。",
                list(docs),
                "在冻结 hidden 协议上运行预声明的独立 replicate 并复算 3σ。",
            )
        elif not pairs:
            self.add(
                "QA04",
                "manual",
                "high",
                "未找到可直接复算 3σ 的 baseline/reference 原始数组。",
                list(docs),
                "提供同协议独立 replicate 数组并声明 population/sample sigma。",
            )
        else:
            failures: list[str] = []
            evidence: list[str] = []
            for rel, direction, baseline_values, reference_values in pairs:
                b_mean = statistics.fmean(baseline_values)
                r_mean = statistics.fmean(reference_values)
                sigma = statistics.pstdev(baseline_values)
                gap = r_mean - b_mean if direction == "maximize" else b_mean - r_mean
                passed = gap + 1e-15 >= 3 * sigma
                evidence.append(
                    f"{rel}: direction={direction}, n={min(len(baseline_values),len(reference_values))}, gap={gap:.12g}, 3sigmaB={3*sigma:.12g}"
                )
                if not passed:
                    failures.append(rel)
            self.add(
                "QA04",
                "fail" if failures else "pass",
                "high",
                "至少一组复算未通过 3σ。" if failures else "从原始数组复算的组均通过 3σ。",
                evidence,
                "使用预声明的独立重复实验并明确 sigma 口径。",
            )

    def grader_files(self) -> list[str]:
        return [
            rel
            for rel in self.files
            if rel.startswith("harbor_task/")
            and rel.endswith(("grader.py", "verifier.py", "grade.py"))
            and ("/tests/" in rel or "/trusted/" in rel or "/verifier/" in rel)
        ]

    def audit_constraints_and_verifier(self, instruction: str) -> None:
        test_files = [
            rel
            for rel in self.files
            if rel.startswith("harbor_task/tests/") and rel.endswith((".py", ".sh"))
        ]
        test_text = "\n".join(self.text(rel) for rel in test_files)
        gate_terms = len(
            re.findall(
                r"reject|invalid|raises|timeout|budget|size|schema|integrity|readonly|forbid|mutation",
                test_text,
                re.I,
            )
        )
        self.add(
            "QA05",
            "manual",
            "high",
            f"检测到 {len(test_files)} 个测试/脚本文件和约 {gate_terms} 个 gate 相关断言；无法自动证明所有题面约束均有对应强制项。",
            test_files[:12],
            "提交 constraint→enforcement→negative-test 映射表，并对每条规范逐项复核。",
        )

        graders = self.grader_files()
        entry = self.nested(self.task_config, "entrypoint", "grader_script")
        entry_ok = isinstance(entry, str) and self.path(f"harbor_task/{entry}").is_file()
        combined = "\n".join(self.text(rel) for rel in graders)
        emits_score = bool(re.search(r"[\"']score[\"']\s*:", combined))
        has_statuses = all(re.search(pattern, combined) for pattern in (r"invalid", r"error"))
        finite = bool(re.search(r"isfinite|finite", combined, re.I))
        inconsistent_exit = bool(
            re.search(r"def\s+invalid\b[\s\S]{0,900}?return\s+0\b", combined)
        )
        if not (entry_ok and graders and emits_score and has_statuses and finite) or inconsistent_exit:
            problems = []
            if not entry_ok:
                problems.append("task.toml grader_script 缺失/不存在")
            if not emits_score:
                problems.append("未识别机器可读 score")
            if not has_statuses:
                problems.append("未区分 invalid/error")
            if not finite:
                problems.append("未识别有限数检查")
            if inconsistent_exit:
                problems.append("invalid 路径返回成功退出码 0")
            self.add(
                "QA06",
                "fail",
                "high",
                "；".join(problems),
                graders + ([f"harbor_task/{entry}"] if isinstance(entry, str) else []),
                "统一 JSON contract、有限标量 score、错误类型和非零失败退出码，并加端到端测试。",
            )
        else:
            self.add(
                "QA06",
                "pass",
                "high",
                "grader 入口存在，输出含 score，并区分 invalid/error 且检查有限值。",
                graders,
                "动态验证 stdout 仅有一个结果对象且超时/基础设施退出码一致。",
            )

        result_integrity_text = combined
        clears = bool(re.search(r"unlink\s*\(|remove\s*\(", result_integrity_text))
        atomic = bool(re.search(r"os\.replace\s*\(|rename\s*\(", result_integrity_text))
        unique_temp = bool(re.search(r"NamedTemporaryFile|mkstemp", result_integrity_text))
        symlink_guard = bool(re.search(r"is_symlink|S_ISLNK|O_NOFOLLOW", result_integrity_text))
        if clears and atomic and unique_temp and symlink_guard:
            self.add(
                "QA09",
                "pass",
                "blocker",
                "检测到预清理、唯一同目录临时文件、符号链接保护和原子 replace。",
                graders,
                "动态增加 symlink/hardlink/FIFO/并发 TOCTOU 对抗测试。",
            )
        else:
            missing = [
                label
                for ok, label in (
                    (clears, "启动清理"),
                    (atomic, "原子 replace"),
                    (unique_temp, "唯一临时文件"),
                    (symlink_guard, "symlink 防护"),
                )
                if not ok
            ]
            self.add(
                "QA09",
                "fail",
                "blocker",
                "结果写入链路缺少: " + ", ".join(missing),
                graders,
                "由 trusted verifier 在可信目录创建唯一临时文件，拒绝特殊目标并原子替换。",
            )

    def agent_visible(self, rel: str) -> bool:
        manifest_rel = "qa_exposure_manifest.json"
        manifest = self.load_json(manifest_rel) if manifest_rel in self.files else None
        if isinstance(manifest, dict) and isinstance(manifest.get("agent_visible_paths"), list):
            for prefix in manifest["agent_visible_paths"]:
                if isinstance(prefix, str) and (rel == prefix or rel.startswith(prefix.rstrip("/") + "/")):
                    return True
            return False
        verifier = self.task_config.get("verifier") if isinstance(self.task_config, dict) else None
        if isinstance(verifier, dict) and verifier.get("environment_mode") == "separate" and rel.startswith("harbor_task/tests/"):
            return False
        return rel == "INIT_PROMPT.md" or rel.startswith("harbor_task/")

    def audit_isolation(self, instruction: str) -> None:
        hidden_files = [
            rel
            for rel in self.files
            if self.agent_visible(rel)
            and re.search(r"(^|/)(hidden_assets?|hidden_data|hidden_cases?)(/|\.|$)", rel, re.I)
            and not rel.endswith((".gitkeep", "/.keep"))
        ]
        leak_named = [
            rel
            for rel in self.files
            if self.agent_visible(rel)
            and re.search(
                r"(^|/)(reference_(?:grade|submission|replicate|evidence)|best_policy|expert_annotation|run_summary)(?:[./]|$)",
                rel,
                re.I,
            )
        ]
        docker = self.text("harbor_task/environment/Dockerfile")
        docker_hidden = self.line_refs(
            "harbor_task/environment/Dockerfile",
            r"^\s*(?:COPY|ADD)\s+.*(?:tests|hidden|expert_evidence|reference|solution)",
        )
        if hidden_files or docker_hidden:
            self.add(
                "QA07",
                "fail",
                "blocker",
                f"Agent 可见面中发现 {len(hidden_files)} 个 hidden 命名文件/资产，或 Docker COPY/ADD 泄露。",
                hidden_files[:20] + docker_hidden,
                "将非空 hidden_assets 仅构建进独立 Verifier 镜像；移除 Agent 镜像和可见面中的 tests/、隐藏集及评分实现。",
            )
        else:
            self.add(
                "QA07",
                "manual",
                "blocker",
                "源码树未发现直接 hidden 文件，但实际镜像层、挂载、env、/proc、IPC 和日志隔离尚未证明。",
                ["harbor_task/", "harbor_task/environment/Dockerfile"],
                "导出最终 Agent 视图和镜像层清单，以 Agent UID 做全盘/进程/IPC 泄露探测。",
            )

        exact_matches: list[str] = []
        expert_candidates = [
            rel
            for rel in self.files
            if rel.startswith("expert_evidence/")
            and re.search(r"best|reference|policy|solution", Path(rel).name, re.I)
            and self.path(rel).stat().st_size >= 64
        ]
        visible_candidates = [
            rel
            for rel in self.files
            if self.agent_visible(rel) and self.path(rel).stat().st_size >= 64
        ]
        expert_hashes: dict[str, str] = {}
        for rel in expert_candidates:
            try:
                expert_hashes[sha256_file(self.path(rel))] = rel
            except OSError:
                pass
        for rel in visible_candidates:
            try:
                digest = sha256_file(self.path(rel))
            except OSError:
                continue
            if digest in expert_hashes:
                exact_matches.append(f"{rel} == {expert_hashes[digest]}")
        if leak_named or exact_matches:
            self.add(
                "QA08",
                "fail",
                "blocker",
                "Agent 可见面含参考证据命名文件或与专家参考产物字节相同的文件。",
                leak_named[:20] + exact_matches[:12],
                "从最终 Agent 视图、所有镜像层、缓存与 Git 对象移除参考代码和派生结果。",
            )
        else:
            self.add(
                "QA08",
                "manual",
                "blocker",
                "未发现高置信参考产物字节复制，但历史、镜像层和实际 Agent 视图仍未证明。",
                expert_candidates[:8],
                "对最终 agent-view manifest、docker save 层和 Git 全对象做哈希与关键词扫描。",
            )

        immutable_copy = bool(
            re.search(r"^\s*COPY\s+trusted/.+\s+/opt/", docker, re.M | re.I)
            and re.search(r"chmod\s+0?(?:444|555)", docker, re.I)
        )
        graders = self.grader_files()
        combined = "\n".join(self.text(rel) for rel in graders)
        writable_import = bool(
            re.search(r"sys\.path\.insert\([^\n]*(?:starter|solution|workspace)", combined)
            or re.search(r"os\.environ\.get\([^\n]*(?:TASK_ROOT|MODEL_DIR|RUNTIME_ROOT)", combined)
        )
        if writable_import:
            self.add(
                "QA10",
                "fail",
                "blocker",
                "trusted grader 的根路径或导入面可受环境/Agent 可见目录影响。",
                graders,
                "从固定只读 digest 恢复所有冻结面，清空危险环境与 module cache，使用绝对可信导入路径。",
            )
        elif immutable_copy:
            self.add(
                "QA10",
                "manual",
                "blocker",
                "Dockerfile 将 trusted 文件复制到 /opt 并设只读，但尚无每次评估从可信 digest 恢复的运行证据。",
                ["harbor_task/environment/Dockerfile", *graders],
                "在正式 runner 中校验 digest/重建命名空间，并保存 Agent UID 写入失败证据。",
            )
        else:
            self.add(
                "QA10",
                "fail",
                "blocker",
                "未识别冻结 evaluator/guard/metric 的独立只读复制与恢复链路。",
                ["harbor_task/environment/Dockerfile", *graders],
                "将可信 evaluator 和依赖放入独立只读镜像层，并在评分时按 digest 恢复。",
            )

    def audit_git(self) -> None:
        git_paths = [rel for rel in self.files if rel == ".git" or "/.git/" in f"/{rel}/" or rel.startswith(".git/")]
        if not any(path == ".git/config" or path.startswith(".git/") for path in git_paths):
            self.add(
                "QA12",
                "pass",
                "high",
                "交付包中未发现 .git 元数据。",
                [],
            )
            return
        config = self.text(".git/config")
        risky = []
        if re.search(r"\[remote\s+", config):
            risky.append(".git/config: remote")
        risky.extend(
            rel
            for rel in git_paths
            if re.search(r"^\.git/(?:logs|refs/tags|refs/remotes|refs/stash|refs/notes|refs/replace)/", rel)
        )
        self.add(
            "QA12",
            "fail" if risky else "manual",
            "high",
            "发现 Git 远端/ref/reflog。" if risky else "存在 .git；静态文件列表无法证明无 unreachable objects。",
            risky[:30] or git_paths[:12],
            "记录外部 provenance 后从交付包移除 .git，并扫描 LFS/submodule/patch/备份文件。",
        )

    def audit_baseline_headroom(self, docs: dict[str, object], instruction: str) -> None:
        baseline, reference = self.score_evidence(docs)
        good_reference = [value for value in reference if value >= 0.15]
        pairs = self.find_series_pairs(docs)
        serialized_docs = json.dumps(docs, ensure_ascii=False).lower()
        hidden_not_run = bool(
            re.search(r"hidden.{0,160}not_run", serialized_docs)
            or '"status": "pilot_required"' in serialized_docs
        )
        baseline_raw = bool(
            re.search(r"baseline_(?:ppl|latency|metric)|gpu_public_ppl|hidden_ppl", serialized_docs, re.I)
            or pairs
        )
        if baseline and good_reference and baseline_raw and not hidden_not_run:
            self.add(
                "QA13",
                "pass",
                "high",
                "存在 baseline 原始指标/归一化锚点及显著提升的 reference 证据。",
                list(docs),
                "仍需按同一可信 hidden 协议干净复跑，排除人为弱化 baseline。",
            )
        else:
            self.add(
                "QA13",
                "fail",
                "high",
                "缺少可核验 baseline 原始指标/参考提升，或正式 hidden 明确未运行。",
                list(docs),
                "提供同协议 baseline/reference 原始日志与归一化计算。",
            )
        strongest = []
        serialized = json.dumps(docs)
        for match in re.finditer(r'"(?:strongest_observed_agent_score|final_score|normalized_score)"\s*:\s*(-?\d+(?:\.\d+)?)', serialized):
            value = self.finite_number(match.group(1))
            if value is not None:
                strongest.append(value)
        reference_below_cap = any(0.15 <= value <= 0.8 for value in reference)
        headroom = reference_below_cap and (any(value > min(reference) for value in strongest) or max(reference, default=1) < 0.8)
        self.add(
            "QA14",
            "manual",
            "medium",
            "分数证据显示参考未达 1 且可能有 headroom；“至少一种合法且未提示方向”必须人工/盲测确认。"
            if headroom
            else "未找到足够 headroom 证据，且无法证明存在未提示的合法改进方向。",
            list(docs),
            "由不知道参考方法的审阅者完成盲审，并保存不泄露方法的 headroom 证明。",
        )

    def audit_resources(self, docs: dict[str, object], instruction: str) -> None:
        cpu = self.finite_number(self.nested(self.task_config, "resources", "cpu_cores"))
        gpu = self.finite_number(self.nested(self.task_config, "resources", "gpu_count"))
        gpu_type = self.nested(self.task_config, "resources", "gpu_type")
        time_limit = self.finite_number(self.nested(self.task_config, "task", "time_limit_seconds"))
        valid = (
            cpu is not None
            and cpu <= 64
            and gpu is not None
            and gpu <= 8
            and isinstance(gpu_type, str)
            and any(kind in gpu_type.upper() for kind in ("H20", "L20"))
            and time_limit is not None
            and time_limit <= 7200
        )
        evidence = [
            f"harbor_task/task.toml: cpu={cpu}, gpu={gpu}, gpu_type={gpu_type}, time_limit={time_limit}"
        ]
        self.add(
            "QA15",
            "pass" if valid else "fail",
            "high",
            "声明资源满足 ≤2h、≤8 GPU、H20/L20、≤64C。" if valid else "task.toml 的资源/时限不满足清单或字段缺失。",
            evidence,
            "同步修正 task.toml、题面与调度器/cgroup 硬限制。",
        )

        serialized = json.dumps(docs, ensure_ascii=False).lower()
        stability_positive = bool(
            re.search(r"twelve_hour_stability[^}]{0,120}(?:passed|measured|ok)", serialized)
            or re.search(r"12[-_ ]?hour[^}]{0,120}(?:passed|measured|ok)", serialized)
        ) and not bool(re.search(r"twelve_hour_stability[^}]{0,80}not_measured", serialized))
        self.add(
            "QA16",
            "pass" if stability_positive else "fail",
            "high",
            "存在 12 小时稳定性通过声明；仍需核对原始资源快照。"
            if stability_positive
            else "没有 12 小时稳定性通过证据，或明确标为 not_measured。",
            list(docs),
            "完成 12h soak，记录内存/FD/PID/磁盘/GPU/日志增长和退出状态。",
        )

        docker = self.text("harbor_task/environment/Dockerfile")
        requirements = self.text("harbor_task/environment/requirements.txt")
        volume = bool(re.search(r"^\s*VOLUME\b|--mount\s+type=bind", docker, re.M | re.I))
        installs = bool(re.search(r"pip\s+install|conda\s+install|uv\s+sync", docker, re.I))
        copies_data = bool(re.search(r"^\s*(?:COPY|ADD)\s+.*public", docker, re.M | re.I))
        pinned = bool(requirements) and all(
            not line.strip()
            or line.lstrip().startswith("#")
            or "==" in line
            or " @ " in line
            for line in requirements.splitlines()
        )
        if installs and copies_data and pinned and not volume:
            self.add(
                "QA17",
                "pass",
                "high",
                "Dockerfile 静态显示依赖/公开数据预构建，requirements 有版本固定且未声明 Volume/bind。",
                ["harbor_task/environment/Dockerfile", "harbor_task/environment/requirements.txt"],
                "以最终镜像离线启动验证，不得依赖宿主缓存或隐式挂载。",
            )
        else:
            self.add(
                "QA17",
                "fail",
                "high",
                "未证明依赖与公开数据预构建，或检测到运行时 Volume/bind/未固定依赖。",
                ["harbor_task/environment/Dockerfile", "harbor_task/environment/requirements.txt"],
                "预构建并固定依赖/数据；移除运行时必需的 Volume Mount。",
            )

    def audit_evidence(self, docs: dict[str, object], instruction: str) -> None:
        run_groups: dict[str, set[str]] = {}
        for rel in self.files:
            match = re.search(r"(?:^|/)expert_evidence/runs/([^/]+)/([^/]+)$", rel)
            if match:
                run_groups.setdefault(f"{rel[:match.start(1)]}{match.group(1)}", set()).add(match.group(2))
        complete_runs = [
            run_id
            for run_id, names in run_groups.items()
            if "run.json" in names
            and "trajectory.json" in names
            and ("stdout.jsonl" in names or "stderr.log" in names)
        ]
        analysis = any(
            rel in self.files
            for rel in (".cc-exp/analysis.json", ".cc-exp/trajectory_analysis.html")
        )
        self.add(
            "QA18",
            "pass" if complete_runs and analysis else "fail",
            "high",
            f"完整根级运行记录={len(complete_runs)}，trajectory analysis={analysis}。",
            [f"{run_id}/" for run_id in complete_runs[:8]]
            + ([".cc-exp/analysis.json"] if analysis else []),
            "至少保留一个可核验 run 的 prompt/run/stdout或stderr/trajectory，并提交解析统计。",
        )

        pairs = self.find_series_pairs(docs)
        deterministic = self.evaluation_is_deterministic(docs, instruction)
        fluctuating = any(statistics.pstdev(pair[2]) > 0 for pair in pairs)
        has_seed = bool(re.search(r"\bseeds?\b", instruction, re.I))
        has_replicate = bool(re.search(r"replicate|repetition|repeated|重复|复现", instruction, re.I))
        has_sigma = bool(re.search(r"3\s*(?:sigma|σ)|three\s+baseline|三倍", instruction, re.I))
        if deterministic:
            self.add(
                "QA19",
                "not_applicable",
                "info",
                "任务声明为确定性评估；随机 seed/replicate/3σ 题面规则不适用。",
                ["harbor_task/task.toml", "harbor_task/instruction.md"],
                "若运行证据出现波动，应撤销确定性声明并补齐随机性协议。",
            )
        elif fluctuating and not (has_seed and has_replicate and has_sigma):
            self.add(
                "QA19",
                "fail",
                "high",
                "原始结果有波动，但题面未同时声明 seed、replicate 与 3σ 有效提升阈值。",
                ["harbor_task/instruction.md", *[pair[0] for pair in pairs]],
                "在题面预声明 seed/warmup/配对顺序/重复次数/sigma 口径/3σ 阈值。",
            )
        elif pairs and (has_seed or not fluctuating):
            self.add(
                "QA19",
                "pass",
                "high",
                "随机性/复现信息与原始 replicate 证据一致；波动任务含阈值声明。",
                ["harbor_task/instruction.md", *[pair[0] for pair in pairs]],
                "确认 trusted RNG 与 candidate RNG 状态隔离。",
            )
        else:
            self.add(
                "QA19",
                "manual",
                "high",
                "未检测到足够原始数组来判定是否有波动，随机性协议需人工确认。",
                ["harbor_task/instruction.md"],
                "提供 replicate 原始值和完整随机性协议。",
            )

        scope = bool(re.search(r"modify|修改|writable|只.*修改", instruction, re.I))
        network = bool(re.search(r"network|网络", instruction, re.I))
        web = bool(re.search(r"WebSearch|WebFetch|web search|网页搜索", instruction, re.I))
        tools = bool(re.search(r"script|command|evaluator|runner|工具|脚本|命令|评分入口", instruction, re.I))
        if scope and network and web and tools:
            self.add(
                "QA20",
                "pass",
                "high",
                "题面明确修改范围、网络、WebSearch/WebFetch 与评分工具。",
                ["harbor_task/instruction.md"],
                "动态验证策略由沙盒/网络层强制。",
            )
        else:
            missing = [name for ok, name in ((scope, "修改范围"), (network, "网络"), (web, "WebSearch/WebFetch"), (tools, "工具/脚本")) if not ok]
            self.add(
                "QA20",
                "fail",
                "high",
                "题面缺少: " + ", ".join(missing),
                ["harbor_task/instruction.md"],
                "在 Allowed Scope/Hard Boundaries 明确并由环境强制这些策略。",
            )

        annotation_rel = "expert_evidence/expert_annotation.json"
        summary_rel = "expert_evidence/run_summary.json"
        annotation = self.load_json(annotation_rel)
        summary = self.load_json(summary_rel)
        annotation_keys = (
            "schema_version",
            "task_type",
            "research_direction",
            "model",
            "metric",
            "reference",
            "selected_agent",
            "verification",
        )
        summary_keys = (
            "schema_version",
            "batch_id",
            "evaluation_protocol",
            "baseline",
            "reference",
            "agent_results",
            "selected_policy",
            "trajectory_validation",
            "execution_note",
        )
        annotation_ok = isinstance(annotation, dict) and annotation.get("schema_version") == 1 and all(
            key in annotation for key in annotation_keys
        )
        summary_ok = isinstance(summary, dict) and summary.get("schema_version") == 1 and all(
            key in summary for key in summary_keys
        )
        trajectory_rel = "expert_evidence/trajectory.json"
        trajectory_ok, trajectory_note = self.validate_trajectory(trajectory_rel)
        if annotation_ok and summary_ok and trajectory_ok:
            self.add(
                "QA21",
                "pass",
                "high",
                "三个核心证据文件满足 schema_version=1、必填结构与 JSONL trial 基本一致性。",
                [annotation_rel, summary_rel, trajectory_rel],
                "继续核对 highlight 字段与原始日志/哈希逐项一致。",
            )
        else:
            self.add(
                "QA21",
                "fail",
                "high",
                f"annotation={annotation_ok}, run_summary={summary_ok}, trajectory={trajectory_ok} ({trajectory_note})。",
                [annotation_rel, summary_rel, trajectory_rel],
                "按教程 schema 重写；trajectory 用逐行 JSON object、trial 从 0 递增并保留失败原因。",
            )

    def validate_trajectory(self, rel: str) -> tuple[bool, str]:
        path = self.path(rel)
        if not path.is_file() or path.stat().st_size == 0:
            return False, "missing/empty"
        if path.stat().st_size > 32 * 1024**2:
            return False, "too large for formal-trial file"
        required = {"trial", "method", "status", "score", "score_direction", "score_metric", "failure_reason"}
        trials: list[int] = []
        directions: set[str] = set()
        try:
            with path.open("r", encoding="utf-8") as stream:
                for number, line in enumerate(stream, 1):
                    if not line.strip():
                        continue
                    item = json.loads(line)
                    if not isinstance(item, dict) or not required.issubset(item):
                        return False, f"line {number} missing formal-trial fields"
                    if not isinstance(item["trial"], int):
                        return False, f"line {number} trial is not int"
                    trials.append(item["trial"])
                    directions.add(str(item["score_direction"]))
                    status_name = str(item.get("status", "")).lower()
                    if re.search(r"fail|error|invalid|timeout", status_name) and not item.get("failure_reason"):
                        return False, f"line {number} failure has no reason"
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            return False, f"parse error: {exc}"
        if not trials:
            return False, "no records"
        if trials[0] != 0:
            return False, f"first trial is {trials[0]}, expected 0"
        if trials != sorted(trials) or len(trials) != len(set(trials)):
            return False, "trial IDs are not unique/increasing"
        if len(directions) != 1:
            return False, "mixed score directions"
        return True, f"{len(trials)} records"

    def audit_expert_cheating(self, docs: dict[str, object], instruction: str) -> None:
        all_code = "\n".join(
            self.text(rel)
            for rel in self.files
            if rel.startswith("harbor_task/") and rel.endswith((".py", ".sh"))
        )
        baseline_paths = [
            rel
            for rel in self.files
            if self.agent_visible(rel)
            and re.search(r"starter|baseline|reference_policy", rel, re.I)
            and rel.endswith((".py", ".sh"))
        ]
        sandbag = self.line_refs("harbor_task/solution/reference_policy.py", r"sleep\s*\(|time\.sleep|dummy|intentionally slow|故意")
        self.add(
            "EX01",
            "warn" if sandbag else "manual",
            "high",
            "发现疑似人为延迟/弱化。" if sandbag else "静态未发现显式 sleep/dummy，但 baseline 合理性与参考资源对等仍需领域审阅。",
            sandbag or baseline_paths[:10],
            "用同硬件/数据/精度/资源与常见公开基线复核，记录 baseline 选择理由。",
        )

        evidence_text = "\n".join(
            self.text(rel)
            for rel in self.files
            if (rel.startswith("expert_evidence/") or "reference_evidence/" in rel)
            and rel.endswith((".md", ".json"))
            and self.path(rel).stat().st_size <= MAX_TEXT_BYTES
        )
        cherry = []
        cherry_pattern = r"(?:selected|choose|intentionally|特意|选择).{0,140}(?:0\.15|0\.8|required range|区间)|recalibrat|重新标定"
        for rel in self.files:
            if (rel.startswith("expert_evidence/") or "reference_evidence/" in rel) and rel.endswith((".md", ".json")):
                cherry.extend(self.line_refs(rel, cherry_pattern, limit=4))
        self.add(
            "EX02",
            "warn" if cherry else "manual",
            "high",
            "证据文字暗示按目标分数区间挑参考解或事后重标定锚点。" if cherry else "未命中高置信事后调参措辞，但缺少锚点/参考冻结时间线。",
            cherry[:16],
            "预注册 B/U/reference 与选择规则，保留所有版本和 hidden 首次使用时间。",
        )

        serialized_docs = json.dumps(docs, ensure_ascii=False)
        hidden_selection_zero = bool(
            re.search(r'"hidden_test_uses_for_policy_selection"\s*:\s*0', serialized_docs)
        )
        hidden_metric_occurrences = len(re.findall(r"hidden_(?:ppl|score)", serialized_docs, re.I))
        rejected_hidden_outcomes = bool(
            re.search(r'"rejected_expert_attempts"[\s\S]{0,3000}"hidden_(?:ppl|score)"', serialized_docs, re.I)
        )
        if not hidden_selection_zero:
            status = "warn" if hidden_metric_occurrences else "manual"
            summary = "未找到 hidden selection 次数为 0 的结构化证据。"
        elif rejected_hidden_outcomes or hidden_metric_occurrences > 20:
            status = "warn"
            summary = f"声明 selection uses=0，但专家证据含被拒方案的 hidden 结果或出现 {hidden_metric_occurrences} 次 hidden 指标字段，需核对是否形成 oracle。"
        else:
            status = "pass"
            summary = "声明 hidden_test_uses_for_policy_selection=0，未发现大量 hidden 反馈。"
        self.add(
            "EX03",
            status,
            "blocker",
            summary,
            [rel for rel in docs if "run_summary" in rel],
            "hidden 仅 final-only/限次 score-only；记录每次调用主体、时间、候选 hash 和返回字段。",
        )

        declared_hashes = set(re.findall(r"\b[0-9a-f]{64}\b", evidence_text, re.I))
        matched_hashes: list[str] = []
        if declared_hashes:
            for rel in self.files:
                if rel.startswith("expert_evidence/") and self.path(rel).stat().st_size <= 64 * 1024**2:
                    try:
                        digest = sha256_file(self.path(rel))
                    except OSError:
                        continue
                    if digest in declared_hashes:
                        matched_hashes.append(f"{rel}: {digest}")
        pairs = self.find_series_pairs(docs)
        self.add(
            "EX04",
            "pass" if matched_hashes and pairs else "warn",
            "high",
            "至少一个声明 hash 命中实际专家产物，且统计可由原始数组复算。"
            if matched_hashes and pairs
            else "缺少可命中的产物 hash 或可复算原始统计，证据可能陈旧/自报。",
            matched_hashes[:8] + [pair[0] for pair in pairs],
            "为 selected artifact/image/data/verifier 保存 digest，并从 raw run 自动生成 summary。",
        )

        prompt_hints = self.line_refs(
            "INIT_PROMPT.md",
            r"sensitivity|prefilter|cpu proxy|dynamic program|fused|tensor[- ]core|protect(?:ed)? columns|敏感度|融合|动态规划",
            limit=20,
        )
        self.add(
            "EX05",
            "fail" if prompt_hints else "manual",
            "high",
            "INIT_PROMPT.md 含具体优化工具/路线提示。" if prompt_hints else "未命中高置信 prompt 方法提示；文件名、公开统计和测试期望仍需语义审阅。",
            prompt_hints,
            "INIT_PROMPT 仅保留任务入口与流程；删除能缩小参考方法搜索空间的提示。",
        )

        docker = self.text("harbor_task/environment/Dockerfile")
        docker_rel = "harbor_task/environment/Dockerfile"
        broad_copy = self.line_refs(docker_rel, r"^\s*(?:COPY|ADD)\s+(?:\.|\.\.|/|https?://)")
        secret_arg = self.line_refs(docker_rel, r"^\s*(?:ARG|ENV)\s+.*(?:TOKEN|SECRET|PASSWORD|KEY)\b")
        deleted_secret = bool(broad_copy and re.search(r"\brm\b", docker))
        if broad_copy or secret_arg or deleted_secret:
            self.add(
                "EX06",
                "fail",
                "blocker",
                "Dockerfile 使用宽 COPY/ADD、疑似秘密 ARG/ENV 或复制后删除模式。",
                broad_copy + secret_arg,
                "最小化 build context，使用 secret mount，重建镜像并逐层扫描；不要靠后层删除。",
            )
        else:
            self.add(
                "EX06",
                "manual",
                "blocker",
                "Dockerfile 未命中宽复制，但只有 docker save/history 层扫描才能证明无泄露。",
                [docker_rel],
                "扫描最终镜像每一层、history、缓存与 /opt/model/cache 等目录。",
            )

        risky_env = []
        for rel in self.grader_files():
            risky_env.extend(self.line_refs(rel, r"os\.environ\.(?:get|pop)|sys\.path\.insert|runpy\.run_path"))
        unsafe_deser = []
        for rel in self.files:
            if rel.startswith("harbor_task/") and rel.endswith(".py"):
                unsafe_deser.extend(self.line_refs(rel, r"pickle\.load|torch\.load\([^\n]*(?:submission|candidate)|yaml\.load\("))
        self.add(
            "EX07",
            "warn" if risky_env or unsafe_deser else "manual",
            "blocker",
            "发现环境驱动路径、runpy/sys.path 或可疑反序列化攻击面。" if risky_env or unsafe_deser else "静态未命中常见接管面；仍需对抗样本动态测试。",
            (risky_env + unsafe_deser)[:24],
            "固定可信根、清理环境/import cache、拒绝特殊路径和不安全反序列化，并用恶意提交回归。",
        )

        timing_task = bool(re.search(r"latency|timing|吞吐|时延", instruction, re.I))
        if timing_task:
            timing_patterns = {
                "sync": r"cuda.*synchron|\.synchronize\(",
                "alternate": r"repeat\s*%\s*2|alternat|paired",
                "input_copy": r"clone\(\)|copy_\(|modified.*in place",
                "persistent": r"persistent.*memory|memory_allocated|mem_get_info",
            }
            missing = [name for name, pattern in timing_patterns.items() if not re.search(pattern, all_code, re.I)]
            self.add(
                "EX08",
                "warn" if missing else "pass",
                "high",
                "计时防作弊静态要素缺少: " + ", ".join(missing) if missing else "检测到同步、交替顺序、输入突变和持久内存检查。",
                self.grader_files(),
                "增加 mode/shape/value/order 变化、缓存输出、热/频率污染和后台 GPU 工作对抗测试。",
            )
        else:
            self.add("EX08", "not_applicable", "info", "任务非计时型或未识别 latency 目标。")

        requirements = self.text("harbor_task/environment/requirements.txt")
        unpinned = [
            f"harbor_task/environment/requirements.txt:{number}"
            for number, line in enumerate(requirements.splitlines(), 1)
            if line.strip() and not line.lstrip().startswith("#") and "==" not in line and " @ " not in line
        ]
        from_line = next((line for line in docker.splitlines() if line.upper().startswith("FROM ")), "")
        base_digest = "@sha256:" in from_line
        self.add(
            "EX10",
            "pass" if not unpinned and base_digest else "warn",
            "medium",
            "依赖与 base image 均固定。" if not unpinned and base_digest else "requirements 可能固定，但 base image 未按 digest 固定或存在未固定依赖。",
            unpinned + (["harbor_task/environment/Dockerfile:1"] if from_line and not base_digest else []),
            "固定 requirements/hash、base image digest、模型 revision/hash、CUDA/compiler/runtime。",
        )

        public_files = [rel for rel in self.files if re.search(r"public_(?:assets|cases|data)|/public/", rel, re.I)]
        hidden_files = [rel for rel in self.files if re.search(r"hidden_(?:assets|cases|data)|/hidden/", rel, re.I)]
        public_hashes: dict[str, str] = {}
        for rel in public_files:
            try:
                public_hashes[sha256_file(self.path(rel))] = rel
            except OSError:
                pass
        duplicate_splits = []
        for rel in hidden_files:
            try:
                digest = sha256_file(self.path(rel))
            except OSError:
                continue
            if digest in public_hashes:
                duplicate_splits.append(f"{rel} == {public_hashes[digest]}")
        self.add(
            "EX11",
            "fail" if duplicate_splits else "manual",
            "high",
            "发现 public/hidden 完全相同文件。" if duplicate_splits else "未发现整文件 hash 重复；记录级/近重复与 seed 污染尚未证明。",
            duplicate_splits,
            "对样本 ID、内容 hash、近重复、生成 seed/顺序/哨兵元数据做可信去重审计。",
        )

        timeout_refs = []
        for rel in self.files:
            if rel.startswith("harbor_task/") and rel.endswith((".py", ".sh")):
                timeout_refs.extend(self.line_refs(rel, r"timeout|kill-after|start_new_session|process group|cgroup"))
        descendant_safe = bool(re.search(r"kill-after|start_new_session|killpg|cgroup", all_code, re.I))
        self.add(
            "EX12",
            "manual" if descendant_safe else "warn",
            "high",
            "检测到超时/后代清理线索，但 FD/PID/磁盘/GPU/cgroup 需动态验证。" if descendant_safe else "未识别可靠进程组/cgroup 后代清理；普通 subprocess timeout 可能遗留子进程。",
            timeout_refs[:20],
            "用 cgroup/namespace 强制 wall time、PID/FD/thread/disk/output/GPU 限额并杀死整组。",
        )

        duplicate_tests: list[str] = []
        skipped: list[str] = []
        for rel in self.files:
            if not (rel.startswith("harbor_task/tests/") and rel.endswith(".py")):
                continue
            source = self.text(rel)
            try:
                tree = ast.parse(source)
            except SyntaxError:
                duplicate_tests.append(f"{rel}: syntax error")
                continue
            seen: dict[str, int] = {}
            for node in tree.body:
                if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name.startswith("test_"):
                    if node.name in seen:
                        duplicate_tests.append(f"{rel}:{node.lineno} duplicates line {seen[node.name]} ({node.name})")
                    seen[node.name] = node.lineno
            if re.search(r"pytest\.mark\.(?:skip|xfail)|pytest\.skip\(", source):
                skipped.append(rel)
        self.add(
            "EX13",
            "fail" if duplicate_tests else ("warn" if skipped else "pass"),
            "high",
            "测试函数重名会覆盖前一测试。" if duplicate_tests else ("存在 skip/xfail，需说明。" if skipped else "未发现重复 test_ 函数或显式 skip/xfail。"),
            duplicate_tests + skipped,
            "保证收集测试数与声明一致；移除重名，并让测试调用独立 trusted 路径而非自证 JSON。",
        )

        manifest = self.load_json("qa_exposure_manifest.json") if "qa_exposure_manifest.json" in self.files else None
        self.add(
            "EX14",
            "manual" if not isinstance(manifest, dict) else "warn",
            "blocker",
            "缺少 qa_exposure_manifest.json，采用了保守 Agent 可见面，实际交付隔离未证明。"
            if not isinstance(manifest, dict)
            else "存在 exposure manifest，但仍需与最终镜像/挂载字节比对。",
            ["qa_exposure_manifest.json"] if isinstance(manifest, dict) else [],
            "生成 final Agent-view allowlist（路径、权限、hash、来源层）并由独立 runner 校验。",
        )

        diagnostic_refs: list[str] = []
        for rel in self.grader_files():
            diagnostic_refs.extend(
                self.line_refs(
                    rel,
                    r"hidden_ppl|baseline_ppl|attainable_ppl|case_results|candidate_p50|baseline_p50|config_name|stderr_tail|traceback",
                    limit=20,
                )
            )
        self.add(
            "EX15",
            "warn" if diagnostic_refs else "manual",
            "high",
            "grader 可能输出 hidden 原始指标、锚点、逐 case 或内部错误诊断；若 Agent 可见将形成 oracle。"
            if diagnostic_refs
            else "未命中常见 hidden 诊断字段，但评分可见性和限次策略仍未证明。",
            diagnostic_refs[:24],
            "hidden 返回 score-only 并 final-only/限次；完整诊断仅写入 Agent 不可见可信日志。",
        )

        pairs = self.find_series_pairs(docs)
        replicated = bool(pairs)
        predeclared = bool(re.search(r"replicate|repeated|repetition|重复|复现", instruction, re.I))
        self.add(
            "EX16",
            "manual" if replicated and predeclared else "warn",
            "high",
            "有原始重复值和题面规则，但独立性、可选停止与窗口选择仍需运行审计。"
            if replicated and predeclared
            else "缺少预声明重复统计或原始数组，无法排除挑窗口/可选停止。",
            [pair[0] for pair in pairs],
            "在运行前冻结 n、warmup、outlier、停止规则、sigma 口径，并保留全部连续结果。",
        )


def render_markdown(report: dict) -> str:
    policy = report.get("policy", {"name": "strict", "adjustments": []})
    policy_name = policy.get("name", "strict")
    policy_label = "宽松预检" if policy_name == "precheck" else "严格终审"
    lines = [
        "# AutoResearch 自动质检报告",
        "",
        f"- 结论：**{report['summary']['decision']}**",
        f"- 判定策略：**{policy_name}（{policy_label}）**",
        f"- 来源：`{report['source']['path']}`",
        f"- 文件数：{report['source']['file_count']}",
        f"- 状态计数：`{json.dumps(report['summary']['counts'], ensure_ascii=False, sort_keys=True)}`",
        f"- Blocker：{report['summary']['blockers']}",
        "",
        "> 本报告是静态审计。manual/unproven 不是 pass；动态 gate 完成前不能作为最终 GO。",
        "",
    ]
    adjustments = policy.get("adjustments", [])
    if policy_name == "precheck":
        lines.extend(
            [
                "> 当前为宽松预检：除压缩包安全失败外，严格 FAIL 均作为 WARN 保留；不能将本报告当作交付终审通过证明。",
                "",
                "## 策略调整",
                "",
            ]
        )
        if adjustments:
            lines.extend(
                f"- `{item['id']}`：{item['from'].upper()}/{item.get('from_severity', 'unknown')} "
                f"→ {item['to'].upper()}/{item.get('to_severity', 'unknown')}"
                "（strict 模式仍为 FAIL）"
                for item in adjustments
            )
        else:
            lines.append("- 本次无状态降级。")
        lines.append("")
    lines.extend(
        [
            "## 质检清单逐项结论",
            "",
            "| 序号 | ID | 检查项 | 是否通过 | 原因 | 主要证据 |",
            "|---:|---|---|---|---|---|",
        ]
    )
    for index, item in enumerate(report["checks"], 1):
        evidence = "<br>".join(markdown_cell(value) for value in item.get("evidence", [])[:3]) or "无"
        lines.append(
            f"| {index} | {item['id']} | {markdown_cell(item['title'])} | "
            f"{checklist_verdict(item['status'], policy_name)} | "
            f"{markdown_cell(item['summary'])} | {evidence} |"
        )
    lines.extend(
        [
            "",
            "> “有条件通过”表示宽松预检不阻断，但 strict 终审仍可能不通过；“待人工复核”不等于已通过。",
            "",
            "## 必查清单详细说明",
            "",
        ]
    )
    for item in report["checks"]:
        lines.extend(render_check(item))
    lines.extend(["## 专家作弊面", ""])
    for item in report["extra_checks"]:
        lines.extend(render_check(item))
    lines.extend(["## 假设与限制", ""])
    lines.extend(f"- {value}" for value in report["assumptions"])
    lines.append("")
    lines.extend(f"- {value}" for value in report["limitations"])
    lines.append("")
    return "\n".join(lines)


def markdown_cell(value: object) -> str:
    return str(value).replace("|", "\\|").replace("\r", " ").replace("\n", " ").strip()


def checklist_verdict(status: str, policy_name: str) -> str:
    if status == "pass":
        return "✅ 通过"
    if status == "not_applicable":
        return "➖ 不适用"
    if status == "warn" and policy_name == "precheck":
        return "⚠️ 有条件通过"
    if status == "manual":
        return "⏳ 待人工复核"
    return "❌ 不通过"


def render_check(item: dict) -> list[str]:
    lines = [
        f"### {item['id']} [{item['status'].upper()} / {item['severity']}] {item['title']}",
        "",
        item["summary"],
        "",
    ]
    if item["evidence"]:
        lines.append("证据：")
        lines.append("")
        lines.extend(f"- `{evidence}`" for evidence in item["evidence"])
        lines.append("")
    if item["remediation"]:
        lines.extend([f"修复：{item['remediation']}", ""])
    return lines


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="workspace directory or ZIP")
    parser.add_argument("--out-dir", type=Path, default=Path("qa-report"))
    parser.add_argument(
        "--policy",
        choices=("precheck", "strict"),
        default="precheck",
        help="precheck makes content/compliance failures advisory; strict preserves release-gate failures",
    )
    parser.add_argument(
        "--fail-on",
        choices=("fail", "warn", "manual", "never"),
        default="never",
        help="non-zero exit threshold; default never so reports are always generated",
    )
    return parser.parse_args()


def exit_required(report: dict, threshold: str) -> bool:
    if threshold == "never":
        return False
    statuses = {item["status"] for item in report["checks"] + report["extra_checks"]}
    if threshold == "fail":
        return "fail" in statuses
    if threshold == "warn":
        return bool(statuses & {"fail", "warn"})
    return bool(statuses & {"fail", "warn", "manual"})


def main() -> int:
    selected = next((arg.split("=", 1)[1] for arg in sys.argv[1:] if arg.startswith("--policy=")), None)
    if "--policy" in sys.argv:
        pos = sys.argv.index("--policy")
        selected = sys.argv[pos + 1] if pos + 1 < len(sys.argv) else None
    if selected != "strict":
        from implementation_review import main as implementation_main
        return implementation_main()
    args = parse_args()
    source = args.source.expanduser().resolve()
    if not source.exists():
        print(f"source does not exist: {source}", file=sys.stderr)
        return 2
    temporary: tempfile.TemporaryDirectory[str] | None = None
    try:
        if source.is_file():
            if not zipfile.is_zipfile(source):
                print("source file must be a ZIP", file=sys.stderr)
                return 2
            temporary = tempfile.TemporaryDirectory(prefix="autoresearch-qa-")
            extraction_root = Path(temporary.name)
            facts = safe_extract_zip(source, extraction_root)
            if facts.unsafe_entries:
                report = {
                    "schema_version": 1,
                    "generated_at": datetime.now(timezone.utc).isoformat(),
                    "source": {
                        "path": str(source),
                        "kind": facts.kind,
                        "sha256": facts.sha256,
                        "file_count": facts.file_count,
                        "uncompressed_bytes": facts.uncompressed_bytes,
                    },
                    "workspace_root": None,
                    "policy": {
                        "name": args.policy,
                        "strict_release_certification": args.policy == "strict",
                        "adjustments": [],
                    },
                    "assumptions": [],
                    "summary": {
                        "decision": "NO-GO",
                        "counts": {"pass": 0, "fail": 1, "warn": 0, "manual": 0, "not_applicable": 0},
                        "blockers": 1,
                    },
                    "checks": [],
                    "extra_checks": [
                        asdict(
                            Check(
                                "EX09",
                                EXTRA_TITLES["EX09"],
                                "fail",
                                "blocker",
                                "ZIP preflight failed; no members were extracted.",
                                facts.unsafe_entries[:50],
                                "Rebuild the archive with regular, bounded, unique relative paths.",
                            )
                        )
                    ],
                    "limitations": [],
                }
            else:
                root = locate_workspace(extraction_root)
                report = Auditor(root, source, facts, policy=args.policy).run()
        elif source.is_dir():
            facts = directory_facts(source)
            root = locate_workspace(source)
            report = Auditor(root, source, facts, policy=args.policy).run()
        else:
            print("source must be a regular directory or ZIP", file=sys.stderr)
            return 2

        out_dir = args.out_dir.expanduser().resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        json_path = out_dir / "report.json"
        markdown_path = out_dir / "report.md"
        json_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2, sort_keys=False) + "\n",
            encoding="utf-8",
        )
        markdown_path.write_text(render_markdown(report), encoding="utf-8")
        print(json.dumps({"decision": report["summary"]["decision"], "report_json": str(json_path), "report_md": str(markdown_path)}, ensure_ascii=False))
        return 1 if exit_required(report, args.fail_on) else 0
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        print(f"audit failed safely: {exc}", file=sys.stderr)
        return 2
    finally:
        if temporary is not None:
            temporary.cleanup()


if __name__ == "__main__":
    raise SystemExit(main())
