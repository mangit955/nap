"""Nap, as an agent Harbor can run.

The whole class is a subprocess call and some bookkeeping, and that is the design rather
than an unfinished version of it. Nap's benchmark already composes a real sandbox, a real
model, a real browser and a real judge; wrapping that in a container would break host Chrome,
the host ``.env`` and E2B egress in exchange for an isolation this arrangement never claimed
to provide. What Harbor buys is fan-out, a job directory and a registry — see
``docs/adr/0014``.

So the agent runs **on the host**, writes its artefacts into the job directory Harbor mounts
into the environment, and the verifier — a bundled entrypoint from the same repository — is
what reads them afterwards. Nothing here scores anything.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from napbench_harbor.trial import (
    AGENT_LOG_FILENAME,
    TrialError,
    context_from_report,
    read_report,
    task_id_from_instruction,
    trial_command,
)

#: Where the Nap checkout is, when it is not the parent of this package.
REPO_ROOT_ENV = "NAP_REPO_ROOT"

#: Flags handed to ``napbench`` verbatim, as one string — ``--real --model=…``. Absent means
#: a dry run: free, offline, and the scores mean nothing. Spending money stays something
#: somebody asks for by name, exactly as it is under ``bun run napbench``.
FLAGS_ENV = "NAPBENCH_FLAGS"


def default_repo_root() -> Path:
    """The checkout this package was installed from, unless the environment says otherwise."""
    override = os.environ.get(REPO_ROOT_ENV)
    if override:
        return Path(override).expanduser().resolve()
    # harbor/napbench_harbor/agent.py -> harbor/napbench_harbor -> harbor -> repo root
    return Path(__file__).resolve().parents[2]


class NapbenchAgent(BaseAgent):
    """Runs one NapBench trial on the host and files what it produced."""

    @staticmethod
    def name() -> str:
        return "napbench"

    def version(self) -> str:
        return "1.0.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        """Nothing to install: the trial runs outside this environment entirely."""

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        task_id = task_id_from_instruction(instruction)
        repo_root = default_repo_root()
        flags = os.environ.get(FLAGS_ENV, "").split()

        command = trial_command(
            repo_root=repo_root,
            task_id=task_id,
            job_dir=self.logs_dir,
            napbench_flags=flags,
        )
        self.logger.info("running NapBench task %s on the host: %s", task_id, " ".join(command))

        self.logs_dir.mkdir(parents=True, exist_ok=True)
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=repo_root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await process.communicate()

        # The trial entrypoint writes `trial.log` itself. This is the wrapper's own view of
        # the same run, under its own name, so that the two writers never interleave — and so
        # that a trial which died before the entrypoint opened its log still says something.
        with (self.logs_dir / AGENT_LOG_FILENAME).open("ab") as log:
            log.write(stdout or b"")

        report = read_report(self.logs_dir)

        # Populated from the report rather than counted here — one instrumentation path.
        for key, value in context_from_report(report).items():
            setattr(context, key, value)
        context.metadata = {
            "task_id": task_id,
            "trial_exit_code": process.returncode,
            "status": None if report is None else report.get("status"),
            "error_kind": None if report is None else report.get("errorKind"),
        }

        if report is None:
            # Raised rather than scored: no report means the trial never ran, which is a
            # broken harness. What a *finished* run is worth is the verifier's to say, and
            # it is the only thing allowed to say "this measured nothing".
            raise TrialError(
                f"the trial wrote no report to {self.logs_dir} — "
                f"it exited {process.returncode}; see {AGENT_LOG_FILENAME}"
            )
