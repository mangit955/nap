"""Nap's agent, as an agent Harbor runs inside a task's own machine.

The task's container is the workspace and Harbor's verifier is the judge (see ``docs/adr/0035``,
which says what changed since ``0014``, when NapBench's retired adapter ran the trial on the
host). The agent loop is TypeScript and runs as a ``bun`` child; this class hands it the
instruction, answers the commands it sends with ``environment.exec``, and files what it counted.
Nothing here decides anything about the task.
"""

from __future__ import annotations

import asyncio
import os

from harbor.agents.base import BaseAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

from nap_harbor.channel import LINE_LIMIT, ExecOutcome, finish, serve
from nap_harbor.trial import (
    INSTRUCTION_FILENAME,
    LOG_FILENAME,
    TrialError,
    context_from_result,
    default_repo_root,
    entrypoint_command,
    metadata_from_result,
    read_result,
)

#: Further flags for the entrypoint, as one string — ``--max-steps=20``, say. ``--spend`` is
#: the one that allows a model that is not free.
FLAGS_ENV = "NAP_HARBOR_FLAGS"


class NapAgent(BaseAgent):
    """Runs one Nap turn on a task's instruction, inside the task's machine."""

    @staticmethod
    def name() -> str:
        return "nap"

    def version(self) -> str:
        return "1.0.0"

    async def setup(self, environment: BaseEnvironment) -> None:
        """Nothing to install: the agent stays outside, and reaches in through ``exec``."""

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        repo_root = default_repo_root()
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        (self.logs_dir / INSTRUCTION_FILENAME).write_text(instruction)

        command = entrypoint_command(
            repo_root=repo_root,
            job_dir=self.logs_dir,
            model=self.model_name,
            extra_args=os.environ.get(FLAGS_ENV, "").split(),
        )
        self.logger.info("running Nap's agent: %s", " ".join(command))

        async def run_in_task_machine(command: str, timeout_sec: int | None) -> ExecOutcome:
            result = await environment.exec(command, timeout_sec=timeout_sec)
            return ExecOutcome(
                exit_code=result.return_code,
                stdout=result.stdout or "",
                stderr=result.stderr or "",
            )

        with (self.logs_dir / LOG_FILENAME).open("ab") as log:
            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=repo_root,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=log,
                limit=LINE_LIMIT,
            )
            assert process.stdin is not None and process.stdout is not None
            stdin = process.stdin

            async def reply(line: bytes) -> None:
                stdin.write(line)
                await stdin.drain()

            exit_code: int | None = None
            try:
                await serve(
                    process.stdout,
                    reply,
                    run_in_task_machine,
                    lambda line: self.logger.info("nap: %s", line),
                )
            finally:
                # However this ended, including Harbor cancelling it at the task's timeout: the
                # child is told to stop, and whatever it counted is filed before anything else.
                exit_code = await finish(process)
                result = read_result(self.logs_dir)
                for key, value in context_from_result(result).items():
                    setattr(context, key, value)
                context.metadata = metadata_from_result(result, exit_code)

        if result is None:
            # Raised rather than scored: no result means the agent never ran, which is a broken
            # harness. Whether the task was done is the verifier's to say, and it still runs.
            raise TrialError(
                f"Nap's agent wrote no result to {self.logs_dir} — it exited {exit_code}; "
                f"see {LOG_FILENAME}"
            )
