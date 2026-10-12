from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

import submission_format as fmt


class SubmissionFormatTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.outer = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def make_package(
        self,
        *,
        wrapped: bool = True,
        seeds: tuple[int, ...] = (101, 202),
        task_type: str = "model_training",
        with_models: bool = True,
    ) -> Path:
        root = self.outer / "upload" / "case" if wrapped else self.outer
        harbor = root / "workspace" / "harbor_task"
        for directory in (
            harbor / "environment" / "starter",
            harbor / "solution",
            harbor / "tests" / "hidden_assets",
            root / "workspace" / "reference",
            root / "expert_evidence",
        ):
            directory.mkdir(parents=True, exist_ok=True)
        (harbor / "instruction.md").write_text(
            "This task trains a model from initialization." if task_type == "model_training" else "This is a non-training task; no training is performed.",
            encoding="utf-8",
        )
        (harbor / "task.toml").write_text('name = "fixture"\n', encoding="utf-8")
        (harbor / "environment" / "Dockerfile").write_text("FROM example:local\n", encoding="utf-8")
        (harbor / "tests" / "Dockerfile").write_text("FROM example:local\nCOPY . /tests\n", encoding="utf-8")
        (harbor / "tests" / "hidden_assets" / "cases.json").write_text('{"cases": [1]}\n', encoding="utf-8")
        opt = root / "optimization_evidence"
        opt.mkdir()
        (opt / "训练证据说明.md").write_text("真实运行证据。\n", encoding="utf-8")
        values: dict[str, dict[str, float]] = {}
        for role, offset in (("baseline", 0.0), ("reference", -0.1)):
            role_dir = opt / f"{role}_runs"
            role_dir.mkdir()
            for seed in seeds:
                run = role_dir / f"seed_{seed}"
                run.mkdir()
                value = 1.0 + offset + seed / 10000
                (run / "result.json").write_text(
                    json.dumps(
                        {
                            "schema_version": "fixture.v1",
                            "status": "COMPLETE",
                            "role": role,
                            "seed": seed,
                            "task_type": task_type,
                            "method": {"source_path": "fixture.py"},
                            "protocol": {"train_from_initialization": task_type == "model_training"},
                            "training": {"epochs": 1} if task_type == "model_training" else {},
                            "execution": {"exit_code": 0},
                            "metrics": {"primary": {"name": "loss", "direction": "minimize", "value": value}},
                            "quality_gate": {"valid": True},
                            "artifacts": {},
                        }
                    ),
                    encoding="utf-8",
                )
                (run / "run.log").write_text("completed\n", encoding="utf-8")
                if with_models:
                    model = run / "model"
                    model.mkdir()
                    (model / "model.pt").write_bytes(b"checkpoint")
                    (model / "artifact.json").write_text('{"sha256":"fixture"}\n', encoding="utf-8")
                    (model / "reload.log").write_text("reload ok\n", encoding="utf-8")
                values.setdefault(str(seed), {})[role] = value
        (opt / "comparison_summary.json").write_text(
            json.dumps(
                {
                    "status": "COMPLETE",
                    "metric": {"name": "loss", "direction": "minimize"},
                    "seeds": list(seeds),
                    "paired_results": values,
                    "statistics": {"baseline_mean": 1.0, "reference_mean": 0.9},
                    "normalized_score": {"baseline": 0.0, "reference": 0.25},
                    "significance_rule": {"required_baseline_sigma_multiple": 3, "passed": True},
                }
            ),
            encoding="utf-8",
        )
        return root

    def issue_codes(self, report):
        return {row["code"] for row in report["alignment_issues"]}

    def trajectory_round(self, **changes):
        row = {
            "round": 1, "policy_name": "fixture-method",
            "method_summary": "Synthetic schema fixture, not an actual Agent run.",
            "status": "ok", "score": 0.23, "failure_reason": None,
            "retained_best": True, "time": "2026-09-10 16:20:32",
        }
        row.update(changes)
        return row

    def write_trajectory(self, root, rounds, name="trajectory_codex.json"):
        path = root / "expert_evidence" / name
        path.write_text(json.dumps({"rounds": rounds}), encoding="utf-8")
        return path

    def test_aligned_training_package_below_wrappers(self):
        package = self.make_package()
        report = fmt.collect(self.outer)
        self.assertEqual(report["inspected_root"], ".")
        self.assertEqual(report["submission_root"], "upload/case")
        self.assertEqual(report["submission_root_relative"], "upload/case")
        self.assertEqual(report["wrapper_depth"], 2)
        self.assertEqual(report["status"], "aligned")
        self.assertEqual(report["issues"], [])
        self.assertEqual(report["missing"], [])
        self.assertIn("规范结构已对齐", report["summary"])
        opt = report["optimization_evidence"]
        self.assertEqual(opt["task_kind"], "training")
        self.assertTrue(opt["seed_pairing"]["paired"])
        self.assertEqual(opt["seed_pairing"]["paired_seeds"], ["101", "202"])
        run = opt["baseline_runs"]["runs"]["101"]
        self.assertEqual(run["result"]["role"], "baseline")
        self.assertEqual(run["result"]["seed"], 101)
        self.assertEqual(run["result"]["primary_metric"]["name"], "loss")
        self.assertTrue(run["model"]["artifact"])
        self.assertTrue(run["model"]["reload"])

    def test_missing_top_level_and_harbor_material_are_issues(self):
        root = self.outer / "case"
        (root / "workspace" / "harbor_task").mkdir(parents=True)
        report = fmt.collect(self.outer)
        codes = self.issue_codes(report)
        self.assertEqual(report["status"], "deviations")
        self.assertIn("MISSING_TOP_LEVEL", codes)
        self.assertIn("MISSING_HARBOR_FILE", codes)
        self.assertIn("MISSING_HARBOR_DIR", codes)
        self.assertIn("MISSING_REFERENCE", codes)

    def test_unpaired_seed_sets_are_reported(self):
        root = self.make_package(seeds=(101, 202))
        reference_202 = root / "optimization_evidence" / "reference_runs" / "seed_202"
        for path in sorted(reference_202.rglob("*"), reverse=True):
            if path.is_file():
                path.unlink()
            else:
                path.rmdir()
        reference_202.rmdir()
        report = fmt.collect(self.outer)
        self.assertIn("UNPAIRED_SEEDS", self.issue_codes(report))
        pairing = report["optimization_evidence"]["seed_pairing"]
        self.assertEqual(pairing["baseline_only"], ["202"])
        self.assertEqual(pairing["reference_only"], [])

    def test_required_seed_files_and_minimal_result_fields(self):
        root = self.make_package(seeds=(101,))
        run = root / "optimization_evidence" / "baseline_runs" / "seed_101"
        (run / "run.log").unlink()
        (run / "result.json").write_text('{"role":"reference"}', encoding="utf-8")
        report = fmt.collect(self.outer)
        codes = self.issue_codes(report)
        self.assertIn("MISSING_RUN_LOG", codes)
        self.assertIn("MISSING_RESULT_FIELDS", codes)
        self.assertIn("RESULT_ROLE_MISMATCH", codes)

    def test_seed_mismatch_and_invalid_json_are_reported(self):
        root = self.make_package(seeds=(101,))
        baseline = root / "optimization_evidence" / "baseline_runs" / "seed_101" / "result.json"
        data = json.loads(baseline.read_text())
        data["seed"] = 999
        baseline.write_text(json.dumps(data), encoding="utf-8")
        reference = root / "optimization_evidence" / "reference_runs" / "seed_101" / "result.json"
        reference.write_text("{", encoding="utf-8")
        report = fmt.collect(self.outer)
        codes = self.issue_codes(report)
        self.assertIn("RESULT_SEED_MISMATCH", codes)
        self.assertIn("INVALID_RESULT_JSON", codes)

    def test_summary_seed_set_must_match_paired_runs(self):
        root = self.make_package(seeds=(101, 202))
        path = root / "optimization_evidence" / "comparison_summary.json"
        data = json.loads(path.read_text())
        data["seeds"] = [101]
        path.write_text(json.dumps(data), encoding="utf-8")
        report = fmt.collect(self.outer)
        self.assertIn("SUMMARY_SEED_MISMATCH", self.issue_codes(report))

    def test_training_model_artifact_and_reload_are_required(self):
        root = self.make_package(seeds=(101,))
        model = root / "optimization_evidence" / "reference_runs" / "seed_101" / "model"
        (model / "model.pt").unlink()
        (model / "artifact.json").unlink()
        (model / "reload.log").unlink()
        report = fmt.collect(self.outer)
        codes = self.issue_codes(report)
        self.assertIn("MISSING_MODEL_ARTIFACT", codes)
        self.assertIn("MISSING_ARTIFACT_MANIFEST", codes)
        self.assertIn("MISSING_RELOAD_LOG", codes)

    def test_non_training_empty_or_absent_model_is_allowed(self):
        root = self.make_package(
            seeds=(101,), task_type="non_training", with_models=False
        )
        empty_model = root / "optimization_evidence" / "baseline_runs" / "seed_101" / "model"
        empty_model.mkdir()
        report = fmt.collect(self.outer)
        self.assertEqual(report["status"], "aligned_with_extras")
        self.assertEqual(report["optimization_evidence"]["task_kind"], "non_training")
        self.assertIn(
            "EMPTY_NON_TRAINING_MODEL_DIR",
            {row["code"] for row in report["suggestions"]},
        )

    def test_non_training_nonempty_model_is_only_a_suggestion(self):
        root = self.make_package(
            seeds=(101,), task_type="non_training", with_models=False
        )
        model = root / "optimization_evidence" / "baseline_runs" / "seed_101" / "model"
        model.mkdir()
        (model / "unexpected.pt").write_bytes(b"optional")
        report = fmt.collect(self.outer)
        self.assertEqual(report["status"], "aligned_with_extras")
        self.assertIn(
            "NON_TRAINING_MODEL_PRESENT",
            {row["code"] for row in report["suggestions"]},
        )
        self.assertIn(
            "optimization_evidence/baseline_runs/seed_101/model",
            {row["path"] for row in report["extras"]["extra_allowed"]},
        )

    def test_extra_items_are_classified_without_failing(self):
        root = self.make_package(seeds=(101,))
        opt = root / "optimization_evidence"
        (opt / "README.md").write_text("help\n", encoding="utf-8")
        (opt / "experiment_plan.json").write_text("{}", encoding="utf-8")
        (opt / "ablation").mkdir()
        (root / "notes.txt").write_text("extra\n", encoding="utf-8")
        report = fmt.collect(self.outer)
        self.assertEqual(report["status"], "aligned_with_extras")
        self.assertIn(
            "optimization_evidence/experiment_plan.json",
            {row["path"] for row in report["extras"]["merge_candidate"]},
        )
        self.assertIn(
            "optimization_evidence/ablation",
            {row["path"] for row in report["extras"]["misplaced"]},
        )
        allowed = {row["path"] for row in report["extras"]["extra_allowed"]}
        self.assertIn("optimization_evidence/README.md", allowed)
        self.assertIn("notes.txt", allowed)

    def test_legacy_trusted_and_runtime_are_suggestions_not_failures(self):
        root = self.make_package(seeds=(101,))
        harbor = root / "workspace" / "harbor_task"
        (harbor / "environment" / "trusted").mkdir()
        (harbor / "tests" / "runtime").mkdir()
        report = fmt.collect(self.outer)
        self.assertEqual(report["status"], "aligned_with_extras")
        self.assertTrue(report["harbor_task"]["legacy_trusted_present"])
        self.assertTrue(report["harbor_task"]["legacy_tests_runtime_present"])
        codes = {row["code"] for row in report["suggestions"]}
        self.assertIn("LEGACY_TRUSTED_DIR", codes)
        self.assertIn("LEGACY_TESTS_RUNTIME", codes)
        self.assertTrue(
            all(
                {"path", "classification", "recommendation"} <= set(row)
                for row in report["suggestions"]
            )
        )

    def test_invalid_input_returns_stable_result(self):
        report = fmt.collect(self.outer / "missing")
        self.assertEqual(report["status"], "manual")
        self.assertIsNone(report["submission_root"])
        self.assertEqual(report["alignment_issues"][0]["code"], "INVALID_INPUT")
        self.assertEqual(report["issues"], report["alignment_issues"])

    def test_hidden_folder_name_is_not_a_format_requirement(self):
        root = self.make_package(seeds=(101,), task_type="non_training", with_models=False)
        tests = root / "workspace" / "harbor_task" / "tests"
        (tests / "hidden_assets").rename(tests / "private_fixtures")
        self.assertEqual(fmt.collect(root)["status"], "aligned")

    def test_generated_pca_hidden_without_static_assets_is_allowed_by_format(self):
        root = self.make_package(seeds=(101,), task_type="non_training", with_models=False)
        tests = root / "workspace" / "harbor_task" / "tests"
        (tests / "hidden_assets" / "cases.json").unlink()
        (tests / "hidden_assets").rmdir()
        generated = tests / "grader_pkg" / "data"
        generated.mkdir(parents=True)
        (generated / "generate.py").write_text("# inspection fixture: never executed\n", encoding="utf-8")
        report = fmt.collect(root)
        self.assertEqual(report["status"], "aligned")
        self.assertFalse(any("HIDDEN_ASSETS" in code for code in self.issue_codes(report)))

    def test_empty_hidden_directory_needs_material_review_not_format_failure(self):
        root = self.make_package(seeds=(101,))
        hidden = root / "workspace" / "harbor_task" / "tests" / "hidden_assets"
        (hidden / "cases.json").unlink()
        self.assertEqual(fmt.collect(root)["status"], "aligned")

    def test_optional_source_oracle_and_required_two_dockerfiles(self):
        root = self.make_package(seeds=(101,))
        harbor = root / "workspace" / "harbor_task"
        (harbor / "solution").rmdir()
        self.assertEqual(fmt.collect(root)["status"], "aligned")
        (harbor / "tests" / "Dockerfile").unlink()
        self.assertIn("MISSING_HARBOR_DOCKERFILE", self.issue_codes(fmt.collect(root)))

    def test_complete_eight_field_trajectories_are_valid_without_extra_fields(self):
        root = self.make_package(seeds=(101,))
        for name in ("trajectory_codex.json", "trajectory_seed.json"):
            self.write_trajectory(root, [
                self.trajectory_round(),
                self.trajectory_round(round=2, status="timeout", score=None,
                    failure_reason="Synthetic timeout fixture.", retained_best=False,
                    time="2026-09-10T16:25:32+08:00"),
            ], name=name)
        report = fmt.collect(root)
        self.assertEqual(report["status"], "aligned")
        for item in report["expert_evidence"]["trajectories"].values():
            self.assertEqual(item["round_count"], 2)
            self.assertTrue(item["format_valid"])

    def test_each_of_eight_fields_is_required(self):
        root = self.make_package(seeds=(101,))
        for field in fmt.REQUIRED_TRAJECTORY_FIELDS:
            with self.subTest(field=field):
                row = self.trajectory_round()
                del row[field]
                path = self.write_trajectory(root, [row])
                report = fmt.validate_trajectory(path, root)
                self.assertIn("MISSING_TRAJECTORY_FIELDS", self.issue_codes(report))
                self.assertFalse(report["format_valid"])

    def test_invalid_field_values_are_reported(self):
        root = self.make_package(seeds=(101,))
        cases = [
            {"round": True}, {"round": 0}, {"round": 1.5},
            {"policy_name": ""}, {"method_summary": []}, {"status": False},
            {"score": None}, {"score": True}, {"score": "0.5"},
            {"failure_reason": "success with a failure reason"},
            {"retained_best": "false"}, {"time": "2026-09-10"},
            {"time": "2026-02-30 16:20:32"}, {"time": 123456},
            {"status": "timeout", "failure_reason": None, "retained_best": False},
            {"status": "failed", "failure_reason": "bad output", "retained_best": True},
        ]
        for changes in cases:
            with self.subTest(changes=changes):
                path = self.write_trajectory(root, [self.trajectory_round(**changes)])
                report = fmt.validate_trajectory(path, root)
                self.assertIn("INVALID_TRAJECTORY_FIELD", self.issue_codes(report))
                self.assertFalse(report["format_valid"])

    def test_success_aliases_and_failure_with_actual_metric(self):
        root = self.make_package(seeds=(101,))
        for status in ("ok", "SUCCESS", "passed", "PASS", "Completed"):
            with self.subTest(status=status):
                path = self.write_trajectory(root, [self.trajectory_round(status=status)])
                self.assertTrue(fmt.validate_trajectory(path, root)["format_valid"])
        path = self.write_trajectory(root, [self.trajectory_round(
            status="quality_gate_failed", score=0.1,
            failure_reason="Synthetic gate failure.", retained_best=False,
        )])
        self.assertTrue(fmt.validate_trajectory(path, root)["format_valid"])

    def test_unknown_status_requires_manual_interpretation(self):
        root = self.make_package(seeds=(101,))
        path = self.write_trajectory(root, [self.trajectory_round(status="custom_state")])
        report = fmt.validate_trajectory(path, root)
        self.assertEqual(report["status"], "manual")
        self.assertEqual(self.issue_codes(report), {"TRAJECTORY_STATUS_REVIEW"})
        self.assertEqual(report["alignment_issues"][0]["status"], "manual")

    def test_large_trajectory_is_unreadable_not_a_claimed_format_failure(self):
        root = self.make_package(seeds=(101,))
        path = root / "expert_evidence" / "trajectory_codex.json"
        path.write_bytes(b" " * (fmt.MAX_JSON_BYTES + 1))
        report = fmt.validate_trajectory(path, root)
        self.assertEqual(report["status"], "unreadable")
        self.assertEqual(report["alignment_issues"][0]["status"], "manual")

    def test_round_numbers_must_increase_without_duplicates(self):
        root = self.make_package(seeds=(101,))
        for numbers in ((1, 1), (2, 1)):
            with self.subTest(numbers=numbers):
                path = self.write_trajectory(root, [self.trajectory_round(round=n) for n in numbers])
                self.assertIn("TRAJECTORY_ROUND_ORDER", self.issue_codes(fmt.validate_trajectory(path, root)))

    def test_empty_rounds_are_incomplete_evidence(self):
        root = self.make_package(seeds=(101,))
        path = self.write_trajectory(root, [])
        report = fmt.validate_trajectory(path, root)
        self.assertEqual(report["status"], "incomplete")
        self.assertIn("EMPTY_TRAJECTORY_ROUNDS", self.issue_codes(report))
        self.assertEqual(json.loads(path.read_text())["rounds"], [])

    def test_invalid_json_rounds_and_nonfinite_numbers_are_rejected(self):
        root = self.make_package(seeds=(101,))
        path = root / "expert_evidence" / "trajectory_codex.json"
        for text, code in (
            ("{", "INVALID_TRAJECTORY_JSON"),
            ("[]", "INVALID_TRAJECTORY_JSON"),
            ('{"rounds": {}}', "INVALID_TRAJECTORY_ROUNDS"),
            ('{"rounds": [null]}', "INVALID_TRAJECTORY_ROUND"),
            (json.dumps({"rounds": [self.trajectory_round(score=float("nan"))]}), "INVALID_TRAJECTORY_JSON"),
            (json.dumps({"rounds": [self.trajectory_round(score=float("inf"))]}), "INVALID_TRAJECTORY_JSON"),
        ):
            with self.subTest(text=text):
                path.write_text(text, encoding="utf-8")
                self.assertIn(code, self.issue_codes(fmt.validate_trajectory(path, root)))

    def test_equivalent_review_selected_name_and_missing_file(self):
        root = self.make_package(seeds=(101,))
        path = self.write_trajectory(root, [self.trajectory_round()], name="agent_a_records.json")
        self.assertTrue(fmt.validate_trajectory(path, root)["format_valid"])
        self.assertEqual(fmt.collect(root)["status"], "aligned")
        report = fmt.validate_trajectory(path.with_name("not_here.json"), root)
        self.assertEqual(report["status"], "missing")
        self.assertIn("MISSING_TRAJECTORY", self.issue_codes(report))
        self.assertEqual(report["alignment_issues"][0]["status"], "fail")


if __name__ == "__main__":
    unittest.main()
