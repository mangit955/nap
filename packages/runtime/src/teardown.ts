/**
 * Putting a project away: bundle the repository, upload it, write the row, destroy the sandbox.
 *
 * **The order is the entire point of this file.** A sandbox holds the only copy of the user's
 * work — it is not backed by anything until this runs — so every step that could fail happens
 * *before* the irreversible one. Destroy first and a transient R2 outage silently deletes a
 * project; the user opens it later and finds an empty template, with nothing in any log
 * saying why.
 *
 * The same reasoning explains the two things this deliberately does not do. A failed row write
 * leaves the uploaded object in place rather than cleaning it up: an operator can find an
 * orphaned object, and nobody can find a deleted one. And nothing here retries — the sandbox
 * is still alive and still holds the project, so the honest answer is to report the failure
 * and let whatever asked for the teardown decide whether to try again.
 *
 * It lives in the runtime package because it coordinates the sandbox, object storage and the
 * database, and coordinating is what this layer is for. What it must never grow is knowledge
 * of *when* to tear down — that belongs to the reaper and to project close.
 */

import { bundle, currentSha } from "@nap/sandbox/git";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import type { Result } from "@nap/shared/result";

export type TeardownFailureReason =
  /**
   * The sandbox no longer exists, so there is nothing left to snapshot.
   *
   * Distinct from every other failure because it is the one that will never succeed on a
   * retry. A caller sweeping projects has to stop trying and write the sandbox off, or it
   * spends every tick from now on tearing down something that is already gone.
   */
  | "sandbox_gone"
  /** The repository could not be read or bundled; the sandbox itself is reachable. */
  | "bundle_failed"
  /** Object storage refused the bytes. */
  | "upload_failed"
  /** The bytes are stored, but nothing points at them yet. */
  | "record_failed";

export type TeardownError = {
  reason: TeardownFailureReason;
  message: string;
};

export type TeardownResult = {
  /** Where the bundle went, so a caller can log it or restore from it immediately. */
  key: string;
  gitSha: string;
  /**
   * Whether the sandbox is actually gone. False means the snapshot is safe but the sandbox
   * outlived it — which is a billing problem for whoever runs next, not a failed teardown.
   */
  destroyed: boolean;
  /** Every close captures refs as well as HEAD, even if the current commit did not move. */
  captured: true;
};

/** What `captureSnapshot` needs — a teardown minus the part that destroys anything. */
export type CaptureOptions = {
  sandbox: SandboxManager;
  objects: ObjectStore;
  snapshots: SnapshotStore;
  projectId: string;
  sandboxId: string;
  now?: () => number;
};

export type TearDownOptions = {
  sandbox: SandboxManager;
  objects: ObjectStore;
  snapshots: SnapshotStore;
  projectId: string;
  sandboxId: string;
  /** The timestamp recorded in the object key. */
  now?: () => number;
};

/**
 * Where a project's snapshot lives.
 *
 * Prefixed per project so deleting one is bounded. Each capture gets its own random identity,
 * including two captures at the same SHA within one millisecond.
 */
export function snapshotKey(projectId: string, gitSha: string, at: number): string {
  return `projects/${projectId}/${at}-${gitSha}-${crypto.randomUUID()}.bundle`;
}

/**
 * Everything a teardown does except destroy the sandbox: bundle the repository, upload it,
 * write the row.
 *
 * Split out because the same three steps are what a *turn* needs at the point it commits. Until
 * that existed, a project's work reached storage only when someone closed it or the reaper swept
 * it — so a process that died with a live sandbox left the provider's own timer to delete the
 * only copy. Snapshotting while the sandbox keeps running is the whole difference.
 *
 * The ordering rule at the top of this file is this function's, not `tearDownProject`'s. What
 * that one adds is the irreversible step, which is why it comes last and why it comes after.
 */
export async function captureSnapshot(
  options: CaptureOptions,
): Promise<Result<{ key: string; gitSha: string }, TeardownError>> {
  const { sandbox, sandboxId } = options;
  const now = options.now ?? Date.now;

  const sha = await currentSha(sandbox, sandboxId);
  if (!sha.ok) {
    return fail(reasonFor(sha.error), `could not read HEAD: ${sha.error.message}`);
  }

  const captured = await captureAt(options, sha.value, now);
  if (!captured.ok) return captured;

  return { ok: true, value: { key: captured.value.key, gitSha: sha.value } };
}

export async function tearDownProject(
  options: TearDownOptions,
): Promise<Result<TeardownResult, TeardownError>> {
  const { sandbox, sandboxId } = options;
  const now = options.now ?? Date.now;

  const sha = await currentSha(sandbox, sandboxId);
  if (!sha.ok) {
    return fail(reasonFor(sha.error), `could not read HEAD: ${sha.error.message}`);
  }

  // HEAD alone cannot identify a snapshot: another ref or the current branch can change
  // at the same commit. Capture all refs and exact HEAD on every close.
  const captured = await captureAt(options, sha.value, now);
  if (!captured.ok) return captured;

  // Only now is the sandbox expendable.
  const destroyed = await sandbox.destroy(sandboxId);

  return {
    ok: true,
    value: { key: captured.value.key, gitSha: sha.value, destroyed: destroyed.ok, captured: true },
  };
}

/**
 * Bundle, upload, record — the part where the project's bytes actually become durable.
 *
 * Takes the sha rather than reading it, because both callers have already had to read it and a
 * second read could legitimately return something different.
 */
async function captureAt(
  options: CaptureOptions,
  gitSha: string,
  now: () => number,
): Promise<Result<{ key: string }, TeardownError>> {
  const { sandbox, objects, snapshots, projectId, sandboxId } = options;

  const bytes = await bundle(sandbox, sandboxId);
  if (!bytes.ok) {
    return fail(reasonFor(bytes.error), `could not bundle the repository: ${bytes.error.message}`);
  }

  const key = snapshotKey(projectId, gitSha, now());

  const uploaded = await objects.put(key, bytes.value);
  if (!uploaded.ok) {
    // Nothing has been written down and nothing has been destroyed, so the project is exactly
    // as it was. This is the guard the whole ordering exists for.
    return fail("upload_failed", `could not upload the snapshot: ${uploaded.error.message}`);
  }

  try {
    await snapshots.record({ projectId, key, gitSha });
  } catch (error) {
    // The object stays. See the note at the top: an orphan is recoverable, a deletion is not.
    return fail("record_failed", `could not record the snapshot: ${String(error)}`);
  }

  return { ok: true, value: { key } };
}

/**
 * Whether the sandbox answered at all.
 *
 * A command that ran and failed is a project problem worth retrying; a sandbox that is not
 * there is a fact that will not change.
 */
function reasonFor(error: SandboxError): TeardownFailureReason {
  return error.code === "not_found" || error.code === "destroyed"
    ? "sandbox_gone"
    : "bundle_failed";
}

function fail(reason: TeardownFailureReason, message: string): Result<never, TeardownError> {
  return { ok: false, error: { reason, message } };
}
