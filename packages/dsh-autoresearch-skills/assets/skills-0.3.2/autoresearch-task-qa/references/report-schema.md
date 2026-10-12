# Report schema

`scripts/audit_task.py` writes `report.json` and `report.md`.

The JSON top level is:

```json
{
  "schema_version": 1,
  "generated_at": "UTC ISO-8601",
  "source": {"path": "...", "kind": "zip|directory", "sha256": "..."},
  "policy": {
    "name": "precheck|strict",
    "strict_release_certification": false,
    "adjustments": [{
      "id": "QA03",
      "from": "fail",
      "to": "warn",
      "from_severity": "blocker",
      "to_severity": "high",
      "reason": "..."
    }]
  },
  "assumptions": ["..."],
  "summary": {
    "decision": "NO-GO|PRECHECK-PASS|REVIEW|GO-STATIC-ONLY",
    "counts": {"pass": 0, "fail": 0, "warn": 0, "manual": 0},
    "blockers": 0
  },
  "checks": [],
  "extra_checks": [],
  "limitations": []
}
```

Each check contains `id`, `title`, `status`, `severity`, `summary`, `evidence`,
and `remediation`. Status is `pass`, `fail`, `warn`, `manual`, or
`not_applicable`. Severity is `blocker`, `high`, `medium`, `low`, or `info`.

The generated `report.md` begins with a QA01–QA21 table containing: sequence,
ID, checklist title, current-policy verdict, reason, and up to three primary
evidence references. Verdict labels are `通过`, `有条件通过`, `待人工复核`,
`不通过`, or `不适用`. Full evidence and remediation remain in the
detailed sections below the table.

`NO-GO` means at least one blocker or failed mandatory item exists. `REVIEW`
means no confirmed failure was found, but warnings/manual gates remain.
`GO-STATIC-ONLY` means the static rules passed; it never substitutes for the
dynamic gates listed in `qa-spec.md`.

`precheck` is an authoring aid: content and compliance failures are reported as
warnings and their strict status/severity is retained in `policy.adjustments`.
Only an archive-safety failure remains a hard stop because the package cannot be
inspected reliably. It is not a release certificate. When the archive can be
inspected, its overall decision is `PRECHECK-PASS`. `strict` preserves the
normative checklist result.
