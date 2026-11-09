/**
 * Taking a project back out: find its snapshot, fetch the bundle, start a sandbox, unpack
 * the repository into it, and put back the dependencies it had.
 *
 * **What can overlap does.** The snapshot row, the bundle and the project's dependency archive are
 * read while the sandbox is being created, and the archive is uploaded while the repository is
 * being restored. A storage failure therefore now costs a sandbox that is created and destroyed at
 * once, where it used to cost nothing. That was the price of a reopen no longer waiting for the
 * reads and the create one after another, and the reasoning is in ADR-0032.
 *
 * The judgement call this file exists to make is which failures fall back and which stop:
 *
 *   - **No snapshot at all** is the ordinary state of a new project. Fresh template, no
 *     warning — warning about it would teach people to ignore the warning that matters.
 *   - **A snapshot that is missing or that git refuses** falls back to a fresh template and
 *     says so. The alternative is an error page in place of a project, and the work is
 *     already gone either way; what is left is telling the truth about it.
 *   - **Storage or the database being unreachable** fails the open. "Not there" and "cannot
 *     tell" are different: handing back an empty template on a transient outage invites the
 *     next teardown to overwrite a good snapshot with nothing.
 *   - **The dependency archive is a cache**, so every way it can fail — absent, unreachable,
 *     stale, unreadable, refused by tar — is a miss, and a miss installs. Only the archive whose
 *     key is exactly the restored tree's is ever extracted.
 *
 * Template sandboxes boot their baked dev server. Imported repositories stop that process
 * and run their owner-configured setup and optional development command after restore.
 */

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
} from "@nap/sandbox/dependency-cache";
import { restoreBundle } from "@nap/sandbox/git";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { RESTORE_INSTALL_TIMEOUT_MS } from "@nap/shared/command-windows";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { RepositorySource } from "@nap/shared/ports/repository-workspace";
import type { Sandbox, SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SnapshotRecord, SnapshotStore } from "@nap/shared/ports/snapshot-store";
import type { Result } from "@nap/shared/result";
import { prepareRepositoryEnvironment } from "./repository-environment.ts";
import { captureSnapshot } from "./teardown.ts";

export type OpenFailureReason =
  /** No sandbox could be started, so there is nowhere to put the project. */
  | "sandbox_unavailable"
  /** The snapshot might exist and might not — storage could not say. */
  | "snapshot_unavailable";

export type OpenError = {
  reason: OpenFailureReason;
  message: string;
};

export type OpenedProject = {
  sandboxId: string;
  /** False when the project came up as a bare template — no snapshot, or an unusable one. */
  restored: boolean;
  /**
   * What to tell the user, when something they would notice went wrong but the project is
   * still usable. Null on the ordinary paths, including a first open with no snapshot.
   */
  warning: string | null;
  /** Whether this open ran an install: the project's own setup, or `bun install` on a cache miss. */
  installed: boolean;
  /** Whether the project's dependencies were extracted from its stored archive. */
  cachedDependencies: boolean;
  /**
   * The archive this open is storing for the next one, after an install made one worth storing:
   * true once it is in object storage, false if it was not stored. Never rejects.
   *
   * Nothing in production waits for it, because the whole point is that the user does not: it
   * packs and uploads while the turn that asked for the open is running. It is here so a test can.
   */
  dependencyCacheWrite?: Promise<boolean>;
};

export type OpenProjectOptions = {
  sandbox: SandboxManager;
  objects: ObjectStore;
  snapshots: SnapshotStore;
  projectId: string;
  source?: RepositorySource;
  signal?: AbortSignal | undefined;
  /**
   * Told the sandbox's id the moment it exists, before anything slow runs in it. Whoever is
   * accounting for the sandbox needs to know it is real while the restore and setup are still
   * going; nothing here waits on the answer.
   */
  onCreated?: (sandboxId: string) => void;
};

/**
 * Where a project's dependency archive lives: one object per project, replaced whenever a reopen
 * installs a different set. Derived from the id, so a delete needs no row to find it, and so the
 * cache can never hold more than one archive for a project however often its lockfile changes.
 */
export function dependenciesKey(projectId: string): string {
  return `projects/${projectId}/dependencies.tar.gz`;
}

/**
 * The most an archive may weigh and still be stored. It bounds what one reopen holds in memory and
 * downloads; a project over it installs on every reopen, as every project did before the cache.
 * The template's own dependencies packed to 33 MB when measured on a developer's machine.
 */
export const MAX_DEPENDENCY_ARCHIVE_BYTES = 128 * 1024 * 1024;

const MISSING_SNAPSHOT_WARNING =
  "Couldn't restore this project's last snapshot — it isn't in storage any more. " +
  "Starting from a fresh template.";

const UNREADABLE_SNAPSHOT_WARNING =
  "Couldn't restore this project's last snapshot — the archive could not be read. " +
  "Starting from a fresh template.";

const INSTALL_FAILED_WARNING =
  "Restored this project, but installing its dependencies failed. " +
  "The preview may not build until they install successfully.";

const CANCELLED = "Opening this workspace was cancelled.";

