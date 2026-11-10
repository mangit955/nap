import { describe, expect, it } from "vitest";
import {
  archiveDependencies,
  DEPENDENCY_KEY_PROBE,
  decodeDependencyArchive,
  dependencyCacheKey,
  encodeDependencyArchive,
  extractDependencies,
  installDependencies,
  readDependencyKey,
  stageDependencyArchive,
} from "./dependency-cache.ts";
import { InMemorySandboxManager } from "./testing/in-memory-sandbox-manager.ts";

const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);
const SCRATCH = "/home/user/.nap/dependencies";

async function sandboxed(manager = new InMemorySandboxManager()) {
  const created = await manager.create("project");
  if (!created.ok) throw new Error(created.error.message);
  return { manager, sandboxId: created.value.id };
}

describe("readDependencyKey", () => {
  it("accepts exactly a sha256 in lowercase hex", () => {
    expect(readDependencyKey(KEY)).toBe(KEY);
    expect(readDependencyKey(` ${KEY}\n`)).toBe(KEY);
  });

  it.each([
    ["nothing", ""],
    ["a short hash", "a".repeat(63)],
    ["a long hash", "a".repeat(65)],
    ["uppercase", "A".repeat(64)],
    ["an error message", "sha256sum: command not found"],
  ])("refuses %s, so a probe that could not run never reads as a match", (_, line) => {
    expect(readDependencyKey(line)).toBeNull();
  });
});

describe("dependencyCacheKey", () => {
  it("is a sha256 of both the template's inputs and the project's", () => {
    expect(dependencyCacheKey(KEY, OTHER)).toMatch(/^[0-9a-f]{64}$/);
    expect(dependencyCacheKey(KEY, OTHER)).toBe(dependencyCacheKey(KEY, OTHER));
  });

  it("changes when either side changes, and is not symmetric", () => {
    // The template matters too: the install a cached archive came from ran on top of its baked
    // dependencies, with its toolchain.
    expect(dependencyCacheKey(KEY, OTHER)).not.toBe(dependencyCacheKey(KEY, KEY));
    expect(dependencyCacheKey(KEY, OTHER)).not.toBe(dependencyCacheKey(OTHER, OTHER));
    expect(dependencyCacheKey(KEY, OTHER)).not.toBe(dependencyCacheKey(OTHER, KEY));
  });
});

describe("the stored archive's envelope", () => {
  const ARCHIVE = Uint8Array.from({ length: 256 }, (_, index) => index);

  it("round-trips the key and the archive byte for byte", () => {
    expect(decodeDependencyArchive(encodeDependencyArchive(KEY, ARCHIVE))).toEqual({
      key: KEY,
      archive: ARCHIVE,
    });
  });

  it.each([
    ["no envelope at all", ARCHIVE],
    ["an envelope with no end", new TextEncoder().encode(`# nap dependencies v2\n{"key":"${KEY}"`)],
    [
      // Written before an install had to prove it was decided by its inputs alone.
      "an envelope from the first version",
      new TextEncoder().encode(`# nap dependencies v1\n{"key":"${KEY}"}\nrest`),
    ],
    ["a header that is not JSON", new TextEncoder().encode("# nap dependencies v2\nnope\n")],
    [
      "a key that is not a sha256",
      new TextEncoder().encode('# nap dependencies v2\n{"key":"abc"}\nrest'),
    ],
    ["an empty archive", encodeDependencyArchive(KEY, new Uint8Array())],
  ])("reads %s as no archive, never as one", (_, bytes) => {
    expect(decodeDependencyArchive(bytes)).toBeNull();
  });
});

describe("DEPENDENCY_KEY_PROBE", () => {
  it("hashes the committed install inputs and the toolchain, and cannot fail", () => {
    for (const input of ["package.json", "bun.lock", "bun.lockb", "bunfig.toml", ".npmrc"]) {
      expect(DEPENDENCY_KEY_PROBE).toContain(input);
    }
    expect(DEPENDENCY_KEY_PROBE).toMatch(/git ls-tree HEAD/);
    expect(DEPENDENCY_KEY_PROBE).toMatch(/bun --revision/);
    expect(DEPENDENCY_KEY_PROBE).toMatch(/sha256sum/);
  });
});

