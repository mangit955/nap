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
import { describe, expect, it } from "vitest";
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
    kill: () => Promise.resolve(true),
    ...overrides,
  };
}

function stubClient(handle: E2BSandboxHandle = stubHandle()): E2BClient {
  return {
    create: () => Promise.resolve(handle),
    connect: () => Promise.resolve(handle),
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
