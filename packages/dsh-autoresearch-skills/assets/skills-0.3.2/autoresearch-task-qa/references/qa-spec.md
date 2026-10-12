# AutoResearch delivery QA specification

## Evidence standard

The authoring bundle, Agent runtime view, trusted evaluator view, and hidden-data
injection view are different security domains. A file being called `trusted`,
being chmod `0444/0555`, or being outside the nominal writable directory does
not prove isolation. Require an allowlist/manifest for the actual Agent-visible
mounts and final image plus a trusted image digest. Inspect final image layers,
not only the Dockerfile, before delivery.

When a package contains `qa_exposure_manifest.json`, interpret it using
[exposure-manifest.md](exposure-manifest.md). The manifest is a claim until a
trusted runner compares it with the actual image and mounts.

For every item record: status, severity, evidence paths/lines, the automated
observation, remaining proof needed, and remediation. Missing evidence is
`manual` or `fail` according to whether the artifact is mandatory.

## Required checklist

1. **QA01 — Problem statement hygiene.** `instruction.md` has exactly one useful
   instance of all eight sections: Goal, Task Setting, Objective and Metrics,
   Allowed Scope, Hard Boundaries, Submission Instructions, Workflow &
   Iteration, Completion Criteria. Goal is 2–4 sentences. No paper title, arXiv
   ID, repository name/URL, answer identifier, reference method, or optimization
   recipe is exposed. Scan `INIT_PROMPT.md` too; moving a hint there is still a
   leak.
2. **QA02 — Score function.** The official hidden score is continuous, monotonic
   in the declared direction, unclipped, finite for every valid result, maps the
   hidden baseline to 0 and the independently justified attainable bound to 1.
   Invalid submissions use a separate hard-gate outcome such as -1 and do not
   redefine the valid score curve. Test beyond both anchors and reject NaN/Inf.
3. **QA03 — Reference range and reproduction.** Trusted reruns put the reference
   normalized score in `[0.15, 0.8]`. Pin code/data/image/hardware/seeds and retain
   raw logs. A declaration without raw replicates is insufficient.
4. **QA04 — Statistical separation.** For fluctuating metrics, declare whether
   sigma is population or sample standard deviation and use independent runs.
   Maximize: `mean(R)-mean(B) >= 3*sigma(B)`. Minimize:
   `mean(B)-mean(R) >= 3*sigma(B)`. Recompute from raw values; do not trust a
   boolean `passed` field. Report replicate count and confidence caveats.
5. **QA05 — Constraint enforcement.** Map every normative statement to an
   environment restriction, schema validator, guard, resource controller, or
   verifier test. Text-only constraints fail. Include negative tests for each
   gate and boundary-value tests for sizes, time, precision, and counts.
6. **QA06 — Verifier contract.** One documented command produces exactly one
   machine-readable result with a finite scalar `score` on success. Distinguish
   invalid submission, timeout/resource exhaustion, evaluator failure, and
   infrastructure failure using status/error type and consistent exit codes.
   Ignore candidate stdout and self-reported metrics.
7. **QA07 — Hidden-data isolation.** Hidden data, derived statistics, labels,
   counts, hashes that enable lookup, paths, seeds, per-case diagnostics, and
   loader errors do not enter the Agent image, bundle view, env, argv, `/proc`,
   inherited FDs, IPC replies, logs, caches, shared directories, or earlier image
   layers. `hidden_assets/` in the Agent tree must be empty before injection.
8. **QA08 — Reference isolation.** Reference code, binary artifacts, configs,
   scores, diffs, candidate names, and logs are absent from Agent-visible files,
   image layers, package caches, build context, executions, editor backups, and
   all Git objects/history. A baseline may not be mislabeled or silently replaced
   with reference code.
9. **QA09 — Result integrity.** At startup the trusted verifier rejects unsafe
   symlink/device/FIFO destinations, removes a prewritten result, creates a
   unique temporary file in the same trusted directory, fsyncs when durability
   matters, and atomically replaces the destination. Candidate-controlled
   stdout, filenames, directories, or fixed `.tmp` paths cannot forge it.
