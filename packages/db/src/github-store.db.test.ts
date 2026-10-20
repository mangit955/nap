import { randomUUID } from "node:crypto";
import type {
  GitHubInstallation,
  ProjectRepository,
  RepositoryFeedback,
  RepositoryJob,
} from "@nap/shared/github-protocol";
import type { ImportRepository } from "@nap/shared/ports/github-store";
import type { EnqueueTurnRequest } from "@nap/shared/ports/turn-queue";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { PostgresGitHubStore } from "./github-store.ts";
import {
  githubDeliveries,
  githubInstallations,
  projectRepositories,
  projects,
  repositoryFeedback,
  sessions,
  turnRequests,
  users,
} from "./schema.ts";

let connection: postgres.Sql;
let db: PostgresJsDatabase;
let store: PostgresGitHubStore;
let owner: string;
let stranger: string;
let nextInstallationId = 700_000;

beforeAll(async () => {
  connection = postgres(inject("postgresUrl"), { max: 8 });
  db = drizzle(connection);
  store = new PostgresGitHubStore(db);
  const seeded = await db
    .insert(users)
    .values([
      { email: `${randomUUID()}@example.com`, name: "Owner" },
      { email: `${randomUUID()}@example.com`, name: "Stranger" },
    ])
    .returning();
  owner = seeded[0]?.id ?? "";
  stranger = seeded[1]?.id ?? "";
});

beforeEach(async () => {
  await db.delete(githubDeliveries);
});
afterAll(async () => {
  // Approval enqueues real turn requests, and feedback rows pin them by foreign key. Later files
  // in the run clear the queue or claim its oldest row, so this file takes its own rows back.
  await db.delete(repositoryFeedback);
  await db.delete(turnRequests).where(inArray(turnRequests.userId, [owner, stranger]));
  await connection.end();
});

async function connect(userId = owner): Promise<GitHubInstallation> {
  const installation: GitHubInstallation = {
    installationId: nextInstallationId++,
    userId,
    githubUserId: nextInstallationId++,
    githubLogin: "owner",
    accountLogin: "repo-owner",
    accountType: "Organization",
    status: "active",
  };
  expect(await store.bindInstallation(installation)).toBe(true);
  return installation;
}

function importInput(installation: GitHubInstallation): ImportRepository {
  return {
    userId: installation.userId,
    installationId: installation.installationId,
    name: "Imported app",
    repository: {
      id: nextInstallationId++,
      fullName: "repo-owner/app",
      defaultBranch: "main",
      private: true,
    },
    baseBranch: "feature/base",
    environment: { setupCommand: "bun install", devCommand: null, previewPort: null },
    autoPublish: true,
  };
}

async function imported(userId = owner): Promise<ProjectRepository> {
  const installation = await connect(userId);
  const repository = await store.importRepository(importInput(installation));
  if (repository === null) throw new Error("Fixture import failed");
  return repository;
}

function newJob(repository: ProjectRepository): RepositoryJob {
  const jobId = randomUUID();
  return {
    jobId,
    projectId: repository.projectId,
    sessionId: repository.sessionId,
    baseBranch: repository.baseBranch,
    headBranch: `nap/${jobId}`,
    baseSha: "a".repeat(40),
    headSha: null,
    pushedSha: null,
    pullRequestNumber: null,
    pullRequestUrl: null,
    pullRequestState: "none",
    publishState: "working",
    checkState: "unknown",
    reviewState: "unknown",
    error: null,
    updatedAt: new Date().toISOString(),
  };
}

async function feedbackFixture(): Promise<{
  repository: ProjectRepository;
  job: RepositoryJob;
  feedback: RepositoryFeedback;
}> {
  const repository = await imported();
  const job = await store.createJob(newJob(repository));
  const feedback: RepositoryFeedback = {
    id: `comment:${randomUUID()}`,
    projectId: repository.projectId,
    jobId: job.jobId,
    kind: "comment",
    summary: "Please fix the failing check.",
    requestId: null,
    createdAt: new Date().toISOString(),
  };
  expect(await store.addFeedback(feedback)).toBe(true);
  return { repository, job, feedback };
}

