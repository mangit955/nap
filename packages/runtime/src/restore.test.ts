import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import {
  DEPENDENCY_KEY_PROBE,
  decodeDependencyArchive,
  dependencyCacheKey,
  encodeDependencyArchive,
} from "@nap/sandbox/dependency-cache";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import {
  ARCHIVE_COMMAND,
  archived,
  EXTRACT_COMMAND,
  FAKE_DEPENDENCY_ARCHIVE,
  INCOMING_ARCHIVE,
  INSTALL_COMMAND,
  installedWith,
  OFFLINE_INSTALL_COMMAND,
  PACKAGE_ARCHIVE_COMMAND,
  PACKAGE_EXTRACT_COMMAND,
  scriptDependencies,
} from "@nap/sandbox/testing/script-dependencies";
import { RESTORE_COMMAND, restored } from "@nap/sandbox/testing/script-git";
import type { ObjectStoreError } from "@nap/shared/ports/object-store";
import type { Sandbox, SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPENDENCY_ARCHIVE_WAIT_MS, dependenciesKey, openProject } from "./restore.ts";

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80912";
const KEY = `projects/${PROJECT}/1735689600000-${SHA}.bundle`;
const DEPENDENCIES = dependenciesKey(PROJECT);

/** What the probe reads on the template, and on a project that added a dependency. */
const TEMPLATE_INPUTS = "1".repeat(64);
const PROJECT_INPUTS = "2".repeat(64);
const EARLIER_INPUTS = "3".repeat(64);

/** A bundle, as the bytes an object store hands back. */
const BUNDLE = new TextEncoder().encode("PACK-bundle-bytes");

type Deferred = { promise: Promise<void>; release: () => void };
function deferred(): Deferred {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * The fake cannot fail a `create`, and two guards here are about *when* one happens: a create that
 * failed must be reported, and one that is held must not hold up the storage reads beside it.
 */
class CountingSandboxManager extends InMemorySandboxManager {
  creates = 0;
  /** The most recent sandbox, so a scripted command can act on a sandbox it did not make. */
  lastCreatedId: string | null = null;
  /** Held until released, so a test can see what else ran while it was. */
  createGate: Promise<void> | null = null;
  readonly destroyed: string[] = [];
  #createFailure: SandboxError | undefined;

  failCreateWith(error: SandboxError): this {
    this.#createFailure = error;
    return this;
  }

  override async create(projectId: string): Promise<Result<Sandbox, SandboxError>> {
    this.creates += 1;
    await this.createGate;
    if (this.#createFailure !== undefined) return { ok: false, error: this.#createFailure };

    const created = await super.create(projectId);
    if (created.ok) this.lastCreatedId = created.value.id;
    return created;
  }

  override async destroy(sandboxId: string) {
    this.destroyed.push(sandboxId);
    return await super.destroy(sandboxId);
  }
}

/** An object store that records the order of reads, and can be told to fail one key only. */
class RecordingObjectStore extends InMemoryObjectStore {
  readonly gets: string[] = [];
  /** Held until released, for one key, so a test can see what else ran while it was. */
  gate: { key: string; until: Promise<void> } | null = null;
  readonly #failures = new Map<string, ObjectStoreError>();

  failKey(key: string, error: ObjectStoreError): this {
    this.#failures.set(key, error);
    return this;
  }

  override async get(key: string) {
    this.gets.push(key);
    if (this.gate?.key === key) await this.gate.until;
    const failure = this.#failures.get(key);
    if (failure !== undefined) return { ok: false as const, error: failure };
    return await super.get(key);
  }
}

let sandbox: CountingSandboxManager;
let objects: RecordingObjectStore;
let snapshots: InMemorySnapshotStore;
/** Every `SandboxManager` call an open made, by method name, in order. */
let calls: string[];

/** The manager as `openProject` sees it, with every call through it written down. */
function counted(manager: CountingSandboxManager): SandboxManager {
  return new Proxy(manager, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(property));
        return value.apply(target, args);
      };
    },
  });
}

/** A restore whose probe reads `before` on the template and `after` on the project. */
function restoreReads(before: string, after: string = before): void {
  sandbox.script(RESTORE_COMMAND, restored(before, after));
}

