"""What a trial is, expressed without importing Harbor.

Every decision the agent makes lives here so it can be tested with nothing installed but
Python: which task an instruction names, which command runs it, and where the report lands.
``agent.py`` is the part that needs Harbor, and it is deliberately almost nothing.

Nothing in this file evaluates anything. It builds a command line for an entrypoint in the
Nap repository and reads a report that entrypoint wrote — the reward rule, the checks, the
gates and the score all stay on the other side of that boundary. See ``docs/adr/0014``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

#: The comment a generated ``instruction.md`` carries. Written by
#: ``apps/napbench/src/harbor-task.ts``; the two are checked against each other by
#: ``tests/test_trial.py``, which reads a generated instruction rather than a copy of one.
TASK_MARKER_PATTERN = re.compile(r"<!--\s*napbench-task:\s*([A-Za-z0-9._-]+)\s*-->")

#: The report a trial always leaves in its job directory, measured or not.
REPORT_FILENAME = "report.json"

#: Everything the run printed, written by the trial entrypoint itself.
LOG_FILENAME = "trial.log"

#: The wrapper's own view of the same run, kept apart from ``trial.log`` rather than appended
#: to it: the entrypoint writes that file, so writing to it from here would interleave two
#: writers on one path and leave a reader unable to tell whose line is whose. This one exists
#: for the case the entrypoint never got far enough to open its own — a missing `bun`, a bad
#: repository root — where the only account of what happened is the wrapper's.
AGENT_LOG_FILENAME = "harbor-agent.log"


class TrialError(RuntimeError):
    """Something about the trial itself is wrong — not something about the model."""


def task_id_from_instruction(instruction: str) -> str:
    """The benchmark task an instruction names.

    The instruction is the only per-task channel Harbor gives an agent, so the task id
    travels in it as a marker. Raises rather than guessing: an agent that picked a default
    task would run the wrong benchmark and report a number for it.
    """
    match = TASK_MARKER_PATTERN.search(instruction)
    if match is None:
        raise TrialError(
            "this instruction names no NapBench task — expected a "
            "'<!-- napbench-task: <id> -->' marker, which `bun run harbor:tasks` writes"
        )
    return match.group(1)


def trial_command(
    *,
    repo_root: Path,
    task_id: str,
    job_dir: Path,
    napbench_flags: list[str] | None = None,
) -> list[str]:
    """The command that runs one trial, on the host.

    Flags after ``--`` are the benchmark's own and are passed through untouched — including
    ``--real``, which is the one that spends money. This builds no flags of its own, so
    there is exactly one place that decides what a run costs and it is not here.
    """
    command = [
        "bun",
        "run",
        str(repo_root / "apps" / "napbench" / "scripts" / "napbench-trial.ts"),
        "run",
        f"--task={task_id}",
        f"--job-dir={job_dir}",
    ]
    flags = napbench_flags or []
    if flags:
        command.append("--")
        command.extend(flags)
    return command


def read_report(job_dir: Path) -> dict | None:
    """The report the trial wrote, or ``None`` when it wrote none.

    Absence is returned rather than raised because the caller's job is to record what
    happened, not to decide what it was worth: a trial with no readable report is still a
    trial, and the verifier — which is the only thing allowed to say a run measured nothing
    — will refuse it for that reason a moment later.
    """
    path = job_dir / REPORT_FILENAME
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def context_from_report(report: dict | None) -> dict:
    """The token and cost figures Harbor records for a trial, taken from the report.

    Read out of the report rather than counted here, because the report already counts them
    from the event stream the turn wrote — a second instrumentation path would be a number
    that can disagree with the archived one. Absent figures stay absent: a run whose turns
    never completed has no token usage, and a zero would read as a run that used none.
    """
    if report is None:
        return {}

    metrics = report.get("metrics") or {}
    tokens = metrics.get("tokens") or {}
    estimated = metrics.get("estimatedCost") or {}

    context: dict = {}
    if "inputTokens" in tokens:
        context["n_input_tokens"] = tokens["inputTokens"]
    if "outputTokens" in tokens:
        context["n_output_tokens"] = tokens["outputTokens"]
    if "usd" in estimated:
        context["cost_usd"] = estimated["usd"]
    return context