function request(repository: ProjectRepository): EnqueueTurnRequest {
  return {
    id: randomUUID(),
    sessionId: repository.sessionId,
    userId: repository.userId,
    kind: "turn",
    message: "Address reviewed feedback",
    model: "test-model",
    billsToUser: false,
  };
}

describe("GitHub callback binding", () => {
  it("consumes a state once across competing callbacks and binds it to both owner and stage", async () => {
    const state = {
      hash: randomUUID(),
      userId: owner,
      installationId: null,
      stage: "install" as const,
      expiresAt: new Date(Date.now() + 60_000),
    };
    await store.createState(state);
    expect(await store.consumeState(state.hash, stranger, "install")).toBeNull();
    expect(await store.consumeState(state.hash, owner, "authorize")).toBeNull();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.consumeState(state.hash, owner, "install")),
    );
    expect(results.filter(Boolean)).toEqual([{ ...state, draftId: null }]);
  });

  it("rejects expired state without binding an installation", async () => {
    const hash = randomUUID();
    await store.createState({
      hash,
      userId: owner,
      installationId: 123,
      stage: "authorize",
      expiresAt: new Date(0),
    });
    expect(await store.consumeState(hash, owner, "authorize")).toBeNull();
  });

  it("allows exactly one owner to bind an installation under a race", async () => {
    const value: GitHubInstallation = {
      installationId: nextInstallationId++,
      userId: owner,
      githubUserId: 321,
      githubLogin: "alice",
      accountLogin: "org",
      accountType: "Organization",
      status: "active",
    };
    const result = await Promise.all([
      store.bindInstallation(value),
      store.bindInstallation({ ...value, userId: stranger }),
    ]);
    expect(result.filter(Boolean)).toHaveLength(1);
    const winner = result[0] ? owner : stranger;
    const loser = result[0] ? stranger : owner;
    expect(await store.installation(winner, value.installationId)).not.toBeNull();
    expect(await store.installation(loser, value.installationId)).toBeNull();
    expect(
      (await store.listInstallations(loser)).some(
        (item) => item.installationId === value.installationId,
      ),
    ).toBe(false);
  });

  it("preserves the owner after disconnect and requires a fresh authorized bind to reconnect", async () => {
    const installation = await connect();
    expect(await store.disconnect(stranger, installation.installationId)).toBe(false);
    expect(await store.disconnect(owner, installation.installationId)).toBe(true);
    expect(await store.bindInstallation({ ...installation, userId: stranger })).toBe(false);
    await store.setInstallationStatus(installation.installationId, "active");
    expect((await store.installation(owner, installation.installationId))?.status).toBe(
      "disconnected",
    );
    expect(await store.bindInstallation(installation)).toBe(true);
    expect((await store.installation(owner, installation.installationId))?.status).toBe("active");
  });
});

