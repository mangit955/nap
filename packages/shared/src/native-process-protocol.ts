/** Private supervisor protocol. Credentials and command input never belong in Nap events. */
import { z } from "zod";

const token = z.string().regex(/^[a-f0-9]{64}$/);
const sequence = z.int().nonnegative();
const containment = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("process_group") }),
  z.strictObject({
    kind: z.literal("cgroup"),
    root: z.string().regex(/^\/sys\/fs\/cgroup(?:\/[a-zA-Z0-9_-]+)*$/),
    uid: z.int().positive(),
    gid: z.int().positive(),
  }),
]);

export const NativeHostStartSchema = z.strictObject({
  type: z.literal("start"),
  token,
  executable: z.string().min(1).max(4096),
  args: z.array(z.string().max(65536)).max(256),
  cwd: z.string().startsWith("/").max(4096),
  env: z.record(z.string(), z.string().max(65536)),
  leaseMs: z.int().min(50).max(300_000),
  maxOutputBytes: z
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  maxReplayBytes: z
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  containment,
});
export type NativeHostStart = z.infer<typeof NativeHostStartSchema>;

export const NativeHostCommandSchema = z.discriminatedUnion("type", [
  NativeHostStartSchema,
  z.strictObject({ type: z.literal("input"), token, data: z.string().max(65536) }),
  z.strictObject({ type: z.literal("ack"), token, sequence }),
  z.strictObject({ type: z.literal("replay"), token, afterSequence: sequence }),
  z.strictObject({ type: z.literal("renew"), token }),
  z.strictObject({ type: z.literal("interrupt"), token }),
  z.strictObject({ type: z.literal("stop"), token }),
]);
export type NativeHostCommand = z.infer<typeof NativeHostCommandSchema>;

export const NativeHostExitReasonSchema = z.enum([
  "exited",
  "stopped",
  "interrupted",
  "lease_expired",
  "controller_closed",
  "output_limit",
  "input_limit",
  "replay_limit",
  "replay_unavailable",
  "protocol_error",
  "spawn_failed",
  "containment_unavailable",
]);
export type NativeHostExitReason = z.infer<typeof NativeHostExitReasonSchema>;

export const NativeHostEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ready"),
    pid: z.int().positive(),
    containment: z.enum(["process_group", "cgroup"]),
  }),
  z.strictObject({
    type: z.literal("output"),
    seq: sequence,
    stream: z.enum(["stdout", "stderr"]),
    data: z
      .string()
      .max(1024 * 1024)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
  z.strictObject({
    type: z.literal("exit"),
    seq: sequence,
    code: z.int().nullable(),
    reason: NativeHostExitReasonSchema,
    containment: z.enum(["process_group", "cgroup", "unknown"]),
  }),
]);
export type NativeHostEvent = z.infer<typeof NativeHostEventSchema>;

/** Incremental byte framing bounds an unfinished line before decoding or parsing it. */
export class NativeFrameDecoder<T> {
  readonly #schema: z.ZodType<T>;
  readonly #limit: number;
  #pending = Buffer.alloc(0);
  #closed = false;

  constructor(schema: z.ZodType<T>, maxFrameBytes: number) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1)
      throw new Error("Invalid frame limit");
    this.#schema = schema;
    this.#limit = maxFrameBytes;
  }

  push(chunk: Uint8Array): T[] {
    if (this.#closed) throw new Error("Native process decoder is closed");
    const bytes = Buffer.from(chunk);
    const values: T[] = [];
    let from = 0;
    try {
      while (from < bytes.length) {
        const newline = bytes.indexOf(10, from);
        const end = newline < 0 ? bytes.length : newline;
        if (this.#pending.length + end - from > this.#limit) {
          throw new Error("Native process frame exceeds its byte limit");
        }
        this.#pending = Buffer.concat([this.#pending, bytes.subarray(from, end)]);
        if (newline < 0) break;
        let value: unknown;
        try {
          value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.#pending));
        } catch {
          throw new Error("Invalid native process frame");
        }
        const parsed = this.#schema.safeParse(value);
        if (!parsed.success) throw new Error("Invalid native process frame");
        values.push(parsed.data);
        this.#pending = Buffer.alloc(0);
        from = newline + 1;
      }
      return values;
    } catch (error) {
      this.#pending = Buffer.alloc(0);
      this.#closed = true;
      throw error;
    }
  }

  finish(): void {
    const truncated = this.#pending.length > 0;
    this.#pending = Buffer.alloc(0);
    this.#closed = true;
    if (truncated) throw new Error("Truncated native process frame");
  }
}

/** JSON escaping keeps arbitrary child input inside one protocol frame. */
export function encodeNativeFrame(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Invalid native process frame");
  return `${json}\n`;
}
