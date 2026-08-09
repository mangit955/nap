/**
 * Putting one project away: snapshot it, destroy its sandbox, and record that it has none.
 *
 * This is the whole operation the reaper performs on a timer, lifted out so that a person can
 * ask for it too — "close" on a project they have finished with. Both callers get the same
 * three outcomes and the same rules, which is the point of it being one function: a second
 * copy of this sequence would drift on exactly the details below.
 *
 * The ordering rule belongs to `tearDownProject` and is not restated here. What this adds is
 * the bookkeeping afterwards, and the one distinction that is easy to get wrong:
 *
 *   - **A sandbox that is already gone is not a failure.** Providers reclaim sandboxes on their
 *     own timers, so a row outlives the thing it names. Retrying achieves nothing, forever, so
 *     the reference is dropped — with a **null** key, because no new snapshot was taken and the
 *     one already recorded may be the last copy of the project in existence.
 *   - **Anything else leaves the project pointing at its sandbox.** The sandbox is untouched and
 *     still holds the only current copy of the work; losing track of it would mean a sandbox
 *     nobody can find and nobody stops paying for.
 */

import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { ProjectSandboxStore } from "@nap/shared/ports/project-sandbox-store";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import { tearDownProject } from "./teardown.ts";

export type CloseOutcome =
  /** Snapshotted, destroyed, and the project now points at the bundle. */
  | { outcome: "put_away"; key: string }
  /** The sandbox had already gone; the reference was dropped and nothing was captured. */
  | { outcome: "abandoned" }
  /** Nothing changed. Worth trying again later. */
  | { outcome: "failed"; reason: string; message: string };

export type CloseProjectOptions = {
  projects: ProjectSandboxStore;
  sandbox: SandboxManager;
  objects: ObjectStore;
  snapshots: SnapshotStore;
  projectId: string;
  sandboxId: string;
};

export async function putProjectAway(options: CloseProjectOptions): Promise<CloseOutcome> {
  const { projects, projectId, sandboxId } = options;

  const torn = await tearDownProject({
    sandbox: options.sandbox,
    objects: options.objects,
    snapshots: options.snapshots,
    projectId,
    sandboxId,
  });

  if (!torn.ok && torn.error.reason === "sandbox_gone") {
    return release(projects, projectId, null, () => ({ outcome: "abandoned" }));
  }

  if (!torn.ok) {
    return { outcome: "failed", reason: torn.error.reason, message: torn.error.message };
  }

  return release(projects, projectId, torn.value.key, () => ({
    outcome: "put_away",
    key: torn.value.key,
  }));
}

/**
 * The bookkeeping half, which can fail on its own.
 *
 * A failure here leaves a snapshot that is safe and a sandbox that is gone, with only the row
 * behind — so the next turn fails to resume and restores from that snapshot, reaching the same
 * place by a slower road. It is still reported, because a database that cannot be written to is
 * not something to discover later.
 */
async function release(
  projects: ProjectSandboxStore,
  projectId: string,
  key: string | null,
  onSuccess: () => CloseOutcome,
): Promise<CloseOutcome> {
  try {
    await projects.releaseSandbox(projectId, key);
    return onSuccess();
  } catch (error) {
    return { outcome: "failed", reason: "release_failed", message: String(error) };
  }
}