describe("repository ownership and import", () => {
  it("saves environment changes only for the owner without changing the active sandbox", async () => {
    const repository = await imported();
    const environment = {
      setupCommand: "npm ci",
      devCommand: "npm run dev -- --host",
      previewPort: 3000,
    };
    await db
      .update(projects)
      .set({ sandboxId: "active-sandbox", status: "ready" })
      .where(eq(projects.id, repository.projectId));
    expect(await store.updateEnvironment(repository.projectId, stranger, environment)).toBe(false);
    expect((await store.repository(repository.projectId, owner))?.environment).toEqual(
      repository.environment,
    );
    expect(await store.updateEnvironment(repository.projectId, owner, environment)).toBe(true);
    expect(await store.repository(repository.projectId, owner)).toEqual({
      ...repository,
      environment,
    });
    expect(
      await db.select().from(projects).where(eq(projects.id, repository.projectId)),
    ).toMatchObject([{ sandboxId: "active-sandbox", status: "ready" }]);
    expect(await store.updateEnvironment(randomUUID(), owner, environment)).toBe(false);
  });

  it("refreshes renamed repository metadata only under the matching installation and numeric repository identity", async () => {
    const repository = await imported();
    const secondInstallation = await connect(stranger);
    const otherOwner = await store.importRepository({
      ...importInput(secondInstallation),
      repository: repository.repository,
    });
    const differentRepo = await store.importRepository({
      userId: owner,
      installationId: repository.installationId,
      name: "Different repository",
      repository: { ...repository.repository, id: nextInstallationId++ },
      baseBranch: "main",
      environment: repository.environment,
      autoPublish: true,
    });
    if (otherOwner === null || differentRepo === null) throw new Error("Expected fixture imports");
    const renamed = {
      ...repository.repository,
      fullName: "new-owner/renamed",
      private: false,
      defaultBranch: "trunk",
    };
    await store.refreshRepository(repository.installationId, renamed);
    expect(await store.repository(repository.projectId, owner)).toEqual({
      ...repository,
      repository: renamed,
    });
    expect(await store.repository(otherOwner.projectId, stranger)).toEqual(otherOwner);
    expect(await store.repository(differentRepo.projectId, owner)).toEqual(differentRepo);
    await store.refreshRepository(repository.installationId, {
      ...renamed,
      id: nextInstallationId++,
    });
    expect((await store.repository(repository.projectId, owner))?.repository).toEqual(renamed);
  });

  it("atomically admits the initial resume with an import and rolls the project back if admission fails", async () => {
    const installation = await connect();
    const input = importInput(installation);
    const open = { requestId: randomUUID(), model: "test-model" };
    const repository = await store.importRepository({ ...input, open });
    if (repository === null) throw new Error("Expected owned import");
    expect(
      await db.select().from(turnRequests).where(eq(turnRequests.id, open.requestId)),
    ).toMatchObject([
      {
        sessionId: repository.sessionId,
        userId: owner,
        kind: "resume",
        message: null,
        model: "test-model",
        billsToUser: false,
        state: "queued",
      },
    ]);
    await expect(
      store.importRepository({ ...input, name: "Another project", open }),
    ).rejects.toThrow();
    expect(await store.repositoriesForInstallation(installation.installationId)).toEqual([
      repository,
    ]);
    const orphaned = await db
      .select()
      .from(projects)
      .where(and(eq(projects.userId, owner), eq(projects.name, "Another project")));
    expect(orphaned).toEqual([]);
  });

  it("creates the project, canonical session and repository together", async () => {
    const repository = await imported();
    expect(await store.repository(repository.projectId, owner)).toEqual(repository);
    expect(await store.repository(repository.projectId, stranger)).toBeNull();
    expect(await store.repositoriesForInstallation(repository.installationId)).toEqual([
      repository,
    ]);
    expect(
      await db.select().from(projects).where(eq(projects.id, repository.projectId)),
    ).toMatchObject([{ userId: owner, status: "creating", sandboxId: null }]);
    expect(
      await db.select().from(sessions).where(eq(sessions.projectId, repository.projectId)),
    ).toMatchObject([{ id: repository.sessionId }]);
  });

  it("does not import through another owner's installation or a revoked installation", async () => {
    const installation = await connect();
    const input = importInput(installation);
    expect(await store.importRepository({ ...input, userId: stranger })).toBeNull();
    for (const status of ["suspended", "removed", "disconnected"] as const) {
      await store.setInstallationStatus(installation.installationId, status);
      expect(await store.importRepository(input)).toBeNull();
    }
    expect(await store.repositoriesForInstallation(installation.installationId)).toEqual([]);
  });

  it("retains local project associations and history when access disappears", async () => {
    const repository = await imported();
    const job = await store.createJob(newJob(repository));
    await store.setInstallationStatus(repository.installationId, "removed");
    expect(await store.repository(repository.projectId, owner)).toEqual(repository);
    expect(await store.jobs(repository.projectId, owner)).toEqual([job]);
    expect(await store.jobs(repository.projectId, stranger)).toEqual([]);
  });

  it("validates JSON crossing back out of the database", async () => {
    const repository = await imported();
    await db
      .update(projectRepositories)
      .set({ environment: { setupCommand: 42 } })
      .where(eq(projectRepositories.projectId, repository.projectId));
    await expect(store.repository(repository.projectId, owner)).rejects.toThrow();
  });
});

