import unittest

import content_gates as gates


def fixture(delta=3.0, values=(9.0, 10.0, 11.0), mode="stochastic"):
    comparison = {"direction": "minimize", "paired_runs": [
        {"seed": index, "baseline": value, "reference": value-delta, "baseline_valid": True, "reference_valid": True}
        for index, value in enumerate(values)]}
    assessment = {"direction": "minimize", "formal_seeds": list(range(len(values))), "declared_run_count": len(values),
                  "evaluation_mode": mode, "same_protocol": True, "quality_valid": True, "upper_bound": 0.0,
                  "threshold_basis": "正式算法规范：3σ_B、归一化[0.15,0.8]。"}
    return comparison, assessment


class ContentGateTests(unittest.TestCase):
    def test_three_sigma_uses_baseline_sample_std_at_inclusive_boundary(self):
        result = gates.assess_improvement(*fixture())
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["computed"]["baseline_sample_std"], 1.0)
        self.assertEqual(result["computed"]["sigma_multiplier"], 3.0)
        self.assertTrue(result["warnings"])

    def test_below_three_sigma_fails_even_if_paired_differences_have_zero_variance(self):
        self.assertEqual(gates.assess_improvement(*fixture(delta=2.99))["status"], "fail")

    def test_floating_point_boundary_is_not_a_false_failure(self):
        comparison, assessment = fixture(delta=0.3, values=(0.9, 1.0, 1.1))
        self.assertEqual(gates.assess_improvement(comparison, assessment)["status"], "pass")

    def test_extreme_numbers_produce_manual_not_invalid_json_or_crash(self):
        comparison, assessment = fixture(values=(1e308, 1e308, 1e308))
        result = gates.assess_improvement(comparison, assessment)
        self.assertEqual(result["status"], "manual")
        self.assertEqual(result["computed"], {})

    def test_five_sigma_is_strong_evidence_not_required(self):
        self.assertEqual(gates.assess_improvement(*fixture(delta=4))["status"], "pass")
        self.assertEqual(gates.assess_improvement(*fixture(delta=5))["warnings"], [])

    def test_stochastic_requires_three_declared_complete_runs(self):
        self.assertEqual(gates.assess_improvement(*fixture(values=(10, 10)))["status"], "fail")
        comparison, assessment = fixture()
        assessment["formal_seeds"].append(3)
        assessment["declared_run_count"] = 4
        self.assertEqual(gates.assess_improvement(comparison, assessment)["status"], "manual")

    def test_missing_n_or_missing_formal_seeds_is_manual(self):
        for field in ("declared_run_count", "formal_seeds", "evaluation_mode", "same_protocol", "quality_valid", "upper_bound", "threshold_basis"):
            comparison, assessment = fixture()
            del assessment[field]
            self.assertEqual(gates.assess_improvement(comparison, assessment)["status"], "manual", field)

    def test_zero_sigma_still_requires_positive_improvement(self):
        self.assertEqual(gates.assess_improvement(*fixture(delta=0, values=(10, 10, 10)))["status"], "fail")
        self.assertEqual(gates.assess_improvement(*fixture(delta=3, values=(10, 10, 10)))["status"], "pass")

    def test_deterministic_small_relative_improvement_has_no_obsolete_five_percent_rule(self):
        comparison, assessment = fixture(delta=0.2, values=(10,), mode="deterministic")
        assessment["upper_bound"] = 9
        self.assertEqual(gates.assess_improvement(comparison, assessment)["status"], "pass")

    def test_zero_baseline_does_not_require_absolute_threshold(self):
        comparison, assessment = fixture(delta=0.2, values=(0,), mode="deterministic")
        assessment["upper_bound"] = -1
        self.assertEqual(gates.assess_improvement(comparison, assessment)["status"], "pass")

    def test_task_specific_absolute_threshold_requires_source(self):
        comparison, assessment = fixture()
        assessment["absolute_min_improvement"] = 4
        self.assertEqual(gates.assess_improvement(comparison, assessment)["status"], "manual")
        assessment["absolute_threshold_source"] = "instruction.md:12 中预声明。"
        self.assertEqual(gates.assess_improvement(comparison, assessment)["status"], "fail")

    def test_maximize_and_upper_direction(self):
        comparison, assessment = fixture(delta=-3)
        comparison["direction"] = assessment["direction"] = "maximize"
        assessment["upper_bound"] = 20
        self.assertEqual(gates.assess_improvement(comparison, assessment)["status"], "pass")
        assessment["upper_bound"] = 10
        self.assertEqual(gates.assess_improvement(comparison, assessment)["status"], "fail")

    def test_normalized_score_interval_is_inclusive(self):
        for delta, expected in ((1.5, "pass"), (8.0, "pass"), (1.49, "fail"), (8.01, "fail")):
            result = gates.assess_improvement(*fixture(delta=delta, values=(10,), mode="deterministic"))
            self.assertEqual(result["status"], expected)

    def test_invalid_quality_or_different_protocol_fails(self):
        for field in ("same_protocol", "quality_valid"):
            comparison, assessment = fixture()
            assessment[field] = False
            self.assertEqual(gates.assess_improvement(comparison, assessment)["status"], "fail")
        comparison, assessment = fixture()
        comparison["paired_runs"][1]["reference_valid"] = False
        self.assertEqual(gates.assess_improvement(comparison, assessment)["status"], "fail")

    def test_stated_statistics_must_match_raw_values(self):
        comparison, assessment = fixture()
        comparison["baseline_sample_std"] = 0.1
        self.assertEqual(gates.assess_improvement(comparison, assessment)["status"], "fail")

    def test_no_data_is_manual(self):
        self.assertEqual(gates.assess_improvement({"paired_runs": []}, {})["status"], "manual")

    def test_manual_pass_cannot_override_numeric_failure(self):
        comparison, assessment = fixture(delta=1)
        review = gates.empty()
        for row in review["checks"]:
            row.update(status="pass", evidence=["result.json"], summary="reviewed", reason_code="REVIEWED")
        review["checks"][2]["assessment"] = assessment
        result = gates.apply_review(review, {"baseline_reference": comparison}, None, lambda *args, **kwargs: None)
        self.assertEqual(result["checks"][2]["status"], "fail")
        self.assertTrue(result["checks"][2]["remediation"])
        self.assertTrue(result["checks"][2]["acceptance_evidence"])

    def test_missing_duplicate_and_unknown_gates_are_rejected(self):
        for ids in (("G01", "G02"), ("G01", "G01", "G03"), ("G01", "G02", "G04")):
            review = gates.empty()
            review["checks"] = [dict(review["checks"][0], id=key) for key in ids]
            with self.assertRaises(ValueError):
                gates.apply_review(review, {}, None, lambda *args, **kwargs: None)

    def test_failure_requires_specific_return_instructions(self):
        review = gates.empty()
        with self.assertRaisesRegex(ValueError, "concrete"):
            gates.apply_review(review, {}, None, lambda *args, **kwargs: None)


if __name__ == "__main__":
    unittest.main()