beforeEach(() => {
  sandbox = new CountingSandboxManager();
  scriptDependencies(sandbox);
  sandbox.script(RESTORE_COMMAND, restored(TEMPLATE_INPUTS));
  objects = new RecordingObjectStore();
  snapshots = new InMemorySnapshotStore();
  calls = [];
});

function open(options: { signal?: AbortSignal } = {}) {
  return openProject({
    sandbox: counted(sandbox),
    objects,
    snapshots,
    projectId: PROJECT,
    ...options,
  });
}

/** A project that was torn down once: a row pointing at a bundle that is really there. */
async function seedSnapshot(bytes: Uint8Array = BUNDLE): Promise<void> {
  await objects.put(KEY, bytes);
  await snapshots.record({ projectId: PROJECT, key: KEY, gitSha: SHA });
}

/** An archive of `kind` stored by an earlier reopen whose install read `inputs`. */
async function seedArchive(
  inputs: string = PROJECT_INPUTS,
  kind: "node_modules" | "packages" = "node_modules",
): Promise<void> {
  await objects.put(
    DEPENDENCIES,
    encodeDependencyArchive(
      dependencyCacheKey(TEMPLATE_INPUTS, inputs),
      kind,
      FAKE_DEPENDENCY_ARCHIVE,
    ),
  );
}

function commandsMatching(sandboxId: string, pattern: RegExp): string[] {
  return sandbox.commands(sandboxId).filter((command) => pattern.test(command));
}

describe("a project that has never been torn down", () => {
  it("comes up as a fresh template, with nothing to apologise for", async () => {
    const opened = await open();

    expect(opened).toMatchObject({ ok: true, value: { restored: false, warning: null } });
    // No snapshot is the ordinary state of a brand-new project. Warning about it would
    // teach the user to ignore the one warning that matters.
    expect(sandbox.creates).toBe(1);
  });

  it("runs no git and no install", async () => {
    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(sandbox.commands(opened.value.sandboxId)).toEqual([]);
  });
});

describe("a project with a snapshot", () => {
  it("restores it into a fresh sandbox", async () => {
    await seedSnapshot();

    const opened = await open();

    expect(opened).toMatchObject({ ok: true, value: { restored: true, warning: null } });
  });

  it("verifies, resets and cleans in one command, probing the dependency inputs either side", async () => {
    await seedSnapshot();

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    // Order, not membership: resetting before the fetch would reset onto the template's own
    // HEAD and report a successful restore of nothing.
    const [command, ...rest] = sandbox.commands(opened.value.sandboxId);
    expect(rest).toEqual([]);
    expect(command).toMatch(/git bundle verify[\s\S]*git reset --hard[\s\S]*git clean/);
    expect(command?.split(DEPENDENCY_KEY_PROBE)).toHaveLength(3);
  });
});

describe("dependencies the template already has", () => {
  it("are neither installed nor fetched from the cache", async () => {
    await seedSnapshot();

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    // The whole point of the baked template is that opening a project does not install.
    expect(opened.value).toMatchObject({ installed: false, cachedDependencies: false });
    expect(commandsMatching(opened.value.sandboxId, /bun install|tar /)).toEqual([]);
  });
});