describe("repository job identity", () => {
  it("replays creation without replacing a successful push or linked PR", async () => {
    const repository = await imported();
    const original = newJob(repository);
    await store.createJob(original);
    await store.updateJob(original.jobId, {
      pushedSha: "b".repeat(40),
      pullRequestNumber: 27,
      pullRequestUrl: "https://github.com/repo-owner/app/pull/27",
      publishState: "published",
    });
    const replay = await store.createJob(original);
    expect(replay).toMatchObject({
      jobId: original.jobId,
      pushedSha: "b".repeat(40),
      pullRequestNumber: 27,
      publishState: "published",
    });
  });

  it("rejects a session in another project and allows a follow-up job on its PR branch", async () => {
    const repository = await imported();
    const other = await imported(stranger);
    const original = newJob(repository);
    await expect(store.createJob({ ...original, sessionId: other.sessionId })).rejects.toThrow(
      "must belong",
    );
    expect(await store.job(original.jobId)).toBeNull();
    await store.createJob(original);
    expect(await store.createJob({ ...original, jobId: randomUUID() })).toMatchObject({
      headBranch: original.headBranch,
    });
    await expect(store.createJob({ ...newJob(other), jobId: original.jobId })).rejects.toThrow(
      "identity conflicts",
    );
  });

  it("lists a bounded oldest-first set of open PRs due a refresh, with active access", async () => {
    // Dated long ago so the cutoff below excludes every other test's jobs in this shared database.
    const repository = await imported();
    const earlier = await store.createJob({
      ...newJob(repository),
      pullRequestNumber: 1,
      pullRequestState: "open",
      updatedAt: "2000-01-01T00:00:00.000Z",
    });
    const later = await store.createJob({
      ...newJob(repository),
      pullRequestNumber: 2,
      pullRequestState: "open",
      updatedAt: "2001-01-01T00:00:00.000Z",
    });
    const ids = async (limit: number, cutoff: string) =>
      (await store.listJobsDueRefresh(limit, new Date(cutoff))).map((job) => job.jobId);

    expect(await ids(1, "2002-01-01T00:00:00.000Z")).toEqual([earlier.jobId]);
    expect(await ids(2, "2002-01-01T00:00:00.000Z")).toEqual([earlier.jobId, later.jobId]);
    // Refreshed since the cutoff: left for a later tick.
    expect(await ids(10, "2000-06-01T00:00:00.000Z")).toEqual([earlier.jobId]);

    // A follow-up on the first PR supersedes it, even when the older job was refreshed more
    // recently — which is exactly when ordering by `updated_at` would pick the wrong one.
    const followUp = await store.createJob({
      ...earlier,
      jobId: randomUUID(),
      updatedAt: "1999-01-01T00:00:00.000Z",
    });
    expect(await ids(10, "2002-01-01T00:00:00.000Z")).toEqual([followUp.jobId, later.jobId]);
    expect((await store.jobs(repository.projectId, owner)).map((job) => job.jobId)).toEqual([
      followUp.jobId,
      later.jobId,
      earlier.jobId,
    ]);

    await store.disconnect(owner, repository.installationId);
    expect(await ids(10, "2002-01-01T00:00:00.000Z")).toEqual([]);
  });
});

