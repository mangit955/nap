/**
 * The sandbox a session's project is served from, resumed if there is one already.
 *
 * Four paths, and the order they are tried in is the whole of it: resume what is recorded, restore
 * what is recorded but gone, open what was never opened. Its own module rather than a private
 * method because the interesting path — a recorded sandbox that will not come back — is one no
 * test could reach without booting a whole runtime, and it is the path where a mistake loses
 * somebody's work rather than merely failing their turn.
 */

import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import type { Result } from "@nap/shared/result";
import { openProject } from "./restore.ts";

/** A sandbox to work in, whether this call created it, and anything the user should be told. */
export type AcquiredSandbox = {
  id: string;
  created: boolean;
  notices: { level: "info" | "warning"; text: string }[];
};

/**
 * What a project is restored from. Both halves or neither: the bytes live in one and the record of
 * which bytes in the other, and one without the other cannot open anything.
 */
export type RestoreDeps = { objects: ObjectStore; snapshots: SnapshotStore };

export type AcquireOptions = {
  sandbox: SandboxManager;
  sessions: SessionStore;
  /** `null` when this deployment cannot restore, in which case a lost sandbox is fatal to the turn. */
  restore: RestoreDeps | null;
  /** How long to push a resumed sandbox's deadline out by. */
  ttlMs: number;
};

export const LOST_SANDBOX_WARNING =
  "This project's sandbox was no longer available, so it was restored from its last " +
  "snapshot. Anything changed since then is not in it.";

export async function acquireSandbox(
  options: AcquireOptions,
  session: SessionRecord,
): Promise<Result<AcquiredSandbox, SandboxError>> {
  if (session.sandboxId === null) return await open(options, session);

  const resumed = await options.sandbox.resume(session.sandboxId);
  if (resumed.ok) {
    // Every provider kills a sandbox on a timer that starts when it was created, not when it was
    // last used, so a conversation that runs longer than the budget would lose its workspace
    // mid-sentence. A turn is exactly the signal that someone is still here. The result is
    // deliberately not checked: the sandbox has just answered a resume, and failing a turn over a
    // keepalive would trade a small risk for a certain outage.
    await options.sandbox.extendTimeout(resumed.value.id, options.ttlMs);
    return { ok: true, value: { id: resumed.value.id, created: false, notices: [] } };
  }

  // Nowhere to restore from: a fresh sandbox would be an empty template, and the user would be
  // told their turn succeeded while looking at a project with their work missing.
  if (options.restore === null) return resumed;

  const reopened = await open(options, session);
  if (!reopened.ok) return reopened;

  // First, because it changes what every notice after it means: the project is back, and anything
  // since the last snapshot is not.
  reopened.value.notices.unshift({ level: "warning", text: LOST_SANDBOX_WARNING });
  return reopened;
}

/** A new sandbox for this session's project, holding whatever could be restored into it. */
async function open(
  options: AcquireOptions,
  session: SessionRecord,
): Promise<Result<AcquiredSandbox, SandboxError>> {
  if (options.restore === null) {
    const created = await options.sandbox.create(session.projectId);
    if (!created.ok) return created;

    await options.sessions.setSandboxId(session.sessionId, created.value.id);
    return { ok: true, value: { id: created.value.id, created: true, notices: [] } };
  }

  const opened = await openProject({
    sandbox: options.sandbox,
    objects: options.restore.objects,
    snapshots: options.restore.snapshots,
    projectId: session.projectId,
  });
  if (!opened.ok) {
    // Flattened to the one code a turn can report. The distinction between "no sandbox" and "no
    // snapshot" matters to whoever reads the message, not to the failure itself.
    return { ok: false, error: { code: "unavailable", message: opened.error.message } };
  }

  // Recorded here rather than by the caller: a sandbox nobody wrote down is one the next turn
  // cannot find and the reaper cannot sweep.
  await options.sessions.setSandboxId(session.sessionId, opened.value.sandboxId);
  return {
    ok: true,
    value: {
      id: opened.value.sandboxId,
      created: true,
      notices:
        opened.value.warning === null ? [] : [{ level: "warning", text: opened.value.warning }],
    },
  };
}

/**
 * Half a restore is not a smaller restore, it is a bug — a store of bytes nothing can name, or
 * names with nothing behind them. Thrown rather than returned: this is a wiring mistake at
 * construction, not something a turn could recover from.
 */
export function restoreDepsOf(options: {
  objects?: ObjectStore | undefined;
  snapshots?: SnapshotStore | undefined;
}): RestoreDeps | null {
  const { objects, snapshots } = options;
  if (objects === undefined && snapshots === undefined) return null;
  if (objects === undefined || snapshots === undefined) {
    throw new Error(
      "SingleAgentRuntime needs both `objects` and `snapshots` to restore a project, or neither.",
    );
  }
  return { objects, snapshots };
}
