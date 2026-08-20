/**
 * The durable queue of turn requests, and the per-session leases that make one of them exclusive.
 *
 * It replaces a `Map` of promises in one process. That map stopped a turn and a project-open both
 * creating a sandbox for the same project — and stopped nothing at all once a second process
 * existed: each would create one, the project would end up holding two, and nobody could find or
 * stop paying for the second.
 *
 * **A turn request is not a Job.** A Job is one objective, folded from the event log, and one
 * request may drive a Job through several Turns. A request is a queued *intent to execute*: created
 * at admission, claimed by exactly one worker, terminal exactly once. See `CONTEXT.md`.
 *
 * Three properties are the whole point, and each of them is a database rule rather than something
 * every caller has to remember:
 *
 *   - **One in-flight request per session, cluster-wide**, enforced by a partial unique index over
 *     `state = 'leased'`. Application logic cannot enforce it, because the two callers are in
 *     different processes.
 *   - **At-most-once execution.** There is no path back to `queued`: a request is claimed at most
 *     once, so a worker that dies mid-turn leaves a partial log rather than a turn that runs twice.
 *     A partial log is already a first-class input — `foldJobs` reads one — and a duplicated turn
 *     is not. See `docs/scaling-design.md` §6.
 *   - **Losing the lease is fatal to the turn.** A worker can outlive its lease through a GC pause
 *     or a network blip, and would then keep appending to a session another worker may claim.
 *     `renew` returning `held: false` is the signal to abort immediately, which is why it is a
 *     conditional statement rather than a timer.
 */

/**
 * What a request asks for: a turn on a prompt, or bringing a project back up.
 *
 * Both go through the same lease, and that is what makes offering the second safe at all — they
 * both create a sandbox when the project has none.
 */
export const TURN_REQUEST_KINDS = ["turn", "resume"] as const;
export type TurnRequestKind = (typeof TURN_REQUEST_KINDS)[number];

/** Where a request is in its life. Terminal states are never left, and none returns to `queued`. */
export const TURN_REQUEST_STATES = ["queued", "leased", "done", "failed", "orphaned"] as const;
export type TurnRequestState = (typeof TURN_REQUEST_STATES)[number];

export type EnqueueTurnRequest = {
  sessionId: string;
  /** Who asked, which is also whose stored key a billed turn is re-opened from. */
  userId: string;
  kind: TurnRequestKind;
  /** The prompt. Null for `resume`, which asks for no new work. */
  message: string | null;
  /** Resolved at admission, because which models somebody may name is the route's fact. */
  model: string;
  /**
   * Whether the asker's own account pays.
   *
   * **Never a key.** The worker re-opens the caller's stored credential by `userId`, so plaintext
   * never touches this queue, a query log or a backup.
   */
  billsToUser: boolean;
};

/**
 * A request this worker now holds the session's lease for, and everything it needs to run it.
 *
 * Exactly what was enqueued, plus the id it was given. Written as an intersection rather than as
 * a second list of the same seven fields, because the two being identical is the point: what a
 * worker runs is what admission wrote down and nothing else it went and looked up.
 */
export type LeasedTurnRequest = EnqueueTurnRequest & { id: string };

/**
 * What a renewal found.
 *
 * `held: false` means the lease is gone — expired and reclaimed, or settled by something else —
 * and the only correct response is to abort. `cancelRequested` rides on the same answer because
 * one statement should serve both questions: a worker asking "am I still allowed to run?" every
 * fifteen seconds is asking exactly one thing.
 */
export type LeaseRenewal = { held: true; cancelRequested: boolean } | { held: false };

/** How a claimed request ended. Both are terminal; neither returns it to the queue. */
export type TurnRequestSettlement = "done" | "failed";

/** What a cancellation found, so a route can tell "stopped it" from "there was nothing to stop". */
export type CancelOutcome =
  /** A request was queued and has been failed outright — it will never be claimed. */
  | { cancelled: true; was: "queued" }
  /** A worker holds it. It learns on its next renewal and aborts. */
  | { cancelled: true; was: "leased" }
  | { cancelled: false };

export interface TurnQueue {
  /**
   * Records the intent to execute, durably, and answers with the request's id.
   *
   * Called at admission on whichever process took the HTTP request. It does not wait for the work
   * and cannot report on it: what the caller gets is "written down", not "started".
   */
  enqueue(request: EnqueueTurnRequest): Promise<{ id: string }>;

  /**
   * Takes the oldest claimable request and leases its session to `owner`, or answers `null`.
   *
   * `owner` identifies *this worker* — a process and its restart, not a machine — because it is
   * the predicate every renewal is conditional on. Two workers sharing an owner string would each
   * be able to renew the other's lease, which is the one thing the fencing exists to prevent.
   *
   * A request whose session is already leased is skipped rather than waited for: sessions run in
   * parallel, and a queue that serialized everything would make one slow turn everybody's problem.
   */
  claim(owner: string): Promise<LeasedTurnRequest | null>;

  /**
   * Pushes the lease's expiry out, and says whether the worker still holds it.
   *
   * Conditional on the request id *and* the owner *and* the state, so a worker that lost its lease
   * cannot renew its way back into one another worker now holds.
   */
  renew(requestId: string, owner: string): Promise<LeaseRenewal>;

  /**
   * Moves a held request to a terminal state.
   *
   * Conditional on the owner for the same reason renewal is: a worker whose lease was reclaimed
   * must not settle a request somebody else is now running. Answers whether it did.
   */
  settle(requestId: string, owner: string, state: TurnRequestSettlement): Promise<boolean>;

  /**
   * Asks for whatever is in flight on this session to stop.
   *
   * A `queued` request is failed here and now, so it can never be claimed — the alternative, a row
   * left queued and permanently skipped, is a request with no terminal state and a chat pane with
   * nothing to show. A `leased` one is only flagged: the worker owns its own abort, and stopping it
   * from outside is what the renewal answer is for.
   */
  requestCancel(sessionId: string): Promise<CancelOutcome>;
}