10. **QA10 — Frozen surfaces.** Evaluator, guards, metric, baseline, reference,
    schemas, test configs, dependency lock, and hidden-loader policy are restored
    from independently pinned trusted artifacts at evaluation. Writable Python
    import paths, `sitecustomize`, `PYTHONPATH`, `PATH`, `LD_PRELOAD`, module
    cache, and candidate-controlled working directories cannot shadow them.
11. **QA11 — Eight-section content.** Each section contains the tutorial-required
    facts: input/output/metric/validity; environment and public/hidden split;
    exact formula/aggregation/direction/gates; readable/writable paths and tools;
    enforced protections/resources/forbidden actions; exact submission schema;
    anytime loop and per-iteration budget; completion checklist.
12. **QA12 — Git hygiene.** No remotes, remote-tracking branches, tags, stash,
    reflog, notes, replacement refs, submodule URL, LFS object, dangling/unreachable
    object, patch, or commit subject such as fix/answer/solution leaks information.
    Prefer shipping without `.git` after provenance is recorded elsewhere.
13. **QA13 — Baseline and solvability.** The baseline is valid and non-trivial
    under the identical hidden protocol and resource limits; the reference gives
    a real improvement. Preserve raw baseline/reference logs and reject random
    fluctuation as improvement.
14. **QA14 — Headroom.** The reference is not saturated and at least one legal,
    discoverable improvement direction remains unprompted. Demonstrate headroom
    without disclosing the method to the Agent.
15. **QA15 — Iteration resources.** One score takes at most two hours; one job
    uses no more than 8 GPUs of the allowed H20/L20 class and no more than 64 CPU
    cores. Enforce limits in the scheduler/cgroup, not only `task.toml`.
16. **QA16 — Long-run stability.** A measured 12-hour soak under benign Agent
    activity shows no OOM, FD/process leak, disk/log growth to exhaustion, stuck
    jobs, or premature shutdown. Include start/end resource snapshots and logs.
17. **QA17 — Self-contained image.** Core dependencies and required public data
    are built into a pinned image. No runtime host Volume Mount supplies required
    code/data. Deleting a secret in a later Docker layer does not erase it.
18. **QA18 — Agent evidence.** At least one verified Agent trajectory or reference
    run has prompt, run metadata, stdout/stderr or trusted score output, and a
    completed trajectory analysis. Link all files and retain parse statistics.
19. **QA19 — Randomness protocol.** Declare seeds, warmups, paired ordering,
    replicate count, aggregation, sigma convention, and effective-improvement
    threshold in the problem when evaluation fluctuates. Prevent candidate RNG
    from changing trusted RNG state.
20. **QA20 — Scope/network/tools.** State exact writable/readable roots, network
    policy, WebSearch/WebFetch policy, process/concurrency rules, evaluator entry
    points, and whether direct GPU/worker control is allowed. Enforce them.
21. **QA21 — Evidence schemas.** `trajectory.json` is JSONL formal-trial data,
    with increasing trial IDs and consistent metric direction. Failures have a
    reason and cannot claim trusted scores. `expert_annotation.json` and
    `run_summary.json` use `schema_version: 1` and contain the tutorial-required
    model/metric/reference/selected-Agent, evaluation protocol, baseline,
    reference, Agent results, selected artifact hash, trajectory validation, and
    execution-note fields. Recompute hashes and summaries from source artifacts.

## Additional expert-cheating checks

- **EX01 Sandbagged baseline.** Detect sleeps, deliberate slow paths, reduced
  resource use, wrong precision/batching, weaker preprocessing, invalid defaults,
  or a baseline evaluated under different code/data/hardware than the reference.
  Require a reasonableness review against common public baselines.
- **EX02 Post-hoc anchors/reference cherry-picking.** Record when `U`, the
  baseline, and the named reference were frozen. Flag wording that a weaker
  reference was selected specifically to land in `[0.15, 0.8]`, or that `U` was
  moved after seeing hidden results. Keep all attempted anchors and revisions.
