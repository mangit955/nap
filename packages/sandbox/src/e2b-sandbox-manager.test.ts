import {
  AuthenticationError,
  CommandExitError,
  FileNotFoundError,
  FileType,
  NotEnoughSpaceError,
  RateLimitError,
  SandboxNotFoundError,
  TimeoutError,
} from "e2b";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { groupedCommand, stopGroupCommand } from "./e2b-exec-group.ts";
import type { E2BClient, E2BSandboxHandle, E2BSandboxSummary } from "./e2b-sandbox-manager.ts";
import {
  E2BSandboxManager,
  HANDLE_CACHE_LIMIT,
  STOP_TIMEOUT_MS,
  toSandboxError,
} from "./e2b-sandbox-manager.ts";

/**
 * A stub standing in for one E2B sandbox. Every method rejects unless the test
 * overrides it, so a case can only pass by exercising the path it names.
 */
function stubHandle(
  overrides: Omit<Partial<E2BSandboxHandle>, "commands"> & {
    commands?: Partial<E2BSandboxHandle["commands"]>;
  } = {},
): E2BSandboxHandle {
  return {
    sandboxId: "sbx_stub",
    files: {
      readBytes: () => Promise.reject(new Error("files.readBytes not stubbed")),
      read: () => Promise.reject(new Error("files.read not stubbed")),
      write: () => Promise.reject(new Error("files.write not stubbed")),
      list: () => Promise.reject(new Error("files.list not stubbed")),
    },
    getHost: (port) => `${port}-sbx_stub.e2b.app`,
    setTimeout: () => Promise.resolve(),
    kill: () => Promise.resolve(true),
    ...overrides,
    commands: {
      run: () => Promise.reject(new Error("commands.run not stubbed")),
      ...overrides.commands,
    },
  };
}

function stubClient(handle: E2BSandboxHandle = stubHandle()): E2BClient {
  return {
    create: () => Promise.resolve(handle),
    connect: () => Promise.resolve(handle),
    ping: () => Promise.resolve([]),
    list: () => Promise.reject(new Error("list not stubbed")),
  };
}

/** A manager over a stub, already holding one live sandbox. */
async function managerWith(handle: E2BSandboxHandle): Promise<{
  manager: E2BSandboxManager;
  sandboxId: string;
}> {
  const manager = new E2BSandboxManager({ client: stubClient(handle) });
  const created = await manager.create("project");
  if (!created.ok) throw new Error(created.error.message);
  return { manager, sandboxId: created.value.id };
}

describe("toSandboxError", () => {
  // E2B distinguishes a missing file from a missing sandbox with two subclasses of
  // NotFoundError, and our contract distinguishes them too — so the mapping is
  // one-to-one rather than dependent on which call site caught it.
  it("maps a missing file to file_not_found", () => {
    expect(toSandboxError(new FileNotFoundError("no such file")).code).toBe("file_not_found");
  });

  it("maps a missing sandbox to not_found", () => {
    expect(toSandboxError(new SandboxNotFoundError("gone")).code).toBe("not_found");
  });

  it("maps a timeout to timeout", () => {
    expect(toSandboxError(new TimeoutError("took too long")).code).toBe("timeout");
  });

  it("maps a bad or missing API key to unavailable", () => {
    // AuthenticationError extends Error rather than SandboxError, so a catch-all
    // keyed on SandboxError would miss it entirely.
    expect(toSandboxError(new AuthenticationError("bad key")).code).toBe("unavailable");
  });

  it("maps rate limiting to unavailable", () => {
    expect(toSandboxError(new RateLimitError("slow down")).code).toBe("unavailable");
  });

  it("maps a full disk to unavailable", () => {
    expect(toSandboxError(new NotEnoughSpaceError("disk full")).code).toBe("unavailable");
  });

  it("maps an unrecognised failure to unavailable rather than throwing", () => {
    const mapped = toSandboxError(new Error("connection reset"));
    expect(mapped.code).toBe("unavailable");
    expect(mapped.message).toContain("connection reset");
  });

  it("keeps the underlying message, so a log says what actually went wrong", () => {
    expect(toSandboxError(new FileNotFoundError("/app/missing.ts")).message).toContain(
      "/app/missing.ts",
    );
  });
});

