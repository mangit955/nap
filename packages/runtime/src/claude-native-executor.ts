import { randomUUID } from "node:crypto";
import { ClaudeNativeOutput } from "@nap/agent/claude-native-output";
import type { ClaudeNativeConfigSchema } from "@nap/agent/claude-native-session";
import { ClaudeNativeCommandSchema } from "@nap/agent/claude-native-wire";
import { type SubscriptionTarget, sameExecutionTarget } from "@nap/shared/execution-target";
import { encodeNativeFrame } from "@nap/shared/native-process-protocol";
import { NativeRunBindingSchema, type NativeRunStore } from "@nap/shared/ports/native-run-store";
import type { NativeStateCipher } from "@nap/shared/ports/native-state-cipher";
import type {
  NativeExecutionInput,
  NativeExecutionResult,
  NativeTurnExecutor,
} from "@nap/shared/ports/native-turn-executor";
import {
  NativeWorkspaceReplySchema,
  type NativeWorkspaceTools,
} from "@nap/shared/ports/native-workspace-tools";
import type {
  ProcessExit,
  SandboxProcess,
  SandboxProcessHost,
} from "@nap/shared/ports/sandbox-process";
import type { z } from "zod";
import { NativeDeliveryPump } from "./native-delivery-pump.ts";

/** A resolver must return an already isolated auth runtime, never a project credential directory. */
export type ClaudeExecutionEnvironment = {
  userId: string;
  projectId: string;
  target: SubscriptionTarget;
  sandboxId: string;
  nodeExecutable: string;
  host: SandboxProcessHost;
  config: Omit<z.infer<typeof ClaudeNativeConfigSchema>, "model" | "trustedInstructions">;
  workspace: NativeWorkspaceTools & {
    /** Revoke further writes, await filesystem calls and prove all command descendants stopped. */
    stop(): Promise<ProcessExit[] | null>;
  };
};
type Options = {
  /** No CLI/query/tool may start before the journal admits the run. */
  resolve(input: NativeExecutionInput): Promise<ClaudeExecutionEnvironment | null>;
  store: NativeRunStore;
  cipher: NativeStateCipher;
};
const refused = (message: string): NativeExecutionResult => ({
  kind: "failed",
  reason: "model_unavailable",
  message,
  quiescence: { kind: "not_started" },
});
const uncertain = (): NativeExecutionResult => ({
  kind: "failed",
  reason: "internal",
  message: "Native execution lost its termination receipt. It was not retried.",
  quiescence: { kind: "unconfirmed" },
});
async function bounded<T>(work: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function write(process: SandboxProcess, value: unknown): Promise<void> {
  const line = encodeNativeFrame(ClaudeNativeCommandSchema.parse(value));
  for (let from = 0; from < line.length; ) {
    let end = Math.min(from + 32_768, line.length);
    const last = line.charCodeAt(end - 1);
    if (end < line.length && last >= 0xd800 && last <= 0xdbff) end--;
    const sent = await process.write(line.slice(from, end));
    if (!sent.ok) throw new Error("Native command receipt is uncertain.");
    from = end;
  }
}

/** Bridges the native helper to a leased, encrypted journal. It never calls an LLMProvider. */
export class ClaudeNativeExecutor implements NativeTurnExecutor {
  constructor(private readonly options: Options) {}
  async run(
    input: NativeExecutionInput,
    output: Parameters<NativeTurnExecutor["run"]>[1],
  ): Promise<NativeExecutionResult> {
    if (input.target.driver !== "claude" || input.operation !== undefined || output.signal?.aborted)
      return refused("This native operation is unavailable. No API request was made.");
    const environment = await this.options.resolve(input);
    if (environment === null)
      return refused("The isolated Claude runtime is unavailable. No API request was made.");
    if (
      environment.sandboxId === input.sandboxId ||
      environment.userId !== input.userId ||
      environment.projectId !== input.projectId ||
      !sameExecutionTarget(environment.target, input.target)
    )
      return refused("The authenticated runtime does not belong to this execution target.");
    let admitted: Awaited<ReturnType<NativeRunStore["begin"]>>;
    try {
      admitted = await this.options.store.begin({
        id: randomUUID(),
        requestId: input.lease.requestId,
        workerId: input.lease.workerId,
        turnId: input.turnId,
      });
    } catch {
      return uncertain();
    }
    if (admitted.kind !== "created")
      return refused("This account or workspace cannot start another native run.");
    const { handle, binding } = admitted;
    const expected = NativeRunBindingSchema.parse({
      userId: input.userId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      requestId: input.lease.requestId,
      turnId: input.turnId,
      target: input.target,
    });
    if (JSON.stringify(NativeRunBindingSchema.parse(binding)) !== JSON.stringify(expected)) {
      await this.options.store.uncertain(handle);
      return uncertain();
    }
    const abort = new AbortController();
    const signal =
      output.signal === undefined ? abort.signal : AbortSignal.any([output.signal, abort.signal]);
    let process: SandboxProcess | undefined;
    let decoder: ClaudeNativeOutput | undefined;
    let receive: NativeDeliveryPump | undefined;
    let attach = () => {};
    const attached = new Promise<void>((resolve) => {
      attach = resolve;
    });
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let renewing = false;
    const cancel = () => {
      abort.abort();
      void process?.stop().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    const deadline = setTimeout(cancel, 600_000);
    let failed = false;
    let exit: Awaited<SandboxProcess["closed"]> | null = null;
    try {
      signal.throwIfAborted();
      const started = await environment.host.start(
        {
          sandboxId: environment.sandboxId,
          executable: environment.nodeExecutable,
          args: ["/opt/nap/claude-native-helper.mjs"],
          cwd: environment.config.cwd,
          env: { PATH: environment.config.environment.PATH ?? "/usr/local/bin:/usr/bin:/bin" },
          leaseMs: 5000,
          maxOutputBytes: 64 * 1024 * 1024,
          maxReplayBytes: 4 * 1024 * 1024,
        },
        async (event) => {
          await attached;
          if (receive === undefined || decoder === undefined)
            throw new Error("Native journal did not attach.");
          await receive.accept(event);
          for (const control of decoder.takeControl()) {
            signal.throwIfAborted();
            if (
              process === undefined ||
              (await this.options.store.read(handle))?.phase !== "started"
            )
              throw new Error("Native tool authorization expired.");
            const reply = NativeWorkspaceReplySchema.parse(
              await environment.workspace.execute(control.call, signal),
            );
            await write(process, { type: "tool_reply", id: control.call.id, reply });
            if (!reply.ok) {
              cancel();
              throw new Error("Native workspace execution stopped.");
            }
          }
        },
      );
      if (!started.ok) throw new Error("Native start receipt is uncertain.");
      process = started.value;
      if (
        process.reference.sandboxId !== environment.sandboxId ||
        process.reference.containment !== "cgroup"
      )
        throw new Error("Native containment is unavailable.");
      const recorded = await this.options.store.started(handle, {
        nativeSessionId: environment.config.sessionId,
        receipt: this.options.cipher.seal(
          { kind: "native_receipt", binding, runId: handle.id },
          JSON.stringify(process.reference),
        ),
      });
      if (!recorded) throw new Error("Native start persistence is unavailable.");
      decoder = new ClaudeNativeOutput(environment.config.sessionId);
      receive = await NativeDeliveryPump.open({
        store: this.options.store,
        cipher: this.options.cipher,
        handle,
        binding,
        decoder,
        publish: output.publish,
      });
      decoder.takeControl();
      attach();
      heartbeat = setInterval(() => {
        if (renewing || signal.aborted) return;
        renewing = true;
        void (async () => {
          if (
            (await this.options.store.read(handle))?.phase !== "started" ||
            !(await process?.renew())?.ok
          )
            cancel();
        })()
          .catch(cancel)
          .finally(() => {
            renewing = false;
          });
      }, 1000);
      signal.throwIfAborted();
      await write(process, {
        type: "start",
        runId: handle.id,
        config: {
          ...environment.config,
          model: input.target.model,
          trustedInstructions: input.input.trustedInstructions,
        },
        prompt: input.input.prompt,
        ...(input.input.attachments === undefined ? {} : { attachments: input.input.attachments }),
      });
      exit = await bounded(
        process.closed.catch(() => null),
        610_000,
        null,
      );
    } catch {
      failed = true;
      await this.options.store.uncertain(handle).catch(() => false);
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      signal.removeEventListener("abort", cancel);
      attach();
      // Revoke workspace writes even when native initialization never produced a receipt.
      abort.abort();
      await bounded(
        process?.stop().catch(() => undefined) ?? Promise.resolve(undefined),
        10_000,
        undefined,
      );
      if (process !== undefined)
        exit = await bounded(
          process.closed.catch(() => null),
          10_000,
          null,
        );
    }
    const writers = await bounded(
      environment.workspace.stop().catch(() => null),
      10_000,
      null,
    );
    if (
      exit === null ||
      !exit.ok ||
      exit.value.containment !== "cgroup" ||
      writers === null ||
      writers.some((proof) => proof.containment !== "cgroup")
    )
      return uncertain();
    if (!(await this.options.store.stopped(handle, exit.value))) return uncertain();
    const quiescence = { kind: "confirmed" as const, agent: exit.value, writers };
    if (output.signal?.aborted)
      return {
        kind: "failed",
        reason: "cancelled",
        message: "The native turn was cancelled.",
        quiescence,
      };
    const result = decoder?.result;
    if (failed || result == null || exit.value.code !== 0 || exit.value.reason !== "exited")
      return {
        kind: "failed",
        reason: "internal",
        message: "Native execution ended without a successful receipt. It was not retried.",
        quiescence,
      };
    if (!result.ok)
      return {
        kind: "failed",
        reason:
          result.error.code === "limit_exceeded"
            ? "budget_exceeded"
            : result.error.code === "cancelled"
              ? "cancelled"
              : "model_unavailable",
        message: result.error.message,
        quiescence,
      };
    return { kind: "completed", ...result.value, quiescence };
  }
}
