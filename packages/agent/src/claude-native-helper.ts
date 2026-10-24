import type {
  NativeWorkspaceCall,
  NativeWorkspaceReply,
} from "@nap/shared/ports/native-workspace-tools";
import { z } from "zod";
import { ClaudeNativeSession, type ClaudeQueryFactory } from "./claude-native-session.ts";
import {
  type ClaudeNativeCommand,
  ClaudeNativeCommandSchema,
  type ClaudeNativeFrame,
} from "./claude-native-wire.ts";
import { createNativeWorkspaceTools } from "./native-workspace-tools.ts";

/** One contained helper owns one query. The parent must still prove physical process termination. */
export class ClaudeNativeHelper {
  readonly #abort = new AbortController();
  readonly #pending = new Map<string, (reply: NativeWorkspaceReply) => void>();
  #session: ClaudeNativeSession | undefined;
  #started = false;
  #ended = false;
  #settle = () => {};
  #finished = false;
  readonly closed = new Promise<void>((resolve) => {
    this.#settle = resolve;
  });
  constructor(
    private readonly options: {
      query: ClaudeQueryFactory;
      write: (frame: ClaudeNativeFrame) => Promise<void>;
    },
  ) {}

  async accept(value: unknown): Promise<void> {
    const parsed = ClaudeNativeCommandSchema.safeParse(value);
    if (!parsed.success || this.#ended) {
      this.stop();
      throw new Error("Invalid or closed native command channel.");
    }
    const command = parsed.data;
    switch (command.type) {
      case "start":
        if (this.#started) {
          this.stop();
          throw new Error("Native start cannot be replayed.");
        }
        this.#started = true;
        void this.#run(command);
        return;
      case "cancel":
        this.stop();
        return;
      case "tool_reply": {
        const resolve = this.#pending.get(command.id);
        if (resolve === undefined) {
          this.stop();
          throw new Error("Unknown native operation receipt.");
        }
        this.#pending.delete(command.id);
        resolve(command.reply);
        return;
      }
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  }

  stop(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#abort.abort();
    this.#session?.close();
    for (const resolve of this.#pending.values())
      resolve({ ok: false, error: { code: "execution_uncertain" } });
    this.#pending.clear();
    if (!this.#started) this.#settle();
  }

  async #run(command: Extract<ClaudeNativeCommand, { type: "start" }>): Promise<void> {
    try {
      const tools = await createNativeWorkspaceTools({
        runId: command.runId,
        signal: this.#abort.signal,
        remote: { execute: (call, signal) => this.#call(call, signal) },
        onUncertain: () => this.stop(),
      });
      if (this.#abort.signal.aborted) return;
      const opened = await ClaudeNativeSession.open(command.config, {
        query: this.options.query,
        tools,
      });
      if (!opened.ok) {
        await this.#finish(opened);
        return;
      }
      this.#session = opened.value;
      if (this.#abort.signal.aborted) {
        this.#session.close();
        return;
      }
      const result = await this.#session.run(
        {
          prompt: command.prompt,
          signal: this.#abort.signal,
          ...(command.attachments === undefined ? {} : { attachments: command.attachments }),
        },
        async (message) => {
          // Input echoes can contain the complete image payload; the native transcript owns them.
          if (z.object({ type: z.literal("user") }).safeParse(message).success) return;
          await this.options.write({ type: "message", message });
        },
      );
      await this.#finish(result);
    } catch {
      // No raw SDK, transport or credential-file exception reaches this channel.
      await this.#finish({
        ok: false,
        error: {
          code: "unavailable",
          message: "Native execution lost its receipt. It was not retried.",
        },
      }).catch(() => {});
    } finally {
      if (!this.#finished)
        await this.#finish({
          ok: false,
          error: { code: "cancelled", message: "The native operation was stopped." },
        }).catch(() => {});
      this.stop();
      this.#settle();
    }
  }

  async #finish(result: Extract<ClaudeNativeFrame, { type: "finished" }>["result"]): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    await this.options.write({ type: "finished", result });
  }
  async #call(call: NativeWorkspaceCall, signal: AbortSignal): Promise<NativeWorkspaceReply> {
    if (signal.aborted || this.#ended || this.#pending.size >= 8 || this.#pending.has(call.id))
      return { ok: false, error: { code: "denied" } };
    let resolve = (_reply: NativeWorkspaceReply) => {};
    const reply = new Promise<NativeWorkspaceReply>((done) => {
      resolve = done;
    });
    this.#pending.set(call.id, resolve);
    const abort = () => {
      this.#pending.delete(call.id);
      resolve({ ok: false, error: { code: "execution_uncertain" } });
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 120_000);
    try {
      await this.options.write({ type: "tool_call", call });
      return await reply;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.#pending.delete(call.id);
    }
  }
}