describe("a project that added a dependency", () => {
  it("reopens without an install when its stored archive matches, and extracts that archive", async () => {
    await seedSnapshot();
    await seedArchive();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value).toMatchObject({
      restored: true,
      warning: null,
      installed: false,
      cachedDependencies: true,
    });
    expect(opened.value.dependencyCacheWrite).toBeUndefined();
    expect(commandsMatching(opened.value.sandboxId, INSTALL_COMMAND)).toEqual([]);
    expect(commandsMatching(opened.value.sandboxId, EXTRACT_COMMAND)).toHaveLength(1);
    // The archive itself, without the envelope that names its key.
    expect(await sandbox.readFileBytes(opened.value.sandboxId, INCOMING_ARCHIVE)).toEqual({
      ok: true,
      value: FAKE_DEPENDENCY_ARCHIVE,
    });
  });

  it("installs when there is no archive, and stores one afterwards, off the open's path", async () => {
    await seedSnapshot();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    const archiving = deferred();
    sandbox.script(ARCHIVE_COMMAND, async () => {
      await archiving.promise;
      return {
        exitCode: 0,
        stdout: `${FAKE_DEPENDENCY_ARCHIVE.length}\n`,
        writes: { "/home/user/.nap/dependencies/outgoing.tar.gz": FAKE_DEPENDENCY_ARCHIVE },
      };
    });

    // Resolves while the archive is still being packed: nothing the user waits on waits for it.
    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");
    expect(opened.value).toMatchObject({ installed: true, cachedDependencies: false });
    expect(objects.keys()).not.toContain(DEPENDENCIES);

    archiving.release();
    expect(await opened.value.dependencyCacheWrite).toBe(true);
    const stored = await objects.get(DEPENDENCIES);
    if (!stored.ok) throw new Error("expected an archive to be stored");
    expect(decodeDependencyArchive(stored.value)).toEqual({
      key: dependencyCacheKey(TEMPLATE_INPUTS, PROJECT_INPUTS),
      kind: "node_modules",
      archive: FAKE_DEPENDENCY_ARCHIVE,
    });
  });

  it("misses on an archive stored for a different lockfile, installs, and replaces it", async () => {
    await seedSnapshot();
    await seedArchive(EARLIER_INPUTS);
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value).toMatchObject({ installed: true, cachedDependencies: false });
    expect(commandsMatching(opened.value.sandboxId, EXTRACT_COMMAND)).toEqual([]);
    expect(await opened.value.dependencyCacheWrite).toBe(true);
    const stored = await objects.get(DEPENDENCIES);
    if (!stored.ok) throw new Error("expected an archive to be stored");
    expect(decodeDependencyArchive(stored.value)?.key).toBe(
      dependencyCacheKey(TEMPLATE_INPUTS, PROJECT_INPUTS),
    );
  });

  it("misses when the template is not the one the archive was installed on", async () => {
    await seedSnapshot();
    await seedArchive();
    restoreReads(EARLIER_INPUTS, PROJECT_INPUTS);

    const opened = await open();

    expect(opened).toMatchObject({
      ok: true,
      value: { installed: true, cachedDependencies: false },
    });
  });

  it.each([
    ["an envelope that does not parse", new TextEncoder().encode("garbage")],
    [
      "an envelope with nothing after it",
      encodeDependencyArchive("f".repeat(64), "node_modules", new Uint8Array()),
    ],
  ])("installs when the stored archive is %s", async (_, bytes) => {
    await seedSnapshot();
    await objects.put(DEPENDENCIES, bytes);
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);

    const opened = await open();

    expect(opened).toMatchObject({
      ok: true,
      value: { installed: true, cachedDependencies: false },
    });
  });

  it("installs when the archive matches but will not extract", async () => {
    await seedSnapshot();
    await seedArchive();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    sandbox.script(EXTRACT_COMMAND, { exitCode: 2, stderr: "gzip: stdin: unexpected end of file" });

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    // A corrupt cache entry costs the install it was meant to save, never a broken project.
    expect(opened.value).toMatchObject({
      installed: true,
      cachedDependencies: false,
      warning: null,
    });
    expect(commandsMatching(opened.value.sandboxId, INSTALL_COMMAND)).toHaveLength(1);
  });

  it("installs when the archive cannot be uploaded into the sandbox", async () => {
    await seedSnapshot();
    await seedArchive();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    const write = sandbox.writeFileBytes.bind(sandbox);
    sandbox.writeFileBytes = (id, path, contents) =>
      path === INCOMING_ARCHIVE
        ? Promise.resolve({ ok: false, error: { code: "unavailable", message: "502" } })
        : write(id, path, contents);

    const opened = await open();

    expect(opened).toMatchObject({
      ok: true,
      value: { installed: true, cachedDependencies: false },
    });
  });

  it("installs, and still opens, when storage cannot be reached for the archive alone", async () => {
    // Unlike the bundle, the archive is a cache: not being able to tell is a miss, not a failure.
    await seedSnapshot();
    objects.failKey(DEPENDENCIES, { code: "unavailable", message: "R2 is not answering" });
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);

    const opened = await open();

    expect(opened).toMatchObject({ ok: true, value: { restored: true, installed: true } });
  });

  it("installs when the probe printed nothing it recognises, rather than calling it a match", async () => {
    await seedSnapshot();
    restoreReads("", "");

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value.installed).toBe(true);
    // Without a key there is nothing to store an archive under.
    expect(opened.value.dependencyCacheWrite).toBeUndefined();
  });

  it("stores nothing when the install says its inputs did not decide all of it", async () => {
    // It rewrote the lockfile, or ran a script that could read anything: the key would lie.
    await seedSnapshot();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    sandbox.script(INSTALL_COMMAND, installedWith(null));

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value.installed).toBe(true);
    expect(opened.value.dependencyCacheWrite).toBeUndefined();
    expect(commandsMatching(opened.value.sandboxId, ARCHIVE_COMMAND)).toEqual([]);
  });

  it("stores nothing when the sandbox refuses to pack the tree", async () => {
    await seedSnapshot();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    sandbox.script(ARCHIVE_COMMAND, { exitCode: 1 });

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(await opened.value.dependencyCacheWrite).toBe(false);
    expect(objects.keys()).not.toContain(DEPENDENCIES);
  });

  it("runs the install with the open's signal, a long deadline, and a stop on giving up", async () => {
    await seedSnapshot();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    sandbox.script(INSTALL_COMMAND, { ...installedWith(), runsForMs: 4 * 60_000 });
    const { signal } = new AbortController();

    const opened = await open({ signal });
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value).toMatchObject({ installed: true, warning: null });
    const install = sandbox
      .execs(opened.value.sandboxId)
      .find((exec) => INSTALL_COMMAND.test(exec.command));
    expect(install?.command).toContain(`cd '${TEMPLATE_WORKDIR}'`);
    expect(install?.options).toMatchObject({ signal, stopOnGiveUp: true });
  });

  it("keeps the restored project when the install fails, says so, and stores nothing", async () => {
    await seedSnapshot();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    sandbox.script(INSTALL_COMMAND, { exitCode: 1, stderr: "no such package" });

    const opened = await open();

    // The code is restored and readable; only the dependencies are behind. Failing the open
    // would hide a project the user can still see and edit.
    expect(opened).toMatchObject({ ok: true, value: { restored: true, installed: false } });
    if (!opened.ok) return;
    expect(opened.value.warning).toMatch(/dependenc/i);
    expect(opened.value.dependencyCacheWrite).toBeUndefined();
  });
});

