/**
 * Taking a project back out: find its snapshot, fetch the bundle, start a sandbox, unpack
 * the repository into it.
 *
 * **The order is the point here too, and it is the reverse of teardown's.** Teardown does
 * everything that can fail *before* the irreversible step; this does everything that can fail
 * *before the expensive one*. Nothing creates a sandbox until the bytes to fill it are in
 * hand, so a storage outage costs nothing and leaves nothing running to be billed for.
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
 *
 * Template sandboxes boot their baked dev server. Imported repositories stop that process
 * and run their owner-configured setup and optional development command after restore.
 */

import { restoreBundle } from "@nap/sandbox/git";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { RepositorySource } from "@nap/shared/ports/repository-workspace";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
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
  /** Whether the restored lockfile differed from the template's, so dependencies were installed. */
  installed: boolean;
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
 * The lockfiles a restored project might carry, either of which decides whether the baked
 * `node_modules` still matches. Both names, because which one Bun writes depends on its
 * version, and a project restored from an older snapshot may carry the other.
 */
const LOCKFILES = ["bun.lock", "bun.lockb"] as const;

const MISSING_SNAPSHOT_WARNING =
  "Couldn't restore this project's last snapshot — it isn't in storage any more. " +
  "Starting from a fresh template.";

const UNREADABLE_SNAPSHOT_WARNING =
  "Couldn't restore this project's last snapshot — the archive could not be read. " +
  "Starting from a fresh template.";

const INSTALL_FAILED_WARNING =
  "Restored this project, but installing its dependencies failed. " +
  "The preview may not build until they install successfully.";

export async function openProject(
  options: OpenProjectOptions,
): Promise<Result<OpenedProject, OpenError>> {
  const { sandbox, objects, snapshots, projectId } = options;
  if (options.signal?.aborted)
    return fail("sandbox_unavailable", "Opening this workspace was cancelled.");

  let snapshot: Awaited<ReturnType<SnapshotStore["latestFor"]>>;
  try {
    snapshot = await snapshots.latestFor(projectId);
  } catch (error) {
    // Thrown rather than returned by this port, the same way `record` is — a database that
    // cannot be reached is not an outcome `SnapshotStore` models.
    return fail("snapshot_unavailable", `could not look up the snapshot: ${String(error)}`);
  }

  // Fetched before anything is created: a failure here should cost nothing.
  let bytes: Uint8Array | null = null;
  let warning: string | null = null;

  if (snapshot !== null) {
    const fetched = await objects.get(snapshot.key);
    if (fetched.ok) {
      bytes = fetched.value;
    } else if (fetched.error.code === "not_found") {
      if (options.source !== undefined)
        return fail(
          "snapshot_unavailable",
          "The repository snapshot is missing. Its workspace was not replaced.",
        );
      warning = MISSING_SNAPSHOT_WARNING;
    } else {
      return fail(
        "snapshot_unavailable",
        `could not read the snapshot at ${snapshot.key}: ${fetched.error.message}`,
      );
    }
  }

  if (snapshot === null && options.source !== undefined) {
    const initial = await options.source.initialBundle();
    if (!initial.ok) return fail("snapshot_unavailable", initial.error.message);
    bytes = initial.value;
  }
  if (options.signal?.aborted)
    return fail("sandbox_unavailable", "Opening this workspace was cancelled.");

  const created = await sandbox.create(projectId);
  if (!created.ok) {
    return fail("sandbox_unavailable", `could not create a sandbox: ${created.error.message}`);
  }
  const sandboxId = created.value.id;
  options.onCreated?.(sandboxId);

  if (bytes === null) {
    return { ok: true, value: { sandboxId, restored: false, warning, installed: false } };
  }

  try {
    // Read before the restore, so what is compared afterwards is the template's lockfile
    // against the project's rather than against itself.
    const lockBefore = await lockfileFingerprint(sandbox, sandboxId);

    if (options.source !== undefined) {
      const cleared = await sandbox.exec(sandboxId, `cd ${TEMPLATE_WORKDIR} && git clean -fdx`);
      if (!cleared.ok || cleared.value.exitCode !== 0) {
        await sandbox.destroy(sandboxId);
        return fail("sandbox_unavailable", "Could not prepare an empty repository environment.");
      }
    }
    const restored = await restoreBundle(sandbox, sandboxId, bytes, { signal: options.signal });
    if (!restored.ok) {
      if (options.source !== undefined || options.signal?.aborted) {
        await sandbox.destroy(sandboxId);
        return fail(
          "snapshot_unavailable",
          "The repository snapshot could not be restored. Saved work was not replaced.",
        );
      }
      // The sandbox keeps the template's contents, which is a working project — just not the
      // one that was asked for. No install: this tree is the one the image was built with.
      return {
        ok: true,
        value: {
          sandboxId,
          restored: false,
          warning: UNREADABLE_SNAPSHOT_WARNING,
          installed: false,
        },
      };
    }

    if (options.source !== undefined) {
      const configured = await prepareRepositoryEnvironment({
        sandbox,
        sandboxId,
        source: options.source,
        signal: options.signal,
      });
      if (!configured.ok) {
        await sandbox.destroy(sandboxId);
        return fail("sandbox_unavailable", configured.error.message);
      }
      // Preserve the imported ref before a job can move it. Later opens never re-import it.
      if (snapshot === null) {
        const captured = await captureSnapshot({
          sandbox,
          sandboxId,
          objects,
          snapshots,
          projectId,
        });
        if (!captured.ok) {
          await sandbox.destroy(sandboxId);
          return fail(
            "snapshot_unavailable",
            "The imported repository could not be saved. Try importing again.",
          );
        }
      }
      return {
        ok: true,
        value: {
          sandboxId,
          restored: true,
          warning: null,
          installed: options.source.setupCommand !== null,
        },
      };
    }

    const lockAfter = await lockfileFingerprint(sandbox, sandboxId);
    if (lockAfter === lockBefore) {
      // The baked `node_modules` still matches, which is the whole reason opening a project is
      // seconds rather than a minute.
      return { ok: true, value: { sandboxId, restored: true, warning: null, installed: false } };
    }

    const installed = await sandbox.exec(sandboxId, `cd ${TEMPLATE_WORKDIR} && bun install`);
    if (!installed.ok || installed.value.exitCode !== 0) {
      return {
        ok: true,
        value: { sandboxId, restored: true, warning: INSTALL_FAILED_WARNING, installed: false },
      };
    }

    return { ok: true, value: { sandboxId, restored: true, warning: null, installed: true } };
  } catch (error) {
    if (options.source === undefined) throw error;
    await sandbox.destroy(sandboxId).catch(() => {});
    return fail(
      "sandbox_unavailable",
      "Could not prepare the repository workspace. Its saved snapshot was preserved.",
    );
  }
}

/**
 * The lockfiles as one string, so "did the dependencies move?" is a single comparison.
 *
 * A missing file reads as empty rather than failing: a project that gains a lockfile it did
 * not have is exactly the change this is looking for.
 */
async function lockfileFingerprint(sandbox: SandboxManager, sandboxId: string): Promise<string> {
  const parts: string[] = [];

  for (const name of LOCKFILES) {
    const read = await sandbox.readFile(sandboxId, `${TEMPLATE_WORKDIR}/${name}`);
    parts.push(read.ok ? read.value : "");
  }

  return parts.join("\0");
}

function fail(reason: OpenFailureReason, message: string): Result<never, OpenError> {
  return { ok: false, error: { reason, message } };
}
