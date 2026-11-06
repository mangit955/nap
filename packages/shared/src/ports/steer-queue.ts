/**
 * Messages sent while a turn runs, and where each one lands (ADR-0027).
 *
 * A **steer** is a message somebody sends while a turn is running on their session. It joins that
 * turn: the agent reads it at its next step boundary, instead of the message queueing a turn
 * behind the one that is running. Every steer ends in exactly one of three places, and this port is
 * what makes that "exactly":
 *
 *   - **applied** — the agent read it, at a step boundary of the request it joined.
 *   - **deferred** — the request ended without reading it, so it became the next turn: a queued
 *     turn request carrying the steer's own id, admitted and paid for when the steer was.
 *   - **dropped** — the request was stopped, or its worker died, before reading it. Nothing runs
 *     it; the person is offered it back.
 *
 * Its own port beside `TurnQueue` rather than more methods on it, for the reason `CancelChannel`
 * is: most things that hold a queue have no business steering. But it is implemented by the same
 * store, and has to be, because the one guarantee that matters lives across both tables:
 *
 * **Admission and the end of a request are serialized on the request's row.** `steer` joins a
 * request only while it is leased, not cancelling and still open to steers, and checks that under
 * a lock the end of the request (`close`) also takes. So a steer either joined before the request
 * closed, and `close` resolves it, or it arrived after, and was queued as a turn. There is no
 * moment in which a steer is admitted to a request nothing will ever read or resolve.
 */

import { z } from "zod";
import type { PlanIntent } from "../agent-plan.ts";

/**
 * What admission writes down. Everything a turn request would carry except attachments: images
 * take the media path a prompt takes (ADR-0015), so a message with any is admitted as a turn.
 */
export type SteerRequest = {
  /**
   * Chosen by the client, and the message's identity wherever it lands: the steer's id, and the id
   * of the turn request it becomes if it falls back. A retry with the same id finds what the first
   * attempt did instead of admitting the message twice.
   */
  id: string;
  sessionId: string;
  userId: string;
  message: string;
  /**
   * The composer's plan intent. A steer joins only a request in the same mode — a planning turn
   * takes planning messages — and, if it falls back, the turn it becomes runs in that mode.
   */
  plan?: PlanIntent | undefined;
  /** What the turn it falls back to would run on. A steer that joins runs on the request's model. */
  model: string;
  billsToUser: boolean;
};

export type SteerAdmission =
  /** Joined the request with this id, which is leased and open to steers. */
  | { as: "steer"; requestId: string }
  /** Nothing could take it, so it was queued as a turn under the steer's id. */
  | { as: "turn" }
  /** The id is already somebody else's message, or another session's. Nothing was written. */
  | { as: "conflict" };

/**
 * What `POST /sessions/:id/steers` answers. `requestId` is the message's own id whichever way it
 * landed — the steer's, or the turn request's it became — so a client tracks one id either way.
 */
export const SteerAcceptanceSchema = z.object({
  accepted: z.literal(true),
  requestId: z.uuid(),
  as: z.enum(["steer", "turn"]),
});

/** A steer as the request it joined reads it. */
export type Steer = { id: string; text: string };

/** What closing a request did with the steers it never read. */
export type ClosedSteers = { deferred: Steer[]; dropped: Steer[] };

/**
 * Where a steer stands. `pending` until one of the other three, and never back: a steer is read,
 * deferred or dropped at most once, which is the whole of "never lost, never applied twice".
 */
export const STEER_STATES = ["pending", "applied", "deferred", "dropped"] as const;
export type SteerState = (typeof STEER_STATES)[number];

/**
 * At most this many steers wait on one request at once; the next is queued as a turn.
 *
 * Every steer that joins grows the running turn's context and is re-sent on each of its remaining
 * model calls, so an unbounded backlog is an unbounded bill inside one turn's budget. A turn
 * request is bounded by the rate limit and by its own budget instead, and a message that queues
 * still reaches the agent, one turn later.
 */
export const MAX_WAITING_STEERS = 3;

export interface SteerQueue {
  /**
   * Admits a message to the request leased on its session, or queues it as a turn.
   *
   * Joins only a request that is leased, of kind `turn`, not a `/compact`, not cancelling, not yet
   * closed to steers, in the same plan mode, and with fewer than `MAX_WAITING_STEERS` waiting.
   * Anything else is queued as a turn, which is what a message sent with no turn running always
   * was. Idempotent by `id`.
   */
  steer(request: SteerRequest): Promise<SteerAdmission>;

  /** Where an id already landed, so a retried POST can be answered without being charged again. */
  find(request: Pick<SteerRequest, "id" | "sessionId" | "userId">): Promise<SteerAdmission | null>;

  /**
   * Marks the request's waiting steers read and returns them, oldest first.
   *
   * Conditional on `owner` still holding the lease, like a renewal: a worker that lost its lease
   * reads nothing, so a zombie cannot hand somebody's words to a turn that no longer counts.
   */
  take(requestId: string, owner: string): Promise<Steer[]>;

  /**
   * Ends steering for a request: no steer joins it after this, and the waiting ones are resolved —
   * queued as turns (`defer`) or dropped (`drop`) — in the same transaction.
   *
   * Called once, by the worker, after the request's last turn and before it is settled. Conditional
   * on the lease like `take`: a worker that lost its lease resolves nothing, and the janitor
   * answers for those steers once it reclaims the request.
   */
  close(requestId: string, owner: string, disposition: "defer" | "drop"): Promise<ClosedSteers>;

  /** Every steer that joined a request, oldest first. For the janitor, after it reclaims one. */
  steersOf(requestId: string): Promise<(Steer & { state: SteerState })[]>;
}

/**
 * One request's steering, bound to the lease that runs it: what the worker hands the runtime.
 *
 * Bound rather than passed the queue and the lease separately, so the runtime can read and resolve
 * this request's steers and nothing else, and cannot forget the owner every write is conditional on.
 */
export type RequestSteering = {
  take(): Promise<Steer[]>;
  close(disposition: "defer" | "drop"): Promise<ClosedSteers>;
};
