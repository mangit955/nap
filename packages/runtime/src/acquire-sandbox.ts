/**
 * The sandbox a session's project is served from, resumed if there is one already.
 *
 * Four paths, and the order they are tried in is the whole of it: resume what is recorded, restore
 * what is recorded but gone, open what was never opened. Its own module rather than a private
 * method because the interesting path — a recorded sandbox that will not come back — is one no
 * test could reach without booting a whole runtime, and it is the path where a mistake loses
 * somebody's work rather than merely failing their turn.
 */

import { getLogger } from "@nap/shared/logging";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { Reservation, SandboxCapacity } from "@nap/shared/ports/sandbox-capacity";
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
  /**
   * The ceiling on how many sandboxes may exist at once, claimed here because here is the only
   * place one is created. Absent means uncapped, which is what a fake, a benchmark or the harness
   * wants and what no deployment does — see `composeNap`, which always supplies one.
   */
  capacity?: SandboxCapacity;
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

/**
 * A new sandbox for this session's project, holding whatever could be restored into it — and the
 * capacity it costs, claimed before it exists and given back if it never does.
 *
 * **The reservation is the authoritative ceiling, and this is the only place it is taken.** The
 * HTTP route's quota check is a fast refusal for the obvious case and nothing more: a request can
 * sit queued for a minute, so capacity claimed at admission would either expire unused or be held
 * for work that has not started. Claiming it here means the count and the creation are one
 * decision, which is what stops a hundred simultaneous turns each finding themselves under a cap
 * of ten.
 *
 * Reserved, created, activated — and released on every path where the sandbox did not come into
 * existence, immediately rather than by a sweep, because a slot held by a creation that already
 * failed is one somebody else could have had.
 */
async function open(
  options: AcquireOptions,
  session: SessionRecord,
): Promise<Result<AcquiredSandbox, SandboxError>> {
  const reserved = await reserve(options, session);
  if (!reserved.ok) return reserved;
  const reservation = reserved.value;

  const opened = await create(options, session);
  if (!opened.ok) {
    await releaseQuietly(options, reservation);
    return opened;
  }

  // Activated before the session is told, and neither step may fail the turn once the sandbox
  // exists. The order is what decides how a half-finished acquire looks to whatever cleans up
  // later: an *active* row naming a sandbox no session references is a sandbox that can be found
  // and destroyed, while a *reserved* row over a live one expires in two minutes and leaves
  // something running that nothing is counting.
  await activateQuietly(options, reservation, opened.value.id);

  // A sandbox nobody wrote down is one the next turn cannot find and the reaper cannot sweep.
  await options.sessions.setSandboxId(session.sessionId, opened.value.id);

  return opened;
}

/**
 * Gives the slot back, and never turns a failed acquire into a thrown one.
 *
 * The turn has already failed for a reason worth reporting; replacing it with "the database
 * refused a delete" would hide that reason behind the bookkeeping for it. The row is left holding
 * a slot until it expires, which costs one sandbox's worth of headroom for a couple of minutes.
 */
async function releaseQuietly(
  options: AcquireOptions,
  reservation: Reservation | null,
): Promise<void> {
  if (reservation === null) return;

  try {
    await options.capacity?.release(reservation.id);
  } catch (error) {
    getLogger().warn(
      { err: error },
      "could not release the capacity a failed sandbox creation reserved",
    );
  }
}

/**
 * Records that the reservation became this sandbox, and never fails the turn over it.
 *
 * The sandbox exists and is about to be recorded against the session, so the work can go ahead.
 * What is lost is only the bookkeeping: the row stays `reserved`, expires, and stops counting a
 * sandbox that is really there — under-counting a ceiling, rather than losing somebody's turn.
 */
async function activateQuietly(
  options: AcquireOptions,
  reservation: Reservation | null,
  sandboxId: string,
): Promise<void> {
  if (reservation === null) return;

  try {
    await options.capacity?.activate(reservation.id, sandboxId);
  } catch (error) {
    getLogger().warn(
      { sandboxId, err: error },
      "could not record the sandbox against its reservation; it stays counted only until the " +
        "reservation expires",
    );
  }
}

/** The capacity this creation will cost, or the refusal that stops it happening. */
async function reserve(
  options: AcquireOptions,
  session: SessionRecord,
): Promise<Result<Reservation | null, SandboxError>> {
  if (options.capacity === undefined) return { ok: true, value: null };

  const reserved = await options.capacity.reserve({
    projectId: session.projectId,
    userId: session.userId,
  });

  // Flattened to the one code a turn can report, keeping the refusal's own words: "close a
  // project" and "try again in a few minutes" are different instructions, and the person reading
  // them is the only one who can act on either.
  if (!reserved.ok) {
    return { ok: false, error: { code: "unavailable", message: reserved.error.message } };
  }

  return reserved;
}

/** The sandbox itself, from the template or from the project's last snapshot. */
async function create(
  options: AcquireOptions,
  session: SessionRecord,
): Promise<Result<AcquiredSandbox, SandboxError>> {
  if (options.restore === null) {
    const created = await options.sandbox.create(session.projectId);
    if (!created.ok) return created;
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
    throw new Error("Restoring a project needs both `objects` and `snapshots`, or neither.");
  }
  return { objects, snapshots };
}
