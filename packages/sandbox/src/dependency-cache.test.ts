import { describe, expect, it } from "vitest";
import {
  archiveDependencies,
  archivePackageCache,
  DEPENDENCY_KEY_PROBE,
  decodeDependencyArchive,
  dependencyCacheKey,
  encodeDependencyArchive,
  extractDependencies,
  extractPackageCache,
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

  it.each(["node_modules", "packages"] as const)(
    "round-trips the key, the kind (%s) and the archive byte for byte",
    (kind) => {
      expect(decodeDependencyArchive(encodeDependencyArchive(KEY, kind, ARCHIVE))).toEqual({
        key: KEY,
        kind,
        archive: ARCHIVE,
      });
    },
  );

  it.each([
    ["no envelope at all", ARCHIVE],
    ["an envelope with no end", new TextEncoder().encode(`# nap dependencies v3\n{"key":"${KEY}"`)],
    [
      // Written before an install had to prove it was decided by its inputs alone.
      "an envelope from the first version",
      new TextEncoder().encode(`# nap dependencies v1\n{"key":"${KEY}"}\nrest`),
    ],
    [
      // Written before an archive said what kind it is.
      "an envelope from the second version",
      new TextEncoder().encode(`# nap dependencies v2\n{"key":"${KEY}"}\nrest`),
    ],
    ["a header that is not JSON", new TextEncoder().encode("# nap dependencies v3\nnope\n")],
    [
      "a key that is not a sha256",
      new TextEncoder().encode('# nap dependencies v3\n{"key":"abc","kind":"packages"}\nrest'),
    ],
    [
      "a kind it does not know",
      new TextEncoder().encode(`# nap dependencies v3\n{"key":"${KEY}","kind":"vendor"}\nrest`),
    ],
    ["an empty archive", encodeDependencyArchive(KEY, "node_modules", new Uint8Array())],
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
      stdout: "Checked 42 installs\nnap-dependencies-cache node_modules\n",
    });
    const signal = new AbortController().signal;

    const result = await installDependencies(manager, sandboxId, { signal, timeoutMs: 1234 });

    expect(result).toEqual({
      ok: true,
      value: { exitCode: 0, cache: "node_modules", changed: [], stderr: "" },
    });
    const [install] = manager.execs(sandboxId);
    expect(manager.execs(sandboxId)).toHaveLength(1);
    expect(install?.options).toMatchObject({ signal, stopOnGiveUp: true, timeoutMs: 1234 });
    expect(install?.command).toMatch(
      /git status --porcelain[\s\S]*bun install --backend=copyfile &&[\s\S]*git status/,
    );
    expect(install?.command).not.toMatch(/--offline/);
  });

  it.each([
    ["online", false],
    ["offline", true],
  ])("copies files out of Bun's cache rather than linking them, %s", async (_, offline) => {
    // Linked, a script that edits a dependency's file in place edits the cache's copy too, and a
    // package archive made from that cache hands the edit to the next reopen, which applies its
    // script on top: a tree no fresh install would produce.
    const { manager, sandboxId } = await sandboxed();
    manager.script(/bun install/, { exitCode: 0, stdout: "" });

    await installDependencies(manager, sandboxId, { offline, timeoutMs: 1 });

    expect(manager.commands(sandboxId)[0]).toMatch(/bun install[^&]* --backend=copyfile &&/);
  });

  it("installs offline from the package cache, with the lockfile frozen, when asked", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/bun install/, { exitCode: 0, stdout: "" });

    await installDependencies(manager, sandboxId, { offline: true, timeoutMs: 1 });

    expect(manager.commands(sandboxId)[0]).toMatch(
      /bun install --offline --frozen-lockfile --backend=copyfile &&/,
    );
  });

  it.each([
    ["packages", "nap-dependencies-cache packages\n", "packages"],
    ["none", "", null],
  ] as const)("reads which archive describes the install: %s", async (_, line, cache) => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/bun install/, { exitCode: 0, stdout: `Checked 42 installs\n${line}` });

    const result = await installDependencies(manager, sandboxId, { timeoutMs: 1 });

    expect(result).toMatchObject({ ok: true, value: { exitCode: 0, cache } });
  });

  it("names the committed files the install changed, from git's own listing", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/bun install/, {
      exitCode: 0,
      stdout:
        "Checked 42 installs\nnap-dependencies-changed  M bun.lock\n" +
        "nap-dependencies-changed  D src/old name.ts\n" +
        'nap-dependencies-changed  M "src/caf\\303\\251 page.ts"\n',
    });

    const result = await installDependencies(manager, sandboxId, { timeoutMs: 1 });

    expect(result).toMatchObject({
      ok: true,
      // A name git had to quote is given without the quotes, its escapes as git wrote them.
      value: { cache: null, changed: ["bun.lock", "src/old name.ts", "src/caf\\303\\251 page.ts"] },
    });
  });

  it("reports a failed install as its exit code, never as cacheable", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/bun install/, {
      exitCode: 1,
      stdout: "nap-dependencies-cache node_modules\n",
      stderr: "no such package",
    });

    const result = await installDependencies(manager, sandboxId, { timeoutMs: 1 });

    expect(result).toEqual({
      ok: true,
      value: { exitCode: 1, cache: null, changed: [], stderr: "no such package" },
    });
  });
});

describe("archivePackageCache and extractPackageCache", () => {
  it("packs what the install downloaded in one command, then reads it back", async () => {
    const { manager, sandboxId } = await sandboxed();
    const ARCHIVE = new Uint8Array([31, 139, 8, 0]);
    manager.script(/tar -cz -f/, {
      exitCode: 0,
      stdout: `${ARCHIVE.length}\n`,
      writes: { [`${SCRATCH}/outgoing.tar.gz`]: ARCHIVE },
    });
    manager.script(/rm -f -- /, { exitCode: 0 });

    const result = await archivePackageCache(manager, sandboxId, { maxBytes: 100 });

    expect(result).toEqual({ ok: true, value: ARCHIVE });
    expect(manager.commands(sandboxId)[0]).toMatch(/bun pm cache[\s\S]*-cnewer/);
  });

  it("refuses an archive over the bound without reading it", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/tar -cz -f/, { exitCode: 0, stdout: "101\n" });
    manager.script(/rm -f -- /, { exitCode: 0 });

    const result = await archivePackageCache(manager, sandboxId, { maxBytes: 100 });

    expect(result).toMatchObject({ ok: false, error: { code: "exec_failed" } });
  });

  it("extracts into the package cache with one command, and reports a failure", async () => {
    const { manager, sandboxId } = await sandboxed();
    manager.script(/tar -xz -f/, { exitCode: 2, stderr: "gzip: stdin: not in gzip format" });

    const result = await extractPackageCache(manager, sandboxId);

    expect(result).toMatchObject({ ok: false, error: { code: "exec_failed" } });
    expect(manager.commands(sandboxId)).toHaveLength(1);
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