describe("a project whose install runs scripts or reads local packages", () => {
  // Its node_modules cannot be cached under a key of its inputs, because the scripts read anything.
  // Bun's package cache can: a reopen restores it and installs offline, and the scripts run again
  // against the restored tree, as they would in any install.

  it("stores the packages the install downloaded, not the tree it left", async () => {
    await seedSnapshot();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    sandbox.script(INSTALL_COMMAND, installedWith("packages"));

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value).toMatchObject({ installed: true, cachedDependencies: false });
    expect(await opened.value.dependencyCacheWrite).toBe(true);
    const stored = await objects.get(DEPENDENCIES);
    if (!stored.ok) throw new Error("expected an archive to be stored");
    expect(decodeDependencyArchive(stored.value)).toMatchObject({
      key: dependencyCacheKey(TEMPLATE_INPUTS, PROJECT_INPUTS),
      kind: "packages",
    });
    expect(commandsMatching(opened.value.sandboxId, PACKAGE_ARCHIVE_COMMAND)).toHaveLength(1);
    expect(commandsMatching(opened.value.sandboxId, ARCHIVE_COMMAND)).toEqual([]);
  });

  it("reopens from them with an offline install, and stores nothing new", async () => {
    await seedSnapshot();
    await seedArchive(PROJECT_INPUTS, "packages");
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    sandbox.script(INSTALL_COMMAND, installedWith("packages"));

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value).toMatchObject({
      restored: true,
      warning: null,
      installed: true,
      cachedDependencies: true,
    });
    expect(commandsMatching(opened.value.sandboxId, PACKAGE_EXTRACT_COMMAND)).toHaveLength(1);
    expect(commandsMatching(opened.value.sandboxId, EXTRACT_COMMAND)).toEqual([]);
    const installs = commandsMatching(opened.value.sandboxId, INSTALL_COMMAND);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatch(OFFLINE_INSTALL_COMMAND);
    expect(opened.value.dependencyCacheWrite).toBeUndefined();
  });

  it("installs from the network when the offline install fails, and stores afresh", async () => {
    await seedSnapshot();
    await seedArchive(PROJECT_INPUTS, "packages");
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    sandbox.script(INSTALL_COMMAND, installedWith("packages"));
    sandbox.script(OFFLINE_INSTALL_COMMAND, { exitCode: 1, stderr: "offline: missing" });

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value).toMatchObject({
      installed: true,
      cachedDependencies: false,
      warning: null,
    });
    const installs = commandsMatching(opened.value.sandboxId, INSTALL_COMMAND);
    expect(installs).toHaveLength(2);
    expect(installs[1]).not.toMatch(OFFLINE_INSTALL_COMMAND);
    expect(await opened.value.dependencyCacheWrite).toBe(true);
  });

  it("installs from the network when the package cache will not extract", async () => {
    await seedSnapshot();
    await seedArchive(PROJECT_INPUTS, "packages");
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    sandbox.script(PACKAGE_EXTRACT_COMMAND, { exitCode: 2, stderr: "gzip: unexpected end" });

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value).toMatchObject({ installed: true, cachedDependencies: false });
    const installs = commandsMatching(opened.value.sandboxId, INSTALL_COMMAND);
    expect(installs).toHaveLength(1);
    expect(installs[0]).not.toMatch(OFFLINE_INSTALL_COMMAND);
  });
});

