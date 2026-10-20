import { randomUUID } from "node:crypto";
import type {
  GitHubInstallation,
  RepositoryFeedback,
  RepositoryJob,
} from "@nap/shared/github-protocol";
import { describe, expect, it } from "vitest";
import { InMemoryGitHubStore } from "./in-memory-github-store.ts";

async function fixture(store: InMemoryGitHubStore) {
  const installation: GitHubInstallation = {
    installationId: 123,
    userId: randomUUID(),
    githubUserId: 456,
    githubLogin: "owner",
    accountLogin: "owner",
    accountType: "User",
    status: "active",
  };
  await store.bindInstallation(installation);
  const repository = await store.importRepository({
    userId: installation.userId,
    installationId: 123,
    name: "App",
    repository: { id: 789, fullName: "owner/app", defaultBranch: "main", private: true },
    baseBranch: "main",
    environment: { setupCommand: null, devCommand: null, previewPort: null },
    autoPublish: true,
  });
  if (repository === null) throw new Error("Fixture failed to import");
  const job: RepositoryJob = {
    jobId: randomUUID(),
    projectId: repository.projectId,
    sessionId: repository.sessionId,
    baseBranch: "main",
    headBranch: "nap/change",
    baseSha: "abc",
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
  await store.createJob(job);
  const feedback: RepositoryFeedback = {
    id: "comment:1",
    projectId: repository.projectId,
    jobId: job.jobId,
    kind: "comment",
    summary: "Fix the test",
    requestId: null,
    createdAt: new Date().toISOString(),
  };
  await store.addFeedback(feedback);
  return { installation, repository, job, feedback };
}

describe("InMemoryGitHubStore", () => {
  it("keeps approved and other-job feedback while clearing stale pending feedback", async () => {
    const store = new InMemoryGitHubStore();
    const { repository, job, feedback } = await fixture(store);
    const requestId = randomUUID();
    await store.approveFeedback(repository.projectId, repository.userId, feedback.id, {
      id: requestId,
      userId: repository.userId,
      sessionId: repository.sessionId,
      kind: "turn",
      message: "Fix test",
      model: "test-model",
      billsToUser: false,
    });
    const keep = { ...feedback, id: "comment:keep" };
    await store.addFeedback(keep);
    await store.addFeedback({ ...feedback, id: "comment:stale" });
    const otherJob = { ...job, jobId: randomUUID() };
    await store.createJob(otherJob);
    const other = { ...feedback, id: "comment:other", jobId: otherJob.jobId };
    await store.addFeedback(other);
    await store.discardStaleFeedback(job.jobId, [keep.id]);
    expect(
      await store.feedback(repository.projectId, repository.userId, "comment:stale"),
    ).toBeNull();
    expect(await store.feedback(repository.projectId, repository.userId, keep.id)).toEqual(keep);
    await store.discardStaleFeedback(job.jobId, []);
    expect(await store.feedback(repository.projectId, repository.userId, keep.id)).toBeNull();
    expect(
      await store.feedback(repository.projectId, repository.userId, feedback.id),
    ).toMatchObject({ requestId });
    expect(await store.feedback(repository.projectId, repository.userId, other.id)).toEqual(other);
  });

  it("enforces environment ownership and repository identity when updating metadata", async () => {
    const store = new InMemoryGitHubStore();
    const { installation, repository } = await fixture(store);
    const environment = { setupCommand: "npm ci", devCommand: "npm run dev", previewPort: 3000 };
    expect(await store.updateEnvironment(repository.projectId, randomUUID(), environment)).toBe(
      false,
    );
    expect(
      await store.updateEnvironment(repository.projectId, installation.userId, environment),
    ).toBe(true);
    await store.refreshRepository(999, { ...repository.repository, fullName: "owner/ignored" });
    await store.refreshRepository(installation.installationId, {
      ...repository.repository,
      id: 999,
      fullName: "owner/ignored",
    });
    expect((await store.repository(repository.projectId, installation.userId))?.repository).toEqual(
      repository.repository,
    );
    await store.refreshRepository(installation.installationId, {
      ...repository.repository,
      fullName: "owner/renamed",
    });
    expect(await store.repository(repository.projectId, installation.userId)).toMatchObject({
      environment,
      repository: { fullName: "owner/renamed" },
    });
  });

  it("does not retain an import when initial queue admission fails", async () => {
    const store = new InMemoryGitHubStore({
      queue: {
        enqueue: async () => {
          throw new Error("Queue unavailable");
        },
      },
    });
    const { installation, repository } = await fixture(store);
    await expect(
      store.importRepository({
        userId: installation.userId,
        installationId: installation.installationId,
        name: "Another app",
        repository: repository.repository,
        baseBranch: repository.baseBranch,
        environment: repository.environment,
        autoPublish: true,
        open: { requestId: randomUUID(), model: "test-model" },
      }),
    ).rejects.toThrow("Queue unavailable");
    expect(await store.repositoriesForInstallation(installation.installationId)).toEqual([
      repository,
    ]);
    expect(store.enqueued).toEqual([]);
  });

  it("keeps tenant isolation and disconnected ownership in route tests", async () => {
    const store = new InMemoryGitHubStore();
    const { installation, repository } = await fixture(store);
    const stranger = randomUUID();
    expect(await store.repository(repository.projectId, stranger)).toBeNull();
    expect(await store.jobs(repository.projectId, stranger)).toEqual([]);
    expect(await store.feedbackForProject(repository.projectId, stranger)).toEqual([]);
    await store.disconnect(installation.userId, installation.installationId);
    expect(await store.bindInstallation({ ...installation, userId: stranger })).toBe(false);
    await store.setInstallationStatus(installation.installationId, "active");
    expect(
      (await store.installation(installation.userId, installation.installationId))?.status,
    ).toBe("disconnected");
  });

  it("leaves a failed admission approvable and serializes repeated approvals through the supplied queue", async () => {
    let fail = true;
    const queued: string[] = [];
    const store = new InMemoryGitHubStore({
      queue: {
        enqueue: async (request) => {
          if (fail) throw new Error("Database unavailable");
          queued.push(request.id);
        },
      },
    });
    const { repository, feedback } = await fixture(store);
    const request = {
      id: randomUUID(),
      userId: repository.userId,
      sessionId: repository.sessionId,
      kind: "turn" as const,
      message: "Fix the test",
      model: "test-model",
      billsToUser: false,
    };
    await expect(
      store.approveFeedback(repository.projectId, repository.userId, feedback.id, request),
    ).rejects.toThrow("Database unavailable");
    expect(
      (await store.feedback(repository.projectId, repository.userId, feedback.id))?.requestId,
    ).toBeNull();
    fail = false;
    const requests = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.approveFeedback(repository.projectId, repository.userId, feedback.id, {
          ...request,
          id: randomUUID(),
        }),
      ),
    );
    expect(new Set(requests).size).toBe(1);
    expect(queued).toEqual([requests[0]]);
  });

  it("reclaims expired deliveries while rejecting a stale worker's completion", async () => {
    let now = Date.now();
    const store = new InMemoryGitHubStore({ now: () => now });
    await store.receiveDelivery({ id: "delivery", event: "check_run", payload: {} });
    expect(await store.claimDelivery()).toMatchObject({ attempts: 1 });
    expect(await store.claimDelivery()).toBeNull();
    now += 60_001;
    expect(await store.claimDelivery()).toMatchObject({ attempts: 2 });
    await store.finishDelivery("delivery", 1);
    await store.finishDelivery("delivery", 2, "Unavailable");
    expect(await store.claimDelivery()).toBeNull();
    now += 4_000;
    expect(await store.claimDelivery()).toMatchObject({ attempts: 3 });
  });
});