describe("E2BSandboxManager exec", () => {
  it("converts a non-zero exit from a thrown error into a successful result", async () => {
    // The single most important mapping in this adapter: E2B throws CommandExitError
    // when a command exits non-zero, but our contract says a failing command is data.
    // Without this conversion every failing build would look like an infrastructure
    // fault to the agent.
    const { manager, sandboxId } = await managerWith(
      stubHandle({
        commands: {
          run: () =>
            Promise.reject(
              new CommandExitError({ exitCode: 3, stdout: "out", stderr: "boom", error: "boom" }),
            ),
        },
      }),
    );

    const result = await manager.exec(sandboxId, "exit 3");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ exitCode: 3, stdout: "out", stderr: "boom" });
  });

  it("returns a zero exit unchanged", async () => {
    const { manager, sandboxId } = await managerWith(
      stubHandle({
        commands: {
          run: () => Promise.resolve({ exitCode: 0, stdout: "hi\n", stderr: "", error: undefined }),
        },
      }),
    );

    const result = await manager.exec(sandboxId, "echo hi");

    expect(result).toEqual({ ok: true, value: { exitCode: 0, stdout: "hi\n", stderr: "" } });
  });

  it("forwards streamed output to the handler as typed chunks", async () => {
    const { manager, sandboxId } = await managerWith(
      stubHandle({
        commands: {
          run: (_cmd, opts) => {
            opts?.onStdout?.("one\n");
            opts?.onStderr?.("two\n");
            return Promise.resolve({
              exitCode: 0,
              stdout: "one\n",
              stderr: "two\n",
              error: undefined,
            });
          },
        },
      }),
    );

    const chunks: Array<{ stream: string; data: string }> = [];
    await manager.exec(sandboxId, "noisy", (chunk) => chunks.push(chunk));

    expect(chunks).toEqual([
      { stream: "stdout", data: "one\n" },
      { stream: "stderr", data: "two\n" },
    ]);
  });

  describe("a command to be stopped when the call gives up", () => {
    const OPTIONS = { stopOnGiveUp: true };
    const OK = { exitCode: 0, stdout: "", stderr: "" };

    /** A `run` that answers the command with `answer`, and the stop that may follow with success. */
    function runAnswering(answer: () => Promise<typeof OK>) {
      return vi.fn<E2BSandboxHandle["commands"]["run"]>((command) =>
        command.startsWith("touch ") ? Promise.resolve(OK) : answer(),
      );
    }

    const stops = (run: ReturnType<typeof runAnswering>) =>
      run.mock.calls.map(([command]) => command).filter((command) => command.startsWith("touch "));

    /** The marker in a wrapped command, which is what ties a stop to the command it stops. */
    function markerIn(run: ReturnType<typeof runAnswering>): string {
      const marker = /\/tmp\/nap-exec-[\w-]+/.exec(run.mock.calls[0]?.[0] ?? "")?.[0];
      if (marker === undefined) throw new Error("the command names no marker");
      return marker;
    }

    it("runs the command inside the group, with its timeout, signal and output handlers", async () => {
      const run = runAnswering(() => Promise.resolve(OK));
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));
      const { signal } = new AbortController();

      await manager.exec(sandboxId, "bun run build", undefined, {
        ...OPTIONS,
        signal,
        timeoutMs: 1_234,
      });

      const [command, opts] = run.mock.calls[0] ?? [];
      expect(command).toBe(groupedCommand("bun run build", markerIn(run)));
      expect(opts).toMatchObject({ signal, timeoutMs: 1_234 });
    });

    it("gives each command a marker of its own", async () => {
      const run = runAnswering(() => Promise.resolve(OK));
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));

      await manager.exec(sandboxId, "one", undefined, OPTIONS);
      await manager.exec(sandboxId, "two", undefined, OPTIONS);

      expect(run.mock.calls[0]?.[0].match(/nap-exec-[\w-]+/)?.[0]).not.toBe(
        run.mock.calls[1]?.[0].match(/nap-exec-[\w-]+/)?.[0],
      );
    });

    it("forwards streamed output", async () => {
      const run = vi.fn<E2BSandboxHandle["commands"]["run"]>((_command, opts) => {
        opts?.onStdout?.("one\n");
        return Promise.resolve(OK);
      });
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));
      const chunks: unknown[] = [];

      await manager.exec(sandboxId, "bun run build", (chunk) => chunks.push(chunk), OPTIONS);

      expect(chunks).toEqual([{ stream: "stdout", data: "one\n" }]);
    });

    it("stops the group when the signal fires, and reports why the command did not finish", async () => {
      const controller = new AbortController();
      const run = runAnswering(() => {
        controller.abort();
        return Promise.reject(new TimeoutError("canceled"));
      });
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));

      const result = await manager.exec(sandboxId, "bun run build", undefined, {
        ...OPTIONS,
        signal: controller.signal,
      });

      expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
      expect(stops(run)).toEqual([stopGroupCommand(markerIn(run))]);
    });

    it("stops the group at the deadline, where no signal is involved", async () => {
      const run = runAnswering(() => Promise.reject(new TimeoutError("deadline_exceeded")));
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));

      const result = await manager.exec(sandboxId, "bun run build", undefined, {
        ...OPTIONS,
        timeoutMs: 1_234,
      });

      expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
      expect(stops(run)).toEqual([stopGroupCommand(markerIn(run))]);
    });

    it("stops the group on any other failure, such as the connection dropping", async () => {
      const run = runAnswering(() => Promise.reject(new Error("socket closed")));
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));

      const result = await manager.exec(sandboxId, "bun run build", undefined, OPTIONS);

      expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(stops(run)).toEqual([stopGroupCommand(markerIn(run))]);
    });

    it("waits for the stop, so the next turn cannot start on top of what it was stopping", async () => {
      let stopped: (result: typeof OK) => void = () => {};
      const run = vi.fn<E2BSandboxHandle["commands"]["run"]>((command) =>
        command.startsWith("touch ")
          ? new Promise((resolve) => {
              stopped = resolve;
            })
          : Promise.reject(new TimeoutError("canceled")),
      );
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));
      let returned = false;

      const execution = manager
        .exec(sandboxId, "bun run build", undefined, OPTIONS)
        .then((result) => {
          returned = true;
          return result;
        });
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setImmediate(resolve));

      expect(returned).toBe(false);
      stopped(OK);
      await execution;
    });

    it("gives up on a stop that never answers once its own bound passes, since the caller's signal has already fired", async () => {
      // Node runs `AbortSignal.timeout` on a timer fake timers cannot reach, so this test stands in
      // for the bound with a signal it fires itself, and checks the bound is the one asked for.
      const bound = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(bound.signal);
      onTestFinished(() => timeout.mockRestore());
      const controller = new AbortController();
      const run = vi.fn<E2BSandboxHandle["commands"]["run"]>((command, opts) => {
        if (!command.startsWith("touch ")) {
          controller.abort();
          return Promise.reject(new TimeoutError("canceled"));
        }
        // A sandbox that has stopped answering: nothing but the stop's own signal ends the wait.
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(new Error("stop abandoned")), {
            once: true,
          });
        });
      });
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));
      let returned = false;

      const execution = manager
        .exec(sandboxId, "bun run build", undefined, { ...OPTIONS, signal: controller.signal })
        .then((result) => {
          returned = true;
          return result;
        });
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      await new Promise((resolve) => setImmediate(resolve));

      expect(returned).toBe(false);
      expect(timeout).toHaveBeenCalledWith(STOP_TIMEOUT_MS);
      bound.abort();
      // The command's own failure, not the stop's.
      expect(await execution).toMatchObject({ ok: false, error: { code: "timeout" } });
    });

    it("reports the original failure when the stop fails as well", async () => {
      const run = vi.fn<E2BSandboxHandle["commands"]["run"]>((command) =>
        Promise.reject(
          command.startsWith("touch ")
            ? new SandboxNotFoundError("gone")
            : new TimeoutError("deadline_exceeded"),
        ),
      );
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));

      const result = await manager.exec(sandboxId, "bun run build", undefined, OPTIONS);

      expect(run).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    });

    it("reports a command's non-zero exit as data, with nothing left to stop", async () => {
      const run = runAnswering(() =>
        Promise.reject(new CommandExitError({ exitCode: 3, stdout: "", stderr: "no" })),
      );
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));

      const result = await manager.exec(sandboxId, "bun run build", undefined, OPTIONS);

      expect(result).toMatchObject({ ok: true, value: { exitCode: 3, stderr: "no" } });
      expect(stops(run)).toEqual([]);
    });

    it("does not report the provider killing the shell as the command having failed", async () => {
      // How envd reports a process that died to a signal. The wrapper forwards the command's exit,
      // so this is the wrapper itself dying, with the group still running underneath it.
      const run = runAnswering(() =>
        Promise.reject(
          new CommandExitError({ exitCode: -1, stdout: "", stderr: "", error: "signal: killed" }),
        ),
      );
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));

      const result = await manager.exec(sandboxId, "bun run build", undefined, OPTIONS);

      expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(stops(run)).toEqual([stopGroupCommand(markerIn(run))]);
    });

    it("stops nothing when the command finishes", async () => {
      const run = runAnswering(() => Promise.resolve(OK));
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));

      await manager.exec(sandboxId, "bun run build", undefined, OPTIONS);

      expect(run).toHaveBeenCalledOnce();
    });

    it("leaves the command as it is when the caller did not ask for it to be stopped", async () => {
      // The desktop driver has to live long enough to release what it holds.
      const run = runAnswering(() => Promise.reject(new TimeoutError("canceled")));
      const { manager, sandboxId } = await managerWith(stubHandle({ commands: { run } }));
      const { signal } = new AbortController();

      await manager.exec(sandboxId, "node driver.mjs", undefined, { signal });

      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]?.[0]).toBe("node driver.mjs");
    });
  });

  it("still reports a genuine infrastructure failure as an error", async () => {
    const { manager, sandboxId } = await managerWith(
      stubHandle({
        commands: { run: () => Promise.reject(new TimeoutError("sandbox timed out")) },
      }),
    );

    const result = await manager.exec(sandboxId, "sleep 999");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("timeout");
  });
});