describe("an install that rewrites committed files", () => {
  it("opens the project with a warning naming them, and stores nothing", async () => {
    // The tree cannot be both the committed one and the one whose dependencies work: the install
    // decided otherwise. It keeps the working install and says which files moved.
    await seedSnapshot();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    sandbox.script(INSTALL_COMMAND, installedWith(null, ["bun.lock", "src/generated.ts"]));

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value).toMatchObject({ restored: true, installed: true });
    expect(opened.value.warning).toMatch(/bun\.lock/);
    expect(opened.value.warning).toMatch(/src\/generated\.ts/);
    expect(opened.value.dependencyCacheWrite).toBeUndefined();
  });

  it("says so after an offline install from the package cache too", async () => {
    await seedSnapshot();
    await seedArchive(PROJECT_INPUTS, "packages");
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    sandbox.script(INSTALL_COMMAND, installedWith(null, ["src/generated.ts"]));

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value).toMatchObject({ installed: true, cachedDependencies: true });
    expect(opened.value.warning).toMatch(/src\/generated\.ts/);
  });
});
describe("an archive that is slow to arrive", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets every promise that can settle settle, without moving any clock. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
  }

  it("is not waited for when the template's dependencies already fit", async () => {
    await seedSnapshot();
    await seedArchive();
    const downloading = deferred();
    objects.gate = { key: DEPENDENCIES, until: downloading.promise };

    // A storage read that never answers must not hold up a reopen that does not need it.
    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");
    expect(opened.value).toMatchObject({ restored: true, installed: false });

    // Nor may it land in the sandbox afterwards.
    downloading.release();
    await settle();
    expect((await sandbox.readFileBytes(opened.value.sandboxId, INCOMING_ARCHIVE)).ok).toBe(false);
  });

  it("is given up on at its deadline, and the reopen installs instead", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await seedSnapshot();
    await seedArchive();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    const downloading = deferred();
    objects.gate = { key: DEPENDENCIES, until: downloading.promise };
    // The archive arrives while the install it was given up for is running, and is not uploaded.
    let stagedDuringInstall: boolean | null = null;
    sandbox.script(INSTALL_COMMAND, async () => {
      downloading.release();
      await settle();
      const id = sandbox.lastCreatedId ?? "";
      stagedDuringInstall = (await sandbox.readFileBytes(id, INCOMING_ARCHIVE)).ok;
      return installedWith();
    });

    let settled = false;
    const opening = open().finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(DEPENDENCY_ARCHIVE_WAIT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const opened = await opening;
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value).toMatchObject({ installed: true, cachedDependencies: false });
    expect(stagedDuringInstall).toBe(false);
    expect(commandsMatching(opened.value.sandboxId, EXTRACT_COMMAND)).toEqual([]);
    expect((await sandbox.readFileBytes(opened.value.sandboxId, INCOMING_ARCHIVE)).ok).toBe(false);
    await opened.value.dependencyCacheWrite;
  });

  it("is given up on the moment the open is cancelled", async () => {
    await seedSnapshot();
    await seedArchive();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    const downloading = deferred();
    objects.gate = { key: DEPENDENCIES, until: downloading.promise };
    const controller = new AbortController();
    sandbox.script(RESTORE_COMMAND, async () => {
      // Cancelled once the restore has answered, while the open waits for the archive alone.
      setTimeout(() => controller.abort(), 0);
      return restored(TEMPLATE_INPUTS, PROJECT_INPUTS);
    });

    // Resolves although the archive never arrives, long before its deadline.
    const opened = await open({ signal: controller.signal });

    expect(controller.signal.aborted).toBe(true);
    if (opened.ok) expect(opened.value.cachedDependencies).toBe(false);
    expect(commandsMatching(sandbox.lastCreatedId ?? "", EXTRACT_COMMAND)).toEqual([]);
    downloading.release();
  });
});

