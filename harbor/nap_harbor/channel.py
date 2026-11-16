"""The answering half of the exec channel: Nap's agent asks, this runs the command.

Nap's agent runs as a ``bun`` child of the Harbor agent and cannot reach the task's machine
itself; Harbor holds the only handle to it. So the child writes one JSON line per command on its
stdout, and this answers each on the child's stdin with whatever ``environment.exec`` returned.
The requesting half, and the reason for the arrangement, are in
``packages/sandbox/src/exec-channel.ts`` and ``docs/adr/0035``.

Standard library only, so the suite can drive every line of it without Harbor installed. Both
halves read ``channel-example.jsonl``, so a field renamed on one side fails the other's tests.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

CHANNEL_TAG = "nap-exec"

#: Bytes one request line may hold. A file the agent writes travels base64-encoded in requests,
#: in pieces of about 96 KiB, which asyncio's default of 64 KiB would refuse. Answers, which can
#: hold a whole file read back, go the other way and are not limited here.
LINE_LIMIT = 64 * 1024 * 1024


@dataclass(frozen=True)
class ExecRequest:
    id: int
    command: str
    timeout_sec: int | None


@dataclass(frozen=True)
class ExecOutcome:
    exit_code: int
    stdout: str
    stderr: str


#: Runs one command in the task's machine. ``environment.exec``, adapted.
Exec = Callable[[str, int | None], Awaitable[ExecOutcome]]


def parse_request(line: str) -> ExecRequest | None:
    """The request a line carries, or ``None`` for a line that is not one — a log line, say."""
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or data.get("channel") != CHANNEL_TAG:
        return None
    request_id = data.get("id")
    command = data.get("command")
    timeout = data.get("timeoutSec")
    if not isinstance(request_id, int) or not isinstance(command, str):
        return None
    if timeout is not None and not isinstance(timeout, int):
        return None
    return ExecRequest(id=request_id, command=command, timeout_sec=timeout)


def tagged_id(line: str) -> int | None:
    """The id of a line that is this channel's but not a readable request, else ``None``."""
    try:
        data = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict) or data.get("channel") != CHANNEL_TAG:
        return None
    request_id = data.get("id")
    return request_id if isinstance(request_id, int) else None


def success(request_id: int, outcome: ExecOutcome) -> dict:
    return {
        "channel": CHANNEL_TAG,
        "id": request_id,
        "ok": True,
        "exitCode": outcome.exit_code,
        "stdout": outcome.stdout,
        "stderr": outcome.stderr,
    }


def failure(request_id: int, code: str, message: str) -> dict:
    return {"channel": CHANNEL_TAG, "id": request_id, "ok": False, "code": code, "message": message}


async def answer(request: ExecRequest, run: Exec) -> dict:
    """Runs one request and says how it went. Never raises: a failure is an answer too."""
    try:
        if request.timeout_sec is None:
            outcome = await run(request.command, None)
        else:
            outcome = await asyncio.wait_for(
                run(request.command, request.timeout_sec), request.timeout_sec
            )
    except TimeoutError:
        return failure(
            request.id,
            "timeout",
            f"the command did not finish within {request.timeout_sec} seconds",
        )
    except Exception as error:  # noqa: BLE001 — any failure is reported to the asker, not raised
        return failure(request.id, "exec_failed", f"{type(error).__name__}: {error}")
    return success(request.id, outcome)


async def serve(
    lines: asyncio.StreamReader,
    reply: Callable[[bytes], Awaitable[None]],
    run: Exec,
    other: Callable[[str], None],
) -> None:
    """Answers requests read from ``lines`` until it ends, each as soon as it finishes.

    Requests overlap — the agent lists files and discovers skills at once — so each runs as its
    own task and answers carry the request's id. A line that is not a request goes to ``other``.
    Returns once the stream ends and every answer has been written, or abandoned because the
    asker is gone.
    """
    in_flight: set[asyncio.Task] = set()

    async def respond(request: ExecRequest) -> None:
        body = await answer(request, run)
        try:
            await reply((json.dumps(body) + "\n").encode())
        except (BrokenPipeError, ConnectionResetError):
            pass  # the child exited; nobody is waiting for this answer

    while True:
        raw = await lines.readline()
        if not raw:
            break
        line = raw.decode(errors="replace").rstrip("\n")
        request = parse_request(line)
        if request is None:
            malformed = tagged_id(line)
            if malformed is not None:
                # Ours, but unreadable: answered, so the asker is not left waiting on it.
                body = failure(malformed, "exec_failed", "a request this side cannot read")
                await reply((json.dumps(body) + "\n").encode())
            elif line:
                other(line)
            continue
        task = asyncio.create_task(respond(request))
        in_flight.add(task)
        task.add_done_callback(in_flight.discard)

    for task in list(in_flight):
        task.cancel()
    await asyncio.gather(*in_flight, return_exceptions=True)


#: How long the child has, once its channel is closed, to stop its turn and write what it counted.
STOP_GRACE_SEC = 10.0


async def finish(process: asyncio.subprocess.Process, grace_sec: float = STOP_GRACE_SEC) -> int:
    """Ends the child however the trial ended, and returns its exit code.

    A child that is still running when this is called was abandoned: Harbor timed the trial out
    or was interrupted, and cancelled the code waiting on it. Closing its stdin is how it is
    told: it stops its turn, writes its result and exits. One that does not exit in time is
    killed, so no turn is left calling the model where nothing records the requests.
    """
    if process.returncode is None and process.stdin is not None:
        process.stdin.close()
    try:
        return await asyncio.wait_for(process.wait(), grace_sec)
    except TimeoutError:
        process.kill()
        return await process.wait()
