import { randomUUID } from "node:crypto";
import {
  type GitHubInstallation,
  GitHubInstallationSchema,
  type GitHubRepository,
  GitHubRepositorySchema,
  type ProjectRepository,
  ProjectRepositorySchema,
  type RepositoryEnvironment,
  RepositoryEnvironmentSchema,
  type RepositoryFeedback,
  RepositoryFeedbackSchema,
  type RepositoryJob,
  RepositoryJobSchema,
} from "@nap/shared/github-protocol";
import type {
  ClaimedGitHubDelivery,
  GitHubConnectionState,
  GitHubDelivery,
  GitHubStore,
  ImportRepository,
  RepositoryJobUpdate,
} from "@nap/shared/ports/github-store";
import type { EnqueueTurnRequest } from "@nap/shared/ports/turn-queue";
import { and, asc, desc, eq, gt, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  githubConnectionStates,
  githubDeliveries,
  githubInstallations,
  projectRepositories,
  projects,
  repositoryFeedback,
  repositoryJobs,
  sessions,
  turnRequests,
} from "./schema.ts";

const MAX_DELIVERY_ATTEMPTS = 5;

export class PostgresGitHubStore implements GitHubStore {
  constructor(private readonly db: PostgresJsDatabase) {}

  async createState(state: GitHubConnectionState): Promise<void> {
    await this.db.insert(githubConnectionStates).values(state);
  }

  async consumeState(
    hash: string,
    userId: string,
    stage: GitHubConnectionState["stage"],
  ): Promise<GitHubConnectionState | null> {
    const [state] = await this.db
      .delete(githubConnectionStates)
      .where(
        and(
          eq(githubConnectionStates.hash, hash),
          eq(githubConnectionStates.userId, userId),
          eq(githubConnectionStates.stage, stage),
          gt(githubConnectionStates.expiresAt, sql`now()`),
        ),
      )
      .returning();
    return state ?? null;
  }

  async bindInstallation(installation: GitHubInstallation): Promise<boolean> {
    const value = GitHubInstallationSchema.parse(installation);
    const rows = await this.db
      .insert(githubInstallations)
      .values(value)
      .onConflictDoUpdate({
        target: githubInstallations.installationId,
        set: value,
        setWhere: eq(githubInstallations.userId, value.userId),
      })
      .returning({ id: githubInstallations.installationId });
    return rows.length > 0;
  }

  async listInstallations(userId: string): Promise<GitHubInstallation[]> {
    const rows = await this.db
      .select()
      .from(githubInstallations)
      .where(eq(githubInstallations.userId, userId))
      .orderBy(githubInstallations.installationId);
    return rows.map((row) => GitHubInstallationSchema.parse(row));
  }

