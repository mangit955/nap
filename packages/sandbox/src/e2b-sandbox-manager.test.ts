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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { E2BClient, E2BSandboxHandle } from "./e2b-sandbox-manager.ts";
import { E2BSandboxManager, toSandboxError } from "./e2b-sandbox-manager.ts";

/**
 * A stub standing in for one E2B sandbox. Every method rejects unless the test
 * overrides it, so a case can only pass by exercising the path it names.
 */
function stubHandle(overrides: Partial<E2BSandboxHandle> = {}): E2BSandboxHandle {
  return {
    sandboxId: "sbx_stub",
    files: {
      read: () => Promise.reject(new Error("files.read not stubbed")),
      write: () => Promise.reject(new Error("files.write not stubbed")),
      list: () => Promise.reject(new Error("files.list not stubbed")),
    },
    commands: { run: () => Promise.reject(new Error("commands.run not stubbed")) },
    getHost: (port) => `${port}-sbx_stub.e2b.app`,
    getMetadata: () => Promise.resolve({ projectId: "project" }),
    setTimeout: () => Promise.resolve(),
    kill: () => Promise.resolve(true),
    ...overrides,
  };
}

function stubClient(handle: E2BSandboxHandle = stubHandle()): E2BClient {
  return {
    create: () => Promise.resolve(handle),
    connect: () => Promise.resolve(handle),
    ping: () => Promise.resolve([]),
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

describe("E2BSandboxManager lifecycle", () => {
  it("carries the project id on the sandbox it creates", async () => {
    const manager = new E2BSandboxManager({ client: stubClient() });

    const created = await manager.create("project-42");

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value).toEqual({ id: "sbx_stub", projectId: "project-42" });
  });

  it("recovers the project id on resume from sandbox metadata", async () => {
    // Nothing else persists the association, so a resume in a later process can only
    // learn which project a sandbox belongs to from what E2B stored at create time.
    const manager = new E2BSandboxManager({
      client: stubClient(stubHandle({ getMetadata: () => Promise.resolve({ projectId: "p-7" }) })),
    });

    const resumed = await manager.resume("sbx_stub");

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.value.projectId).toBe("p-7");
  });

  it("reports an unknown sandbox as not_found", async () => {
    const manager = new E2BSandboxManager({
      client: {
        create: () => Promise.reject(new Error("unused")),
        connect: () => Promise.reject(new SandboxNotFoundError("no such sandbox")),
        ping: () => Promise.reject(new Error("unused")),
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
        read: () => Promise.resolve("contents"),
        write: () => Promise.resolve(),
        list: () => Promise.resolve([]),
      },
    });
    const manager = new E2BSandboxManager({
      client: {
        create: () => Promise.reject(new Error("unused")),
        ping: () => Promise.reject(new Error("unused")),
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
