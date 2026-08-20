/**
 * A `SandboxCapacity` holding reservations in a map.
 *
 * It exists so that the *callers* of the port are testable — that a failed creation releases what
 * it reserved, that a teardown gives capacity back, that a refusal fails the turn rather than
 * creating a sandbox anyway. It deliberately proves nothing about the ceiling itself: atomicity
 * is a property of a transaction and a lock, and a fake that reimplemented the counting in
 * JavaScript would agree with itself under any concurrency at all. That belongs to
 * `postgres-sandbox-capacity.db.test.ts` and to a real Postgres.
 *
 * Unlimited by default, because most callers are testing something else entirely and a limit they
 * did not ask for would refuse a turn for reasons their test never mentions.
 */

import type {
  CapacityRefusal,
  Reservation,
  SandboxCapacity,
} from "@nap/shared/ports/sandbox-capacity";
import type { Result } from "@nap/shared/result";

export type FakeCapacityLimits = { perUser?: number; total?: number };

export type FakeReservation = {
  id: string;
  projectId: string;
  userId: string;
  state: "reserved" | "active";
  sandboxId: string | null;
};

export class InMemorySandboxCapacity implements SandboxCapacity {
  readonly #rows = new Map<string, FakeReservation>();
  readonly #limits: Required<FakeCapacityLimits>;
  #next = 0;
  #failure: Error | undefined;
  #afterReserve: Error | undefined;

  constructor(limits: FakeCapacityLimits = {}) {
    this.#limits = {
      perUser: limits.perUser ?? Number.POSITIVE_INFINITY,
      total: limits.total ?? Number.POSITIVE_INFINITY,
    };
  }

  /** Makes every method throw until called again with `undefined` — a database that is not there. */
  failWith(error: Error | undefined): this {
    this.#failure = error;
    return this;
  }

  /**
   * Makes everything *except* `reserve` throw — a database that goes away between claiming a slot
   * and writing down what became of it, which is the failure a caller has to survive rather than
   * report: by then there is a sandbox, and the turn can go ahead without the bookkeeping.
   */
  failAfterReserve(error: Error | undefined): this {
    this.#afterReserve = error;
    return this;
  }

  /** Every reservation still held, which is the assertion surface for "was it released?". */
  held(): FakeReservation[] {
    return [...this.#rows.values()].map((row) => ({ ...row }));
  }

  async reserve(request: {
    projectId: string;
    userId: string;
  }): Promise<Result<Reservation, CapacityRefusal>> {
    if (this.#failure !== undefined) throw this.#failure;

    const rows = [...this.#rows.values()];

    // The same two answers the real one gives a project that already holds a row: refuse while a
    // creation is genuinely in flight, and hand the slot back for an `active` row, which by the
    // time anybody is creating again names a sandbox that has gone. Nothing here expires, so
    // "in flight" is simply "still reserved".
    const held = rows.find((row) => row.projectId === request.projectId);
    if (held !== undefined) {
      if (held.state === "reserved") {
        return refuse("project_held", "This project is already opening a sandbox.");
      }
      this.#rows.set(held.id, { ...held, state: "reserved", sandboxId: null });
      return { ok: true, value: { id: held.id } };
    }

    if (rows.filter((row) => row.userId === request.userId).length >= this.#limits.perUser) {
      return refuse("per_user", "You already have as many projects running as you may.");
    }
    if (rows.length >= this.#limits.total) {
      return refuse("total", "This server is at its limit of running projects.");
    }

    this.#next += 1;
    const id = `reservation-${this.#next}`;
    this.#rows.set(id, { id, ...request, state: "reserved", sandboxId: null });
    return { ok: true, value: { id } };
  }

  async activate(reservationId: string, sandboxId: string): Promise<void> {
    this.#refuseIfBroken();

    const row = this.#rows.get(reservationId);
    if (row === undefined) return;
    this.#rows.set(reservationId, { ...row, state: "active", sandboxId });
  }

  async release(reservationId: string): Promise<void> {
    this.#refuseIfBroken();

    this.#rows.delete(reservationId);
  }

  async releaseForProject(projectId: string): Promise<void> {
    this.#refuseIfBroken();

    for (const [id, row] of this.#rows) {
      if (row.projectId === projectId) this.#rows.delete(id);
    }
  }

  #refuseIfBroken(): void {
    const error = this.#failure ?? this.#afterReserve;
    if (error !== undefined) throw error;
  }
}

function refuse(
  reason: CapacityRefusal["reason"],
  message: string,
): Result<never, CapacityRefusal> {
  return { ok: false, error: { reason, message } };
}
