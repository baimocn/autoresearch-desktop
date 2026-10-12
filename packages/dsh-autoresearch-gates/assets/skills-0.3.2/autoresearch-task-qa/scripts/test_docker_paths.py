import tempfile
from pathlib import Path
import unittest

import docker_paths as paths


DOCKER = """FROM example:local
ENV EVFI_TASK_ROOT=/workspace
COPY environment/requirements.txt /tmp/requirements.txt
WORKDIR /workspace
COPY instruction.md task.toml ./
COPY environment/starter ./environment/starter
COPY solution ./solution
COPY tests ./tests
CMD ["bash"]
"""


class DockerPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.task = self.root / "wrapper/workspace/harbor_task"
        for name in ("environment/requirements.txt", "environment/starter/method.py", "solution/solve.sh", "tests/test.sh", "instruction.md", "task.toml"):
            path = self.task / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("fixture\n")
        self.docker = self.task / "environment/Dockerfile"
        self.docker.write_text(DOCKER)

    def tearDown(self):
        self.temp.cleanup()

    def inspect(self, profile=paths.TEACHING, **extra):
        return paths.inspect(self.root, "wrapper/workspace/harbor_task", declaration={"profile": profile, "profile_basis": "fixture", **extra})

    def codes(self, result):
        return {f["code"] for f in result["findings"]}

    def test_teaching_example_paths_and_wrapper(self):
        result = self.inspect()
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["build_context"], "wrapper/workspace/harbor_task")
        self.assertEqual(result["runtime_task_root"], "/workspace")
        self.assertEqual(result["test_entry"], "/workspace/tests/test.sh")

    def test_legacy_teaching_still_requires_oracle_hook(self):
        (self.task / "solution/solve.sh").unlink()
        self.assertIn("entry_missing", self.codes(self.inspect()))

    def test_wrong_dockerfile_location_fails(self):
        self.docker.rename(self.task / "Dockerfile")
        result = self.inspect()
        self.assertEqual(result["status"], "fail")
        self.assertIn("dockerfile_missing", self.codes(result))

    def test_profiles_cannot_mix_contexts(self):
        result = self.inspect(paths.NATIVE)
        self.assertEqual(result["status"], "fail")
        self.assertIn("copy_source_missing", self.codes(result))

    def test_explicit_wrong_context_fails(self):
        result = self.inspect(build_context="wrapper/workspace/harbor_task/environment")
        self.assertIn("profile_path_mismatch", self.codes(result))

    def test_json_copy_and_continuations(self):
        self.docker.write_text(DOCKER.replace("COPY instruction.md task.toml ./", 'COPY ["instruction.md", "task.toml", "./"]').replace("COPY tests ./tests", "COPY --chown=1000:1000 \\\n+ tests ./tests".replace("\n+", "\n")))
        self.assertEqual(self.inspect()["status"], "pass")

    def test_dotdot_source_fails(self):
        self.docker.write_text(DOCKER + "COPY ../reference /private\n")
        self.assertIn("copy_source_escape", self.codes(self.inspect()))

    def test_private_source_fails(self):
        self.docker.write_text(DOCKER + "COPY reference /private\n")
        self.assertIn("private_copy_source", self.codes(self.inspect()))

    def test_environment_root_mismatch_fails(self):
        self.docker.write_text(DOCKER.replace("EVFI_TASK_ROOT=/workspace", "EVFI_TASK_ROOT=/harbor_task"))
        self.assertIn("runtime_root_mismatch", self.codes(self.inspect()))

    def test_workdir_mismatch_fails(self):
        self.docker.write_text(DOCKER.replace("WORKDIR /workspace", "WORKDIR /harbor_task"))
        self.assertIn("workdir_mismatch", self.codes(self.inspect()))

    def test_dynamic_source_manual_not_false_missing(self):
        self.docker.write_text(DOCKER + "COPY ${ASSET_DIR} /assets\n")
        self.assertEqual(self.inspect()["status"], "manual")

    def test_stage_source_not_local_source(self):
        self.docker.write_text(DOCKER + "COPY --from=builder /artifact /artifact\n")
        self.assertEqual(self.inspect()["status"], "manual")
        self.assertNotIn("copy_source_missing", self.codes(self.inspect()))

    def test_ignore_of_required_source_fails(self):
        (self.task / ".dockerignore").write_text("tests\n")
        self.assertIn("copy_source_ignored", self.codes(self.inspect()))

    def test_complex_ignore_requires_manual(self):
        (self.task / ".dockerignore").write_text("**\n!tests/**\n")
        self.assertEqual(self.inspect()["status"], "manual")

    def test_missing_runtime_test_entry_fails(self):
        self.docker.write_text(DOCKER.replace("COPY tests ./tests", "COPY tests /wrong_tests"))
        result = self.inspect()
        self.assertEqual(result["status"], "fail")
        self.assertIn("runtime_entry_unmapped", self.codes(result))

    def test_run_generated_runtime_entry_is_manual(self):
        self.docker.write_text(DOCKER.replace("COPY tests ./tests", "RUN generate-tests"))
        self.assertEqual(self.inspect()["status"], "manual")

    def test_native_test_is_harness_injected(self):
        self.docker.write_text("FROM example:local\nWORKDIR /app\nCOPY requirements.txt /tmp/requirements.txt\n")
        result = self.inspect(paths.NATIVE, runtime_task_root="/app")
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["test_entry"], "/tests/test.sh")

    def test_native_prebuilt_does_not_require_dockerfile(self):
        self.docker.unlink()
        result = paths.inspect(self.root, "wrapper/workspace/harbor_task", {"environment": {"docker_image": "fixture:local"}}, {"profile": paths.NATIVE})
        self.assertEqual(result["status"], "not_applicable")

    def test_context_symlink_escape_fails(self):
        outside = self.root / "outside.txt"
        outside.write_text("fixture")
        (self.task / "outside.txt").symlink_to(outside)
        self.docker.write_text(DOCKER + "COPY outside.txt /outside.txt\n")
        self.assertIn("copy_symlink_escape", self.codes(self.inspect()))

    def test_fixed_test_entry_cannot_be_replaced(self):
        result = paths.inspect(self.root, "wrapper/workspace/harbor_task", {"entrypoint": {"test_script": "tests/wrong.sh"}})
        self.assertIn("canonical_entry_mismatch", self.codes(result))

    def test_missing_cmd_script_fails(self):
        self.docker.write_text(DOCKER.replace('CMD ["bash"]', 'CMD ["bash", "/workspace/solution/missing.sh"]'))
        self.assertIn("runtime_command_unmapped", self.codes(self.inspect()))

    def test_valid_cmd_script_passes(self):
        self.docker.write_text(DOCKER.replace('CMD ["bash"]', 'CMD ["bash", "/workspace/solution/solve.sh"]'))
        self.assertEqual(self.inspect()["status"], "pass")

    def test_entry_symlink_escape_fails(self):
        outside = self.root / "outside.sh"
        outside.write_text("fixture")
        (self.task / "tests/test.sh").unlink()
        (self.task / "tests/test.sh").symlink_to(outside)
        self.assertIn("entry_path_escape", self.codes(self.inspect()))

    def test_unused_stage_does_not_cause_false_runtime_root_failure(self):
        self.docker.write_text("FROM example:local AS builder\nENV TASK_ROOT=/build\nCOPY unavailable /optional\n" + DOCKER)
        result = self.inspect()
        self.assertEqual(result["status"], "manual")
        self.assertNotIn("runtime_root_mismatch", self.codes(result))


class SeparateDockerPathTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.task = self.root / "task"
        self.config = {"artifacts": ["/workspace/solution"], "verifier": {"environment_mode": "separate"}}
        self.write("task.toml", 'artifacts = ["/workspace/solution"]\n')
        self.write("environment/Dockerfile", "FROM python:3.11-slim\nWORKDIR /workspace\nCOPY public_eval/ /workspace/public_eval/\n")
        self.write("environment/public_eval/grader.py", "# Public Dev evaluator.\n")
        self.write("tests/Dockerfile", "FROM python:3.11-slim\nCOPY . /tests/\n")
        self.write("tests/test.sh", "#!/bin/bash\npython /tests/grader.py\n")
        self.write("tests/grader.py", "# Private final evaluator.\n")
        self.write("tests/hidden_assets/data.json", '{"held_out": true}\n')

    def tearDown(self):
        self.temp.cleanup()

    def write(self, name, content):
        target = self.task / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    def inspect(self, separate=True):
        return paths.inspect(self.root, "task", self.config, require_separate=separate)

    def codes(self, report):
        return {finding["code"] for finding in report["findings"]}

    def test_two_images_use_independent_contexts_and_mappings(self):
        result = self.inspect()
        self.assertEqual(result["status"], "pass")
        self.assertEqual(result["build_context"], "task/environment")
        self.assertEqual(result["verifier_build_context"], "task/tests")
        self.assertIn("/tests/test.sh", result["verifier"]["mapped_files"])
        self.assertIn("/workspace/public_eval/grader.py", result["mapped_files"])
        self.assertNotIn("/tests/test.sh", result["mapped_files"])
        self.assertNotIn("private_copy_source", self.codes(result))

    def test_teaching_separate_does_not_require_oracle_hook(self):
        self.write("environment/Dockerfile", "FROM python:3.11-slim\nWORKDIR /workspace\nCOPY environment/public_eval/ /workspace/public_eval/\n")
        result = paths.inspect(self.root, "task", self.config,
                               declaration={"profile": paths.TEACHING}, require_separate=True)
        self.assertEqual(result["status"], "pass")
        self.assertFalse((self.task / "solution/solve.sh").exists())
        self.assertEqual(result["test_entry"], "/tests/test.sh")
        self.assertIn("/tests/test.sh", result["verifier"]["mapped_files"])
        self.assertNotIn("/workspace/tests/test.sh", result["mapped_files"])

    def test_optional_oracle_on_host_need_not_be_copied_to_agent(self):
        self.write("environment/Dockerfile", "FROM python:3.11-slim\nWORKDIR /workspace\nCOPY environment/public_eval/ /workspace/public_eval/\n")
        self.write("solution/solve.sh", "#!/bin/bash\n# Expert-only Oracle hook.\n")
        result = paths.inspect(self.root, "task", self.config,
                               declaration={"profile": paths.TEACHING}, require_separate=True)
        self.assertEqual(result["status"], "pass")
        self.assertNotIn("/workspace/solution/solve.sh", result["mapped_files"])

    def test_verifier_copy_missing_source_is_failure(self):
        self.write("tests/Dockerfile", "FROM python:3.11-slim\nCOPY missing_grader.py /tests/grader.py\nCOPY test.sh /tests/test.sh\n")
        result = self.inspect()
        self.assertEqual(result["status"], "fail")
        self.assertIn("verifier_copy_source_missing", self.codes(result))

    def test_verifier_does_not_resolve_copy_against_agent_context(self):
        self.write("tests/Dockerfile", "FROM python:3.11-slim\nCOPY public_eval/grader.py /tests/grader.py\nCOPY test.sh /tests/test.sh\n")
        self.assertIn("verifier_copy_source_missing", self.codes(self.inspect()))

    def test_verifier_entry_must_be_baked_into_image(self):
        self.write("tests/Dockerfile", "FROM scratch\n")
        result = self.inspect()
        self.assertEqual(result["status"], "fail")
        self.assertIn("verifier_runtime_entry_unmapped", self.codes(result))
        self.assertIn("verifier_runtime_unverified", self.codes(result))

    def test_verifier_entry_wrong_destination_is_failure(self):
        self.write("tests/Dockerfile", "FROM python:3.11-slim\nCOPY . /wrong/\n")
        self.assertIn("verifier_runtime_entry_unmapped", self.codes(self.inspect()))

    def test_verifier_ignore_excludes_explicit_copy(self):
        self.write("tests/.dockerignore", "test.sh\n")
        self.write("tests/Dockerfile", "FROM python:3.11-slim\nCOPY test.sh /tests/test.sh\n")
        result = self.inspect()
        self.assertIn("verifier_copy_source_ignored", self.codes(result))
        self.assertIn("verifier_runtime_entry_unmapped", self.codes(result))

    def test_verifier_ignore_applies_to_directory_copy(self):
        self.write("tests/.dockerignore", "test.sh\n")
        self.assertIn("verifier_runtime_entry_unmapped", self.codes(self.inspect()))

    def test_verifier_specific_ignore_takes_precedence(self):
        self.write("tests/.dockerignore", "test.sh\n")
        self.write("tests/Dockerfile.dockerignore", "unused.txt\n")
        self.assertEqual(self.inspect()["status"], "pass")

    def test_verifier_dynamic_generation_is_manual(self):
        self.write("tests/Dockerfile", "FROM python:3.11-slim\nRUN generate-test-entry\n")
        self.assertEqual(self.inspect()["status"], "manual")

    def test_verifier_scratch_does_not_get_false_runtime_pass(self):
        self.write("tests/Dockerfile", "FROM scratch\nCOPY . /tests/\n")
        self.assertEqual(self.inspect()["status"], "manual")

    def test_custom_base_without_runtime_declaration_is_manual(self):
        self.write("tests/Dockerfile", "FROM organization/base:1\nCOPY . /tests/\n")
        self.assertEqual(self.inspect()["status"], "manual")

    def test_explicit_bash_install_is_a_static_declaration(self):
        self.write("tests/Dockerfile", "FROM alpine:3.21\nRUN apk add --no-cache bash python3\nCOPY . /tests/\n")
        self.assertEqual(self.inspect()["status"], "pass")

    def test_echo_does_not_establish_runtime_install(self):
        self.write("tests/Dockerfile", 'FROM alpine:3.21\nRUN echo "apk add bash"\nCOPY . /tests/\n')
        self.assertEqual(self.inspect()["status"], "manual")

    def test_missing_agent_does_not_skip_verifier_inspection(self):
        (self.task / "environment/Dockerfile").unlink()
        self.write("tests/Dockerfile", "FROM python:3.11-slim\nCOPY missing /tests/\n")
        result = self.inspect()
        self.assertIn("agent_dockerfile_missing", self.codes(result))
        self.assertIn("verifier_copy_source_missing", self.codes(result))

    def test_native_agent_reference_copy_is_failure_without_separate(self):
        self.write("environment/reference/answer.py", "# Private expert reference.\n")
        self.write("environment/Dockerfile", "FROM python:3.11-slim\nCOPY reference/ /workspace/reference/\n")
        self.assertIn("private_copy_source", self.codes(self.inspect(separate=False)))

    def test_native_agent_hidden_nested_in_dot_copy_is_failure(self):
        self.write("environment/hidden_assets/answers.json", "{}\n")
        self.write("environment/Dockerfile", "FROM python:3.11-slim\nCOPY . /workspace/\n")
        self.assertIn("private_copy_source", self.codes(self.inspect()))

    def test_ignored_private_data_is_not_copied(self):
        self.write("environment/hidden_assets/answers.json", "{}\n")
        self.write("environment/.dockerignore", "hidden_assets\n")
        self.write("environment/Dockerfile", "FROM python:3.11-slim\nCOPY . /workspace/\n")
        self.assertEqual(self.inspect()["status"], "pass")

    def test_private_data_still_fails_with_dynamic_destination(self):
        self.write("environment/hidden_assets/answers.json", "{}\n")
        self.write("environment/Dockerfile", "FROM python:3.11-slim\nCOPY . ${TARGET}/\n")
        self.assertIn("private_copy_source", self.codes(self.inspect()))

    def test_public_dev_tests_and_grader_names_are_allowed(self):
        self.write("environment/public_eval/tests/test_metric.py", "# Public metric test.\n")
        self.assertEqual(self.inspect()["status"], "pass")

    def test_agent_cannot_assume_final_tests_harness_injection(self):
        self.write("environment/Dockerfile", 'FROM python:3.11-slim\nCMD ["bash", "/tests/test.sh"]\n')
        self.assertIn("agent_final_test_entry", self.codes(self.inspect()))

    def test_verifier_cmd_script_requires_own_mapping(self):
        self.write("tests/start.sh", "#!/bin/bash\n")
        self.write("tests/Dockerfile", 'FROM python:3.11-slim\nCOPY test.sh /tests/test.sh\nCMD ["bash", "/tests/start.sh"]\n')
        self.assertIn("verifier_runtime_command_unmapped", self.codes(self.inspect()))


if __name__ == "__main__":
    unittest.main()
