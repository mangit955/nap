/** Authenticated supervisor transport. Native protocols and user credentials stay above this seam. */
import { randomBytes } from "node:crypto";
import {
  encodeNativeFrame,
  NativeFrameDecoder,
  type NativeHostCommand,
  NativeHostCommandSchema,
  type NativeHostEvent,
  NativeHostEventSchema,
  NativeHostStartSchema,
  NativeTerminalSizeSchema,
} from "@nap/shared/native-process-protocol";
import type {
  ProcessError,
  ProcessEvent,
  ProcessExit,
  ProcessReference,
  ProcessStart,
  SandboxProcess,
  SandboxProcessHost,
} from "@nap/shared/ports/sandbox-process";
import type { Result, VoidResult } from "@nap/shared/result";
import { z } from "zod";

type Handle = {
  pid: number;
  sendStdin(data: string): Promise<void>;
  wait(): Promise<{ exitCode: number }>;
  disconnect(): Promise<void>;
};
export type ProcessClient = {
  start(
    sandboxId: string,
    executablePath: string,
    output: (text: string) => Promise<void>,
  ): Promise<Handle>;
  connect(sandboxId: string, pid: number, output: (text: string) => Promise<void>): Promise<Handle>;
};

const referenceSchema = z.strictObject({
  sandboxId: z.string().min(1),
  pid: z.int().positive(),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  containment: z.enum(["cgroup", "process_group"]),
  terminal: z.boolean().optional(),
});
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
type AttachedSandbox = {
  sandboxId: string;
  commands: {
    run(
      command: string,
      options: {
        user: "root";
        envs: Record<string, string>;
        background: true;
        stdin: true;
        timeoutMs: number;
        onStdout: (text: string) => Promise<void>;
      },
    ): Promise<Handle>;
    connect(
      pid: number,
      options: { timeoutMs: number; onStdout: (text: string) => Promise<void> },
    ): Promise<Handle>;
  };
};

/** Sandbox.connect can extend its lifetime. The lifecycle owner supplies its existing handle. */
export function attachedE2BProcessClient(sandbox: AttachedSandbox): ProcessClient {
  const owned = (sandboxId: string) => {
    if (sandboxId !== sandbox.sandboxId)
      throw new Error("Native process sandbox does not match its attached sandbox.");
  };
  return {
    async start(sandboxId, executablePath, onStdout) {
      owned(sandboxId);
      return sandbox.commands.run(`node ${quote(executablePath)}`, {
        user: "root",
        envs: {},
        background: true,
        stdin: true,
        timeoutMs: 0,
        onStdout,
      });
    },
    async connect(sandboxId, pid, onStdout) {
      owned(sandboxId);
      return sandbox.commands.connect(pid, { timeoutMs: 0, onStdout });
    },
  };
}

function failure(code: ProcessError["code"], message: string): Result<never, ProcessError> {
  return { ok: false, error: { code, message } };
}

