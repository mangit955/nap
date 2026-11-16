"""What one Terminal-Bench trial of Nap's agent runs and leaves behind, without Harbor.

Standard library only, like ``channel.py``, so the suite covers it on a checkout that never
installed an evaluation framework. ``agent.py`` is the thin part that needs Harbor.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

#: Where the Nap checkout is, when it is not the parent of this package.
REPO_ROOT_ENV = "NAP_REPO_ROOT"

#: The entrypoint the agent runs, relative to the checkout.
ENTRYPOINT = Path("packages") / "runtime" / "scripts" / "harbor-task.ts"

#: Written into the job directory before the turn, read by the entrypoint.
INSTRUCTION_FILENAME = "instruction.md"
#: Written by the entrypoint: the outcome, Nap's own count of tokens and model requests.
RESULT_FILENAME = "nap-result.json"
#: Written by the entrypoint: every event the turn emitted, one JSON object per line.
TRAJECTORY_FILENAME = "trajectory.jsonl"
#: The entrypoint's stderr: what it printed while the turn ran.
LOG_FILENAME = "nap.log"

#: The model the run uses when Harbor's ``--model`` names none. Free, because spending is
#: something somebody asks for by name; see ``--spend`` in the entrypoint.
DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free"


class TrialError(RuntimeError):
    """The trial could not run at all — a broken harness, not a task the agent failed."""


def default_repo_root() -> Path:
    """The checkout this package was installed from, unless the environment says otherwise."""
    override = os.environ.get(REPO_ROOT_ENV)
    if override:
        return Path(override).expanduser().resolve()
    # harbor/nap_harbor/trial.py -> harbor/nap_harbor -> harbor -> repo root
    return Path(__file__).resolve().parents[2]


def entrypoint_command(
    *,
    repo_root: Path,
    job_dir: Path,
    model: str | None,
    extra_args: list[str],
) -> list[str]:
    """The command that runs Nap's agent for one trial, reading and writing ``job_dir``."""
    return [
        "bun",
        "run",
        str(repo_root / ENTRYPOINT),
        f"--job-dir={job_dir}",
        f"--model={model or DEFAULT_MODEL}",
        *extra_args,
    ]


def read_result(job_dir: Path) -> dict | None:
    """The entrypoint's result, or ``None`` when it never wrote one."""
    path = job_dir / RESULT_FILENAME
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def context_from_result(result: dict | None) -> dict:
    """The token figures Harbor records for a trial, as Nap counted them.

    Read out of the result rather than counted here: the entrypoint already counts them from the
    provider, and a second instrumentation path would be a number that can disagree with it.
    Harbor's input count includes the cache, which is what Nap's ``inputTokens`` already is.
    Absent figures stay absent rather than becoming zero.
    """
    if result is None:
        return {}
    usage = result.get("usage") or {}
    context: dict = {}
    if "inputTokens" in usage:
        context["n_input_tokens"] = usage["inputTokens"]
    if "cacheReadTokens" in usage:
        context["n_cache_tokens"] = usage["cacheReadTokens"]
    if "outputTokens" in usage:
        context["n_output_tokens"] = usage["outputTokens"]
    return context


def metadata_from_result(result: dict | None, exit_code: int | None) -> dict:
    """What else a reader of Harbor's trial result needs: the outcome and the request count.

    ``model_requests`` is HTTP requests, retries included, which is what a free model's quota
    counts; ``model_steps`` is the agent's model calls.
    """
    if result is None:
        return {"entrypoint_exit_code": exit_code}
    return {
        "entrypoint_exit_code": exit_code,
        "status": result.get("status"),
        "failure": result.get("failure"),
        "model": result.get("model"),
        "model_requests": result.get("requests"),
        "model_steps": result.get("steps"),
        "duration_ms": result.get("durationMs"),
    }