describe("E2BSandboxManager preview readiness", () => {
  // Restoring globals belongs in a hook registered on the suite, not inside a test: a
  // stub that outlived its test would silently answer every later one.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Answers each successive fetch from `responses`, repeating the last one forever so a
   * polling test can keep failing without needing an entry per attempt.
   */
  function stubFetch(responses: Array<Response | Error>): { calls: () => number } {
    let index = 0;
    vi.stubGlobal("fetch", () => {
      const next = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    });
    return { calls: () => index };
  }

  it("returns the preview URL as soon as the address answers", async () => {
    const fetches = stubFetch([new Response("<!doctype html>", { status: 200 })]);
    const { manager, sandboxId } = await managerWith(stubHandle());

    const result = await manager.waitForPreview(sandboxId, 5173);

    expect(result).toEqual({ ok: true, value: "https://5173-sbx_stub.e2b.app" });
    expect(fetches.calls()).toBe(1);
  });

  it("keeps polling through connection failures while the server boots", async () => {
    // A refused connection is the normal state for the first second or two of a dev
    // server's life, so treating the first failure as fatal would fail every cold start.
    const fetches = stubFetch([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new Response("ok", { status: 200 }),
    ]);
    const { manager, sandboxId } = await managerWith(stubHandle());

    const result = await manager.waitForPreview(sandboxId, 5173, { timeoutMs: 5_000 });

    expect(result.ok).toBe(true);
    expect(fetches.calls()).toBe(3);
  });

  it("keeps polling while the address answers with an error status", async () => {
    // E2B's proxy answers before the sandbox behind it does, so a 502 means "not yet",
    // not "broken".
    const fetches = stubFetch([
      new Response("bad gateway", { status: 502 }),
      new Response("ok", { status: 200 }),
    ]);
    const { manager, sandboxId } = await managerWith(stubHandle());

    const result = await manager.waitForPreview(sandboxId, 5173, { timeoutMs: 5_000 });

    expect(result.ok).toBe(true);
    expect(fetches.calls()).toBe(2);
  });

  it("gives up with a typed timeout, within the budget, when nothing ever answers", async () => {
    stubFetch([new TypeError("fetch failed")]);
    const { manager, sandboxId } = await managerWith(stubHandle());

    const startedAt = Date.now();
    const result = await manager.waitForPreview(sandboxId, 5173, { timeoutMs: 600 });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("timeout");
    // The budget is the contract: a caller sizes a turn around it.
    expect(elapsed).toBeLessThan(3_000);
  });

  it("reports the last failure, so a stuck preview can be diagnosed", async () => {
    stubFetch([new Response("nope", { status: 500 })]);
    const { manager, sandboxId } = await managerWith(stubHandle());

    const result = await manager.waitForPreview(sandboxId, 5173, { timeoutMs: 300 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("500");
  });

  it("does not poll at all for a destroyed sandbox", async () => {
    const fetches = stubFetch([new Response("ok", { status: 200 })]);
    const { manager, sandboxId } = await managerWith(stubHandle());
    await manager.destroy(sandboxId);

    const result = await manager.waitForPreview(sandboxId, 5173, { timeoutMs: 300 });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("destroyed");
    expect(fetches.calls()).toBe(0);
  });
});

describe("E2BSandboxManager filesystem", () => {
  it("maps entries to absolute paths and our two node types", async () => {
    const { manager, sandboxId } = await managerWith(
      stubHandle({
        files: {
          readBytes: () => Promise.reject(new Error("files.readBytes not stubbed")),
          read: () => Promise.reject(new Error("unused")),
          write: () => Promise.resolve(),
          list: () =>
            Promise.resolve([
              { name: "main.ts", path: "/home/user/main.ts", type: FileType.FILE },
              { name: "src", path: "/home/user/src", type: FileType.DIR },
              { name: "link", path: "/home/user/link", type: FileType.SYMLINK },
            ]),
        },
      }),
    );

    const listed = await manager.listFiles(sandboxId, "/home/user");

    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toEqual([
      { path: "/home/user/main.ts", type: "file" },
      { path: "/home/user/src", type: "directory" },
      // Our contract has only files and directories; a symlink is readable, so it
      // presents as a file rather than being dropped from the listing.
      { path: "/home/user/link", type: "file" },
    ]);
  });

  it("treats an entry of unknown type as a file rather than crashing", async () => {
    // `EntryInfo.type` is optional in the SDK, so this is reachable, not defensive.
    const { manager, sandboxId } = await managerWith(
      stubHandle({
        files: {
          readBytes: () => Promise.reject(new Error("files.readBytes not stubbed")),
          read: () => Promise.reject(new Error("unused")),
          write: () => Promise.resolve(),
          list: () => Promise.resolve([{ name: "odd", path: "/home/user/odd" }]),
        },
      }),
    );

    const listed = await manager.listFiles(sandboxId, "/home/user");

    expect(listed).toEqual({ ok: true, value: [{ path: "/home/user/odd", type: "file" }] });
  });

  it("reports a missing file as file_not_found", async () => {
    const { manager, sandboxId } = await managerWith(
      stubHandle({
        files: {
          readBytes: () => Promise.reject(new Error("files.readBytes not stubbed")),
          read: () => Promise.reject(new FileNotFoundError("/home/user/nope.txt")),
          write: () => Promise.resolve(),
          list: () => Promise.resolve([]),
        },
      }),
    );

    const read = await manager.readFile(sandboxId, "/home/user/nope.txt");

    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.error.code).toBe("file_not_found");
  });
});

describe("E2BSandboxManager file bytes", () => {
  it("reads a file as bytes in one request, with nothing decoding it on the way", async () => {
    const { client, requests } = countingProvider();
    const manager = new E2BSandboxManager({ client });
    const created = await manager.create("project");
    if (!created.ok) throw new Error(created.error.message);
    requests.length = 0;

    const read = await manager.readFileBytes(created.value.id, "/tmp/nap-snapshot.bundle");

    expect(read).toEqual({ ok: true, value: new Uint8Array([0, 255]) });
    expect(requests).toEqual(["files.readBytes"]);
  });

  it("writes bytes as a Blob, which the SDK uploads exactly as it is", async () => {
    const written: unknown[] = [];
    const { manager, sandboxId } = await managerWith(
      stubHandle({
        files: {
          read: () => Promise.reject(new Error("unused")),
          readBytes: () => Promise.reject(new Error("unused")),
          write: (_path, data) => {
            written.push(data);
            return Promise.resolve();
          },
          list: () => Promise.reject(new Error("unused")),
        },
      }),
    );
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);

    const result = await manager.writeFileBytes(sandboxId, "/tmp/nap-snapshot.bundle", bytes);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(written).toHaveLength(1);
    const [data] = written;
    expect(data).toBeInstanceOf(Blob);
    if (!(data instanceof Blob)) return;
    expect(new Uint8Array(await data.arrayBuffer())).toEqual(bytes);
  });
});

