/**
 * Where a project's picture gets taken: beside the turn, not inside its lease.
 *
 * Photographing a project opens a browser, which is up to half a minute of work nobody is waiting
 * for. Done before a request settles, it kept the session's lease for all of that, so a follow-up
 * message queued behind a dashboard picture — and at one browser a worker, behind every other
 * project's picture too. The turn now only asks for one, and this takes it after the lease has gone
 * back. See `docs/scaling-design.md` §17 (B-6, B-7).
 *
 * Leaving the lease is what makes the rest of this file necessary, because nothing holds the
 * sandbox still any more. Four rules follow.
 *
 * **It never replaces a good picture with a worse one.** A following turn may be halfway through an
 * edit, and a close may have destroyed the machine, which leaves an error page at the address. So
 * the workspace's state is read when the picture is asked for, while the lease still holds it
 * still, and again before a browser is launched and before the bytes overwrite anything. If it no
 * longer matches, the card keeps the picture it has; if that turn commits, it asks for another.
 *
 * **It owes nobody anything, so it is bounded by dropping.** A skipped thumbnail is a stale card.
 * One project holds one place however often it asks, and the newest request takes the place over,
 * since nobody wants the older picture. Past `maxQueued` a request is refused, so overload costs
 * cards rather than memory or a queue a worker takes an hour to get through.
 *
 * **It keeps no sandbox alive and holds no slot of the ceiling.** It never creates, resumes or
 * extends one, and nothing here is `busy`: the idle sweep and a person closing the project go
 * straight past it, and the worst that does to a shot in flight is the skip above.
 *
 * **A shutdown does not wait for it.** What is queued is dropped, and what is running gets a short
 * grace. Nothing here is written down anywhere, so a process that dies with shots outstanding
 * loses only those pictures: the project's next committed turn or restart takes another.
 *
 * How many run at once and how many may wait are the composition's to say, since both depend on
 * how many turns this worker runs.
 */

import { type WorkspaceState, workspaceState } from "@nap/sandbox/git";
import { getLogger, type Logger, withLogContext } from "@nap/shared/logging";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { PageCapture } from "@nap/shared/ports/page-capture";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { captureThumbnail } from "./turn-thumbnail.ts";

/** Long enough for a browser that has loaded its page to finish, not for one that has not. */
const DEFAULT_STOP_GRACE_MS = 10_000;

export type ThumbnailLaneOptions = {
  sandbox: SandboxManager;
  capture: PageCapture;
  objects: ObjectStore;
  /** How many shots may be in flight. Must be at least one, or nothing is ever photographed. */
  concurrency: number;
  /** How many projects may wait for a browser. Beyond this a request is refused. */
  maxQueued: number;
  /** How long `stop` waits for shots already in flight. */
  stopGraceMs?: number;
};

export type ThumbnailTarget = {
  projectId: string;
  sandboxId: string;
  /** The port the project's dev server listens on. */
  port: number;
};

type Shot = ThumbnailTarget & {
  /** The workspace the picture was asked for, which is what makes it worth keeping. */
  workspace: WorkspaceState;
  /** The asker's, so that a line logged later still says which turn this belonged to. */
  logger: Logger;
};

export class ThumbnailLane {
  readonly #sandbox: SandboxManager;
  readonly #capture: PageCapture;
  readonly #objects: ObjectStore;
  readonly #limit: number;
  readonly #maxQueued: number;
  readonly #stopGraceMs: number;
  /** One per project, oldest first. A `Map` keeps a replaced entry's place in the line. */
  readonly #queued = new Map<string, Shot>();
  /** Keyed by project, because two shots of one could otherwise land in the wrong order. */
  readonly #running = new Map<string, Promise<void>>();
  #stopped = false;

  constructor(options: ThumbnailLaneOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      // Programmer error rather than a failed capture: a bound of nought is a deployment that
      // silently never photographs anything, which looks exactly like a browser that is broken.
      throw new RangeError("a capture bound below one photographs nothing");
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new RangeError("a queue bound must be a count");
    }

    this.#sandbox = options.sandbox;
    this.#capture = options.capture;
    this.#objects = options.objects;
    this.#limit = options.concurrency;
    this.#maxQueued = options.maxQueued;
    this.#stopGraceMs = options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  }

