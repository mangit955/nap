import { TOOL_SCHEMAS } from "@nap/agent/tools/definitions";
import { executeTool } from "@nap/agent/tools/execute";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { EventStore, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import {
  type NativeWorkspaceCall,
  NativeWorkspaceCallSchema,
  type NativeWorkspaceReply,
  type NativeWorkspaceTools,
} from "@nap/shared/ports/native-workspace-tools";
import type {
  ExecOutputHandler,
  ExecResult,
  SandboxError,
  SandboxManager,
} from "@nap/shared/ports/sandbox-manager";
import type {
  ProcessExit,
  SandboxProcess,
  SandboxProcessHost,
} from "@nap/shared/ports/sandbox-process";
import type { Result } from "@nap/shared/result";

const denied = (): NativeWorkspaceReply => ({ ok: false, error: { code: "denied" } });
const uncertain = (): NativeWorkspaceReply => ({
  ok: false,
  error: { code: "execution_uncertain" },
});
const unavailable = (): Result<never, SandboxError> => ({
  ok: false,
  error: {
    code: "unavailable",
    message: "The supervised project operation could not be confirmed.",
  },
});
async function bounded<T>(work: Promise<T>, fallback: T, timeoutMs = 10_000): Promise<T> {
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

/** Bound to a single leased run. There is no provider credential or account selector in tool input. */
export class NativeWorkspaceGateway implements NativeWorkspaceTools {
  #closed = false;
  #uncertain = false;
  #outputBytes = 0;
  readonly #abort = new AbortController();
  readonly #seen = new Set<string>();
  readonly #active = new Set<Promise<NativeWorkspaceReply>>();
  readonly #processes = new Set<SandboxProcess>();
  readonly #proofs: ProcessExit[] = [];
  #delivery: Promise<void> = Promise.resolve();
  constructor(
    private readonly options: {
      sessionId: string;
      turnId: string;
      sandboxId: string;
      sandbox: SandboxManager;
      host: SandboxProcessHost;
      authorize(): Promise<boolean>;
      events: EventStore;
      publish(event: StoredEvent): Promise<void>;
    },
  ) {}

  async execute(value: NativeWorkspaceCall, signal: AbortSignal): Promise<NativeWorkspaceReply> {
    const call = NativeWorkspaceCallSchema.safeParse(value);
    if (
      !call.success ||
      this.#seen.size >= 1000 ||
      this.#seen.has(call.data.id) ||
      this.#closed ||
      signal.aborted
    )
      return denied();
    const args = TOOL_SCHEMAS[call.data.tool].safeParse(call.data.input);
    if (!args.success) return denied();
    this.#seen.add(call.data.id);
    if (!(await this.#authorized(signal)) || this.#closed || signal.aborted) return denied();
    const combined = AbortSignal.any([signal, this.#abort.signal]);
    const active = this.#execute({ ...call.data, input: args.data }, combined);
    this.#active.add(active);
    try {
      return await active;
    } finally {
      this.#active.delete(active);
    }
  }
  async #execute(call: NativeWorkspaceCall, signal: AbortSignal): Promise<NativeWorkspaceReply> {
    try {
      // Durable intent precedes the first filesystem or command side effect.
      this.#emit({
        sessionId: this.options.sessionId,
        turnId: this.options.turnId,
        createdAt: new Date().toISOString(),
        type: "tool.call",
        payload: { toolCallId: call.id, toolName: call.tool, input: call.input },
      });
      await this.#delivery;
      if (!(await this.#authorized(signal))) return denied();
      const result = await executeTool(
        { id: call.id, name: call.tool, input: call.input },
        {
          sessionId: this.options.sessionId,
          turnId: this.options.turnId,
          sandboxId: this.options.sandboxId,
          sandbox: this.#sandbox(signal),
          emit: (event) => {
            if (event.type !== "tool.call") this.#emit(event);
          },
        },
      );
      await this.#delivery;
      return this.#uncertain ? uncertain() : { ok: true, value: result };
    } catch {
      this.#uncertain = true;
      return uncertain();
    }
  }

  async stop(): Promise<ProcessExit[] | null> {
    this.#closed = true;
    this.#abort.abort();
    const stopped = await bounded(
      (async () => {
        await Promise.allSettled([...this.#processes].map((process) => process.stop()));
        await Promise.allSettled([...this.#active]);
        await this.#delivery;
        return true;
      })().catch(() => false),
      false,
    );
    return stopped && !this.#uncertain && this.#processes.size === 0 ? [...this.#proofs] : null;
  }
  async #authorized(signal: AbortSignal): Promise<boolean> {
    return (
      !this.#closed &&
      !signal.aborted &&
      (await this.options.authorize().catch(() => false)) &&
      !this.#closed &&
      !signal.aborted
    );
  }
  #emit(event: PendingEvent): void {
    this.#delivery = this.#delivery.then(async () => {
      const stored = await this.options.events.append(event);
      await this.options.publish(stored);
    });
  }
  async #file<T>(
    signal: AbortSignal,
    mutates: boolean,
    action: () => Promise<Result<T, SandboxError>>,
  ): Promise<Result<T, SandboxError>> {
    if (!(await this.#authorized(signal)) || this.#closed || signal.aborted) return unavailable();
    try {
      const result = await action();
      if (!result.ok) {
        if (mutates) this.#uncertain = true;
        return {
          ok: false,
          error: {
            code: result.error.code,
            message: "The supervised project operation could not be confirmed.",
          },
        };
      }
      return result;
    } catch {
      if (mutates) this.#uncertain = true;
      return unavailable();
    }
  }
  #sandbox(signal: AbortSignal): SandboxManager {
    const id = this.options.sandboxId;
    return {
      create: async () => unavailable(),
      resume: async () => unavailable(),
      destroy: async () => unavailable(),
      extendTimeout: async () => unavailable(),
      getPreviewUrl: async () => unavailable(),
      waitForPreview: async () => unavailable(),
      readFile: (_id, path) =>
        this.#file(signal, false, () => this.options.sandbox.readFile(id, path)),
      writeFile: (_id, path, contents) =>
        this.#file(signal, true, () => this.options.sandbox.writeFile(id, path, contents)),
      listFiles: (_id, path) =>
        this.#file(signal, false, () => this.options.sandbox.listFiles(id, path)),
      exec: (_id, command, output) => this.#exec(command, signal, output),
    };
  }
  async #exec(
    command: string,
    signal: AbortSignal,
    output?: ExecOutputHandler,
  ): Promise<Result<ExecResult, SandboxError>> {
    if (!(await this.#authorized(signal)) || this.#closed || signal.aborted) return unavailable();
    let process: SandboxProcess | undefined;
    const streams = { stdout: new TextDecoder(), stderr: new TextDecoder() };
    const text = { stdout: "", stderr: "" };
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let renewing = false;
    const cancel = () => {
      void process?.stop().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    const timeout = setTimeout(cancel, 120_000);
    try {
      const started = await this.options.host.start(
        {
          sandboxId: this.options.sandboxId,
          executable: "/bin/sh",
          args: ["-c", command],
          cwd: PROJECT_ROOT_PATH,
          env: { HOME: "/home/user", PATH: "/usr/local/bin:/usr/bin:/bin" },
          leaseMs: 5000,
          maxOutputBytes: 512 * 1024,
          maxReplayBytes: 1024 * 1024,
        },
        async (event) => {
          if (event.kind === "output") {
            this.#outputBytes += event.data.byteLength;
            if (this.#outputBytes > 4 * 1024 * 1024)
              throw new Error("Project output exceeded its limit.");
            const data = streams[event.stream].decode(event.data, { stream: true });
            text[event.stream] += data;
            output?.({ stream: event.stream, data });
          } else {
            for (const stream of ["stdout", "stderr"] as const) {
              const data = streams[stream].decode();
              text[stream] += data;
              if (data) output?.({ stream, data });
            }
          }
          await this.#delivery;
        },
      );
      if (!started.ok) throw new Error("Project command start is uncertain.");
      process = started.value;
      this.#processes.add(process);
      if (
        process.reference.sandboxId !== this.options.sandboxId ||
        process.reference.containment !== "cgroup"
      )
        throw new Error("Project containment is unavailable.");
      if (signal.aborted) cancel();
      heartbeat = setInterval(() => {
        if (renewing) return;
        renewing = true;
        void (async () => {
          if (!(await this.#authorized(signal)) || !(await process?.renew())?.ok) cancel();
        })()
          .catch(cancel)
          .finally(() => {
            renewing = false;
          });
      }, 1000);
      const closed = await bounded(process.closed, null, 130_000);
      if (closed === null || !closed.ok || closed.value.containment !== "cgroup")
        throw new Error("Project command termination is uncertain.");
      this.#proofs.push(closed.value);
      return {
        ok: true,
        value: { exitCode: closed.value.code ?? 1, stdout: text.stdout, stderr: text.stderr },
      };
    } catch {
      this.#uncertain = true;
      return unavailable();
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      signal.removeEventListener("abort", cancel);
      if (process !== undefined) {
        await bounded(
          process.stop().catch(() => undefined),
          undefined,
        );
        this.#processes.delete(process);
      }
    }
  }
}
