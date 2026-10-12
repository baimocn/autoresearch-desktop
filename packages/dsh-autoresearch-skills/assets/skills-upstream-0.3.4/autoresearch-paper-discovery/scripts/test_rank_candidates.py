import unittest

from rank_candidates import HARD_GATES, rank


def candidate(candidate_id, *, gpu, cost, hours, status="PASS", mode="pool"):
    return {
        "candidate_id": candidate_id,
        "selection_mode": mode,
        "gates": {name: status for name in HARD_GATES},
        "resources": {
            "requires_gpu": gpu,
            "pilot_cost_upper_bound": cost,
            "pilot_hours_upper_bound": hours,
        },
    }


class RankCandidateTests(unittest.TestCase):
    def test_cpu_preference_applies_only_between_recommendable_candidates(self):
        ranked = rank([
            candidate("gpu", gpu=True, cost=1, hours=1),
            candidate("cpu", gpu=False, cost=10, hours=10),
        ])
        self.assertEqual([row["candidate_id"] for row in ranked], ["cpu", "gpu"])

    def test_soft_cost_cannot_offset_failed_gate(self):
        rejected = candidate("cheap-failed", gpu=False, cost=0, hours=0)
        rejected["gates"]["effect_noise"] = "FAIL"
        ranked = rank([rejected, candidate("valid", gpu=True, cost=100, hours=10)])
        self.assertEqual(ranked[0]["candidate_id"], "valid")
        self.assertEqual(ranked[1]["decision"], "REJECT")

    def test_unknown_gate_blocks_recommendation(self):
        unresolved = candidate("unresolved", gpu=False, cost=1, hours=1)
        unresolved["gates"]["duplicate_registry"] = "UNKNOWN"
        self.assertEqual(rank([unresolved])[0]["decision"], "NEEDS_EVIDENCE")


if __name__ == "__main__":
    unittest.main()
