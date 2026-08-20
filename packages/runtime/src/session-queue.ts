/**
 * One thing at a time per session — a turn, or bringing the project back up.
 *
 * Both of those create a sandbox when the project has none, and a page that resumes on arrival
 * while its user types a message asks for both at once. Serialized, the second finds the first
 * one's sandbox; run in parallel, they each start one and the project ends up holding two — one
 * of which nobody can find and nobody stops paying for.
 *
 * **The lock is per session, not per process.** Different sessions run at the same time; a queue
 * that serialized everything would make one slow turn everybody's problem.
 *
 * **It is per process, though, and that is why it is being retired.** A second replica has its own
 * copy of this map and the two agree about nothing, so the failure above returns in full the
 * moment there are two of anything. The durable replacement is the per-session lease in
 * `turn_requests` — see `turn-worker.ts` and `CONTEXT.md`, *Lease* — and turns already go through
 * it. What still arrives here without one is a project-open calling `resumeSession` inside the
 * request that asked for it; until that becomes a queued `resume` request too, this map is the
 * only thing keeping an open and a turn from creating two sandboxes for one project, and deleting
 * it now would reintroduce exactly what it was written to prevent.
 */

export class SessionQueue {
  readonly #queues = new Map<string, Promise<void>>();

  /**
   * Runs `work` once everything already queued for this session has finished.
   *
   * The caller gets the work's own result — value or rejection. What the *queue* holds is a tail
   * that has already swallowed the rejection, because a turn that failed must not reject the turn
   * queued behind it: that would be one user's failure becoming another's, on a queue they cannot
   * see.
   */
  run<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve();
    const outcome = previous.then(work);

    const tail = outcome.then(
      () => {},
      () => {},
    );
    this.#queues.set(sessionId, tail);

    void tail.then(() => {
      // Only if nothing else has queued behind us; otherwise this is now someone else's tail, and
      // deleting it would let the next caller start beside work that is still running. Without
      // the delete at all, the map grows one key per session anybody ever opened.
      if (this.#queues.get(sessionId) === tail) this.#queues.delete(sessionId);
    });

    return outcome;
  }

  /**
   * How many sessions currently hold work.
   *
   * Here so the "nothing is left behind" rule can be asserted at all: a leak is invisible from the
   * outside — every turn still runs — and shows up as memory, months later, on a process nobody
   * restarts.
   */
  get size(): number {
    return this.#queues.size;
  }
}