/** What a snapshot fetch found: the bytes to restore, or none, and what to say about it. */
type Fetched = {
  snapshot: SnapshotRecord | null;
  bytes: Uint8Array | null;
  warning: string | null;
};

/** A stored dependency archive, read but not yet known to fit. */
type StoredArchive = { key: string; archive: Uint8Array };

export async function openProject(
  options: OpenProjectOptions,
): Promise<Result<OpenedProject, OpenError>> {
  const { sandbox, objects, projectId } = options;
  if (options.signal?.aborted) return fail("sandbox_unavailable", CANCELLED);

  // A template project's reads start beside the create, which is the slow one, and finish inside
  // it. An imported repository's first bundle can wait minutes behind the broker's transfer slots,
  // and a sandbox created beside that wait would be billed for it and could outlive its own
  // deadline, so there the bytes still come first.
  const fetching = fetchSnapshot(options);
  const archiving =
    options.source === undefined ? fetchArchive(objects, projectId) : Promise.resolve(null);
  const early = options.source === undefined ? createSandbox(options) : null;
  const fetched = await fetching;
  const ready = fetched.ok && !options.signal?.aborted;
  const created = early !== null ? await early : ready ? await createSandbox(options) : null;

  if (!fetched.ok || !ready) {
    if (created?.ok) await sandbox.destroy(created.value.id).catch(() => {});
    return fetched.ok ? fail("sandbox_unavailable", CANCELLED) : fetched;
  }
  if (created === null || !created.ok) {
    const reason = created?.ok === false ? created.error.message : CANCELLED;
    return fail("sandbox_unavailable", `could not create a sandbox: ${reason}`);
  }
  const sandboxId = created.value.id;
  const { snapshot, bytes, warning } = fetched.value;

  if (bytes === null) {
    return opened(sandboxId, { restored: false, warning });
  }
  if (options.source !== undefined) {
    return await restoreRepository(options, options.source, sandboxId, snapshot, bytes);
  }

  // Uploaded beside the restore, before anyone knows whether it fits: on a reopen that needs it,
  // that takes the upload off the critical path, and a reopen that does not is rare.
  const staging = archiving.then(async (stored) => {
    if (stored === null) return null;
    const staged = await stageDependencyArchive(sandbox, sandboxId, stored.archive);
    return staged.ok ? stored.key : null;
  });
  const restored = await restoreBundle(sandbox, sandboxId, bytes, {
    signal: options.signal,
    probe: DEPENDENCY_KEY_PROBE,
  });
  const stagedKey = await staging;

  if (!restored.ok) {
    if (options.signal?.aborted) {
      await sandbox.destroy(sandboxId);
      return fail("snapshot_unavailable", CANCELLED);
    }
    // The sandbox keeps the template's contents, which is a working project — just not the
    // one that was asked for. No install: this tree is the one the image was built with.
    return opened(sandboxId, { restored: false, warning: UNREADABLE_SNAPSHOT_WARNING });
  }

  // Read on the template's tree and the project's, inside the restore's own command. Equal, the
  // baked `node_modules` is already the project's, which is why most reopens take seconds. Not
  // read at all, nothing can be shown to match, and the install below is the safe answer.
  const template = readDependencyKey(restored.value.probe?.before ?? "");
  const project = readDependencyKey(restored.value.probe?.after ?? "");
  if (template !== null && template === project) {
    return opened(sandboxId, { restored: true });
  }

  const key = template !== null && project !== null ? dependencyCacheKey(template, project) : null;
  if (key !== null && stagedKey === key) {
    const extracted = await extractDependencies(sandbox, sandboxId);
    if (extracted.ok) return opened(sandboxId, { restored: true, cachedDependencies: true });
  }

  const installed = await installDependencies(sandbox, sandboxId, {
    signal: options.signal,
    timeoutMs: RESTORE_INSTALL_TIMEOUT_MS,
  });
  if (!installed.ok || installed.value.exitCode !== 0) {
    return opened(sandboxId, { restored: true, warning: INSTALL_FAILED_WARNING });
  }

  // Stored only when the install was decided by the committed inputs alone — it read the same key
  // afterwards — and the open was not abandoned on the way.
  if (key === null || installed.value.key !== project || options.signal?.aborted) {
    return opened(sandboxId, { restored: true, installed: true });
  }
  return {
    ok: true,
    value: {
      ...opened(sandboxId, { restored: true, installed: true }).value,
      dependencyCacheWrite: storeArchive(sandbox, sandboxId, objects, projectId, key),
    },
  };
}

/** The create, reported to `onCreated` the moment it exists, whatever happens beside it. */
async function createSandbox(options: OpenProjectOptions): Promise<Result<Sandbox, SandboxError>> {
  const created = await options.sandbox.create(options.projectId);
  if (created.ok) options.onCreated?.(created.value.id);
  return created;
}

