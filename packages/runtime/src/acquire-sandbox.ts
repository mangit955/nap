/**
 * The sandbox a session's project is served from, resumed if there is one already.
 *
 * Four paths, and the order they are tried in is the whole of it: resume what is recorded, restore
 * what is recorded but gone, open what was never opened. Its own module rather than a private
 * method because the interesting path — a recorded sandbox that will not come back — is one no
 * test could reach without booting a whole runtime, and it is the path where a mistake loses
 * somebody's work rather than merely failing their turn.
 */

import { RESERVATION_TTL_MS } from "@nap/shared/capacity-windows";
import { getLogger } from "@nap/shared/logging";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { RepositorySource, RepositoryWorkspace } from "@nap/shared/ports/repository-workspace";
import type {
  ActivationFailure,
  Reservation,
  SandboxCapacity,
} from "@nap/shared/ports/sandbox-capacity";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import type { Result, VoidResult } from "@nap/shared/result";
import { readRepositoryPreviewPort } from "./repository-environment.ts";
import { openProject } from "./restore.ts";

/** A sandbox to work in, whether this call created it, and anything the user should be told. */
export type AcquiredSandbox = {
  id: string;
  created: boolean;
  notices: { level: "info" | "warning"; text: string }[];
  repository?: RepositorySource;
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
  repository?: RepositoryWorkspace;
  signal?: AbortSignal | undefined;
  source?: RepositorySource;
};

/**
 * What somebody is told when their sandbox took so long to create that its reservation expired.
 *
 * The sandbox really was made and is then destroyed unused, which sounds wasteful and is the
 * honest outcome: it is counted by nothing, so keeping it would run the turn on capacity nobody
 * granted and leave the ceiling that bounds the bill under-counting for as long as it lives.
 * Nothing is lost by refusing — no turn has run in it, and a restore still has its snapshot.
 */
export const UNCOUNTED_SANDBOX_REFUSAL =
  "This project's sandbox took too long to start, so it was shut down rather than left running. " +
  "Try again.";

export const LOST_SANDBOX_WARNING =
  "This project's sandbox was no longer available, so it was restored from its last " +
  "snapshot. Anything changed since then is not in it.";

export async function acquireSandbox(
  options: AcquireOptions,
  session: SessionRecord,
): Promise<Result<AcquiredSandbox, SandboxError>> {
  if (options.signal?.aborted) return cancelledAcquire();
  const source = await options.repository?.source(session, options.signal);
  if (source !== undefined && !source.ok) {
    return { ok: false, error: { code: "unavailable", message: source.error.message } };
  }
  const repository = source?.value ?? null;
  const acquired = await acquireAuthorizedSandbox(
    repository === null ? options : { ...options, source: repository },
    session,
  );
  if (!acquired.ok || repository === null) return acquired;
  const preview = acquired.value.created
    ? { ok: true as const, value: repository.previewPort }
    : await readRepositoryPreviewPort({
        sandbox: options.sandbox,
        sandboxId: acquired.value.id,
        fallback: repository.previewPort,
      });
  if (!preview.ok)
    return { ok: false, error: { code: "unavailable", message: preview.error.message } };
  return {
    ok: true,
    value: {
      ...acquired.value,
      repository: { ...repository, previewPort: preview.value },
      notices: acquired.value.created
        ? [...acquired.value.notices, { level: "info", text: "Repository workspace ready." }]
        : acquired.value.notices,
    },
  };
}

