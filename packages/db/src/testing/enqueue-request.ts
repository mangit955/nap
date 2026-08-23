/**
 * Admission's half of enqueueing, for tests that stand in for an API pod.
 *
 * A turn request's id is the caller's — it is the first logical Turn's `turnId` and has to be
 * durable before any execution of it, so `turn_requests.id` carries no database default. That
 * leaves every test that writes a request doing the same two steps: allocate, then insert. Four
 * suites had grown their own copy of it.
 *
 * Written against the `TurnQueue` port rather than against the fake, because the same two steps are
 * what `postgres-turn-queue.db.test.ts` needs against a real database.
 */

import type { EnqueueTurnRequest, TurnQueue } from "@nap/shared/ports/turn-queue";

/** Allocates the request's id, writes the row, and answers the id it chose. */
export async function enqueueRequest(
  queue: TurnQueue,
  request: Omit<EnqueueTurnRequest, "id">,
): Promise<{ id: string }> {
  const id = crypto.randomUUID();
  await queue.enqueue({ id, ...request });
  return { id };
}