async function deadline<T>(work: Promise<T>, ms: number, expired: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(expired()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function channel(options: {
  token: string;
  afterSequence: number;
  maxBufferedBytes: number;
  commandTimeoutMs: number;
  requiresReady: boolean;
  onEvent: (event: ProcessEvent) => Promise<void>;
}) {
  let handle: Handle | null = null;
  let cursor = options.afterSequence;
  let ended = false;
  let controlUncertain = false;
  let receiptTimer: ReturnType<typeof setTimeout> | undefined;
  let queuedBytes = 0;
  const prefetched: string[] = [];
  let pending = Promise.resolve();
  let resolveReady: (value: Result<void, ProcessError>) => void = () => {};
  let resolveClosed: (value: Result<ProcessExit, ProcessError>) => void = () => {};
  const ready = new Promise<Result<void, ProcessError>>((resolve) => {
    resolveReady = resolve;
  });
  const closed = new Promise<Result<ProcessExit, ProcessError>>((resolve) => {
    resolveClosed = resolve;
  });
  const decoder = new NativeFrameDecoder(NativeHostEventSchema, 1024 * 1024);
  let containment: ProcessReference["containment"] = "cgroup";
  let readySeen = !options.requiresReady;

  async function send(command: NativeHostCommand): Promise<VoidResult<ProcessError>> {
    if (!handle || ended) return failure("disconnected", "The native process channel is closed.");
    if (controlUncertain)
      return failure("delivery_uncertain", "The native process command could not be confirmed.");
    try {
      return await deadline(
        handle
          .sendStdin(encodeNativeFrame(command))
          .then<VoidResult<ProcessError>>(() => ({ ok: true, value: undefined })),
        options.commandTimeoutMs,
        () => {
          commandUncertain();
          return failure(
            "delivery_uncertain",
            "The native process command could not be confirmed.",
          );
        },
      );
    } catch {
      commandUncertain();
      return failure("delivery_uncertain", "The native process command could not be confirmed.");
    }
  }
  function commandUncertain() {
    if (ended || controlUncertain) return;
    controlUncertain = true;
    // A process can close stdin before the ACK RPC responds while its terminal frame is in flight.
    // Fence further input immediately, but retain the bounded opportunity to observe that proof.
    receiptTimer = setTimeout(
      () => fail("delivery_uncertain", "The native process command could not be confirmed."),
      options.commandTimeoutMs,
    );
    if (handle)
      void handle
        .sendStdin(encodeNativeFrame({ type: "stop", token: options.token }))
        .catch(() => {});
  }
  function fail(code: ProcessError["code"], message: string, stop = true) {
    if (ended) return;
    ended = true;
    clearTimeout(receiptTimer);
    prefetched.length = 0;
    resolveReady(failure(code, message));
    resolveClosed(failure(code, message));
    if (handle && stop)
      void handle
        .sendStdin(encodeNativeFrame({ type: "stop", token: options.token }))
        .catch(() => {});
    if (handle) void handle.disconnect().catch(() => {});
  }
  async function accept(event: NativeHostEvent) {
    if (ended) return;
    if (event.type === "ready") {
      if (event.containment !== containment) {
        fail("unavailable", "The native process lacks its required containment.");
        return;
      }
      readySeen = true;
      resolveReady({ ok: true, value: undefined });
      return;
    }
    if (!readySeen && event.type !== "exit") {
      fail("delivery_uncertain", "Native process output arrived before containment was confirmed.");
      return;
    }
    if (event.seq <= cursor) return;
    if (event.seq !== cursor + 1) {
      fail("delivery_uncertain", "Native process output has a delivery gap.");
      return;
    }
    const value: ProcessEvent =
      event.type === "output"
        ? {
            kind: "output",
            sequence: event.seq,
            stream: event.stream,
            data: Buffer.from(event.data, "base64"),
          }
        : {
            kind: "exit",
            sequence: event.seq,
            code: event.code,
            reason: event.reason,
            containment: event.containment,
          };
    try {
      const persisted = await deadline(
        options.onEvent(value).then(() => true),
        options.commandTimeoutMs,
        () => false,
      );
      if (!persisted) {
        fail(
          "persistence_failed",
          "Native process persistence could not be confirmed before its deadline.",
        );
        return;
      }
    } catch {
      fail("persistence_failed", "Native process output could not be persisted.");
      return;
    }
    cursor = event.seq;
    if (value.kind === "exit") {
      ended = true;
      clearTimeout(receiptTimer);
      resolveReady(failure("unavailable", "The native process exited before becoming ready."));
      resolveClosed({ ok: true, value });
    } else await send({ type: "ack", token: options.token, sequence: cursor });
  }
  function enqueue(text: string): Promise<void> {
    const bytes = Buffer.byteLength(text);
    pending = pending.then(async () => {
      try {
        for (const event of decoder.push(Buffer.from(text))) await accept(event);
      } catch {
        fail("delivery_uncertain", "The native process returned an invalid frame.");
      } finally {
        queuedBytes -= bytes;
      }
    });
    return pending;
  }
  function output(text: string): Promise<void> {
    if (ended) return Promise.resolve();
    queuedBytes += Buffer.byteLength(text);
    if (queuedBytes > options.maxBufferedBytes) {
      fail("delivery_uncertain", "Native process output exceeded its buffer limit.");
      return Promise.resolve();
    }
    // SDK connect can deliver buffered output before it returns the writable handle.
    if (!handle) {
      prefetched.push(text);
      return Promise.resolve();
    }
    return enqueue(text);
  }
  return {
    ready,
    closed,
    output,
    ended: () => ended,
    bind(found: Handle, expected: ProcessReference["containment"]) {
      handle = found;
      containment = expected;
      if (ended) {
        void found
          .sendStdin(encodeNativeFrame({ type: "stop", token: options.token }))
          .catch(() => {});
        void found.disconnect().catch(() => {});
        return;
      }
      for (const text of prefetched.splice(0)) void enqueue(text);
      void found.wait().then(
        () =>
          pending.then(() => {
            if (!ended && !controlUncertain)
              fail("delivery_uncertain", "The native process ended without a terminal receipt.");
          }),
        () =>
          pending.then(() => {
            if (!ended && !controlUncertain)
              fail("delivery_uncertain", "The native process connection was lost.");
          }),
      );
    },
    fail,
    connection(reference: ProcessReference): SandboxProcess {
      return {
        reference,
        closed,
        write: (data) => {
          const parsed = NativeHostCommandSchema.safeParse({
            type: "input",
            token: options.token,
            data,
          });
          return parsed.success
            ? send(parsed.data)
            : Promise.resolve(
                failure("invalid_request", "Native process input exceeds its limit."),
              );
        },
        resize: (size) => {
          const parsed = NativeTerminalSizeSchema.safeParse(size);
          if (!reference.terminal || !parsed.success)
            return Promise.resolve(
              failure("invalid_request", "This process cannot accept that terminal size."),
            );
          return send({ type: "resize", token: options.token, ...parsed.data });
        },
        renew: () => send({ type: "renew", token: options.token }),
        interrupt: () => send({ type: "interrupt", token: options.token }),
        stop: () => send({ type: "stop", token: options.token }),
        async disconnect() {
          if (!handle) return failure("disconnected", "The native process channel is closed.");
          try {
            await handle.disconnect();
            fail("disconnected", "The native process stream was disconnected.", false);
            return { ok: true, value: undefined };
          } catch {
            return failure(
              "delivery_uncertain",
              "The native process disconnect could not be confirmed.",
            );
          }
        },
      };
    },
  };
}

export class E2BProcessHost implements SandboxProcessHost {
  readonly #client: ProcessClient;
  readonly #path: string;
  readonly #readyTimeoutMs: number;

  constructor(options: {
    executablePath: string;
    client: ProcessClient;
    readyTimeoutMs?: number;
  }) {
    this.#client = options.client;
    this.#path = options.executablePath;
    this.#readyTimeoutMs = options.readyTimeoutMs ?? 5000;
  }

  async start(
    request: ProcessStart,
    onEvent: (event: ProcessEvent) => Promise<void>,
  ): Promise<Result<SandboxProcess, ProcessError>> {
    const { sandboxId, ...spec } = request;
    const token = randomBytes(32).toString("hex");
    const parsed = NativeHostStartSchema.safeParse({
      ...spec,
      type: "start",
      token,
      containment: { kind: "cgroup", root: "/sys/fs/cgroup", uid: 1000, gid: 1000 },
    });
    if (!parsed.success || !sandboxId)
      return failure("invalid_request", "Invalid native process configuration.");
    const stream = channel({
      token,
      afterSequence: 0,
      maxBufferedBytes: request.maxReplayBytes + 65536,
      commandTimeoutMs: this.#readyTimeoutMs,
      requiresReady: true,
      onEvent,
    });
    const opening = (async (): Promise<Result<SandboxProcess, ProcessError>> => {
      try {
        const handle = await this.#client.start(sandboxId, this.#path, stream.output);
        stream.bind(handle, "cgroup");
        if (stream.ended())
          return failure("start_uncertain", "The native process startup could not be confirmed.");
        await handle.sendStdin(encodeNativeFrame(parsed.data));
        const result = await stream.ready;
        return result.ok
          ? {
              ok: true,
              value: stream.connection({
                sandboxId,
                pid: handle.pid,
                token,
                containment: "cgroup",
                ...(request.terminal === undefined ? {} : { terminal: true }),
              }),
            }
          : result;
      } catch {
        stream.fail("start_uncertain", "The native process startup could not be confirmed.");
        return failure("start_uncertain", "The native process startup could not be confirmed.");
      }
    })();
    return deadline(opening, this.#readyTimeoutMs, () => {
      stream.fail("start_uncertain", "The native process startup could not be confirmed.");
      return failure("start_uncertain", "The native process startup could not be confirmed.");
    });
  }

  async connect(
    reference: ProcessReference,
    afterSequence: number,
    onEvent: (event: ProcessEvent) => Promise<void>,
  ): Promise<Result<SandboxProcess, ProcessError>> {
    if (
      !referenceSchema.safeParse(reference).success ||
      !Number.isSafeInteger(afterSequence) ||
      afterSequence < 0
    )
      return failure("invalid_request", "Invalid native process reference.");
    const stream = channel({
      token: reference.token,
      afterSequence,
      maxBufferedBytes: 64 * 1024 * 1024 + 65536,
      commandTimeoutMs: this.#readyTimeoutMs,
      requiresReady: false,
      onEvent,
    });
    const opening = (async (): Promise<Result<SandboxProcess, ProcessError>> => {
      try {
        const handle = await this.#client.connect(
          reference.sandboxId,
          reference.pid,
          stream.output,
        );
        stream.bind(handle, reference.containment);
        if (stream.ended())
          return failure(
            "delivery_uncertain",
            "The native process reconnect could not be confirmed.",
          );
        const connection = stream.connection(reference);
        await handle.sendStdin(
          encodeNativeFrame({ type: "replay", token: reference.token, afterSequence }),
        );
        return { ok: true, value: connection };
      } catch {
        stream.fail("delivery_uncertain", "The native process reconnect could not be confirmed.");
        return failure(
          "delivery_uncertain",
          "The native process reconnect could not be confirmed.",
        );
      }
    })();
    return deadline(opening, this.#readyTimeoutMs, () => {
      stream.fail("delivery_uncertain", "The native process reconnect could not be confirmed.");
      return failure("delivery_uncertain", "The native process reconnect could not be confirmed.");
    });
  }
}
