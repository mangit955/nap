import { randomUUID } from "node:crypto";
import type {
  GitHubInstallation,
  GitHubRepository,
  ProjectRepository,
  RepositoryEnvironment,
  RepositoryFeedback,
  RepositoryJob,
} from "@nap/shared/github-protocol";
import { GitHubRepositorySchema, RepositoryEnvironmentSchema } from "@nap/shared/github-protocol";
import type {
  ClaimedGitHubDelivery,
  GitHubConnectionState,
  GitHubDelivery,
  GitHubStore,
  ImportRepository,
  RepositoryJobUpdate,
} from "@nap/shared/ports/github-store";
import type { EnqueueTurnRequest, TurnQueue } from "@nap/shared/ports/turn-queue";

type MemoryDelivery = GitHubDelivery & {
  attempts: number;
  state: "pending" | "processing" | "done" | "failed";
  availableAt: number;
};

export class InMemoryGitHubStore implements GitHubStore {
  readonly enqueued: EnqueueTurnRequest[] = [];
  private readonly states = new Map<string, GitHubConnectionState>();
  private readonly installations = new Map<number, GitHubInstallation>();
  private readonly repositories = new Map<string, ProjectRepository>();
  private readonly jobRows = new Map<string, RepositoryJob>();
  /** Creation order, which the real store keeps in `created_at`. */
  private readonly jobCreated = new Map<string, number>();
  private readonly feedbackRows = new Map<string, RepositoryFeedback>();
  private readonly deliveries = new Map<string, MemoryDelivery>();
  private approvalTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      queue?: Pick<TurnQueue, "enqueue">;
      onImport?: (repository: ProjectRepository, name: string) => void;
      now?: () => number;
    } = {},
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  putRepository(repository: ProjectRepository): this {
    this.repositories.set(repository.projectId, structuredClone(repository));
    return this;
  }

  async createState(state: GitHubConnectionState): Promise<void> {
    if (this.states.has(state.hash)) throw new Error("Connection state already exists.");
    this.states.set(state.hash, structuredClone(state));
  }

  async consumeState(
    hash: string,
    userId: string,
    stage: GitHubConnectionState["stage"],
  ): Promise<GitHubConnectionState | null> {
    const state = this.states.get(hash);
    if (
      state === undefined ||
      state.userId !== userId ||
      state.stage !== stage ||
      state.expiresAt.getTime() <= this.now()
    )
      return null;
    this.states.delete(hash);
    return structuredClone(state);
  }

  async bindInstallation(installation: GitHubInstallation): Promise<boolean> {
    const prior = this.installations.get(installation.installationId);
    if (prior !== undefined && prior.userId !== installation.userId) return false;
    this.installations.set(installation.installationId, structuredClone(installation));
    return true;
  }

  async listInstallations(userId: string): Promise<GitHubInstallation[]> {
    return structuredClone(
      [...this.installations.values()]
        .filter((item) => item.userId === userId)
        .sort((a, b) => a.installationId - b.installationId),
    );
  }

  async installation(userId: string, installationId: number): Promise<GitHubInstallation | null> {
    const value = this.installations.get(installationId);
    return value?.userId === userId ? structuredClone(value) : null;
  }

  async setInstallationStatus(
    installationId: number,
    status: GitHubInstallation["status"],
  ): Promise<void> {
    const value = this.installations.get(installationId);
    if (value !== undefined && value.status !== "disconnected") value.status = status;
  }

  async disconnect(userId: string, installationId: number): Promise<boolean> {
    const value = this.installations.get(installationId);
    if (value?.userId !== userId) return false;
    value.status = "disconnected";
    return true;
  }

  async importRepository(input: ImportRepository): Promise<ProjectRepository | null> {
    const installation = this.installations.get(input.installationId);
    if (installation?.userId !== input.userId || installation.status !== "active") return null;
    const { name, open, ...fields } = input;
    const repository = { ...fields, projectId: randomUUID(), sessionId: randomUUID() };
    if (open !== undefined) {
      const request: EnqueueTurnRequest = {
        id: open.requestId,
        sessionId: repository.sessionId,
        userId: input.userId,
        kind: "resume",
        message: null,
        model: open.model,
        billsToUser: false,
      };
      if (this.enqueued.some((item) => item.id === request.id))
        throw new Error("Turn request already exists.");
      await this.options.queue?.enqueue(request);
      this.enqueued.push(structuredClone(request));
    }
    this.options.onImport?.(repository, name);
    this.putRepository(repository);
    return structuredClone(repository);
  }

  async repository(projectId: string, userId: string): Promise<ProjectRepository | null> {
    const repository = this.repositories.get(projectId);
    return repository?.userId === userId ? structuredClone(repository) : null;
  }

  async updateEnvironment(
    projectId: string,
    userId: string,
    environment: RepositoryEnvironment,
  ): Promise<boolean> {
    const repository = this.repositories.get(projectId);
    if (repository?.userId !== userId) return false;
    repository.environment = RepositoryEnvironmentSchema.parse(environment);
    return true;
  }

  async refreshRepository(installationId: number, repository: GitHubRepository): Promise<void> {
    const value = GitHubRepositorySchema.parse(repository);
    for (const binding of this.repositories.values()) {
      if (binding.installationId === installationId && binding.repository.id === value.id)
        binding.repository = structuredClone(value);
    }
  }

  async repositoriesForInstallation(installationId: number): Promise<ProjectRepository[]> {
    return structuredClone(
      [...this.repositories.values()].filter((item) => item.installationId === installationId),
    );
  }

  async createJob(job: RepositoryJob): Promise<RepositoryJob> {
    const repository = this.repositories.get(job.projectId);
    if (repository === undefined || repository.sessionId !== job.sessionId)
      throw new Error("Repository job must belong to a session in its project.");
    const previous = this.jobRows.get(job.jobId);
    if (
      previous !== undefined &&
      (previous.projectId !== job.projectId ||
        previous.sessionId !== job.sessionId ||
        previous.headBranch !== job.headBranch)
    ) {
      throw new Error("Repository job identity conflicts with existing work.");
    }
    if (previous === undefined) {
      this.jobRows.set(job.jobId, structuredClone(job));
      this.jobCreated.set(job.jobId, this.jobCreated.size);
    }
    return structuredClone(previous ?? job);
  }

  async job(jobId: string): Promise<RepositoryJob | null> {
    return structuredClone(this.jobRows.get(jobId) ?? null);
  }

  async jobs(projectId: string, userId: string): Promise<RepositoryJob[]> {
    if (this.repositories.get(projectId)?.userId !== userId) return [];
    return structuredClone(
      [...this.jobRows.values()]
        .filter((job) => job.projectId === projectId)
        .sort((a, b) => this.#created(b) - this.#created(a)),
    );
  }

  async updateJob(jobId: string, update: RepositoryJobUpdate): Promise<void> {
    const job = this.jobRows.get(jobId);
    if (job !== undefined)
      this.jobRows.set(jobId, {
        ...job,
        ...structuredClone(update),
        updatedAt: update.updatedAt ?? new Date(this.now()).toISOString(),
      });
  }

  async listReconcileJobs(limit: number, notUpdatedSince: Date): Promise<RepositoryJob[]> {
    const jobs = [...this.jobRows.values()];
    return structuredClone(
      jobs
        .filter((job) => {
          const repository = this.repositories.get(job.projectId);
          return (
            job.pullRequestState === "open" &&
            repository !== undefined &&
            this.installations.get(repository.installationId)?.status === "active" &&
            Date.parse(job.updatedAt) < notUpdatedSince.getTime() &&
            !jobs.some(
              (other) =>
                other.projectId === job.projectId &&
                other.pullRequestNumber === job.pullRequestNumber &&
                this.#created(other) > this.#created(job),
            )
          );
        })
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.jobId.localeCompare(b.jobId))
        .slice(0, Math.max(0, Math.min(100, Math.floor(limit)))),
    );
  }

  #created(job: RepositoryJob): number {
    return this.jobCreated.get(job.jobId) ?? -1;
  }

  async feedbackForProject(projectId: string, userId: string): Promise<RepositoryFeedback[]> {
    if (this.repositories.get(projectId)?.userId !== userId) return [];
    return structuredClone(
      [...this.feedbackRows.values()]
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    );
  }

  async feedback(
    projectId: string,
    userId: string,
    feedbackId: string,
  ): Promise<RepositoryFeedback | null> {
    const feedback = this.feedbackRows.get(feedbackId);
    return this.repositories.get(projectId)?.userId === userId && feedback?.projectId === projectId
      ? structuredClone(feedback)
      : null;
  }

  async addFeedback(feedback: RepositoryFeedback): Promise<boolean> {
    if (
      this.jobRows.get(feedback.jobId)?.projectId !== feedback.projectId ||
      feedback.requestId !== null
    )
      throw new Error("New repository feedback must belong to its job and await approval.");
    if (this.feedbackRows.has(feedback.id)) return false;
    this.feedbackRows.set(feedback.id, structuredClone(feedback));
    return true;
  }

  async discardStaleFeedback(jobId: string, keepIds: string[]): Promise<void> {
    const discarded = this.approvalTail.then(() => {
      const keep = new Set(keepIds);
      for (const [id, feedback] of this.feedbackRows) {
        if (feedback.jobId === jobId && feedback.requestId === null && !keep.has(id))
          this.feedbackRows.delete(id);
      }
    });
    this.approvalTail = discarded.catch(() => undefined);
    await discarded;
  }

  async approveFeedback(
    projectId: string,
    userId: string,
    feedbackId: string,
    queueRequest: EnqueueTurnRequest,
  ): Promise<string | null> {
    const approved = this.approvalTail.then(async () => {
      const repository = this.repositories.get(projectId);
      const feedback = this.feedbackRows.get(feedbackId);
      const job = feedback === undefined ? undefined : this.jobRows.get(feedback.jobId);
      if (
        repository?.userId !== userId ||
        feedback?.projectId !== projectId ||
        job?.sessionId !== queueRequest.sessionId ||
        queueRequest.userId !== userId ||
        queueRequest.kind !== "turn" ||
        this.installations.get(repository.installationId)?.status !== "active"
      )
        return null;
      if (feedback.requestId !== null) return feedback.requestId;
      if (this.enqueued.some((item) => item.id === queueRequest.id))
        throw new Error("Turn request already exists.");
      await this.options.queue?.enqueue(queueRequest);
      this.enqueued.push(structuredClone(queueRequest));
      feedback.requestId = queueRequest.id;
      return queueRequest.id;
    });
    this.approvalTail = approved.catch(() => undefined);
    return approved;
  }

  async receiveDelivery(delivery: GitHubDelivery): Promise<boolean> {
    if (this.deliveries.has(delivery.id)) return false;
    this.deliveries.set(delivery.id, {
      ...structuredClone(delivery),
      attempts: 0,
      state: "pending",
      availableAt: this.now(),
    });
    return true;
  }

  async claimDelivery(): Promise<ClaimedGitHubDelivery | null> {
    for (const delivery of this.deliveries.values()) {
      if (
        delivery.state === "processing" &&
        delivery.attempts >= 5 &&
        delivery.availableAt <= this.now()
      )
        delivery.state = "failed";
    }
    const candidate = [...this.deliveries.values()]
      .filter(
        (item) =>
          (item.state === "pending" || item.state === "processing") &&
          item.attempts < 5 &&
          item.availableAt <= this.now(),
      )
      .sort((a, b) => a.availableAt - b.availableAt || a.id.localeCompare(b.id))[0];
    if (candidate === undefined) return null;
    candidate.state = "processing";
    candidate.attempts += 1;
    candidate.availableAt = this.now() + 60_000;
    return structuredClone({
      id: candidate.id,
      event: candidate.event,
      payload: candidate.payload,
      attempts: candidate.attempts,
    });
  }

  async finishDelivery(deliveryId: string, attempts: number, error?: string): Promise<void> {
    const delivery = this.deliveries.get(deliveryId);
    if (
      delivery === undefined ||
      delivery.attempts !== attempts ||
      delivery.state !== "processing" ||
      delivery.availableAt <= this.now()
    )
      return;
    delivery.state = error === undefined ? "done" : attempts >= 5 ? "failed" : "pending";
    delivery.availableAt = this.now() + Math.min(300, 2 ** attempts) * 1000;
  }

  async renewDelivery(deliveryId: string, attempts: number): Promise<boolean> {
    const delivery = this.deliveries.get(deliveryId);
    if (
      delivery === undefined ||
      delivery.attempts !== attempts ||
      delivery.state !== "processing" ||
      delivery.availableAt <= this.now()
    )
      return false;
    delivery.availableAt = this.now() + 60_000;
    return true;
  }
}
