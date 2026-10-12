import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("deduplicate_candidates.py")
SPEC = importlib.util.spec_from_file_location("deduplicate_candidates", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class DeduplicateCandidatesTest(unittest.TestCase):
    def test_canonicalizes_identifiers_and_urls(self):
        records = [
            MODULE.normalize_record({
                "title": "A Useful Method",
                "identifiers": {"doi": "https://doi.org/10.1000/ABC", "arxiv": "ARXIV:2401.00001v2"},
                "url": "http://example.org/paper/?utm_source=test",
            }, "one.json", 0),
            MODULE.normalize_record({
                "title": "A useful method",
                "identifiers": {"doi": "doi:10.1000/abc"},
                "url": "https://example.org/paper",
            }, "two.json", 0),
        ]
        result = MODULE.deduplicate(records)
        self.assertEqual(len(result["candidates"]), 1)
        candidate = result["candidates"][0]
        self.assertEqual(candidate["candidate_id"], "doi:10.1000/abc")
        self.assertEqual(candidate["identifiers"]["doi"], "10.1000/abc")
        self.assertEqual(candidate["identifiers"]["arxiv"], "2401.00001")
        self.assertEqual(candidate["urls"], ["https://example.org/paper"])

    def test_merges_title_only_record_into_identified_record(self):
        records = [
            MODULE.normalize_record({"title": "Method: One", "identifiers": {"doi": "10.1/a"}}, "one.json", 0),
            MODULE.normalize_record({"title": "method one"}, "two.json", 0),
        ]
        result = MODULE.deduplicate(records)
        self.assertEqual(len(result["candidates"]), 1)
        self.assertEqual(result["candidates"][0]["duplicate_reasons"], ["title_fingerprint_without_conflicting_ids"])

    def test_same_title_with_disjoint_ids_requires_review(self):
        records = [
            MODULE.normalize_record({"title": "Shared title", "identifiers": {"doi": "10.1/a"}}, "one.json", 0),
            MODULE.normalize_record({"title": "Shared title", "identifiers": {"doi": "10.1/b"}}, "two.json", 0),
        ]
        result = MODULE.deduplicate(records)
        self.assertEqual(len(result["candidates"]), 2)
        self.assertEqual(result["review_conflicts"][0]["reason"], "same_title_disjoint_identifiers")

    def test_shared_url_with_conflicting_ids_requires_review(self):
        records = [
            MODULE.normalize_record({"title": "First", "identifiers": {"doi": "10.1/a"}, "url": "https://example.org/work"}, "one.json", 0),
            MODULE.normalize_record({"title": "Second", "identifiers": {"doi": "10.1/b"}, "url": "https://example.org/work"}, "two.json", 0),
        ]
        result = MODULE.deduplicate(records)
        self.assertEqual(len(result["candidates"]), 2)
        self.assertEqual(result["review_conflicts"][0]["reason"], "shared_key_conflicting_identifiers")

    def test_cli_accepts_candidates_wrapper(self):
        with tempfile.TemporaryDirectory() as temp:
            temp_path = Path(temp)
            source = temp_path / "source.json"
            output = temp_path / "output.json"
            source.write_text(json.dumps({"candidates": [{"title": "Paper"}]}), encoding="utf-8")
            self.assertEqual(MODULE.main([str(source), "--output", str(output)]), 0)
            self.assertEqual(json.loads(output.read_text(encoding="utf-8"))["candidates"][0]["title"], "Paper")

    def test_missing_title_fails_closed(self):
        with self.assertRaisesRegex(ValueError, "has no title"):
            MODULE.normalize_record({"identifiers": {"doi": "10.1/a"}}, "bad.json", 0)


if __name__ == "__main__":
    unittest.main()