describe("E2BSandboxManager lifecycle", () => {
  it("carries the project id on the sandbox it creates", async () => {
    const manager = new E2BSandboxManager({ client: stubClient() });

    const created = await manager.create("project-42");

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toEqual({ id: "sbx_stub", projectId: "project-42" });
  });

  it("reports an unknown sandbox as not_found", async () => {
    const manager = new E2BSandboxManager({
      client: {
        create: () => Promise.reject(new Error("unused")),
        connect: () => Promise.reject(new SandboxNotFoundError("no such sandbox")),
        ping: () => Promise.reject(new Error("unused")),
        list: () => Promise.reject(new Error("unused")),
      },
    });

    const resumed = await manager.resume("sbx_missing");

    expect(resumed.ok).toBe(false);
    if (resumed.ok) return;
    expect(resumed.error.code).toBe("not_found");
  });

  it("fails every operation with `destroyed`, not `not_found`, after destroy", async () => {
    // E2B cannot tell "you killed this" from "this never existed" — both surface as
    // SandboxNotFoundError. The adapter remembers what it killed so that a
    // use-after-destroy bug reads differently from a bad id, as the contract requires.
    const { manager, sandboxId } = await managerWith(stubHandle());

    expect((await manager.destroy(sandboxId)).ok).toBe(true);

    const results = [
      await manager.readFile(sandboxId, "/home/user/a.txt"),
      await manager.writeFile(sandboxId, "/home/user/a.txt", "x"),
      await manager.listFiles(sandboxId, "/home/user"),
      await manager.exec(sandboxId, "echo hi"),
      await manager.getPreviewUrl(sandboxId, 5173),
      await manager.resume(sandboxId),
      await manager.destroy(sandboxId),
    ];

    for (const result of results) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.code).toBe("destroyed");
    }
  });

  it("reuses a connected handle instead of reconnecting for every operation", async () => {
    // Each connect is a network round-trip. An agent turn does dozens of file
    // operations, so reconnecting per call would put an API call between every one.
    let connects = 0;
    const handle = stubHandle({
      files: {
        readBytes: () => Promise.reject(new Error("files.readBytes not stubbed")),
        read: () => Promise.resolve("contents"),
        write: () => Promise.resolve(),
        list: () => Promise.resolve([]),
      },
    });
    const manager = new E2BSandboxManager({
      client: {
        create: () => Promise.resolve(handle),
        connect: () => {
          connects += 1;
          return Promise.resolve(handle);
        },
        ping: () => Promise.reject(new Error("unused")),
        list: () => Promise.reject(new Error("unused")),
      },
    });

    const created = await manager.create("project");
    if (!created.ok) throw new Error(created.error.message);
    await manager.readFile(created.value.id, "/home/user/a.txt");
    await manager.readFile(created.value.id, "/home/user/b.txt");
    await manager.listFiles(created.value.id, "/home/user");

    // create() already yielded a handle; nothing after it needed a new connection.
    expect(connects).toBe(0);
  });

  it("connects once for a sandbox it did not create, then reuses that handle", async () => {
    let connects = 0;
    const handle = stubHandle({
      files: {
        readBytes: () => Promise.reject(new Error("files.readBytes not stubbed")),
        read: () => Promise.resolve("contents"),
        write: () => Promise.resolve(),
        list: () => Promise.resolve([]),
      },
    });
    const manager = new E2BSandboxManager({
      client: {
        create: () => Promise.reject(new Error("unused")),
        ping: () => Promise.reject(new Error("unused")),
        list: () => Promise.reject(new Error("unused")),
        connect: () => {
          connects += 1;
          return Promise.resolve(handle);
        },
      },
    });

    await manager.readFile("sbx_elsewhere", "/home/user/a.txt");
    await manager.readFile("sbx_elsewhere", "/home/user/b.txt");

    expect(connects).toBe(1);
  });

  it("builds an https preview URL from the host E2B returns", async () => {
    // getHost returns a bare host with no scheme; a caller handed that straight to a
    // browser or to fetch would get a relative-path resolution, not a request.
    const { manager, sandboxId } = await managerWith(
      stubHandle({ getHost: (port) => `${port}-sbx_stub.e2b.app` }),
    );

    const url = await manager.getPreviewUrl(sandboxId, 5173);

    expect(url).toEqual({ ok: true, value: "https://5173-sbx_stub.e2b.app" });
  });
});