describe("an archive stored for a project that no longer exists", () => {
  it("is deleted again when the project was deleted while it was being stored", async () => {
    // A delete removes the archive before the rows; an upload that lands after that has nobody
    // left to remove it, so the upload checks afterwards and removes its own.
    await seedSnapshot();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    const archiving = deferred();
    sandbox.script(ARCHIVE_COMMAND, async () => {
      await archiving.promise;
      return archived();
    });

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");
    snapshots.latestFor = async () => null;
    archiving.release();

    expect(await opened.value.dependencyCacheWrite).toBe(false);
    expect(objects.keys()).not.toContain(DEPENDENCIES);
  });

  it("is deleted again when whether the project still exists cannot be told", async () => {
    await seedSnapshot();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    const archiving = deferred();
    sandbox.script(ARCHIVE_COMMAND, async () => {
      await archiving.promise;
      return archived();
    });

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");
    snapshots.latestFor = async () => {
      throw new Error("database unreachable");
    };
    archiving.release();

    expect(await opened.value.dependencyCacheWrite).toBe(false);
    expect(objects.keys()).not.toContain(DEPENDENCIES);
  });
});

describe("what runs at the same time", () => {
  it("reads the snapshot row, the bundle and the archive while the sandbox is still being created", async () => {
    await seedSnapshot();
    await seedArchive();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    const creating = deferred();
    sandbox.createGate = creating.promise;

    const opening = open();
    // Each read is a few awaits deep; give them all the chance to start before looking.
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    expect(sandbox.creates).toBe(1);
    expect(objects.gets).toEqual(expect.arrayContaining([KEY, DEPENDENCIES]));
    creating.release();
    expect(await opening).toMatchObject({ ok: true, value: { cachedDependencies: true } });
  });

  it("starts creating the sandbox while the bundle is still downloading", async () => {
    await seedSnapshot();
    const downloading = deferred();
    objects.gate = { key: KEY, until: downloading.promise };

    const opening = open();
    for (let i = 0; i < 20; i += 1) await Promise.resolve();

    // The other half of the overlap: a create that waited for the bytes would not have started.
    expect(objects.gets).toContain(KEY);
    expect(sandbox.creates).toBe(1);
    downloading.release();
    expect(await opening).toMatchObject({ ok: true, value: { restored: true } });
  });

  it("uploads the archive while the restore command is still running", async () => {
    await seedSnapshot();
    await seedArchive();
    const restoring = deferred();
    let stagedDuringRestore = false;
    sandbox.script(RESTORE_COMMAND, async () => {
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      const id = sandbox.lastCreatedId ?? "";
      stagedDuringRestore = (await sandbox.readFileBytes(id, INCOMING_ARCHIVE)).ok;
      restoring.release();
      return restored(TEMPLATE_INPUTS, PROJECT_INPUTS);
    });

    const opened = await open();

    await restoring.promise;
    expect(stagedDuringRestore).toBe(true);
    expect(opened).toMatchObject({ ok: true, value: { cachedDependencies: true } });
  });
});

