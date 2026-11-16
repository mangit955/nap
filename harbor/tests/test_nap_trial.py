"""What a Terminal-Bench trial runs and reads back, tested without Harbor installed."""

from __future__ import annotations

import json
from pathlib import Path

from nap_harbor.trial import (
    DEFAULT_MODEL,
    ENTRYPOINT,
    RESULT_FILENAME,
    context_from_result,
    default_repo_root,
    entrypoint_command,
    metadata_from_result,
    read_result,
)

EXAMPLE = Path(__file__).resolve().parents[1] / "nap_harbor" / "result-example.json"


class TestEntrypointCommand:
    def test_runs_the_entrypoint_on_the_job_directory_with_harbors_model(self):
        command = entrypoint_command(
            repo_root=Path("/repo"),
            job_dir=Path("/jobs/t1/agent"),
            model="vendor/m:free",
            extra_args=["--max-steps=5"],
        )

        assert command == [
            "bun",
            "run",
            "/repo/packages/runtime/scripts/harbor-task.ts",
            "--job-dir=/jobs/t1/agent",
            "--model=vendor/m:free",
            "--max-steps=5",
        ]

    def test_falls_back_to_a_free_model(self):
        command = entrypoint_command(
            repo_root=Path("/r"), job_dir=Path("/j"), model=None, extra_args=[]
        )

        assert f"--model={DEFAULT_MODEL}" in command
        assert DEFAULT_MODEL.endswith(":free")

    def test_names_an_entrypoint_this_checkout_has(self):
        assert (default_repo_root() / ENTRYPOINT).exists()


class TestReadingTheResult:
    def test_reads_what_the_entrypoint_wrote(self, tmp_path: Path):
        (tmp_path / RESULT_FILENAME).write_text(EXAMPLE.read_text())

        assert read_result(tmp_path) == json.loads(EXAMPLE.read_text())

    def test_a_missing_or_broken_result_is_none(self, tmp_path: Path):
        assert read_result(tmp_path) is None
        (tmp_path / RESULT_FILENAME).write_text("{not json")
        assert read_result(tmp_path) is None

    def test_files_nap_token_counts_under_harbors_names(self):
        result = json.loads(EXAMPLE.read_text())

        assert context_from_result(result) == {
            "n_input_tokens": 120400,
            "n_cache_tokens": 88000,
            "n_output_tokens": 5310,
        }

    def test_leaves_absent_figures_absent(self):
        assert context_from_result(None) == {}
        assert context_from_result({"usage": {"inputTokens": 5, "outputTokens": 1}}) == {
            "n_input_tokens": 5,
            "n_output_tokens": 1,
        }

    def test_carries_the_request_count_into_the_trial_metadata(self):
        metadata = metadata_from_result(json.loads(EXAMPLE.read_text()), 0)

        assert metadata["model_requests"] == 21
        assert metadata["model_steps"] == 20
        # Every figure the example carries reaches Harbor; a field renamed on the TypeScript
        # side and in the example would arrive here as None.
        assert None not in [value for key, value in metadata.items() if key != "failure"]
        assert metadata["status"] == "failed"
        assert metadata["failure"]["reason"] == "budget_exceeded"
        assert metadata_from_result(None, 1) == {"entrypoint_exit_code": 1}