describe("feedback admission", () => {
  it("discards only stale pending feedback for this job and retains approved records for replay", async () => {
    const { repository, job, feedback } = await feedbackFixture();
    const approved = request(repository);
    await store.approveFeedback(repository.projectId, owner, feedback.id, approved);
    const current = { ...feedback, id: `comment:${randomUUID()}` };
    const stale = { ...feedback, id: `comment:${randomUUID()}` };
    await store.addFeedback(current);
    await store.addFeedback(stale);
    const otherJob = await store.createJob(newJob(repository));
    const other = { ...feedback, id: `comment:${randomUUID()}`, jobId: otherJob.jobId };
    await store.addFeedback(other);
    await store.discardStaleFeedback(job.jobId, [current.id]);
    expect(await store.feedback(repository.projectId, owner, current.id)).toEqual(current);
    expect(await store.feedback(repository.projectId, owner, stale.id)).toBeNull();
    expect(await store.feedback(repository.projectId, owner, feedback.id)).toMatchObject({
      requestId: approved.id,
    });
    expect(await store.feedback(repository.projectId, owner, other.id)).toEqual(other);
    await store.discardStaleFeedback(job.jobId, []);
    expect(await store.feedback(repository.projectId, owner, current.id)).toBeNull();
    expect(
      await store.approveFeedback(repository.projectId, owner, feedback.id, request(repository)),
    ).toBe(approved.id);
    expect(await store.feedback(repository.projectId, owner, other.id)).toEqual(other);
  });

  it("serializes stale cleanup against approval without losing a successfully queued request's record", async () => {
    const { repository, job, feedback } = await feedbackFixture();
    const queued = request(repository);
    const [approved] = await Promise.all([
      store.approveFeedback(repository.projectId, owner, feedback.id, queued),
      store.discardStaleFeedback(job.jobId, []),
    ]);
    const rows = await db.select().from(turnRequests).where(eq(turnRequests.id, queued.id));
    if (approved === null) {
      expect(rows).toEqual([]);
      expect(await store.feedback(repository.projectId, owner, feedback.id)).toBeNull();
    } else {
      expect(rows).toHaveLength(1);
      expect(await store.feedback(repository.projectId, owner, feedback.id)).toMatchObject({
        requestId: approved,
      });
    }
  });

  it("serializes admission after a revocation already holding the installation lock", async () => {
    const { repository, feedback } = await feedbackFixture();
    const locked = deferred();
    const revoke = deferred();
    const revocation = db.transaction(async (tx) => {
      await tx
        .select()
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, repository.installationId))
        .for("update");
      locked.resolve();
      await revoke.promise;
      await tx
        .update(githubInstallations)
        .set({ status: "disconnected" })
        .where(eq(githubInstallations.installationId, repository.installationId));
    });
    await locked.promise;
    const approval = store.approveFeedback(
      repository.projectId,
      owner,
      feedback.id,
      request(repository),
    );
    const importing = store.importRepository(
      importInput({
        installationId: repository.installationId,
        userId: owner,
        githubUserId: 1,
        githubLogin: "owner",
        accountLogin: "repo-owner",
        accountType: "Organization",
        status: "active",
      }),
    );
    revoke.resolve();
    await revocation;
    expect(await approval).toBeNull();
    expect(await importing).toBeNull();
    expect(
      await db.select().from(turnRequests).where(eq(turnRequests.sessionId, repository.sessionId)),
    ).toEqual([]);
  });

  it("deduplicates deliveries and atomically enqueues exactly one approved request across retries", async () => {
    const { repository, feedback } = await feedbackFixture();
    expect(await store.addFeedback({ ...feedback, summary: "Do something else" })).toBe(false);
    const requests = Array.from({ length: 8 }, () => request(repository));
    const approved = await Promise.all(
      requests.map((item) => store.approveFeedback(repository.projectId, owner, feedback.id, item)),
    );
    expect(new Set(approved).size).toBe(1);
    expect(approved[0]).not.toBeNull();
    const queued = await db
      .select()
      .from(turnRequests)
      .where(eq(turnRequests.sessionId, repository.sessionId));
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      id: approved[0],
      kind: "turn",
      userId: owner,
      message: "Address reviewed feedback",
    });
    expect(await store.feedback(repository.projectId, owner, feedback.id)).toMatchObject({
      requestId: approved[0],
      summary: feedback.summary,
    });
  });

  it("rejects other owners, projects, sessions and revoked access", async () => {
    const { repository, feedback } = await feedbackFixture();
    const other = await imported(stranger);
    expect(await store.feedback(repository.projectId, stranger, feedback.id)).toBeNull();
    expect(await store.feedbackForProject(repository.projectId, stranger)).toEqual([]);
    expect(
      await store.approveFeedback(repository.projectId, stranger, feedback.id, request(other)),
    ).toBeNull();
    expect(
      await store.approveFeedback(other.projectId, stranger, feedback.id, request(other)),
    ).toBeNull();
    expect(
      await store.approveFeedback(repository.projectId, owner, feedback.id, {
        ...request(repository),
        sessionId: other.sessionId,
      }),
    ).toBeNull();
    expect(
      await store.approveFeedback(repository.projectId, owner, feedback.id, {
        ...request(repository),
        userId: stranger,
      }),
    ).toBeNull();
    await store.setInstallationStatus(repository.installationId, "suspended");
    expect(
      await store.approveFeedback(repository.projectId, owner, feedback.id, request(repository)),
    ).toBeNull();
    expect(
      await db.select().from(turnRequests).where(eq(turnRequests.sessionId, repository.sessionId)),
    ).toEqual([]);
  });

  it("rolls approval back if queue admission fails, so a retry can still work", async () => {
    const { repository, feedback } = await feedbackFixture();
    const existing = request(repository);
    await db.insert(turnRequests).values(existing);
    await expect(
      store.approveFeedback(repository.projectId, owner, feedback.id, existing),
    ).rejects.toThrow();
    expect((await store.feedback(repository.projectId, owner, feedback.id))?.requestId).toBeNull();
    const retry = request(repository);
    expect(await store.approveFeedback(repository.projectId, owner, feedback.id, retry)).toBe(
      retry.id,
    );
  });

  it("rejects feedback falsely attached to another project", async () => {
    const { feedback } = await feedbackFixture();
    const other = await imported(stranger);
    await expect(
      store.addFeedback({ ...feedback, id: randomUUID(), projectId: other.projectId }),
    ).rejects.toThrow("must belong");
  });

  it("deleting a project removes repository work and approved feedback through foreign keys", async () => {
    const { repository, job, feedback } = await feedbackFixture();
    await store.approveFeedback(repository.projectId, owner, feedback.id, request(repository));
    await db.delete(projects).where(eq(projects.id, repository.projectId));
    expect(await store.job(job.jobId)).toBeNull();
    expect(
      await db.select().from(repositoryFeedback).where(eq(repositoryFeedback.id, feedback.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(projectRepositories)
        .where(eq(projectRepositories.projectId, repository.projectId)),
    ).toEqual([]);
    expect(await store.installation(owner, repository.installationId)).not.toBeNull();
  });
});

