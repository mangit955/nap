import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CHANNEL_TAG,
  ExecRequestSchema,
  ExecResponseSchema,
  LineExecChannel,
} from "./exec-channel.ts";

/** The example lines the Python half's tests read too; see the header of exec-channel.ts. */
const EXAMPLE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "harbor",
  "nap_harbor",
  "channel-example.jsonl",
);

function wired() {
  const sent: unknown[] = [];
  const channel = new LineExecChannel((line) => sent.push(JSON.parse(line)));
  return { channel, sent };
}

describe("LineExecChannel", () => {
  it("sends a tagged request with the deadline in whole seconds, rounded up", () => {
    const { channel, sent } = wired();
    void channel.exec("ls /app", { timeoutMs: 1_500 });
    expect(sent).toEqual([{ channel: CHANNEL_TAG, id: 0, command: "ls /app", timeoutSec: 2 }]);
  });

  it("settles overlapping requests by id, whatever order the answers come in", async () => {
    const { channel } = wired();
    const first = channel.exec("first");
    const second = channel.exec("second");
    channel.receive(
      JSON.stringify({
        channel: CHANNEL_TAG,
        id: 1,
        ok: true,
        exitCode: 0,
        stdout: "2",
        stderr: "",
      }),
    );
    channel.receive(
      JSON.stringify({
        channel: CHANNEL_TAG,
        id: 0,
        ok: true,
        exitCode: 3,
        stdout: "1",
        stderr: "e",
      }),
    );
    expect(await first).toEqual({ ok: true, value: { exitCode: 3, stdout: "1", stderr: "e" } });
    expect(await second).toEqual({ ok: true, value: { exitCode: 0, stdout: "2", stderr: "" } });
  });

  it("carries a failure the parent reports as a typed error", async () => {
    const { channel } = wired();
    const pending = channel.exec("sleep 99", { timeoutMs: 1_000 });
    channel.receive(
      JSON.stringify({ channel: CHANNEL_TAG, id: 0, ok: false, code: "timeout", message: "slow" }),
    );
    expect(await pending).toEqual({ ok: false, error: { code: "timeout", message: "slow" } });
  });

  it("ignores a line that is not an answer instead of failing what is in flight", async () => {
    const { channel } = wired();
    const pending = channel.exec("true");
    expect(channel.receive("some log line")).toBe(false);
    expect(channel.receive(JSON.stringify({ id: 0, ok: true }))).toBe(false);
    channel.receive(
      JSON.stringify({
        channel: CHANNEL_TAG,
        id: 0,
        ok: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
      }),
    );
    expect((await pending).ok).toBe(true);
  });

  it("fails a command whose answer it cannot read, rather than leaving it waiting", async () => {
    const { channel } = wired();
    const pending = channel.exec("true");
    expect(
      channel.receive(JSON.stringify({ channel: CHANNEL_TAG, id: 0, ok: true, exitCode: "0" })),
    ).toBe(true);
    expect(await pending).toMatchObject({ ok: false, error: { code: "exec_failed" } });
  });

  it("fails everything waiting, and everything after, once the parent goes away", async () => {
    const { channel } = wired();
    const pending = channel.exec("true");
    channel.close("the parent exited");
    expect(await pending).toEqual({
      ok: false,
      error: { code: "unavailable", message: "the parent exited" },
    });
    expect(await channel.exec("true")).toEqual({
      ok: false,
      error: { code: "unavailable", message: "the parent exited" },
    });
  });

  it("stops waiting when the caller cancels, and drops the late answer", async () => {
    const { channel } = wired();
    const controller = new AbortController();
    const pending = channel.exec("sleep 5", { signal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "exec_failed" } });
    expect(
      channel.receive(
        JSON.stringify({
          channel: CHANNEL_TAG,
          id: 0,
          ok: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
        }),
      ),
    ).toBe(true);
  });
});

describe("the lines the Python half reads too", () => {
  const lines = readFileSync(EXAMPLE, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { direction: string; line: unknown });

  it("covers a request, a success and each kind of failure", () => {
    expect(lines.map((entry) => entry.direction)).toEqual([
      "request",
      "request",
      "response",
      "response",
      "response",
    ]);
  });

  it.each(lines.map((entry, index) => [index, entry] as const))(
    "line %i is one this side accepts",
    (_index, entry) => {
      const schema = entry.direction === "request" ? ExecRequestSchema : ExecResponseSchema;
      expect(schema.safeParse(entry.line).success).toBe(true);
    },
  );
});
