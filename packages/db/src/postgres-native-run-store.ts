import { createHash, randomBytes } from "node:crypto";
import { NapEventSchema } from "@nap/shared/events";
import { ExecutionTargetSchema, sameExecutionTarget } from "@nap/shared/execution-target";
import { NativeHostExitReasonSchema } from "@nap/shared/native-process-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import type {
  NativeDelivery,
  NativeRunHandle,
  NativeRunRecord,
  NativeRunStore,
  StoredNativeDelivery,
} from "@nap/shared/ports/native-run-store";
import { NativeRunBindingSchema as Binding } from "@nap/shared/ports/native-run-store";
import { SealedProviderCredentialsSchema } from "@nap/shared/ports/provider-account-store";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import {
  events,
  nativeDeliveries,
  nativeRuns,
  projects,
  providerAccounts,
  providerCredentialRefreshes,
  providerCredentials,
  sessions,
  turnRequests,
  users,
} from "./schema.ts";

type Transaction = Parameters<Parameters<PostgresJsDatabase["transaction"]>[0]>[0];
type RunRow = typeof nativeRuns.$inferSelect;
type DeliveryRow = typeof nativeDeliveries.$inferSelect;
const Handle = z.strictObject({ id: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) });
const Begin = z.strictObject({
  id: z.uuid(),
  requestId: z.uuid(),
  turnId: z.uuid(),
  workerId: z.string().min(1).max(1000),
});
const Receipt = z.strictObject({
  nativeSessionId: z.string().min(1).max(1000),
  receipt: SealedProviderCredentialsSchema,
});
const Proof = z.strictObject({
  kind: z.literal("exit"),
  sequence: z.int().positive(),
  code: z.int().nullable(),
  reason: NativeHostExitReasonSchema,
  containment: z.literal("cgroup"),
});
const Delivery = z.strictObject({
  sequence: z.int().positive().max(2_147_483_647),
  rawHash: z.string().regex(/^[a-f0-9]{64}$/),
  raw: SealedProviderCredentialsSchema,
  events: z.array(z.unknown()).max(256),
});
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function toEvent(row: typeof events.$inferSelect): StoredEvent {
  const { id: _id, ...event } = row;
  return NapEventSchema.parse({ ...event, createdAt: row.createdAt.toISOString() });
}

/** Queue and account checks happen in the same transaction as the durable receipt. */
export class PostgresNativeRunStore implements NativeRunStore {
  constructor(private readonly db: PostgresJsDatabase) {}

  async begin(input: Parameters<NativeRunStore["begin"]>[0]): ReturnType<NativeRunStore["begin"]> {
    const parsed = Begin.safeParse(input);
    if (!parsed.success) return { kind: "denied" };
    const token = randomBytes(32).toString("hex");
    return this.db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(turnRequests)
        .where(
          and(
            eq(turnRequests.id, input.requestId),
            eq(turnRequests.leaseOwner, input.workerId),
            eq(turnRequests.state, "leased"),
            eq(turnRequests.cancelRequested, false),
            gt(turnRequests.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .for("share");
      if (request === undefined) return { kind: "denied" };
      const target = ExecutionTargetSchema.parse(request.target);
      if (target.kind !== "subscription") return { kind: "denied" };
      const [scope] = await tx
        .select({ projectId: projects.id })
        .from(sessions)
        .innerJoin(projects, eq(projects.id, sessions.projectId))
        .innerJoin(users, eq(users.id, projects.userId))
        .where(
          and(
            eq(sessions.id, request.sessionId),
            eq(projects.userId, request.userId),
            eq(users.isAnonymous, false),
          ),
        )
        .for("share");
      if (scope === undefined) return { kind: "denied" };
      const binding = Binding.parse({
        userId: request.userId,
        projectId: scope.projectId,
        sessionId: request.sessionId,
        requestId: request.id,
        turnId: input.turnId,
        target,
      });
      if (!(await this.#authorized(tx, binding))) return { kind: "denied" };
      const [existing] = await tx
        .select({ id: nativeRuns.id })
        .from(nativeRuns)
        .where(
          sql`${nativeRuns.id} = ${input.id}::uuid or ${nativeRuns.turnId} = ${input.turnId}::uuid`,
        );
      if (existing !== undefined) return { kind: "already_exists" };
      const inserted = await tx
        .insert(nativeRuns)
        .values({
          id: input.id,
          requestId: request.id,
          turnId: input.turnId,
          projectId: scope.projectId,
          accountId: target.accountId,
          workerId: input.workerId,
          tokenHash: hash(token),
          binding,
          phase: "intent",
        })
        .onConflictDoNothing()
        .returning({ id: nativeRuns.id });
      return inserted.length === 0
        ? { kind: "busy" }
        : { kind: "created", handle: { id: input.id, token }, binding };
    });
  }

  async started(
    handle: NativeRunHandle,
    input: Parameters<NativeRunStore["started"]>[1],
  ): Promise<boolean> {
    const parsed = Receipt.safeParse(input);
    if (!parsed.success || JSON.stringify(input).length > 1_048_576) return false;
    return this.db.transaction(async (tx) => {
      const run = await this.#run(tx, handle, true);
      if (run === null) return false;
      if (run.phase === "started")
        return (
          run.nativeSessionId === input.nativeSessionId &&
          JSON.stringify(SealedProviderCredentialsSchema.parse(run.receipt)) ===
            JSON.stringify(parsed.data.receipt)
        );
      if (run.phase !== "intent") return false;
      await tx
        .update(nativeRuns)
        .set({
          phase: "started",
          nativeSessionId: parsed.data.nativeSessionId,
          receipt: parsed.data.receipt,
        })
        .where(eq(nativeRuns.id, run.id));
      return true;
    });
  }

  async uncertain(handle: NativeRunHandle): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const run = await this.#run(tx, handle, false);
      if (run === null || (run.phase !== "intent" && run.phase !== "start_uncertain")) return false;
      await tx
        .update(nativeRuns)
        .set({ phase: "start_uncertain" })
        .where(eq(nativeRuns.id, run.id));
      return true;
    });
  }