describe("installDependencies", () => {
  it("runs one command that checks the inputs either side of the install and records the result", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/bun install/, {
      exitCode: 0,
      stdout: "Checked 42 installs\nnap-dependencies-cacheable\n",
    });
    const signal = new AbortController().signal;

    const result = await installDependencies(manager, sandboxId, { signal, timeoutMs: 1234 });

    expect(result).toEqual({ ok: true, value: { exitCode: 0, cacheable: true, stderr: "" } });
    const [install] = manager.execs(sandboxId);
    expect(manager.execs(sandboxId)).toHaveLength(1);
    expect(install?.options).toMatchObject({ signal, stopOnGiveUp: true, timeoutMs: 1234 });
    expect(install?.command).toMatch(/git status --porcelain[\s\S]*bun install[\s\S]*git status/);
  });

  it("reports an install that left nothing worth caching as not cacheable", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/bun install/, { exitCode: 0, stdout: "Checked 42 installs\n" });

    const result = await installDependencies(manager, sandboxId, { timeoutMs: 1 });

    expect(result).toMatchObject({ ok: true, value: { exitCode: 0, cacheable: false } });
  });

  it("reports a failed install as its exit code, never as cacheable", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/bun install/, {
      exitCode: 1,
      stdout: "nap-dependencies-cacheable\n",
      stderr: "no such package",
    });

    const result = await installDependencies(manager, sandboxId, { timeoutMs: 1 });

    expect(result).toEqual({
      ok: true,
      value: { exitCode: 1, cacheable: false, stderr: "no such package" },
    });
  });
});

describe("stageDependencyArchive and extractDependencies", () => {
  it("uploads the archive as bytes and extracts it with one command", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/tar -xzf/, { exitCode: 0 });
    const archive = new Uint8Array([31, 139, 8]);

    expect(await stageDependencyArchive(manager, sandboxId, archive)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(await extractDependencies(manager, sandboxId)).toEqual({ ok: true, value: undefined });

    expect(await manager.readFileBytes(sandboxId, `${SCRATCH}/incoming.tar.gz`)).toEqual({
      ok: true,
      value: archive,
    });
    expect(manager.commands(sandboxId)).toHaveLength(1);
  });

  it("reports an extraction that failed as exec_failed", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/tar -xzf/, { exitCode: 2, stderr: "gzip: stdin: not in gzip format" });

    const result = await extractDependencies(manager, sandboxId);

    expect(result).toMatchObject({ ok: false, error: { code: "exec_failed" } });
  });
});

describe("archiveDependencies", () => {
  const ARCHIVE = new Uint8Array([31, 139, 8, 0]);

  it("archives, checks and measures in one command, then reads the archive back", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/tar -czf/, {
      exitCode: 0,
      stdout: `${ARCHIVE.length}\n`,
      writes: { [`${SCRATCH}/outgoing.tar.gz`]: ARCHIVE },
    });
    manager.script(/rm -f -- /, { exitCode: 0 });

    const result = await archiveDependencies(manager, sandboxId, { maxBytes: 100 });

    expect(result).toEqual({ ok: true, value: ARCHIVE });
  });

  it("refuses an archive over the bound without reading it", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/tar -czf/, {
      exitCode: 0,
      stdout: "101\n",
      writes: { [`${SCRATCH}/outgoing.tar.gz`]: ARCHIVE },
    });
    manager.script(/rm -f -- /, { exitCode: 0 });
    let reads = 0;
    const read = manager.readFileBytes.bind(manager);
    manager.readFileBytes = (...args) => {
      reads += 1;
      return read(...args);
    };

    const result = await archiveDependencies(manager, sandboxId, { maxBytes: 100 });

    expect(result).toMatchObject({ ok: false, error: { code: "exec_failed" } });
    expect(reads).toBe(0);
  });

  it("refuses when the dependencies moved since the install, as the command reports", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/tar -czf/, { exitCode: 1 });
    manager.script(/rm -f -- /, { exitCode: 0 });

    const result = await archiveDependencies(manager, sandboxId, { maxBytes: 100 });

    expect(result).toMatchObject({ ok: false, error: { code: "exec_failed" } });
  });
});