async function acquireAuthorizedSandbox(
  options: AcquireOptions,
  session: SessionRecord,
): Promise<Result<AcquiredSandbox, SandboxError>> {
  if (options.signal?.aborted) return cancelledAcquire();
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
 * Reserved, created, renewed while it is prepared, activated — and released on every path where the sandbox did not come into
 * existence, immediately rather than by a sweep, because a slot held by a creation that already
 * failed is one somebody else could have had.
 *
 * The one path that runs the other way is a creation that outlived its reservation: the row was
 * reclaimed while the provider was still working, so the sandbox that arrives is real and counted
 * by nothing. There the sandbox is destroyed and the turn refused, because the alternative is
 * running it on capacity nobody granted.
 */
async function open(
  options: AcquireOptions,
  session: SessionRecord,
): Promise<Result<AcquiredSandbox, SandboxError>> {
  const reserved = await reserve(options, session);
  if (!reserved.ok) return reserved;
  const reservation = reserved.value;

  const heartbeat = holdWhilePreparing(options, reservation);
  let opened: Result<AcquiredSandbox, SandboxError>;
  try {
    opened = await create(options, session, heartbeat.created);
  } finally {
    await heartbeat.stop();
  }
  if (!opened.ok) {
    await releaseQuietly(options, reservation);
    return opened;
  }
  if (options.signal?.aborted) {
    await destroyQuietly(options, opened.value.id);
    await releaseQuietly(options, reservation);
    return cancelledAcquire();
  }

  // Activated before the session is told. The order is what decides how a half-finished acquire
  // looks to whatever cleans up later: an *active* row naming a sandbox no session references is a
  // sandbox that can be found and destroyed, while a *reserved* row over a live one expires in two
  // minutes and leaves something running that nothing is counting.
  const activated = await recordActivation(options, reservation, opened.value.id);
  if (!activated.ok) {
    await destroyQuietly(options, opened.value.id);
    return { ok: false, error: { code: "unavailable", message: UNCOUNTED_SANDBOX_REFUSAL } };
  }

  // A sandbox nobody wrote down is one the next turn cannot find and the reaper cannot sweep.
  await options.sessions.setSandboxId(session.sessionId, opened.value.id);

  return opened;
}

/** How often a reservation is renewed while its sandbox is being prepared — well inside its TTL. */
const RENEW_EVERY_MS = RESERVATION_TTL_MS / 4;

/**
 * Keeps the reservation from lapsing between the sandbox existing and the sandbox being ready.
 *
 * A repository's setup command may run for ten minutes; a reservation lives for two. Without this
 * an ordinary dependency install outlives its row, the reaper reclaims it, and the finished
 * sandbox is refused as uncounted. Renewal keeps the row `reserved` rather than activating it
 * early, so a process that dies mid-setup still gives the slot back within one TTL — and it
 * records the sandbox id, so the inventory sweep sees the sandbox as referenced meanwhile.
 *
 * A failed renewal is only logged: `activate` at the end asks the same question authoritatively,
 * and a renewal that could not reach the database says nothing about whether the row survives.
 */
function holdWhilePreparing(
  options: AcquireOptions,
  reservation: Reservation | null,
): { created: (sandboxId: string) => void; stop: () => Promise<void> } {
  const capacity = options.capacity;
  if (reservation === null || capacity === undefined) {
    return { created: () => {}, stop: async () => {} };
  }

  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> = Promise.resolve();
  const renew = (sandboxId: string) => {
    inFlight = inFlight.then(async () => {
      try {
        const renewed = await capacity.renew(reservation.id, sandboxId);
        if (!renewed.ok) getLogger().warn({ sandboxId }, renewed.error.message);
      } catch (error) {
        getLogger().warn({ sandboxId, err: error }, "could not renew a sandbox reservation");
      }
    });
  };

  return {
    created: (sandboxId) => {
      renew(sandboxId);
      timer = setInterval(() => renew(sandboxId), RENEW_EVERY_MS);
    },
    stop: async () => {
      if (timer !== undefined) clearInterval(timer);
      await inFlight;
    },
  };
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
 * Records that the reservation became this sandbox — and tells the caller when there was no
 * reservation left to record it against.
 *
 * **A failure to *reach* the store and a definite "that row is gone" are different answers.** A
 * thrown error means the bookkeeping could not be done and nothing is known: the sandbox exists,
 * the session is about to be told where it is, and the row expires on its own, so the turn goes
 * ahead and a ceiling loses some accuracy for a couple of minutes. A returned failure means the
 * reservation was reclaimed while the sandbox was being created — a create slower than the
 * two-minute TTL needs no crash and no concurrency — and the sandbox in hand is running, billed
 * and counted by nothing. That one the caller has to act on.
 */
async function recordActivation(
  options: AcquireOptions,
  reservation: Reservation | null,
  sandboxId: string,
): Promise<VoidResult<ActivationFailure>> {
  if (reservation === null) return { ok: true, value: undefined };

  try {
    return (
      (await options.capacity?.activate(reservation.id, sandboxId)) ?? {
        ok: true,
        value: undefined,
      }
    );
  } catch (error) {
    getLogger().warn(
      { sandboxId, err: error },
      "could not record the sandbox against its reservation; it stays counted only until the " +
        "reservation expires",
    );
    return { ok: true, value: undefined };
  }
}

/**
 * Puts back a sandbox that may not be kept, and never replaces the refusal with its own failure.
 *
 * A destroy that fails leaves the very thing being refused — a sandbox nothing counts — so this is
 * the one path where the reaper's inventory sweep is the backstop rather than the belt: it finds
 * sandboxes no project references and destroys them, minutes later.
 */
async function destroyQuietly(options: AcquireOptions, sandboxId: string): Promise<void> {
  const failed = (reason: unknown): void => {
    getLogger().warn(
      { sandboxId, err: reason },
      "could not destroy a sandbox nothing is counting; the reaper's inventory sweep is what " +
        "finds it now",
    );
  };

  try {
    const destroyed = await options.sandbox.destroy(sandboxId);
    if (!destroyed.ok) failed(destroyed.error);
  } catch (error) {
    failed(error);
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
  onCreated: (sandboxId: string) => void,
): Promise<Result<AcquiredSandbox, SandboxError>> {
  if (options.restore === null) {
    if (options.source !== undefined) {
      return {
        ok: false,
        error: { code: "unavailable", message: "Repository workspaces require snapshot storage." },
      };
    }
    const created = await options.sandbox.create(session.projectId);
    if (!created.ok) return created;
    return { ok: true, value: { id: created.value.id, created: true, notices: [] } };
  }

  const opened = await openProject({
    sandbox: options.sandbox,
    objects: options.restore.objects,
    snapshots: options.restore.snapshots,
    projectId: session.projectId,
    ...(options.source === undefined ? {} : { source: options.source }),
    signal: options.signal,
    onCreated,
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

function cancelledAcquire(): Result<never, SandboxError> {
  return {
    ok: false,
    error: { code: "unavailable", message: "Opening this workspace was cancelled." },
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