describe("how many round trips a reopen makes", () => {
  // Each is a request to the provider, made while somebody waits for their project. Before these
  // were counted a reopen made eleven, one after another. The bound is the regression guard.
  it("is three when the template's dependencies still fit", async () => {
    await seedSnapshot();

    await open();

    expect(calls).toEqual(["create", "writeFileBytes", "exec"]);
  });

  it("is six when the project installs offline from its package cache", async () => {
    await seedSnapshot();
    await seedArchive(PROJECT_INPUTS, "packages");
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);

    await open();

    expect(calls).toHaveLength(6);
    expect(calls.filter((call) => call === "exec")).toHaveLength(3);
  });

  it("is five when the project's dependencies come from its archive", async () => {
    await seedSnapshot();
    await seedArchive();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);

    await open();

    expect(calls).toHaveLength(5);
    expect(calls.filter((call) => call === "exec")).toHaveLength(2);
  });

  it("is four on a miss, with the archive packed and stored after the open has returned", async () => {
    await seedSnapshot();
    restoreReads(TEMPLATE_INPUTS, PROJECT_INPUTS);
    const archiving = deferred();
    sandbox.script(ARCHIVE_COMMAND, async () => {
      await archiving.promise;
      return archived();
    });

    const opened = await open();
    // The archive command has been sent by now, but nothing has waited for its answer.
    const duringOpen = calls.slice(0, 4);
    archiving.release();
    if (opened.ok) await opened.value.dependencyCacheWrite;

    expect(duringOpen).toEqual(["create", "writeFileBytes", "exec", "exec"]);
    expect(calls.slice(4)).toEqual(["exec", "readFileBytes", "exec"]);
  });
});

describe("a snapshot that cannot be applied", () => {
  it("falls back to a fresh template with a warning when the bundle is missing", async () => {
    // The row survives; the object does not. An operator deleting a bucket must not make a
    // project unopenable.
    await snapshots.record({ projectId: PROJECT, key: KEY, gitSha: SHA });

    const opened = await open();

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.restored).toBe(false);
    expect(opened.value.warning).toMatch(/snapshot/i);
    expect(opened.value.sandboxId).not.toBe("");
  });

  it("falls back to a fresh template, without installing, when git refuses the bundle", async () => {
    await seedSnapshot(new TextEncoder().encode("not a bundle at all"));
    await seedArchive();
    sandbox.script(RESTORE_COMMAND, { exitCode: 128, stderr: "fatal: not a valid object name" });

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value).toMatchObject({ restored: false, installed: false });
    expect(opened.value.warning).toMatch(/snapshot/i);
    // The tree is the template's, so its dependencies are the template's. An install here would
    // spend a minute reaching the state it is already in.
    expect(commandsMatching(opened.value.sandboxId, /bun install|tar -xzf/)).toEqual([]);
  });
});

describe("failures that must not become an empty project", () => {
  it("fails the open when object storage cannot be reached, and destroys the sandbox it made", async () => {
    await seedSnapshot();
    objects.failWith({ code: "unavailable", message: "R2 is not answering" });

    const opened = await open();

    // Unreachable is not the same as absent. Handing back a template here would let the
    // next teardown overwrite a good snapshot with an empty one. The sandbox was created
    // alongside the read, so it is destroyed rather than left to be billed.
    expect(opened).toMatchObject({ ok: false, error: { reason: "snapshot_unavailable" } });
    expect(sandbox.creates).toBe(1);
    expect(sandbox.destroyed).toEqual([sandbox.lastCreatedId]);
  });

  it("fails the open when the snapshot row cannot be read, and destroys the sandbox it made", async () => {
    snapshots.latestFor = () => Promise.reject(new Error("connection terminated"));

    const opened = await open();

    expect(opened).toMatchObject({ ok: false, error: { reason: "snapshot_unavailable" } });
    expect(sandbox.destroyed).toEqual([sandbox.lastCreatedId]);
  });

  it("reports a sandbox that could not be created", async () => {
    await seedSnapshot();
    sandbox.failCreateWith({ code: "unavailable", message: "no capacity in us-east-1" });

    const opened = await open();

    expect(opened).toMatchObject({
      ok: false,
      error: { reason: "sandbox_unavailable", message: expect.stringContaining("no capacity") },
    });
  });

  it("destroys the sandbox when the open is cancelled while it was being created", async () => {
    await seedSnapshot();
    const controller = new AbortController();
    const creating = deferred();
    sandbox.createGate = creating.promise;

    const opening = open({ signal: controller.signal });
    controller.abort();
    creating.release();

    expect(await opening).toMatchObject({ ok: false, error: { reason: "sandbox_unavailable" } });
    expect(sandbox.destroyed).toEqual([sandbox.lastCreatedId]);
  });
});
