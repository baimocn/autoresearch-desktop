import tempfile
import unittest
from pathlib import Path

from sync_formats import render, synchronize


class SyncFormatsTests(unittest.TestCase):
    SOURCE = """---
name: example-skill
description: Example description.
---

# Example Skill

Body.
"""

    def test_render_moves_description_below_title(self):
        self.assertEqual(render(self.SOURCE), "# Example Skill\n\n> Example description.\n\nBody.\n")

    def test_check_detects_and_write_repairs_drift(self):
        with tempfile.TemporaryDirectory() as directory:
            skills = Path(directory) / "skills"
            skill = skills / "example"
            skill.mkdir(parents=True)
            (skill / "SKILL.md").write_text(self.SOURCE, encoding="utf-8")
            self.assertEqual(len(synchronize(skills, check=True)), 2)
            self.assertEqual(len(synchronize(skills, check=False)), 2)
            self.assertEqual(synchronize(skills, check=True), [])


if __name__ == "__main__":
    unittest.main()