  async installation(userId: string, installationId: number): Promise<GitHubInstallation | null> {
    const [row] = await this.db
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.installationId, installationId),
          eq(githubInstallations.userId, userId),
        ),
      );
    return row === undefined ? null : GitHubInstallationSchema.parse(row);
  }

  async setInstallationStatus(
    installationId: number,
    status: GitHubInstallation["status"],
  ): Promise<void> {
    await this.db
      .update(githubInstallations)
      .set({ status })
      .where(
        and(
          eq(githubInstallations.installationId, installationId),
          // Only a new authorized connection may undo an explicit disconnect.
          ne(githubInstallations.status, "disconnected"),
        ),
      );
  }

  async disconnect(userId: string, installationId: number): Promise<boolean> {
    const rows = await this.db
      .update(githubInstallations)
      .set({ status: "disconnected" })
      .where(
        and(
          eq(githubInstallations.installationId, installationId),
          eq(githubInstallations.userId, userId),
        ),
      )
      .returning({ id: githubInstallations.installationId });
    return rows.length > 0;
  }

  async importRepository(input: ImportRepository): Promise<ProjectRepository | null> {
    return this.db.transaction(async (tx) => {
      // Serialize import against revocation, so a disconnected installation cannot admit work.
      const [installation] = await tx
        .select()
        .from(githubInstallations)
        .where(
          and(
            eq(githubInstallations.installationId, input.installationId),
            eq(githubInstallations.userId, input.userId),
            eq(githubInstallations.status, "active"),
          ),
        )
        .for("update");
      if (installation === undefined) return null;

      const projectId = randomUUID();
      const sessionId = randomUUID();
      const association = ProjectRepositorySchema.parse({ ...input, projectId, sessionId });
      await tx.insert(projects).values({
        id: projectId,
        userId: input.userId,
        name: input.name,
        slug: `github-${projectId}`,
      });
      await tx.insert(sessions).values({ id: sessionId, projectId, title: input.name });
      await tx.insert(projectRepositories).values(association);
      if (input.open !== undefined) {
        await tx.insert(turnRequests).values({
          id: input.open.requestId,
          sessionId,
          userId: input.userId,
          kind: "resume",
          message: null,
          model: input.open.model,
          billsToUser: false,
        });
      }
      return association;
    });
  }

  async repository(projectId: string, userId: string): Promise<ProjectRepository | null> {
    const [row] = await this.repositoryQuery().where(
      and(
        eq(projectRepositories.projectId, projectId),
        eq(projects.userId, userId),
        eq(githubInstallations.userId, userId),
      ),
    );
    return row === undefined
      ? null
      : ProjectRepositorySchema.parse({ ...row.repository, userId: row.userId });
  }

  async updateEnvironment(
    projectId: string,
    userId: string,
    environment: RepositoryEnvironment,
  ): Promise<boolean> {
    const rows = await this.db
      .update(projectRepositories)
      .set({ environment: RepositoryEnvironmentSchema.parse(environment) })
      .where(
        and(
          eq(projectRepositories.projectId, projectId),
          sql`exists (
        select 1 from ${projects} where ${projects.id} = ${projectRepositories.projectId} and ${projects.userId} = ${userId}
      )`,
        ),
      )
      .returning({ id: projectRepositories.projectId });
    return rows.length > 0;
  }

  async refreshRepository(installationId: number, repository: GitHubRepository): Promise<void> {
    const value = GitHubRepositorySchema.parse(repository);
    await this.db
      .update(projectRepositories)
      .set({ repository: value })
      .where(
        and(
          eq(projectRepositories.installationId, installationId),
          sql`${projectRepositories.repository}->>'id' = ${String(value.id)}`,
        ),
      );
  }

  async repositoriesForInstallation(installationId: number): Promise<ProjectRepository[]> {
    const rows = await this.repositoryQuery().where(
      eq(projectRepositories.installationId, installationId),
    );
    return rows.map((row) =>
      ProjectRepositorySchema.parse({ ...row.repository, userId: row.userId }),
    );
  }

  private repositoryQuery() {
    return this.db
      .select({ repository: projectRepositories, userId: projects.userId })
      .from(projectRepositories)
      .innerJoin(projects, eq(projects.id, projectRepositories.projectId))
      .innerJoin(
        githubInstallations,
        and(
          eq(githubInstallations.installationId, projectRepositories.installationId),
          eq(githubInstallations.userId, projects.userId),
        ),
      );
  }

  async createJob(job: RepositoryJob): Promise<RepositoryJob> {
    const value = RepositoryJobSchema.parse(job);
    return this.db.transaction(async (tx) => {
      const [repository] = await tx
        .select({ projectId: projectRepositories.projectId })
        .from(projectRepositories)
        .innerJoin(
          sessions,
          and(
            eq(sessions.projectId, projectRepositories.projectId),
            eq(sessions.id, value.sessionId),
          ),
        )
        .where(eq(projectRepositories.projectId, value.projectId));
      if (repository === undefined)
        throw new Error("Repository job must belong to a session in its project.");
      await tx
        .insert(repositoryJobs)
        .values({ ...value, updatedAt: new Date(value.updatedAt) })
        .onConflictDoNothing({ target: repositoryJobs.jobId });
      const [row] = await tx
        .select()
        .from(repositoryJobs)
        .where(eq(repositoryJobs.jobId, value.jobId));
      if (
        row === undefined ||
        row.projectId !== value.projectId ||
        row.sessionId !== value.sessionId ||
        row.headBranch !== value.headBranch
      ) {
        throw new Error("Repository job identity conflicts with existing work.");
      }
      return toJob(row);
    });
  }

  async job(jobId: string): Promise<RepositoryJob | null> {
    const [row] = await this.db
      .select()
      .from(repositoryJobs)
      .where(eq(repositoryJobs.jobId, jobId));
    return row === undefined ? null : toJob(row);
  }

  async jobs(projectId: string, userId: string): Promise<RepositoryJob[]> {
    const rows = await this.db
      .select({ job: repositoryJobs })
      .from(repositoryJobs)
      .innerJoin(projects, eq(projects.id, repositoryJobs.projectId))
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .orderBy(desc(repositoryJobs.updatedAt));
    return rows.map(({ job }) => toJob(job));
  }

  async updateJob(jobId: string, update: RepositoryJobUpdate): Promise<void> {
    await this.db
      .update(repositoryJobs)
      .set({
        ...update,
        updatedAt: update.updatedAt === undefined ? new Date() : new Date(update.updatedAt),
      })
      .where(eq(repositoryJobs.jobId, jobId));
  }

  async listReconcileJobs(limit: number): Promise<RepositoryJob[]> {
    const rows = await this.db
      .select({ job: repositoryJobs })
      .from(repositoryJobs)
      .innerJoin(projectRepositories, eq(projectRepositories.projectId, repositoryJobs.projectId))
      .innerJoin(
        githubInstallations,
        eq(githubInstallations.installationId, projectRepositories.installationId),
      )
      .where(
        and(eq(repositoryJobs.pullRequestState, "open"), eq(githubInstallations.status, "active")),
      )
      .orderBy(asc(repositoryJobs.updatedAt), asc(repositoryJobs.jobId))
      .limit(Math.max(0, Math.min(100, Math.floor(limit))));
    return rows.map(({ job }) => toJob(job));
  }

  async feedbackForProject(projectId: string, userId: string): Promise<RepositoryFeedback[]> {
    const rows = await this.db
      .select({ feedback: repositoryFeedback })
      .from(repositoryFeedback)
      .innerJoin(projects, eq(projects.id, repositoryFeedback.projectId))
      .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
      .orderBy(desc(repositoryFeedback.createdAt));
    return rows.map(({ feedback }) => toFeedback(feedback));
  }

  async feedback(
    projectId: string,
    userId: string,
    feedbackId: string,
  ): Promise<RepositoryFeedback | null> {
    const [row] = await this.db
      .select({ feedback: repositoryFeedback })
      .from(repositoryFeedback)
      .innerJoin(projects, eq(projects.id, repositoryFeedback.projectId))
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.userId, userId),
          eq(repositoryFeedback.id, feedbackId),
        ),
      );
    return row === undefined ? null : toFeedback(row.feedback);
  }

  async addFeedback(feedback: RepositoryFeedback): Promise<boolean> {
    const value = RepositoryFeedbackSchema.parse(feedback);
    const [job] = await this.db
      .select({ projectId: repositoryJobs.projectId })
      .from(repositoryJobs)
      .where(
        and(eq(repositoryJobs.jobId, value.jobId), eq(repositoryJobs.projectId, value.projectId)),
      );
    if (job === undefined || value.requestId !== null)
      throw new Error("New repository feedback must belong to its job and await approval.");
    const rows = await this.db
      .insert(repositoryFeedback)
      .values({ ...value, createdAt: new Date(value.createdAt) })
      .onConflictDoNothing({ target: repositoryFeedback.id })
      .returning({ id: repositoryFeedback.id });
    return rows.length > 0;
  }

  async discardStaleFeedback(jobId: string, keepIds: string[]): Promise<void> {
    await this.db
      .delete(repositoryFeedback)
      .where(
        and(
          eq(repositoryFeedback.jobId, jobId),
          isNull(repositoryFeedback.requestId),
          keepIds.length === 0 ? undefined : notInArray(repositoryFeedback.id, keepIds),
        ),
      );
  }

  async approveFeedback(
    projectId: string,
    userId: string,
    feedbackId: string,
    queueRequest: EnqueueTurnRequest,
  ): Promise<string | null> {
    if (queueRequest.userId !== userId || queueRequest.kind !== "turn") return null;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ feedback: repositoryFeedback, sessionId: repositoryJobs.sessionId })
        .from(repositoryFeedback)
        .innerJoin(projects, eq(projects.id, repositoryFeedback.projectId))
        .innerJoin(
          repositoryJobs,
          and(
            eq(repositoryJobs.jobId, repositoryFeedback.jobId),
            eq(repositoryJobs.projectId, projects.id),
          ),
        )
        .innerJoin(projectRepositories, eq(projectRepositories.projectId, projects.id))
        .innerJoin(
          githubInstallations,
          eq(githubInstallations.installationId, projectRepositories.installationId),
        )
        .where(
          and(
            eq(projects.id, projectId),
            eq(projects.userId, userId),
            eq(githubInstallations.userId, userId),
            eq(githubInstallations.status, "active"),
            eq(repositoryFeedback.id, feedbackId),
          ),
        )
        .for("update", { of: [repositoryFeedback, githubInstallations] });
      if (row === undefined || row.sessionId !== queueRequest.sessionId) return null;
      if (row.feedback.requestId !== null) return row.feedback.requestId;
      await tx
        .insert(turnRequests)
        .values({ ...queueRequest, attachments: queueRequest.attachments ?? null });
      await tx
        .update(repositoryFeedback)
        .set({ requestId: queueRequest.id })
        .where(eq(repositoryFeedback.id, feedbackId));
      return queueRequest.id;
    });
  }

  async receiveDelivery(delivery: GitHubDelivery): Promise<boolean> {
    const rows = await this.db
      .insert(githubDeliveries)
      .values(delivery)
      .onConflictDoNothing({ target: githubDeliveries.id })
      .returning({ id: githubDeliveries.id });
    return rows.length > 0;
  }

  async claimDelivery(): Promise<ClaimedGitHubDelivery | null> {
    return this.db.transaction(async (tx) => {
      // A crash on the last attempt cannot leave an expired lease stuck forever.
      await tx
        .update(githubDeliveries)
        .set({
          state: "failed",
          leaseExpiresAt: null,
          lastError: "Webhook processing lease expired.",
        })
        .where(
          and(
            eq(githubDeliveries.state, "processing"),
            eq(githubDeliveries.attempts, MAX_DELIVERY_ATTEMPTS),
            lt(githubDeliveries.leaseExpiresAt, sql`now()`),
          ),
        );
      const [candidate] = await tx
        .select()
        .from(githubDeliveries)
        .where(
          and(
            lt(githubDeliveries.attempts, MAX_DELIVERY_ATTEMPTS),
            or(
              and(
                eq(githubDeliveries.state, "pending"),
                lt(githubDeliveries.nextAttemptAt, sql`now()`),
              ),
              and(
                eq(githubDeliveries.state, "processing"),
                lt(githubDeliveries.leaseExpiresAt, sql`now()`),
              ),
            ),
          ),
        )
        .orderBy(asc(githubDeliveries.nextAttemptAt), asc(githubDeliveries.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (candidate === undefined) return null;
      const [claimed] = await tx
        .update(githubDeliveries)
        .set({
          state: "processing",
          attempts: candidate.attempts + 1,
          leaseExpiresAt: sql`now() + interval '60 seconds'`,
        })
        .where(eq(githubDeliveries.id, candidate.id))
        .returning();
      return claimed === undefined
        ? null
        : {
            id: claimed.id,
            event: claimed.event,
            payload: claimed.payload,
            attempts: claimed.attempts,
          };
    });
  }

  async finishDelivery(deliveryId: string, attempts: number, error?: string): Promise<void> {
    await this.db
      .update(githubDeliveries)
      .set({
        state:
          error === undefined ? "done" : attempts >= MAX_DELIVERY_ATTEMPTS ? "failed" : "pending",
        leaseExpiresAt: null,
        lastError: error ?? null,
        nextAttemptAt: sql`now() + ${Math.min(300, 2 ** attempts)} * interval '1 second'`,
      })
      .where(
        and(
          eq(githubDeliveries.id, deliveryId),
          eq(githubDeliveries.attempts, attempts),
          eq(githubDeliveries.state, "processing"),
          gt(githubDeliveries.leaseExpiresAt, sql`now()`),
        ),
      );
  }
}

function toJob(row: typeof repositoryJobs.$inferSelect): RepositoryJob {
  return RepositoryJobSchema.parse({ ...row, updatedAt: row.updatedAt.toISOString() });
}

function toFeedback(row: typeof repositoryFeedback.$inferSelect): RepositoryFeedback {
  return RepositoryFeedbackSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}
