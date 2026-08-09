/**
 * Deleting a project: the sandbox, the bytes, and then the rows.
 *
 * **The order is the entire point, and it is the opposite of teardown's.** Teardown protects
 * the user's work by writing everything down before destroying anything. This is the one
 * operation whose whole purpose is destruction, and what it protects instead is the *ability to
 * finish* — so the rows go last, because they are the only record of which objects exist.
 *
 * Delete the project row first and the snapshot rows go with it by cascade; the bundles in
 * object storage are then unreferenced, unfindable and paid for forever. There is no listing
 * that can recover them: keys are per project, and the project is gone. So:
 *
 *   1. destroy the sandbox, best effort — a sandbox that cannot be reached must not block a
 *      delete, but one nobody destroys keeps billing;
 *   2. read the snapshot rows, which name every object;
 *   3. delete the objects, and **stop here if any of that fails** — the rows still name them,
 *      so the same call can be made again;
 *   4. delete the project, which takes its sessions, events and snapshot rows with it.
 *
 * Step 3 is safe to repeat: `ObjectStore.delete` treats a missing key as success, so a retry
 * after a partial failure finishes the job rather than reporting a new one.
 */

import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { ProjectStore } from "@nap/shared/ports/project-store";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import type { Result } from "@nap/shared/result";

export type DeleteFailureReason =
  /** Object storage refused. Nothing has been removed from the database. */
  | "objects_failed"
  /** The objects are gone but the rows are not; the same call can be repeated. */
  | "rows_failed";

export type DeleteError = { reason: DeleteFailureReason; message: string };

export type DeleteResult = {
  /** False when there was no such project — two clicks, or two tabs. */
  deleted: boolean;
  /** How many objects were removed, so a caller can say what it did. */
  objectsDeleted: number;
  /**
   * Whether the sandbox was destroyed. False means it was already gone *or* could not be
   * reached; the project is deleted either way, and this is what an operator would grep for.
   */
  sandboxDestroyed: boolean;
};

export type DeleteProjectOptions = {
  projects: ProjectStore;
  snapshots: SnapshotStore;
  objects: ObjectStore;
  sandbox: SandboxManager;
  projectId: string;
};

export async function deleteProject(
  options: DeleteProjectOptions,
): Promise<Result<DeleteResult, DeleteError>> {
  const { projects, snapshots, objects, sandbox, projectId } = options;

  const project = await projects.get(projectId);
  if (project === null) {
    return { ok: true, value: { deleted: false, objectsDeleted: 0, sandboxDestroyed: false } };
  }

  // Best effort, and deliberately first: the sandbox holds nothing anybody wants any more, and
  // every second it survives is billed. A failure here is not a reason to keep the project.
  let sandboxDestroyed = false;
  if (project.sandboxId !== null) {
    const destroyed = await sandbox.destroy(project.sandboxId);
    sandboxDestroyed = destroyed.ok;
  }

  const rows = await snapshots.listFor(projectId);

  let objectsDeleted = 0;
  for (const row of rows) {
    const removed = await objects.delete(row.key);
    if (!removed.ok) {
      // Stop before touching the database. The rows are the only thing that knows these keys,
      // and deleting them now would strand every object this loop had not reached.
      return {
        ok: false,
        error: {
          reason: "objects_failed",
          message: `could not delete ${row.key}: ${removed.error.message}`,
        },
      };
    }
    objectsDeleted += 1;
  }

  try {
    const deleted = await projects.delete(projectId);
    return { ok: true, value: { deleted, objectsDeleted, sandboxDestroyed } };
  } catch (error) {
    // The objects are gone and the rows are not, which is the recoverable half of the two:
    // calling this again deletes nothing extra and finishes the job.
    return { ok: false, error: { reason: "rows_failed", message: String(error) } };
  }
}
