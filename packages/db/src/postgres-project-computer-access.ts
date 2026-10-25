import { ScopeDrainProofSchema } from "@nap/shared/ports/desktop-input-transport";
import {
  type ComputerAdmissionError,
  type ComputerReservation,
  type ComputerReservationRequest,
  ComputerReservationRequestSchema,
  ComputerReservationSchema,
  type ComputerScopeIdentity,
  type ProjectComputerAccess,
} from "@nap/shared/ports/project-computer-access";
import type { Result } from "@nap/shared/result";
import { and, eq, ne, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { projectComputerOperations, projects, sessions, turnRequests } from "./schema.ts";

type Row = typeof projectComputerOperations.$inferSelect;
const matches = (scope: ComputerScopeIdentity) =>
  and(
    eq(projectComputerOperations.projectId, scope.projectId),
    eq(projectComputerOperations.sandboxId, scope.sandboxId),
    eq(projectComputerOperations.scopeId, scope.scopeId),
  );
function reservation(row: Row): ComputerReservation {
  return ComputerReservationSchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    nextRecoveryAt: row.nextRecoveryAt.toISOString(),
  });
}
const denied = (code: ComputerAdmissionError["code"]): Result<never, ComputerAdmissionError> => ({
  ok: false,
  error: { code },
});

export class PostgresProjectComputerAccess implements ProjectComputerAccess {
  constructor(readonly db: PostgresJsDatabase) {}