- **EX03 Hidden-test oracle use.** Hidden evaluation is final-only or tightly
  budgeted. Flag policy selection on hidden data, repeated hidden scores,
  per-case hidden metrics, high-precision feedback, adaptive retries, or public
  candidate names paired with hidden outcomes.
- **EX04 Fabricated/stale evidence.** Verify digests, timestamps, run IDs, image
  digest, hardware, software versions, exit status, and provenance. Recompute
  means/sigmas. Reject copied logs, duplicate supposedly independent runs,
  selected-code/hash mismatch, and summaries not derivable from raw records.
- **EX05 Side-channel hints.** Scan title, prompt, filenames, comments, public
  statistics, tests, expected hashes, trace snippets, error messages, and public
  cases for the reference technique or exact hidden properties.
- **EX06 Docker/build leaks.** Inspect final `docker save` layers and history for
  `COPY .`, `ADD` archives/URLs, secrets copied then deleted, build args, cache
  mounts, package caches, model caches, `.dockerignore` omissions, and multi-stage
  copy mistakes. Pin base image by digest.
- **EX07 Verifier takeover.** Test path traversal, symlink/hardlink/FIFO/device
  files, TOCTOU, environment overrides, import/path shadowing, unsafe deserialization,
  shell injection, module monkeypatching, writable loader code, candidate cleanup
  hooks, inherited handles, and result-parser ambiguity.
- **EX08 Benchmark gaming.** Randomize/alternate candidate and baseline order;
  use trusted timing and streams; synchronize asynchronous devices; clone and
  verify inputs; bound persistent state; vary hidden shapes/values/order; detect
  cached outputs, mode detection, allocator/thermal poisoning, background GPU
  work, and baseline slowdown.
- **EX09 Package attacks.** Reject ZIP path traversal, absolute/backslash paths,
  symlink/hardlink/special entries, duplicate and case/Unicode-colliding names,
  encrypted entries, excessive expansion ratio/count/size, nested archives, and
  executable artifacts that are not required.
- **EX10 Dependency/supply-chain drift.** Pin package versions and hashes, model
  revisions, base image digest, compiler/CUDA/runtime, and external downloads.
  Build without injecting author credentials; scan packages and licenses.
- **EX11 Public/hidden contamination.** Prove split provenance and deduplicate
  exact and near-duplicate records. Ensure generators do not reuse hidden seeds,
  ordering, IDs, sentinel values, or metadata in public data.
- **EX12 Resource escape.** Enforce process-group/cgroup timeouts, descendant
  cleanup, PID/FD/thread limits, shared-memory/tmpfs/disk/output quotas, GPU memory
  and job concurrency. Prevent detached children and log floods from surviving.
- **EX13 Hollow tests.** Detect duplicate test names that overwrite earlier
  tests, skipped/xfail tests, assertions against self-authored evidence, tests
  that never invoke the trusted path, and claimed test counts that differ from
  collected tests.
- **EX14 Unproven delivery view.** Require an explicit generated allowlist of the
  final Agent image/mount and compare it byte-for-byte with the authoring bundle.
  A textual statement that `expert_evidence/` is forbidden is not isolation.
- **EX15 Diagnostic leakage.** Return only the information needed for iteration
  on public data. Hidden scoring exposed to the Agent should be score-only,
  coarse if needed, rate-limited, and never reveal case names/shapes/latencies,
  raw hidden metric, anchor values, paths, tracebacks, or loader failures.
- **EX16 Statistical gaming.** Predeclare run count, outlier handling, stopping
  rule, warmup, clock state, and sigma convention. Reject cherry-picked windows,
  optional stopping, non-independent replicates, mismatched hardware, and
  comparing the best reference run against the mean baseline.

## Dynamic gates before GO

Static review cannot close these gates: final-image layer scan; runtime mount and
permission probe as the real Agent UID; hidden/ref absence across `/proc`, env,
argv, IPC and logs; clean-checkout baseline/reference reruns; adversarial
submission corpus; repeated statistical run; scheduler/cgroup enforcement;
public/hidden dedup; and a 12-hour soak. A delivery is not GO until every required
dynamic gate has a trusted artifact or an explicitly approved exception.