  async read(handle: NativeRunHandle): Promise<NativeRunRecord | null> {
    return this.db.transaction(async (tx) => {
      const row = await this.#run(tx, handle, true);
      if (row === null) return null;
      const base = { binding: Binding.parse(row.binding), cursor: row.cursor };
      switch (row.phase) {
        case "intent":
        case "start_uncertain":
          return { ...base, phase: row.phase };
        case "started":
          return {
            ...base,
            phase: "started",
            ...Receipt.parse({ nativeSessionId: row.nativeSessionId, receipt: row.receipt }),
          };
        case "stopped":
          return { ...base, phase: "stopped", proof: Proof.parse(row.proof) };
      }
    });
  }

  async append(
    handle: NativeRunHandle,
    input: NativeDelivery,
  ): ReturnType<NativeRunStore["append"]> {
    const parsed = Delivery.safeParse(input);
    const deliveryBytes = Buffer.byteLength(JSON.stringify(input), "utf8");
    if (!parsed.success || deliveryBytes > 1_048_576) return { kind: "denied" };
    const parsedEvents = input.events.map((event) =>
      NapEventSchema.safeParse({ ...event, seq: 1 }),
    );
    if (parsedEvents.some((event) => !event.success)) return { kind: "denied" };
    const pending = parsedEvents.flatMap((event) => {
      if (!event.success) return [];
      const { seq: _seq, ...value } = event.data;
      return [{ ...value, createdAt: new Date(value.createdAt).toISOString() }];
    });
    const eventHash = hash(JSON.stringify(pending));
    return this.db.transaction(async (tx) => {
      const run = await this.#run(tx, handle, true);
      if (run === null || run.phase !== "started") return { kind: "denied" };
      const binding = Binding.parse(run.binding);
      if (
        pending.some(
          (event) => event.sessionId !== binding.sessionId || event.turnId !== binding.turnId,
        )
      )
        return { kind: "denied" };
      const [existing] = await tx
        .select()
        .from(nativeDeliveries)
        .where(
          and(eq(nativeDeliveries.runId, run.id), eq(nativeDeliveries.sequence, input.sequence)),
        );
      if (existing !== undefined) {
        if (existing.rawHash !== input.rawHash || existing.eventHash !== eventHash)
          return { kind: "conflict" };
        return { kind: "duplicate", delivery: await this.#delivery(tx, run, existing) };
      }
      if (input.sequence !== run.cursor + 1) return { kind: "out_of_order" };
      if (run.deliveryBytes + deliveryBytes > 67_108_864 || input.sequence > 100_000)
        return { kind: "limit_exceeded" };
      // Share the ordinary event store's lock, so API/system events cannot race max(seq).
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${binding.sessionId}))`);
      const stored: StoredEvent[] = [];
      for (const event of pending) {
        const [inserted] = await tx
          .insert(events)
          .values({
            ...event,
            createdAt: new Date(event.createdAt),
            seq: sql`(select coalesce(max(${events.seq}), 0) + 1 from ${events} where ${events.sessionId} = ${binding.sessionId}::uuid)`,
          })
          .returning();
        if (inserted === undefined) throw new Error("Native event append returned no row");
        stored.push(toEvent(inserted));
      }
      await tx.insert(nativeDeliveries).values({
        runId: run.id,
        sequence: input.sequence,
        rawHash: input.rawHash,
        raw: parsed.data.raw,
        eventHash,
        eventSequences: stored.map((event) => event.seq),
      });
      await tx
        .update(nativeRuns)
        .set({ cursor: input.sequence, deliveryBytes: run.deliveryBytes + deliveryBytes })
        .where(eq(nativeRuns.id, run.id));
      return {
        kind: "appended",
        delivery: {
          sequence: input.sequence,
          rawHash: input.rawHash,
          raw: parsed.data.raw,
          events: stored,
        },
      };
    });
  }

  async deliveries(
    handle: NativeRunHandle,
    afterSequence: number,
  ): Promise<StoredNativeDelivery[] | null> {
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) return null;
    return this.db.transaction(async (tx) => {
      const run = await this.#run(tx, handle, true);
      if (run === null || afterSequence > run.cursor) return null;
      const rows = await tx
        .select()
        .from(nativeDeliveries)
        .where(
          and(eq(nativeDeliveries.runId, run.id), gt(nativeDeliveries.sequence, afterSequence)),
        )
        .orderBy(asc(nativeDeliveries.sequence));
      const result: StoredNativeDelivery[] = [];
      for (const row of rows) result.push(await this.#delivery(tx, run, row));
      return result;
    });
  }

  async stopped(
    handle: NativeRunHandle,
    proof: Parameters<NativeRunStore["stopped"]>[1],
  ): Promise<boolean> {
    const parsed = Proof.safeParse(proof);
    if (!parsed.success) return false;
    return this.db.transaction(async (tx) => {
      const run = await this.#run(tx, handle, false);
      if (run === null) return false;
      if (run.phase === "stopped")
        return JSON.stringify(Proof.parse(run.proof)) === JSON.stringify(parsed.data);
      await tx
        .update(nativeRuns)
        .set({ phase: "stopped", proof: parsed.data, receipt: null })
        .where(eq(nativeRuns.id, run.id));
      return true;
    });
  }

  async #run(tx: Transaction, handle: NativeRunHandle, authorize: boolean): Promise<RunRow | null> {
    if (!Handle.safeParse(handle).success) return null;
    const [run] = await tx
      .select()
      .from(nativeRuns)
      .where(and(eq(nativeRuns.id, handle.id), eq(nativeRuns.tokenHash, hash(handle.token))))
      .for("update");
    if (run === undefined) return null;
    const binding = Binding.parse(run.binding);
    if (!authorize) return run;
    const [request] = await tx
      .select({ id: turnRequests.id, target: turnRequests.target })
      .from(turnRequests)
      .innerJoin(sessions, eq(sessions.id, turnRequests.sessionId))
      .innerJoin(projects, eq(projects.id, sessions.projectId))
      .innerJoin(users, eq(users.id, projects.userId))
      .where(
        and(
          eq(turnRequests.id, binding.requestId),
          eq(turnRequests.userId, binding.userId),
          eq(turnRequests.sessionId, binding.sessionId),
          eq(projects.id, binding.projectId),
          eq(projects.userId, binding.userId),
          eq(users.isAnonymous, false),
          eq(turnRequests.leaseOwner, run.workerId),
          eq(turnRequests.state, "leased"),
          eq(turnRequests.cancelRequested, false),
          gt(turnRequests.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .for("share");
    return request !== undefined &&
      sameExecutionTarget(ExecutionTargetSchema.parse(request.target), binding.target) &&
      (await this.#authorized(tx, binding))
      ? run
      : null;
  }

  async #authorized(tx: Transaction, binding: NativeRunRecord["binding"]): Promise<boolean> {
    const [account] = await tx
      .select({ id: providerAccounts.id })
      .from(providerAccounts)
      .innerJoin(providerCredentials, eq(providerCredentials.accountId, providerAccounts.id))
      .where(
        and(
          eq(providerAccounts.id, binding.target.accountId),
          eq(providerAccounts.userId, binding.userId),
          eq(providerAccounts.driver, binding.target.driver),
          eq(providerAccounts.enabled, true),
          eq(providerAccounts.authStatus, "authenticated"),
          eq(providerCredentials.generation, binding.target.generation),
          sql`${providerCredentials.ciphertext} is not null`,
        ),
      )
      .for("share");
    if (account === undefined) return false;
    const [refresh] = await tx
      .select({ id: providerCredentialRefreshes.accountId })
      .from(providerCredentialRefreshes)
      .where(eq(providerCredentialRefreshes.accountId, account.id));
    return refresh === undefined;
  }

  async #delivery(tx: Transaction, run: RunRow, row: DeliveryRow): Promise<StoredNativeDelivery> {
    const binding = Binding.parse(run.binding);
    const sequences = z.array(z.int().positive()).max(256).parse(row.eventSequences);
    const stored =
      sequences.length === 0
        ? []
        : await tx
            .select()
            .from(events)
            .where(and(eq(events.sessionId, binding.sessionId), inArray(events.seq, sequences)))
            .orderBy(asc(events.seq));
    if (stored.length !== sequences.length)
      throw new Error("Native delivery lost its durable events");
    return {
      sequence: row.sequence,
      rawHash: row.rawHash,
      raw: SealedProviderCredentialsSchema.parse(row.raw),
      events: stored.map(toEvent),
    };
  }
}