describe("durable webhook inbox", () => {
  it("deduplicates globally without replacing a signed delivery payload", async () => {
    const delivery = {
      id: randomUUID(),
      event: "installation",
      payload: { action: "deleted", installation: { id: 777 } },
    };
    const writes = await Promise.all(
      Array.from({ length: 8 }, () => store.receiveDelivery(delivery)),
    );
    expect(writes.filter(Boolean)).toHaveLength(1);
    expect(await store.receiveDelivery({ ...delivery, payload: { action: "created" } })).toBe(
      false,
    );
    expect(await store.claimDelivery()).toMatchObject({ ...delivery, attempts: 1 });
  });

  it("allows one claim per delivery and fences a worker after its lease is reclaimed", async () => {
    const delivery = { id: randomUUID(), event: "pull_request", payload: { number: 12 } };
    await store.receiveDelivery(delivery);
    const claims = await Promise.all(Array.from({ length: 8 }, () => store.claimDelivery()));
    expect(claims.filter(Boolean)).toHaveLength(1);
    await db
      .update(githubDeliveries)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(githubDeliveries.id, delivery.id));
    expect(await store.claimDelivery()).toMatchObject({ id: delivery.id, attempts: 2 });
    await store.finishDelivery(delivery.id, 1);
    expect(
      await db.select().from(githubDeliveries).where(eq(githubDeliveries.id, delivery.id)),
    ).toMatchObject([{ state: "processing", attempts: 2 }]);
    await store.finishDelivery(delivery.id, 2);
    expect(await store.claimDelivery()).toBeNull();
    expect(
      await db.select().from(githubDeliveries).where(eq(githubDeliveries.id, delivery.id)),
    ).toMatchObject([{ state: "done", leaseExpiresAt: null }]);
  });

  it("renews a lease the attempt still holds, and never one that lapsed or moved on", async () => {
    const delivery = { id: randomUUID(), event: "check_run", payload: {} };
    await store.receiveDelivery(delivery);
    expect(await store.claimDelivery()).toMatchObject({ id: delivery.id, attempts: 1 });
    await db
      .update(githubDeliveries)
      .set({ leaseExpiresAt: sql`now() + interval '1 second'` })
      .where(eq(githubDeliveries.id, delivery.id));

    expect(await store.renewDelivery(delivery.id, 1)).toBe(true);
    const [renewed] = await db
      .select({
        outlivesHalfAMinute: sql<boolean>`lease_expires_at > now() + interval '30 seconds'`,
      })
      .from(githubDeliveries)
      .where(eq(githubDeliveries.id, delivery.id));
    expect(renewed?.outlivesHalfAMinute).toBe(true);

    await db
      .update(githubDeliveries)
      .set({ leaseExpiresAt: new Date(0) })
      .where(eq(githubDeliveries.id, delivery.id));
    expect(await store.renewDelivery(delivery.id, 1)).toBe(false);
    expect(await store.claimDelivery()).toMatchObject({ id: delivery.id, attempts: 2 });
    expect(await store.renewDelivery(delivery.id, 1)).toBe(false);
    expect(await store.renewDelivery(delivery.id, 2)).toBe(true);
    await store.finishDelivery(delivery.id, 2);
    expect(await store.renewDelivery(delivery.id, 2)).toBe(false);
  });

  it("backs failures off and stops retrying after five attempts", async () => {
    const id = randomUUID();
    await store.receiveDelivery({ id, event: "check_run", payload: {} });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await store.claimDelivery()).toMatchObject({ id, attempts: attempt });
      await store.finishDelivery(id, attempt, "GitHub unavailable");
      expect(await store.claimDelivery()).toBeNull();
      await db
        .update(githubDeliveries)
        .set({ nextAttemptAt: new Date(0) })
        .where(eq(githubDeliveries.id, id));
    }
    expect(await store.claimDelivery()).toBeNull();
    expect(
      await db.select().from(githubDeliveries).where(eq(githubDeliveries.id, id)),
    ).toMatchObject([{ state: "failed", attempts: 5 }]);
  });

  it("closes a delivery when the worker dies on its last attempt", async () => {
    const id = randomUUID();
    await store.receiveDelivery({ id, event: "installation", payload: {} });
    await db
      .update(githubDeliveries)
      .set({ state: "processing", attempts: 5, leaseExpiresAt: new Date(0) })
      .where(eq(githubDeliveries.id, id));
    expect(await store.claimDelivery()).toBeNull();
    expect(
      await db
        .select()
        .from(githubDeliveries)
        .where(and(eq(githubDeliveries.id, id), eq(githubDeliveries.state, "failed"))),
    ).toHaveLength(1);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