  /**
   * Asks for a picture of the workspace as it stands.
   *
   * Awaited under the caller's lease, for one command: reading the state is the only part that has
   * to happen before the lease goes back. Never rejects — every failure is a stale card and a log
   * line, and nothing here is worth failing a turn or a resume over.
   */
  async request(target: ThumbnailTarget): Promise<void> {
    if (this.#stopped) return;
    const logger = getLogger();

    const workspace = await this.#readWorkspace(target.sandboxId);
    if (workspace === null) {
      logger.warn({}, "could not read the workspace; no project thumbnail this time");
      return;
    }

    // Asked again because the read above is the one moment a stop can land in between.
    if (this.#stopped) return;
    const { projectId } = target;
    if (!this.#queued.has(projectId) && this.#queued.size >= this.#maxQueued) {
      logger.warn({ queued: this.#queued.size }, "too many thumbnails waiting; dropping this one");
      return;
    }

    this.#queued.set(projectId, { ...target, workspace, logger });
    this.#pump();
  }

  /**
   * Stops taking pictures: drops what is waiting and gives what is running a short grace.
   *
   * Never waits longer than the grace, because the caller is a process on its way out, and a page
   * that will not load must not cost it the deadline the platform gave it. A browser left behind
   * goes with the process.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    this.#queued.clear();
    if (this.#running.size === 0) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceOver = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#stopGraceMs);
    });
    await Promise.race([Promise.all(this.#running.values()), graceOver]);
    clearTimeout(timer);
  }

  /**
   * How many shots are waiting or running.
   *
   * Here so a test can tell "nothing was stored" from "nothing has been stored yet", which would
   * otherwise read the same.
   */
  get pending(): number {
    return this.#queued.size + this.#running.size;
  }

  /**
   * Starts whatever may start.
   *
   * Runs to completion without yielding, so unlike a permit handed back across an `await` there is
   * no moment in which a second caller could read the count as free.
   */
  #pump(): void {
    for (const [projectId, shot] of this.#queued) {
      if (this.#running.size >= this.#limit) return;
      if (this.#running.has(projectId)) continue;

      this.#queued.delete(projectId);
      const running = withLogContext(shot.logger, {}, () => this.#take(shot))
        .catch((error: unknown) => {
          shot.logger.warn({ err: error }, "could not capture a project thumbnail");
        })
        .finally(() => {
          // In a `finally` because a throw must not cost the slot: one lost at a bound of one is a
          // worker that never photographs anything again.
          this.#running.delete(projectId);
          this.#pump();
        });
      this.#running.set(projectId, running);
    }
  }

  async #take(shot: Shot): Promise<void> {
    const { projectId, sandboxId, port } = shot;
    const log = getLogger();

    // A shot may have waited minutes behind other projects' pictures, so this is often where it
    // turns out nobody wants it — before a browser is launched for it rather than after.
    if (!(await this.#unchanged(shot))) {
      log.info({}, "the workspace moved on before its thumbnail was taken");
      return;
    }

    const taken = await captureThumbnail({
      sandbox: this.#sandbox,
      capture: this.#capture,
      objects: this.#objects,
      projectId,
      sandboxId,
      port,
      // Last, because the picture just taken may show a half-finished edit or a dead sandbox's
      // error page, and this is the moment it would replace a good one.
      beforeStore: () => this.#unchanged(shot),
    });

    if (taken.ok) {
      log.info({ key: taken.value.key }, "project thumbnail captured");
    } else if (taken.error.superseded === true) {
      log.info({}, "the workspace moved on while its thumbnail was being taken");
    } else {
      log.warn({ reason: taken.error.message }, "could not capture a project thumbnail");
    }
  }

  async #unchanged(shot: Shot): Promise<boolean> {
    return (await this.#readWorkspace(shot.sandboxId)) === shot.workspace;
  }

  /** `null` for a sandbox that did not answer, which is a thing nobody can photograph anyway. */
  async #readWorkspace(sandboxId: string): Promise<WorkspaceState | null> {
    try {
      const state = await workspaceState(this.#sandbox, sandboxId);
      return state.ok ? state.value : null;
    } catch (error) {
      getLogger().warn({ err: error }, "could not read the workspace");
      return null;
    }
  }
}
