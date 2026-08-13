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

import { getLogger } from "@nap/shared/logging";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore, PendingEvent } from "@nap/shared/ports/event-store";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { ProjectSandboxStore } from "@nap/shared/ports/project-sandbox-store";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import { EventSink } from "./event-sink.ts";
import { tearDownProject } from "./teardown.ts";

export type CloseOutcome =
  /** Snapshotted, destroyed, and the project now points at the bundle. */
  | { outcome: "put_away"; key: string }
  /** The sandbox had already gone; the reference was dropped and nothing was captured. */
  | { outcome: "abandoned" }
  /** Nothing changed. Worth trying again later. */
  | { outcome: "failed"; reason: string; message: string };

/**
 * Where to say that the preview has gone, and to whom.
 *
 * Optional so that a caller with no event log — the tests of the sequence itself — still gets
 * the sequence. Every session in the project, because the sandbox belonged to the project they
 * share: a tab open on one conversation is showing the same address as a tab open on another,
 * and it has just stopped answering for both.
 */
export type CloseAnnouncement = {
  events: EventStore;
  bus: EventBus;
  sessionIds: string[];
  /** Injected so a test can assert on whole events rather than on everything but the clock. */
  now?: () => string;
};

export type CloseProjectOptions = {
  projects: ProjectSandboxStore;
  sandbox: SandboxManager;
  objects: ObjectStore;
  snapshots: SnapshotStore;
  projectId: string;
  sandboxId: string;
  announce?: CloseAnnouncement;
};

/**
 * Closing deliberately does not take another thumbnail. A completed turn has already captured
 * the current app, and waiting for a browser at this point could hold the close request for
 * eighteen seconds before teardown even starts. The dashboard needs the sandbox gone promptly;
 * its existing thumbnail remains the project's shelf image.
 */
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
    const outcome = await release(projects, projectId, null, () => ({ outcome: "abandoned" }));
    await announceStopped(options);
    return outcome;
  }

  // The one path that leaves the sandbox serving. Announcing here would empty every open
  // preview pane over a snapshot upload the user never asked about, and the app is still up.
  if (!torn.ok) {
    return { outcome: "failed", reason: torn.error.reason, message: torn.error.message };
  }

  const outcome = await release(projects, projectId, torn.value.key, () => ({
    outcome: "put_away",
    key: torn.value.key,
  }));
  await announceStopped(options);
  return outcome;
}

/**
 * Tells every session in the project that its preview has stopped answering.
 *
 * Keyed to the destroy rather than to the bookkeeping: by the time this is called the sandbox
 * is gone, whether or not the row managed to say so. A pane left pointing at it renders the
 * provider's own "not found" page inside a frame that otherwise looks like a working app,
 * which is a worse lie than a row that is briefly out of date.
 *
 * **A failure here never fails the close.** The sandbox is destroyed and the snapshot is safe;
 * reporting a `failed` outcome would invite a caller to run the whole sequence again against a
 * sandbox that no longer exists. The clients that missed the event find out when they
 * reconnect, since the append is the same log they replay from.
 */
async function announceStopped(options: CloseProjectOptions): Promise<void> {
  const { announce } = options;
  if (announce === undefined) return;

  const sink = new EventSink(announce.events, announce.bus);
  const createdAt = (announce.now ?? (() => new Date().toISOString()))();
  // Every lifecycle event needs a turn id it cannot have — no turn ran. Nothing joins on the
  // column, and one id per close keeps the events of a single close identifiable together.
  const turnId = crypto.randomUUID();

  for (const sessionId of announce.sessionIds) {
    sink.emit({
      type: "preview.stopped",
      payload: {},
      sessionId,
      turnId,
      createdAt,
    } as PendingEvent);
  }

  try {
    await sink.drain();
  } catch (error) {
    getLogger().warn(
      { projectId: options.projectId, err: error },
      "could not announce that the preview stopped; open tabs will find out when they reconnect",
    );
  }
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