describe("keeping a sandbox alive", () => {
  it("creates sandboxes with the lifetime it was configured with", async () => {
    // E2B's own default is five minutes from *creation*, active or not. Left alone, a
    // conversation that pauses for a coffee comes back to a workspace that no longer exists.
    const asked: { timeoutMs?: number }[] = [];
    const handle = stubHandle();
    const manager = new E2BSandboxManager({
      timeoutMs: 30 * 60 * 1000,
      client: {
        create: (opts) => {
          asked.push(opts);
          return Promise.resolve(handle);
        },
        connect: () => Promise.resolve(handle),
        ping: () => Promise.reject(new Error("unused")),
        list: () => Promise.reject(new Error("unused")),
      },
    });

    await manager.create("project");

    expect(asked).toEqual([{ metadata: { projectId: "project" }, timeoutMs: 30 * 60 * 1000 }]);
  });

  it("pushes the deadline back on an existing sandbox", async () => {
    const extended: number[] = [];
    const { manager, sandboxId } = await managerWith(
      stubHandle({
        setTimeout: (ms) => {
          extended.push(ms);
          return Promise.resolve();
        },
      }),
    );

    const result = await manager.extendTimeout(sandboxId, 15 * 60 * 1000);

    expect(result).toEqual({ ok: true, value: undefined });
    expect(extended).toEqual([15 * 60 * 1000]);
  });

  it("reports a sandbox that is already gone rather than throwing", async () => {
    const { manager, sandboxId } = await managerWith(
      stubHandle({ setTimeout: () => Promise.reject(new SandboxNotFoundError("gone")) }),
    );

    const result = await manager.extendTimeout(sandboxId, 60_000);

    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

/**
 * A provider that writes down every request the adapter makes to it, in order.
 *
 * Everything on the client and the handle is a round trip except `getHost`, which only formats a
 * string, so everything else is counted. The point is the count: a turn resumes its sandbox before
 * anything else happens, so each extra request here is latency every turn pays.
 */
function countingProvider(overrides: Partial<E2BClient> = {}) {
  const requests: string[] = [];
  const handle = (sandboxId: string): E2BSandboxHandle => ({
    sandboxId,
    files: {
      readBytes: () => {
        requests.push("files.readBytes");
        return Promise.resolve(new Uint8Array([0, 255]));
      },
      read: () => {
        requests.push("files.read");
        return Promise.resolve("contents");
      },
      write: () => {
        requests.push("files.write");
        return Promise.resolve();
      },
      list: () => {
        requests.push("files.list");
        return Promise.resolve([]);
      },
    },
    commands: {
      run: () => {
        requests.push("commands.run");
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    },
    getHost: (port) => `${port}-${sandboxId}.e2b.app`,
    setTimeout: (ms) => {
      requests.push(`setTimeout(${ms})`);
      return Promise.resolve();
    },
    kill: () => {
      requests.push("kill");
      return Promise.resolve(true);
    },
  });
  const client: E2BClient = {
    create: () => {
      requests.push("create");
      return Promise.resolve(handle("sbx_counted"));
    },
    connect: (sandboxId, opts) => {
      requests.push(`connect(${opts?.timeoutMs})`);
      return Promise.resolve(handle(sandboxId));
    },
    ping: () => Promise.reject(new Error("unused")),
    list: () => Promise.reject(new Error("unused")),
    ...overrides,
  };
  return { client, requests };
}

describe("resuming a sandbox", () => {
  it("resumes one it is holding, and pushes its deadline out, in one request", async () => {
    // Every turn starts here. Before, a held sandbox cost a metadata read and then a separate
    // keepalive, two round trips one after the other, with nothing reading the metadata.
    const { client, requests } = countingProvider();
    const manager = new E2BSandboxManager({ client });
    const created = await manager.create("project");
    if (!created.ok) throw new Error(created.error.message);
    requests.length = 0;

    const resumed = await manager.resume(created.value.id, { keepAliveMs: 90_000 });

    expect(resumed).toEqual({ ok: true, value: { id: "sbx_counted" } });
    expect(requests).toEqual(["connect(90000)"]);
  });

  it("resumes one it has never seen, a worker picking up another's project, in one request", async () => {
    const { client, requests } = countingProvider();
    const manager = new E2BSandboxManager({ client });

    const resumed = await manager.resume("sbx_elsewhere", { keepAliveMs: 90_000 });

    expect(resumed).toEqual({ ok: true, value: { id: "sbx_elsewhere" } });
    expect(requests).toEqual(["connect(90000)"]);
  });

  it("leaves the deadline to the provider when no keepalive is asked for", async () => {
    const { client, requests } = countingProvider();
    const manager = new E2BSandboxManager({ client });

    await manager.resume("sbx_elsewhere");

    expect(requests).toEqual(["connect(undefined)"]);
  });

  it("works through the handle the resume made, with no further connect", async () => {
    const { client, requests } = countingProvider();
    const manager = new E2BSandboxManager({ client });

    await manager.resume("sbx_elsewhere", { keepAliveMs: 90_000 });
    await manager.readFile("sbx_elsewhere", "/home/user/a.txt");

    expect(requests).toEqual(["connect(90000)", "files.read"]);
  });
});

describe("the handles it keeps", () => {
  /** A provider whose handles each answer one read with `outcome`, then read normally. */
  function flakyProvider(outcome: () => Promise<string>) {
    let connects = 0;
    const client: E2BClient = {
      create: () => Promise.reject(new Error("unused")),
      connect: (sandboxId) => {
        connects += 1;
        let first = connects === 1;
        return Promise.resolve(
          stubHandle({
            sandboxId,
            files: {
              readBytes: () => Promise.reject(new Error("files.readBytes not stubbed")),
              read: () => {
                if (!first) return Promise.resolve("contents");
                first = false;
                return outcome();
              },
              write: () => Promise.resolve(),
              list: () => Promise.resolve([]),
            },
          }),
        );
      },
      ping: () => Promise.reject(new Error("unused")),
      list: () => Promise.reject(new Error("unused")),
    };
    return { client, connects: () => connects };
  }

  it("forgets a handle whose sandbox has gone, so the next call reconnects rather than failing through it", async () => {
    // The reaper is another process and E2B's own timer kills sandboxes nobody here destroyed, so
    // a cached handle can outlive its sandbox. Kept, every later call would fail through it.
    const { client, connects } = flakyProvider(() =>
      Promise.reject(new SandboxNotFoundError("Sandbox is probably not running anymore")),
    );
    const manager = new E2BSandboxManager({ client });

    expect(await manager.readFile("sbx_a", "/home/user/a.txt")).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await manager.readFile("sbx_a", "/home/user/a.txt")).toEqual({
      ok: true,
      value: "contents",
    });
    expect(connects()).toBe(2);
  });

  it("forgets one on a timeout too, which is how E2B reports a file operation on a dead sandbox", async () => {
    const { client, connects } = flakyProvider(() =>
      Promise.reject(new TimeoutError("502: This error is likely due to sandbox timeout")),
    );
    const manager = new E2BSandboxManager({ client });

    await manager.readFile("sbx_a", "/home/user/a.txt");
    await manager.readFile("sbx_a", "/home/user/a.txt");

    expect(connects()).toBe(2);
  });

  it("keeps one through a failure that says nothing about the sandbox", async () => {
    const { client, connects } = flakyProvider(() =>
      Promise.reject(new FileNotFoundError("no such file")),
    );
    const manager = new E2BSandboxManager({ client });

    await manager.readFile("sbx_a", "/home/user/a.txt");
    await manager.readFile("sbx_a", "/home/user/a.txt");

    expect(connects()).toBe(1);
  });

  it("forgets one when a keepalive finds the sandbox gone", async () => {
    let connects = 0;
    const manager = new E2BSandboxManager({
      client: {
        create: () => Promise.reject(new Error("unused")),
        connect: (sandboxId) => {
          connects += 1;
          return Promise.resolve(
            stubHandle({
              sandboxId,
              setTimeout: () => Promise.reject(new SandboxNotFoundError("gone")),
            }),
          );
        },
        ping: () => Promise.reject(new Error("unused")),
        list: () => Promise.reject(new Error("unused")),
      },
    });

    await manager.extendTimeout("sbx_a", 60_000);
    await manager.extendTimeout("sbx_a", 60_000);

    expect(connects).toBe(2);
  });

  it("holds at most a bounded number, dropping the one used longest ago", async () => {
    // A worker lives for days and serves thousands of projects. Without a bound, every sandbox it
    // ever touched would stay in this map, handle and all.
    const { client, requests } = countingProvider();
    const manager = new E2BSandboxManager({ client });
    for (let index = 0; index <= HANDLE_CACHE_LIMIT; index += 1) {
      await manager.readFile(`sbx_${index}`, "/home/user/a.txt");
    }
    // The second, read again just now, is the most recently used and so is not the one dropped.
    await manager.readFile("sbx_1", "/home/user/a.txt");
    await manager.readFile(`sbx_${HANDLE_CACHE_LIMIT + 1}`, "/home/user/a.txt");
    requests.length = 0;

    await manager.readFile("sbx_1", "/home/user/a.txt");
    await manager.readFile(`sbx_${HANDLE_CACHE_LIMIT + 1}`, "/home/user/a.txt");
    expect(requests).toEqual(["files.read", "files.read"]);

    await manager.readFile("sbx_0", "/home/user/a.txt");
    await manager.readFile("sbx_2", "/home/user/a.txt");
    expect(requests).toEqual([
      "files.read",
      "files.read",
      "connect(undefined)",
      "files.read",
      "connect(undefined)",
      "files.read",
    ]);
  });
});

describe("ping", () => {
  it("resolves when the provider answers", async () => {
    const manager = new E2BSandboxManager({ client: stubClient() });
    await expect(manager.ping()).resolves.toBeUndefined();
  });

  it("rejects when the provider does not, so a health check can report it down", async () => {
    // Rejecting rather than swallowing is the whole contract: a probe that resolved on failure
    // would report every outage as healthy, which is worse than having no check at all.
    const manager = new E2BSandboxManager({
      client: { ...stubClient(), ping: () => Promise.reject(new Error("getaddrinfo ENOTFOUND")) },
    });

    await expect(manager.ping()).rejects.toThrow("ENOTFOUND");
  });

  it("does not create a sandbox to find out", async () => {
    // Polled every few seconds forever. Creating one would bill for each poll and take seconds
    // to answer, at which point the check is the outage.
    let created = 0;
    const manager = new E2BSandboxManager({
      client: {
        ...stubClient(),
        create: () => {
          created += 1;
          return Promise.resolve(stubHandle());
        },
      },
    });

    await manager.ping();

    expect(created).toBe(0);
  });
});

describe("listing what the provider is running", () => {
  const RUNNING = new Date("2026-08-09T11:00:00.000Z");

  function listing(overrides: Partial<E2BSandboxSummary> = {}): E2BSandboxSummary {
    return {
      sandboxId: "sbx_listed",
      metadata: { projectId: "project" },
      startedAt: RUNNING,
      ...overrides,
    };
  }

  it("reports the id, the project it was made for, and when it started", async () => {
    // All three are what a reconciling sweep decides on: what to destroy, whether it is ours at
    // all, and whether it is young enough to be a creation still in flight.
    const manager = new E2BSandboxManager({
      client: { ...stubClient(), list: () => Promise.resolve([listing()]) },
    });

    await expect(manager.list()).resolves.toEqual({
      ok: true,
      value: [{ id: "sbx_listed", projectId: "project", startedAt: RUNNING.toISOString() }],
    });
  });

  it("reports no project for a sandbox nothing here created", async () => {
    // The account may be shared. Whoever consumes this destroys unreferenced sandboxes, and a
    // missing project id is the only evidence that something else owns one.
    const manager = new E2BSandboxManager({
      client: { ...stubClient(), list: () => Promise.resolve([listing({ metadata: {} })]) },
    });

    const listed = await manager.list();

    expect(listed).toMatchObject({ ok: true, value: [{ projectId: null }] });
  });

  it("maps a provider failure onto our vocabulary rather than throwing", async () => {
    // A sweep runs on a timer with nobody watching; an exception here would end the whole pass.
    const manager = new E2BSandboxManager({
      client: {
        ...stubClient(),
        list: () => Promise.reject(new AuthenticationError("invalid api key")),
      },
    });

    await expect(manager.list()).resolves.toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });
});
