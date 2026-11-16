"""The answering half of the exec channel, driven without Harbor or a child process."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from nap_harbor.channel import (
    CHANNEL_TAG,
    ExecOutcome,
    ExecRequest,
    answer,
    parse_request,
    serve,
)

EXAMPLE = Path(__file__).resolve().parents[1] / "nap_harbor" / "channel-example.jsonl"


def example_lines(direction: str) -> list[dict]:
    entries = [json.loads(line) for line in EXAMPLE.read_text().splitlines() if line.strip()]
    return [entry["line"] for entry in entries if entry["direction"] == direction]


async def ok(command: str, timeout_sec: int | None) -> ExecOutcome:
    return ExecOutcome(exit_code=0, stdout=f"ran {command}", stderr="")


class TestTheSharedExample:
    """The TypeScript half's tests read the same file; a renamed field fails one side or the other."""

    def test_every_example_request_parses(self):
        requests = [parse_request(json.dumps(line)) for line in example_lines("request")]

        assert requests == [
            ExecRequest(id=0, command="timeout -k 5 60 bash -c 'ls /app'", timeout_sec=75),
            ExecRequest(id=1, command="pwd", timeout_sec=None),
        ]

    def test_every_example_response_is_one_this_side_writes(self):
        responses = example_lines("response")
        success, timeout, failed = responses

        assert (
            asyncio.run(answer(ExecRequest(id=0, command="x", timeout_sec=None), _returns(success)))
            == success
        )
        assert set(timeout) == set(failed) == {"channel", "id", "ok", "code", "message"}
        assert {timeout["code"], failed["code"]} == {"timeout", "exec_failed"}


def _returns(response: dict):
    async def run(command: str, timeout_sec: int | None) -> ExecOutcome:
        return ExecOutcome(response["exitCode"], response["stdout"], response["stderr"])

    return run


class TestParseRequest:
    def test_ignores_a_line_that_is_not_a_request(self):
        assert parse_request("Nap on a Terminal-Bench task") is None
        assert parse_request(json.dumps({"id": 1, "command": "ls"})) is None
        assert (
            parse_request(json.dumps({"channel": CHANNEL_TAG, "id": "1", "command": "ls"})) is None
        )
        assert (
            parse_request(
                json.dumps({"channel": CHANNEL_TAG, "id": 1, "command": "ls", "timeoutSec": "9"})
            )
            is None
        )


class TestAnswer:
    def test_reports_a_command_that_overran_as_a_timeout(self):
        async def slow(command: str, timeout_sec: int | None) -> ExecOutcome:
            await asyncio.sleep(5)
            return ExecOutcome(0, "", "")

        reply = asyncio.run(answer(ExecRequest(id=3, command="sleep", timeout_sec=1), slow))

        assert reply["ok"] is False
        assert reply["code"] == "timeout"
        assert reply["id"] == 3

    def test_reports_an_environment_that_raised_rather_than_raising(self):
        async def broken(command: str, timeout_sec: int | None) -> ExecOutcome:
            raise RuntimeError("the environment is gone")

        reply = asyncio.run(answer(ExecRequest(id=4, command="ls", timeout_sec=None), broken))

        assert reply == {
            "channel": CHANNEL_TAG,
            "id": 4,
            "ok": False,
            "code": "exec_failed",
            "message": "RuntimeError: the environment is gone",
        }


class TestServe:
    def test_answers_every_request_and_passes_other_lines_on(self):
        async def scenario() -> tuple[list[dict], list[str]]:
            reader = asyncio.StreamReader()
            for line in [
                "starting up",
                json.dumps({"channel": CHANNEL_TAG, "id": 0, "command": "a"}),
                json.dumps({"channel": CHANNEL_TAG, "id": 1, "command": "b", "timeoutSec": 5}),
            ]:
                reader.feed_data((line + "\n").encode())
            replies: list[dict] = []
            others: list[str] = []

            async def reply(data: bytes) -> None:
                replies.append(json.loads(data))

            async def end_later() -> None:
                await asyncio.sleep(0.1)
                reader.feed_eof()

            await asyncio.gather(serve(reader, reply, ok, others.append), end_later())
            return replies, others

        replies, others = asyncio.run(scenario())

        assert others == ["starting up"]
        assert sorted((r["id"], r["stdout"]) for r in replies) == [(0, "ran a"), (1, "ran b")]

    def test_answers_a_quick_request_before_a_slow_one_that_came_first(self):
        async def scenario() -> list[int]:
            reader = asyncio.StreamReader()
            order: list[int] = []

            async def run(command: str, timeout_sec: int | None) -> ExecOutcome:
                await asyncio.sleep(0.2 if command == "slow" else 0)
                return ExecOutcome(0, "", "")

            async def reply(data: bytes) -> None:
                order.append(json.loads(data)["id"])

            for request_id, command in [(0, "slow"), (1, "quick")]:
                line = {"channel": CHANNEL_TAG, "id": request_id, "command": command}
                reader.feed_data((json.dumps(line) + "\n").encode())

            async def end_later() -> None:
                await asyncio.sleep(0.4)
                reader.feed_eof()

            await asyncio.gather(serve(reader, reply, run, lambda _: None), end_later())
            return order

        assert asyncio.run(scenario()) == [1, 0]

    def test_abandons_what_is_still_running_once_the_asker_has_gone(self):
        """The child closing its stdout means it exited: nobody is left to read an answer."""

        async def scenario() -> list[dict]:
            reader = asyncio.StreamReader()
            replies: list[dict] = []

            async def run(command: str, timeout_sec: int | None) -> ExecOutcome:
                await asyncio.sleep(5)
                return ExecOutcome(0, "", "")

            async def reply(data: bytes) -> None:
                replies.append(json.loads(data))

            line = {"channel": CHANNEL_TAG, "id": 0, "command": "slow"}
            reader.feed_data((json.dumps(line) + "\n").encode())
            reader.feed_eof()
            await asyncio.wait_for(serve(reader, reply, run, lambda _: None), 2)
            return replies

        assert asyncio.run(scenario()) == []
