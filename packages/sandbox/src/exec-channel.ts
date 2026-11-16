/**
 * Running commands in a machine this process cannot reach, by asking the process that can.
 *
 * Harbor builds a benchmark task's container and holds the only handle to it, in Python. Nap's
 * agent is TypeScript. Rather than learn how each of Harbor's environments names its machine (a
 * Docker Compose project, a Daytona sandbox, a Modal function), the agent asks its parent: one
 * JSON line per command on stdout, one JSON line per answer on stdin, and the parent runs each
 * through `environment.exec`, the one call every Harbor environment has. See ADR-0035.
 *
 * Requests carry an id because they overlap — the context engine lists files and discovers
 * skills at once — and answers come back in whatever order they finish. A line that is not an
 * answer is not this channel's, and is ignored rather than failing every command in flight.
 *
 * The Python half is `harbor/nap_harbor/channel.py`. Both halves read the same example lines in
 * `harbor/nap_harbor/channel-example.jsonl`, so a field renamed on one side fails the other's
 * tests rather than every trial.
 */

import type { ExecResult, SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { z } from "zod";

/** Marks a line as this channel's, so it can share a stream with anything else that prints. */
export const CHANNEL_TAG = "nap-exec";

export const ExecRequestSchema = z.strictObject({
  channel: z.literal(CHANNEL_TAG),
  id: z.int().nonnegative(),
  command: z.string(),
  /** Whole seconds, because that is what `environment.exec` takes. Absent is no deadline. */
  timeoutSec: z.int().positive().optional(),
});
export type ExecRequest = z.infer<typeof ExecRequestSchema>;

export const ExecResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    channel: z.literal(CHANNEL_TAG),
    id: z.int().nonnegative(),
    ok: z.literal(true),
    exitCode: z.int(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  z.strictObject({
    channel: z.literal(CHANNEL_TAG),
    id: z.int().nonnegative(),
    ok: z.literal(false),
    code: z.enum(["timeout", "exec_failed"]),
    message: z.string(),
  }),
]);
export type ExecResponse = z.infer<typeof ExecResponseSchema>;

/** Just enough of a line to know it answers one of this channel's requests. */
const ExecAddressSchema = z.object({ channel: z.literal(CHANNEL_TAG), id: z.int().nonnegative() });

/** One command, run to completion in the far machine's default working directory. */
export type ExecChannel = (
  command: string,
  options?: { timeoutMs?: number | undefined; signal?: AbortSignal | undefined },
) => Promise<Result<ExecResult, SandboxError>>;

type Pending = (answer: Result<ExecResult, SandboxError>) => void;

/**
 * The requesting half over a pair of line streams.
 *
 * `send` writes one line; `receive` is fed every line read back. Kept apart from any particular
 * stream so a test can wire two of these halves to each other, or to a fake, without a process.
 */
export class LineExecChannel {
  readonly #send: (line: string) => void;
  readonly #pending = new Map<number, Pending>();
  #nextId = 0;
  #closed: string | undefined;

  constructor(send: (line: string) => void) {
    this.#send = send;
  }

  /** The channel as the function a sandbox adapter takes. */
  readonly exec: ExecChannel = (command, options) => {
    if (this.#closed !== undefined)
      return Promise.resolve({ ok: false, error: { code: "unavailable", message: this.#closed } });
    if (options?.signal?.aborted)
      return Promise.resolve({
        ok: false,
        error: { code: "exec_failed", message: "Cancelled before running." },
      });

    const id = this.#nextId++;
    const request: ExecRequest = {
      channel: CHANNEL_TAG,
      id,
      command,
      // Rounded up: a deadline of 1.5 seconds must not become one that fires at 1.
      ...(options?.timeoutMs === undefined
        ? {}
        : { timeoutSec: Math.max(1, Math.ceil(options.timeoutMs / 1_000)) }),
    };
    return new Promise((resolve) => {
      const abort = () => {
        // The parent may still be running it; a signal only stops this side waiting, which is
        // all `ExecOptions.signal` promises.
        this.#pending.delete(id);
        resolve({ ok: false, error: { code: "exec_failed", message: "Cancelled while running." } });
      };
      options?.signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, (answer) => {
        options?.signal?.removeEventListener("abort", abort);
        resolve(answer);
      });
      this.#send(JSON.stringify(request));
    });
  };

  /** Feeds one line read back from the parent. Returns whether it was an answer. */
  receive(line: string): boolean {
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return false;
    }
    const parsed = ExecResponseSchema.safeParse(json);
    if (!parsed.success) {
      // An answer to one of ours that cannot be read fails that command now. Dropped, it would
      // leave the command waiting for an answer that has already come.
      const id = ExecAddressSchema.safeParse(json);
      if (!id.success) return false;
      const settle = this.#pending.get(id.data.id);
      this.#pending.delete(id.data.id);
      settle?.({
        ok: false,
        error: {
          code: "exec_failed",
          message: `An answer this side cannot read: ${line.slice(0, 200)}`,
        },
      });
      return true;
    }
    const answer = parsed.data;
    const settle = this.#pending.get(answer.id);
    if (settle === undefined) return true;
    this.#pending.delete(answer.id);
    settle(
      answer.ok
        ? {
            ok: true,
            value: { exitCode: answer.exitCode, stdout: answer.stdout, stderr: answer.stderr },
          }
        : { ok: false, error: { code: answer.code, message: answer.message } },
    );
    return true;
  }

  /**
   * The parent stopped answering. Everything waiting fails as `unavailable`, and so does every
   * later command, rather than hanging a turn on an answer nobody will send.
   */
  close(reason: string): void {
    this.#closed = reason;
    for (const settle of this.#pending.values())
      settle({ ok: false, error: { code: "unavailable", message: reason } });
    this.#pending.clear();
  }
}
