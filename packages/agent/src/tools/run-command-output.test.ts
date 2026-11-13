/**
 * What `run_command` writes to the event log while a command runs.
 *
 * Every `command.output` is a durable row: an append, a notification, and a read on every API
 * process streaming the session. So output is coalesced on its way to the log, and these are the
 * properties that must survive the coalescing — the bytes, their order, and that all of it is in
 * the log before the call's result, however the call ended.
 */

import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type {
  ExecOptions,
  ExecOutputHandler,
  ExecResult,
  SandboxError,
} from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeTool, type ToolContext } from "./execute.ts";
import { OUTPUT_FLUSH_AFTER_CHARS, OUTPUT_FLUSH_AFTER_MS } from "./output-stream.ts";

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN_ID = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";

let manager: InMemorySandboxManager;
let sandboxId: string;
let events: PendingEvent[];

beforeEach(async () => {
  manager = new InMemorySandboxManager();
  const created = await manager.create("project");
  if (!created.ok) throw new Error(created.error.message);
  sandboxId = created.value.id;
  events = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function context(signal?: AbortSignal): ToolContext {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sandboxId,
    sandbox: manager,
    signal,
    emit: (event) => events.push(event as PendingEvent),
    now: () => "2026-01-01T00:00:00.000Z",
  };
}

function run(command: string, signal?: AbortSignal) {
  return executeTool({ id: "toolu_1", name: "run_command", input: { command } }, context(signal));
}

const types = () => events.map((event) => event.type);

function outputs(): { stream: string; chunk: string }[] {
  return events.flatMap((event) =>
    event.type === "command.output"
      ? [{ stream: event.payload.stream, chunk: event.payload.chunk }]
      : [],
  );
}

type Exec = (
  sandboxId: string,
  command: string,
  onOutput?: ExecOutputHandler,
  options?: ExecOptions,
) => Promise<Result<ExecResult, SandboxError>>;

/** Replaces the fake's `exec` with one the test drives chunk by chunk. */
function execWith(body: Exec): void {
  vi.spyOn(manager, "exec").mockImplementation(body);
}

describe("run_command output", () => {
  it("writes a thousand small chunks as a bounded number of events, byte for byte", async () => {
    // An `npm install`: a thousand short lines, with the odd warning on stderr.
    const chunks = Array.from({ length: 1_000 }, (_, i) => ({
      stream: i % 100 === 99 ? ("stderr" as const) : ("stdout" as const),
      data: `added package-${i}@1.0.${i} in ${i % 7}ms\n`,
    }));
    manager.script(/install/, { chunks });

    await run("npm install");

    // Ten stderr lines each split the stdout around them, so at most two pieces per run of
    // stdout plus each warning — and nowhere near one row per line.
    expect(outputs().length).toBeLessThanOrEqual(30);
    // Every byte, in the order it arrived, with each stream's bytes on that stream.
    expect(
      outputs()
        .map((piece) => piece.chunk)
        .join(""),
    ).toBe(chunks.map((chunk) => chunk.data).join(""));
    for (const stream of ["stdout", "stderr"] as const)
      expect(
        outputs()
          .filter((piece) => piece.stream === stream)
          .map((piece) => piece.chunk)
          .join(""),
      ).toBe(
        chunks
          .filter((chunk) => chunk.stream === stream)
          .map((chunk) => chunk.data)
          .join(""),
      );
  });

  it("flushes the last partial piece before the call's result", async () => {
    manager.script(/build/, {
      chunks: [
        { stream: "stdout", data: "vite building\n" },
        { stream: "stdout", data: "built in 1.2s\n" },
      ],
    });

    await run("bun run build");

    expect(types()).toEqual(["tool.call", "command.output", "tool.result"]);
    expect(outputs()).toEqual([{ stream: "stdout", chunk: "vite building\nbuilt in 1.2s\n" }]);
  });

  it("shows output while the command is still running, on a real timer", async () => {
    vi.useFakeTimers();
    let finish = () => {};
    execWith(async (_id, _command, onOutput) => {
      onOutput?.({ stream: "stdout", data: "starting\n" });
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { ok: true, value: { exitCode: 0, stdout: "starting\n", stderr: "" } };
    });

    const pending = run("bun run dev");
    await vi.advanceTimersByTimeAsync(OUTPUT_FLUSH_AFTER_MS);

    // Nothing else has arrived and the command has not returned, yet the line is in the log.
    expect(types()).toEqual(["tool.call", "command.output"]);

    finish();
    await pending;
    expect(types()).toEqual(["tool.call", "command.output", "tool.result"]);
  });

  it("loses nothing written before a cancel, and writes nothing after the result", async () => {
    const controller = new AbortController();
    let late: (() => void) | undefined;
    execWith(async (_id, _command, onOutput, options) => {
      onOutput?.({ stream: "stdout", data: "step 1\n" });
      onOutput?.({ stream: "stderr", data: "warn: slow\n" });
      onOutput?.({ stream: "stdout", data: "step 2\n" });
      await new Promise<void>((resolve) => {
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      // A transport tearing down can deliver once more after the call has been answered.
      late = () => onOutput?.({ stream: "stdout", data: "after the cancel\n" });
      return { ok: false, error: { code: "exec_failed", message: "aborted" } };
    });

    const pending = run("npm test", controller.signal);
    await Promise.resolve();
    controller.abort();
    await pending;
    late?.();

    expect(outputs()).toEqual([
      { stream: "stdout", chunk: "step 1\n" },
      { stream: "stderr", chunk: "warn: slow\n" },
      { stream: "stdout", chunk: "step 2\n" },
    ]);
    expect(types().at(-1)).toBe("tool.result");
  });

  it("writes everything already buffered when the sandbox throws", async () => {
    execWith(async (_id, _command, onOutput) => {
      onOutput?.({ stream: "stdout", data: "partial\n" });
      throw new Error("transport closed");
    });

    await expect(run("npm test")).rejects.toThrow("transport closed");

    expect(outputs()).toEqual([{ stream: "stdout", chunk: "partial\n" }]);
  });

  it("keeps the size of any one event near the threshold", async () => {
    manager.script(/noisy/, {
      chunks: Array.from({ length: 500 }, () => ({
        stream: "stdout" as const,
        data: "y".repeat(97),
      })),
    });

    await run("noisy");

    for (const piece of outputs())
      expect(piece.chunk.length).toBeLessThan(OUTPUT_FLUSH_AFTER_CHARS + 97);
  });
});