/** The newest snapshot's bytes, an imported repository's first bundle, or nothing to restore. */
async function fetchSnapshot(options: OpenProjectOptions): Promise<Result<Fetched, OpenError>> {
  let snapshot: SnapshotRecord | null;
  try {
    snapshot = await options.snapshots.latestFor(options.projectId);
  } catch (error) {
    // Thrown rather than returned by this port, the same way `record` is — a database that
    // cannot be reached is not an outcome `SnapshotStore` models.
    return fail("snapshot_unavailable", `could not look up the snapshot: ${String(error)}`);
  }

  if (snapshot !== null) {
    const fetched = await options.objects.get(snapshot.key);
    if (fetched.ok) return { ok: true, value: { snapshot, bytes: fetched.value, warning: null } };
    if (fetched.error.code !== "not_found") {
      return fail(
        "snapshot_unavailable",
        `could not read the snapshot at ${snapshot.key}: ${fetched.error.message}`,
      );
    }
    if (options.source !== undefined) {
      return fail(
        "snapshot_unavailable",
        "The repository snapshot is missing. Its workspace was not replaced.",
      );
    }
    return { ok: true, value: { snapshot, bytes: null, warning: MISSING_SNAPSHOT_WARNING } };
  }

  if (options.source === undefined) {
    return { ok: true, value: { snapshot, bytes: null, warning: null } };
  }
  try {
    const initial = await options.source.initialBundle();
    if (!initial.ok) return fail("snapshot_unavailable", initial.error.message);
    return { ok: true, value: { snapshot, bytes: initial.value, warning: null } };
  } catch (error) {
    // Caught here because a create is in flight beside this, and a throw would strand it.
    return fail("snapshot_unavailable", `could not import the repository: ${String(error)}`);
  }
}

/** The project's stored archive, or null for every way it might not be one. Never rejects. */
async function fetchArchive(
  objects: ObjectStore,
  projectId: string,
): Promise<StoredArchive | null> {
  try {
    const fetched = await objects.get(dependenciesKey(projectId));
    return fetched.ok ? decodeDependencyArchive(fetched.value) : null;
  } catch {
    return null;
  }
}

/** Packs the dependencies an install just left and stores them for the next reopen. Never rejects. */
async function storeArchive(
  sandbox: SandboxManager,
  sandboxId: string,
  objects: ObjectStore,
  projectId: string,
  key: string,
): Promise<boolean> {
  try {
    const archive = await archiveDependencies(sandbox, sandboxId, {
      maxBytes: MAX_DEPENDENCY_ARCHIVE_BYTES,
    });
    if (!archive.ok) return false;
    const stored = await objects.put(
      dependenciesKey(projectId),
      encodeDependencyArchive(key, archive.value),
    );
    return stored.ok;
  } catch {
    return false;
  }
}

/** An imported repository: cleared, restored, and set up by its owner's own command. */
async function restoreRepository(
  options: OpenProjectOptions,
  source: RepositorySource,
  sandboxId: string,
  snapshot: SnapshotRecord | null,
  bytes: Uint8Array,
): Promise<Result<OpenedProject, OpenError>> {
  const { sandbox, objects, snapshots, projectId } = options;
  try {
    const cleared = await sandbox.exec(sandboxId, `cd ${TEMPLATE_WORKDIR} && git clean -fdx`);
    if (!cleared.ok || cleared.value.exitCode !== 0) {
      await sandbox.destroy(sandboxId);
      return fail("sandbox_unavailable", "Could not prepare an empty repository environment.");
    }
    const restored = await restoreBundle(sandbox, sandboxId, bytes, { signal: options.signal });
    if (!restored.ok) {
      await sandbox.destroy(sandboxId);
      return fail(
        "snapshot_unavailable",
        "The repository snapshot could not be restored. Saved work was not replaced.",
      );
    }

    const configured = await prepareRepositoryEnvironment({
      sandbox,
      sandboxId,
      source,
      signal: options.signal,
    });
    if (!configured.ok) {
      await sandbox.destroy(sandboxId);
      return fail("sandbox_unavailable", configured.error.message);
    }
    // Preserve the imported ref before a job can move it. Later opens never re-import it.
    if (snapshot === null) {
      const captured = await captureSnapshot({ sandbox, sandboxId, objects, snapshots, projectId });
      if (!captured.ok) {
        await sandbox.destroy(sandboxId);
        return fail(
          "snapshot_unavailable",
          "The imported repository could not be saved. Try importing again.",
        );
      }
    }
    return opened(sandboxId, { restored: true, installed: source.setupCommand !== null });
  } catch {
    await sandbox.destroy(sandboxId).catch(() => {});
    return fail(
      "sandbox_unavailable",
      "Could not prepare the repository workspace. Its saved snapshot was preserved.",
    );
  }
}

function opened(
  sandboxId: string,
  outcome: Partial<Omit<OpenedProject, "sandboxId" | "dependencyCacheWrite">>,
): { ok: true; value: OpenedProject } {
  return {
    ok: true,
    value: {
      sandboxId,
      restored: false,
      warning: null,
      installed: false,
      cachedDependencies: false,
      ...outcome,
    },
  };
}

function fail(reason: OpenFailureReason, message: string): Result<never, OpenError> {
  return { ok: false, error: { reason, message } };
}
