import { randomUUID } from "node:crypto";
import { ProjectRepositorySchema } from "@nap/shared/github-protocol";
import type { ClaimAnnouncer } from "@nap/shared/ports/claim-channel";
import type {
  AdmittedSessionStart,
  SessionStartStore,
  StartReceipt,
  StartResult,
} from "@nap/shared/ports/session-start-store";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  githubInstallations,
  projectRepositories,
  projects,
  sessionStarts,
  sessions,
  turnRequests,
  users,
} from "./schema.ts";

export type PostgresSessionStartStoreOptions = {
  /**
   * Told once a start has committed its first request, because that request is the first thing a
   * new project's author is waiting on. Required and nullable for the reason it is on
   * `PostgresTurnQueue`.
   */
  // Use a pooled database: a nested transaction only commits a savepoint.
  claims: ClaimAnnouncer | null;
};

export class PostgresSessionStartStore implements SessionStartStore {
  readonly #claims: ClaimAnnouncer | null;

  constructor(
    private readonly db: PostgresJsDatabase,
    options: PostgresSessionStartStoreOptions,
  ) {
    this.#claims = options.claims;
  }

  async find(userId: string, operationId: string): Promise<StartReceipt | null> {
    const [row] = await this.db
      .select()
      .from(sessionStarts)
      .where(and(eq(sessionStarts.userId, userId), eq(sessionStarts.operationId, operationId)));
    return row === undefined
      ? null
      : {
          fingerprint: row.fingerprint,
          result:
            row.projectId === null || row.sessionId === null
              ? null
              : { projectId: row.projectId, sessionId: row.sessionId, requestId: row.requestId },
        };
  }

  async start(input: AdmittedSessionStart): Promise<StartResult> {
    const result = await this.#admit(input);
    // After the commit, and on a retry that found its earlier start as well: a wake-up that names
    // nothing new costs one claim query, and one that was lost the first time is replaced.
    if (result.kind === "created") this.#claims?.announce();
    return result;
  }

  async #admit(input: AdmittedSessionStart): Promise<StartResult> {
    return this.db.transaction(async (tx): Promise<StartResult> => {
      // A short owner lock serializes retries across API replicas. No remote work runs here.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("update");
      const [prior] = await tx
        .select()
        .from(sessionStarts)
        .where(
          and(
            eq(sessionStarts.userId, input.userId),
            eq(sessionStarts.operationId, input.operationId),
          ),
        );
      if (prior) {
        if (prior.fingerprint !== input.fingerprint) return { kind: "conflict" };
        if (prior.projectId === null || prior.sessionId === null) return { kind: "deleted" };
        return {
          kind: "created",
          projectId: prior.projectId,
          sessionId: prior.sessionId,
          requestId: prior.requestId,
        };
      }
      if (input.source.kind === "github") {
        const [installation] = await tx
          .select()
          .from(githubInstallations)
          .where(
            and(
              eq(githubInstallations.installationId, input.source.import.installationId),
              eq(githubInstallations.userId, input.userId),
              eq(githubInstallations.status, "active"),
            ),
          )
          .for("update");
        if (!installation) return { kind: "access_changed" };
      }
      const result = { projectId: randomUUID(), sessionId: randomUUID(), requestId: randomUUID() };
      await tx.insert(projects).values({
        id: result.projectId,
        userId: input.userId,
        name: input.name,
        slug: `session-${result.projectId}`,
      });
      await tx
        .insert(sessions)
        .values({ id: result.sessionId, projectId: result.projectId, title: input.name });
      if (input.source.kind === "github") {
        await tx.insert(projectRepositories).values(
          ProjectRepositorySchema.parse({
            ...input.source.import,
            projectId: result.projectId,
            sessionId: result.sessionId,
          }),
        );
      }
      // A turn acquires and prepares its source before calling the model. A repository-only
      // start uses resume, which opens the empty workspace without manufacturing a prompt.
      await tx.insert(turnRequests).values({
        ...input.request,
        id: result.requestId,
        sessionId: result.sessionId,
        userId: input.userId,
      });
      await tx.insert(sessionStarts).values({
        ...result,
        userId: input.userId,
        operationId: input.operationId,
        fingerprint: input.fingerprint,
      });
      return { kind: "created", ...result };
    });
  }
}
