# 候选账本合同

账本可以采用 JSON、JSONL、CSV 或数据库，但必须保留原始证据引用，不只保留代理生成的摘要。

## 最小字段

```yaml
candidate_id: stable-local-id
selection_mode: pool  # or expert_self_selection
title: exact paper title
identifiers:
  doi: null
  arxiv: null
  openalex: null
  semantic_scholar: null
paper:
  canonical_url: null
  version_read: null
  published_at: null
  evidence_ref: null
code:
  repository_url: null
  revision: null
  license_spdx: null
  license_evidence_ref: null
discovery:
  sources: []
  query_log_refs: []
duplicate_registry:
  registry_name: null
  data_version: null
  checked_at: null
  query_digest: null
  status: UNKNOWN
  evidence_ref: null
optimization:
  method_surface: null
  code_entrypoint: null
  frozen_surface: null
evaluation:
  baseline_command: null
  evaluator_command: null
  primary_metric: null
  metric_direction: null
  effective_improvement_threshold: null
  randomness_protocol: null
effect_noise:
  baseline_trials: []
  reference_trials: []
  effect_summary: null
  noise_summary: null
resources:
  requires_gpu: null
  development: null
  formal: null
  pilot_cost_upper_bound: null
  pilot_hours_upper_bound: null
  upper_bound: null
  recovery_plan: null
delivery:
  target_harness: null
  backend: null
  capability_evidence_ref: null
  artifact_contract: null
gates:
  provenance_license: UNKNOWN
  optimization_surface: UNKNOWN
  baseline_evaluation: UNKNOWN
  effect_noise: UNKNOWN
  resources_recovery: UNKNOWN
  harness_delivery: UNKNOWN
  duplicate_registry: UNKNOWN
decision: NEEDS_EVIDENCE
decision_reason: null
next_minimum_check: null
```

## 证据纪律

- `evidence_ref` 指向本地保存的响应、命令输出、配置、日志或公开 URL；摘要不能代替它。
- 所有时间使用带时区的 ISO 8601，哈希写明算法。
- `UNKNOWN` 不等于失败，但会阻止推荐；`REVIEW` 表示存在歧义，仍需人工或权威来源消解。
- 任何门槛变化都保留历史记录；不得覆盖掉失败 pilot、重复题命中或许可证缺口。
- 对外发布前移除密钥、个人路径、私有主机、内部 URL、人员身份和未获授权的原文附件；保留可公开验证的来源与哈希。
