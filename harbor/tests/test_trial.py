"""What the Harbor agent decides, tested without Harbor installed.

Everything here drives ``napbench_harbor.trial``, which imports nothing but the standard
library. That is deliberate: the suite has to be runnable on a checkout that has never
installed an evaluation framework, or the Python in this repository would be covered by a
gate nobody can run — which is worse than one nobody wrote.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from napbench_harbor.trial import (
    TrialError,
    context_from_report,
    read_report,
    task_id_from_instruction,
    trial_command,
)


class TestTaskIdFromInstruction:
    def test_reads_the_marker_a_generated_instruction_carries(self):
        instruction = "# Reading list\n\n<!-- napbench-task: reading-list -->\n\nDo the thing.\n"

        assert task_id_from_instruction(instruction) == "reading-list"

    def test_tolerates_the_spacing_a_generator_might_change(self):
        assert task_id_from_instruction("<!--napbench-task:todo-crud-->") == "todo-crud"

    def test_refuses_an_instruction_that_names_no_task(self):
        """A default task would run the wrong benchmark and report a number for it."""
        with pytest.raises(TrialError):
            task_id_from_instruction("Build me a to-do list.")


class TestTrialCommand:
    def test_runs_the_repository_entrypoint_against_one_task(self):
        command = trial_command(
            repo_root=Path("/repo"),
            task_id="reading-list",
            job_dir=Path("/jobs/t1/agent"),
        )

        assert command[:3] == ["bun", "run", "/repo/apps/napbench/scripts/napbench-trial.ts"]
        assert "run" in command
        assert "--task=reading-list" in command
        assert "--job-dir=/jobs/t1/agent" in command

    def test_passes_benchmark_flags_after_the_separator(self):
        command = trial_command(
            repo_root=Path("/repo"),
            task_id="reading-list",
            job_dir=Path("/jobs/t1/agent"),
            napbench_flags=["--real", "--model=openai/gpt-5.6-luna"],
        )

        assert command[-3:] == ["--", "--real", "--model=openai/gpt-5.6-luna"]

    def test_spends_nothing_unless_asked(self):
        """A dry run is the default here for the same reason it is under `bun run napbench`."""
        command = trial_command(
            repo_root=Path("/repo"), task_id="reading-list", job_dir=Path("/jobs/t1")
        )

        assert "--real" not in command

    def test_never_asks_for_a_suite(self):
        command = trial_command(
            repo_root=Path("/repo"), task_id="reading-list", job_dir=Path("/jobs/t1")
        )

        assert not any(argument.startswith("--suite") for argument in command)


class TestReadReport:
    def test_reads_the_report_a_trial_left(self, tmp_path: Path):
        (tmp_path / "report.json").write_text(json.dumps({"status": "passed"}))

        assert read_report(tmp_path) == {"status": "passed"}

    def test_returns_nothing_when_the_trial_wrote_nothing(self, tmp_path: Path):
        assert read_report(tmp_path) is None

    def test_returns_nothing_for_a_report_that_cannot_be_read(self, tmp_path: Path):
        (tmp_path / "report.json").write_text("{not json")

        assert read_report(tmp_path) is None


class TestContextFromReport:
    def test_carries_the_figures_the_report_already_counted(self):
        context = context_from_report(
            {
                "metrics": {
                    "tokens": {"inputTokens": 1200, "outputTokens": 300},
                    "estimatedCost": {"usd": 0.0042, "model": "m", "priceTableVersion": "1"},
                }
            }
        )

        assert context == {
            "n_input_tokens": 1200,
            "n_output_tokens": 300,
            "cost_usd": 0.0042,
        }

    def test_leaves_an_absent_figure_absent_rather_than_reporting_zero(self):
        """A run whose turns never completed has no token usage; zero would be a measurement."""
        context = context_from_report({"metrics": {"toolCalls": 4, "turns": {}}})

        assert context == {}

    def test_says_nothing_at_all_about_a_trial_with_no_report(self):
        assert context_from_report(None) == {}
