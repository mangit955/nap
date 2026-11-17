"""The Terminal-Bench entrypoint's wiring, end to end, on a scripted model: free and offline.

Every piece the entrypoint wires is tested on its own, but the wiring itself (console output
moved to stderr, the channel on stdin and stdout, the result file, stopping when stdin closes)
would otherwise be seen only on a run that spends a model's quota. Here the real ``bun`` child
runs with ``--scripted`` and ``serve`` answers it from a throwaway container standing in for the
task's machine. A container rather than a local shell because the agent's project path is
``/home/user/app``, which the entrypoint links to the task's directory, and a test must not
create that on the machine running it.

Needs ``bun`` with the checkout installed, and Docker. Skipped without them, unless
``NAP_HARBOR_E2E=required``, which CI sets so a missing tool fails rather than hides the test;
``NAP_HARBOR_E2E=skip`` skips it outright, for CI's second pass, which has already run it.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

from nap_harbor.channel import LINE_LIMIT, ExecOutcome, finish, serve
from nap_harbor.trial import (
    INSTRUCTION_FILENAME,
    TRAJECTORY_FILENAME,
    default_repo_root,
    entrypoint_command,
    read_result,
)

IMAGE = "debian:bookworm-slim"
REQUIRED = os.environ.get("NAP_HARBOR_E2E") == "required"
SKIPPED = os.environ.get("NAP_HARBOR_E2E") == "skip"


def _missing() -> str | None:
    if shutil.which("bun") is None:
        return "bun is not installed"
    if not (default_repo_root() / "node_modules").is_dir():
        return "the checkout has no node_modules; run bun install"
    if shutil.which("docker") is None:
        return "docker is not installed"
    probe = subprocess.run(["docker", "info"], capture_output=True, check=False)
    if probe.returncode != 0:
        return "docker is not running"
    return None


@pytest.fixture
def machine():
    """A container with a task's shape: an ``/app`` working directory and a shell."""
    if SKIPPED:
        pytest.skip("NAP_HARBOR_E2E=skip: already run in this CI job")
    missing = _missing()
    if missing is not None:
        if REQUIRED:
            pytest.fail(f"NAP_HARBOR_E2E=required, but {missing}")
        pytest.skip(missing)
    started = subprocess.run(
        ["docker", "run", "-d", "--rm", "-w", "/app", IMAGE, "sleep", "600"],
        capture_output=True,
        text=True,
        check=True,
    )
    container = started.stdout.strip()
    try:
        yield container
    finally:
        subprocess.run(["docker", "rm", "-f", container], capture_output=True, check=False)


def _exec_in(container: str):
    async def run(command: str, timeout_sec: int | None) -> ExecOutcome:
        process = await asyncio.create_subprocess_exec(
            "docker",
            "exec",
            container,
            "bash",
            "-c",
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()
        return ExecOutcome(
            exit_code=process.returncode or 0,
            stdout=stdout.decode(errors="replace"),
            stderr=stderr.decode(errors="replace"),
        )

    return run


async def _start(job_dir: Path) -> asyncio.subprocess.Process:
    (job_dir / INSTRUCTION_FILENAME).write_text("Write the marker file.")
    command = entrypoint_command(
        repo_root=default_repo_root(),
        job_dir=job_dir,
        model="openai/gpt-6-luna",  # ignored by --scripted, which must win over it
        extra_args=["--scripted"],
    )
    return await asyncio.create_subprocess_exec(
        *command,
        cwd=default_repo_root(),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
        limit=LINE_LIMIT,
    )


def test_a_scripted_turn_runs_in_the_machine_and_files_its_result(machine, tmp_path):
    stray: list[str] = []

    async def trial() -> int:
        process = await _start(tmp_path)
        assert process.stdin is not None and process.stdout is not None
        stdin = process.stdin

        async def reply(line: bytes) -> None:
            stdin.write(line)
            await stdin.drain()

        try:
            await asyncio.wait_for(
                serve(process.stdout, reply, _exec_in(machine), stray.append), 120
            )
        finally:
            exit_code = await finish(process)
        return exit_code

    exit_code = asyncio.run(trial())

    assert exit_code == 0
    # Stdout is the channel: anything else on it is a print that escaped to the wrong stream.
    assert stray == []
    result = read_result(tmp_path)
    assert result is not None
    assert result["status"] == "completed", result
    assert result["model"] == "nap/scripted"
    assert result["requests"] == 0
    assert result["steps"] == 3
    assert result["workdir"] == "/app"
    events = [
        json.loads(line) for line in (tmp_path / TRAJECTORY_FILENAME).read_text().splitlines()
    ]
    assert [e["type"] for e in events if e["type"].startswith("turn.")] == [
        "turn.started",
        "turn.completed",
    ]
    marker = subprocess.run(
        ["docker", "exec", machine, "cat", "/app/nap-scripted.txt"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert marker.stdout == "written by Nap's scripted model\n"


def test_closing_stdin_stops_the_turn_and_still_files_a_result(machine, tmp_path):
    async def trial() -> int:
        process = await _start(tmp_path)
        assert process.stdout is not None
        # The first request is never answered: Harbor gave up on the trial before it could be.
        first = await asyncio.wait_for(process.stdout.readline(), 60)
        assert json.loads(first)["channel"] == "nap-exec"
        return await finish(process)

    exit_code = asyncio.run(trial())

    assert exit_code == 0
    result = read_result(tmp_path)
    assert result is not None
    assert result["status"] == "failed"
    assert result["failure"]["reason"] == "sandbox_unavailable"