  async occupied(projectId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: projectComputerOperations.projectId })
      .from(projectComputerOperations)
      .where(eq(projectComputerOperations.projectId, projectId))
      .limit(1);
    return row !== undefined;
  }

  async read(request: {
    projectId: string;
    userId: string;
  }): ReturnType<ProjectComputerAccess["read"]> {
    return this.db.transaction<Awaited<ReturnType<ProjectComputerAccess["read"]>>>(async (tx) => {
      const [project] = await tx
        .select({ sandboxId: projects.sandboxId, revision: projects.computerRevision })
        .from(projects)
        .where(and(eq(projects.id, request.projectId), eq(projects.userId, request.userId)))
        .for("update");
      if (!project) return denied("not_found");
      if (await new PostgresProjectComputerAccess(tx).occupied(request.projectId))
        return denied("recovery_pending");
      const leased = await tx
        .select({ id: turnRequests.id })
        .from(turnRequests)
        .innerJoin(sessions, eq(sessions.id, turnRequests.sessionId))
        .where(and(eq(sessions.projectId, request.projectId), eq(turnRequests.state, "leased")))
        .limit(1);
      return leased.length ? denied("busy") : { ok: true, value: project };
    });
  }

  async reserve(input: ComputerReservationRequest): ReturnType<ProjectComputerAccess["reserve"]> {
    const request = ComputerReservationRequestSchema.parse(input);
    // A resolved transaction includes its COMMIT acknowledgment. An exception can mean
    // COMMIT landed; callers dispatch nothing and leave any committed row for recovery.
    return this.db.transaction<Awaited<ReturnType<ProjectComputerAccess["reserve"]>>>(
      async (tx) => {
        const actor = request.actor;
        let owningSession: string | undefined;
        if (actor.kind === "turn") {
          // Claim locks request before project. Never invert that order during reservation.
          const [held] = await tx
            .select()
            .from(turnRequests)
            .where(eq(turnRequests.id, actor.lease.requestId))
            .for("update");
          if (
            !held ||
            held.state !== "leased" ||
            held.leaseOwner !== actor.lease.owner ||
            held.cancelRequested
          )
            return denied("busy");
          const [fresh] = await tx.execute<{ valid: boolean | null }>(sql`
          select ${turnRequests.leaseExpiresAt} > now() as valid
          from ${turnRequests} where ${turnRequests.id} = ${held.id}
        `);
          if (!fresh?.valid) return denied("busy");
          const [session] = await tx.select().from(sessions).where(eq(sessions.id, held.sessionId));
          if (!session || session.projectId !== request.projectId) return denied("not_found");
          owningSession = held.sessionId;
        }
        const [project] = await tx
          .select()
          .from(projects)
          .where(eq(projects.id, request.projectId))
          .for("update");
        if (!project || (actor.kind === "owner" && project.userId !== actor.binding.userId))
          return denied("not_found");
        if (await new PostgresProjectComputerAccess(tx).occupied(request.projectId))
          return denied("recovery_pending");
        if (project.sandboxId !== request.sandboxId) return denied("stale_grant");
        if (actor.kind === "owner") {
          const b = actor.binding;
          const [session] = await tx
            .select()
            .from(sessions)
            .where(and(eq(sessions.id, b.sessionId), eq(sessions.projectId, request.projectId)));
          const [clock] = await tx.execute<{ valid: boolean }>(
            sql`select to_timestamp(${b.expiresAt} / 1000.0) > now() as valid`,
          );
          if (
            !session ||
            b.projectId !== project.id ||
            b.sandboxId !== project.sandboxId ||
            b.revision !== project.computerRevision ||
            !clock?.valid
          )
            return denied("stale_grant");
        }
        const other = await tx
          .select({ id: turnRequests.id })
          .from(turnRequests)
          .innerJoin(sessions, eq(sessions.id, turnRequests.sessionId))
          .where(
            and(
              eq(sessions.projectId, project.id),
              eq(turnRequests.state, "leased"),
              owningSession === undefined ? undefined : ne(turnRequests.sessionId, owningSession),
            ),
          )
          .limit(1);
        if (other.length) return denied("busy");
        const [row] = await tx.insert(projectComputerOperations).values(request).returning();
        if (!row) throw new Error("Input reservation insert returned no row.");
        return { ok: true, value: reservation(row) };
      },
    );
  }

  async markRecovering(scope: ComputerScopeIdentity): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, scope.projectId))
        .for("update");
      const updated = await tx
        .update(projectComputerOperations)
        .set({ state: "recovering", nextRecoveryAt: sql`now()` })
        .where(matches(scope))
        .returning();
      if (updated.length)
        await tx
          .update(projects)
          .set({ computerRevision: sql`gen_random_uuid()` })
          .where(eq(projects.id, scope.projectId));
    });
  }

  async clear(request: Parameters<ProjectComputerAccess["clear"]>[0]): Promise<boolean> {
    const proof = ScopeDrainProofSchema.parse(request.proof);
    if (proof.scopeId !== request.scopeId || proof.sandboxId !== request.sandboxId) return false;
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, request.projectId))
        .for("update");
      const removed = await tx
        .delete(projectComputerOperations)
        .where(matches(request))
        .returning();
      return removed.length === 1;
    });
  }

  async recoverable(limit: number): Promise<ComputerReservation[]> {
    const rows = await this.db
      .select()
      .from(projectComputerOperations)
      .where(
        and(
          sql`${projectComputerOperations.nextRecoveryAt} <= now()`,
          sql`(${projectComputerOperations.state} = 'recovering' or ${projectComputerOperations.actor}->>'kind' = 'owner' or not exists (
        select 1 from ${turnRequests} where ${turnRequests.id}::text = ${projectComputerOperations.actor}->'lease'->>'requestId' and ${turnRequests.state} = 'leased'
      ))`,
        ),
      )
      .orderBy(projectComputerOperations.nextRecoveryAt, projectComputerOperations.projectId)
      .limit(Math.min(Math.max(1, limit), 100));
    return rows.map(reservation);
  }

  async defer(scope: ComputerScopeIdentity): Promise<void> {
    await this.db
      .update(projectComputerOperations)
      .set({ nextRecoveryAt: sql`now() + interval '60 seconds'` })
      .where(matches(scope));
  }
}
