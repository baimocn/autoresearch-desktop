#!/usr/bin/env python3
"""Merge normalized paper candidates without network access or third-party packages."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

ID_FIELDS = ("doi", "arxiv", "openalex", "semantic_scholar")
TRACKING_PARAMS = {"fbclid", "gclid", "ref", "source", "utm_campaign", "utm_content", "utm_medium", "utm_source", "utm_term"}


def compact_space(value: str) -> str:
    return " ".join(value.split())


def normalize_title(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    value = re.sub(r"[^\w]+", " ", value, flags=re.UNICODE)
    return compact_space(value)


def normalize_identifier(kind: str, value: object) -> str | None:
    if value is None:
        return None
    text = compact_space(str(value)).strip().casefold()
    if not text:
        return None
    if kind == "doi":
        text = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", text)
    elif kind == "arxiv":
        text = re.sub(r"^(?:https?://arxiv\.org/(?:abs|pdf)/|arxiv:\s*)", "", text)
        text = re.sub(r"\.pdf$", "", text)
        text = re.sub(r"v\d+$", "", text)
    elif kind == "openalex":
        text = re.sub(r"^https?://openalex\.org/", "", text)
    elif kind == "semantic_scholar":
        text = re.sub(r"^https?://(?:www\.)?semanticscholar\.org/paper/(?:[^/]+/)?", "", text)
    return text.rstrip("/") or None


def normalize_url(value: object) -> str | None:
    if value is None:
        return None
    text = compact_space(str(value)).strip()
    if not text:
        return None
    parts = urlsplit(text)
    if parts.scheme.casefold() not in {"http", "https"} or not parts.netloc:
        return text.rstrip("/")
    host = parts.hostname.casefold() if parts.hostname else ""
    port = parts.port
    netloc = host if port is None else f"{host}:{port}"
    path = re.sub(r"/+", "/", parts.path).rstrip("/")
    query = urlencode(sorted((key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key.casefold() not in TRACKING_PARAMS))
    return urlunsplit(("https", netloc, path, query, ""))


def normalize_record(raw: dict, source_name: str, ordinal: int) -> dict:
    title = compact_space(str(raw.get("title", "")))
    if not title:
        raise ValueError(f"{source_name}[{ordinal}] has no title")
    raw_ids = raw.get("identifiers") or {}
    if not isinstance(raw_ids, dict):
        raise ValueError(f"{source_name}[{ordinal}].identifiers must be an object")
    identifiers = {kind: normalized for kind in ID_FIELDS if (normalized := normalize_identifier(kind, raw_ids.get(kind)))}
    url = normalize_url(raw.get("url") or raw.get("canonical_url"))
    source_urls = raw.get("source_urls") or []
    if not isinstance(source_urls, list):
        raise ValueError(f"{source_name}[{ordinal}].source_urls must be a list")
    urls = sorted({item for item in [url, *(normalize_url(value) for value in source_urls)] if item})
    return {
        "title": title,
        "title_fingerprint": normalize_title(title),
        "identifiers": identifiers,
        "urls": urls,
        "sources": [{"file": source_name, "index": ordinal}],
    }


def strong_keys(record: dict) -> set[str]:
    keys = {f"id:{kind}:{value}" for kind, value in record["identifiers"].items()}
    keys.update(f"url:{value}" for value in record["urls"])
    return keys


def identifier_conflicts(left: dict, right: dict) -> dict[str, list[str]]:
    conflicts = {}
    for kind in ID_FIELDS:
        left_value = left["identifiers"].get(kind)
        right_value = right["identifiers"].get(kind)
        if left_value and right_value and left_value != right_value:
            conflicts[kind] = sorted([left_value, right_value])
    return conflicts


def merge_into(target: dict, incoming: dict, reason: str) -> None:
    target["identifiers"].update(incoming["identifiers"])
    target["urls"] = sorted(set(target["urls"]) | set(incoming["urls"]))
    target["sources"].extend(incoming["sources"])
    target.setdefault("duplicate_reasons", []).append(reason)


def deduplicate(records: list[dict]) -> dict:
    merged: list[dict] = []
    title_index: dict[str, list[int]] = {}
    conflicts: list[dict] = []

    for record in records:
        keys = strong_keys(record)
        exact = None
        for index, current in enumerate(merged):
            overlap = keys & strong_keys(current)
            if not overlap:
                continue
            conflicts_by_kind = identifier_conflicts(current, record)
            if conflicts_by_kind:
                conflicts.append({
                    "reason": "shared_key_conflicting_identifiers",
                    "shared_keys": sorted(overlap),
                    "conflicting_identifiers": conflicts_by_kind,
                    "left_sources": current["sources"],
                    "right_sources": record["sources"],
                })
                continue
            exact = index
            break
        if exact is not None:
            merge_into(merged[exact], record, "canonical_id_or_url")
            continue

        title_matches = title_index.get(record["title_fingerprint"], [])
        title_target = None
        for index in title_matches:
            current = merged[index]
            current_ids = set(current["identifiers"].items())
            incoming_ids = set(record["identifiers"].items())
            if not current_ids or not incoming_ids:
                title_target = index
                break
            conflicts.append({
                "reason": "same_title_disjoint_identifiers",
                "title_fingerprint": record["title_fingerprint"],
                "left_sources": current["sources"],
                "right_sources": record["sources"],
            })
        if title_target is not None:
            merge_into(merged[title_target], record, "title_fingerprint_without_conflicting_ids")
            continue

        title_index.setdefault(record["title_fingerprint"], []).append(len(merged))
        merged.append(record)

    for record in merged:
        record["sources"] = sorted(record["sources"], key=lambda item: (item["file"], item["index"]))
        record["duplicate_reasons"] = sorted(set(record.get("duplicate_reasons", [])))
        identifier = next((f"{kind}:{record['identifiers'][kind]}" for kind in ID_FIELDS if kind in record["identifiers"]), None)
        record["candidate_id"] = identifier or f"title:{hashlib.sha256(record['title_fingerprint'].encode('utf-8')).hexdigest()[:16]}"
    return {"candidates": merged, "review_conflicts": conflicts}


def load_records(paths: list[Path]) -> list[dict]:
    records: list[dict] = []
    for path in paths:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(payload, dict):
            payload = payload.get("candidates")
        if not isinstance(payload, list):
            raise ValueError(f"{path} must contain a list or an object with candidates[]")
        records.extend(normalize_record(item, path.name, index) for index, item in enumerate(payload))
    return records


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        result = deduplicate(load_records(args.inputs))
        args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(f"candidates={len(result['candidates'])} review_conflicts={len(result['review_conflicts'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
