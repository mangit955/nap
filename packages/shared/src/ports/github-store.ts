import type {
  GitHubInstallation,
  GitHubRepository,
  ProjectRepository,
  RepositoryEnvironment,
  RepositoryFeedback,
  RepositoryJob,
} from "../github-protocol.ts";
import type { EnqueueTurnRequest } from "./turn-queue.ts";

export type GitHubConnectionState = {
  hash: string;
  userId: string;
  installationId: number | null;
  stage: "install" | "authorize";
  expiresAt: Date;
  draftId?: string | null;
};

export type ImportRepository = Pick<
  ProjectRepository,
  "userId" | "installationId" | "baseBranch" | "environment" | "autoPublish"
> & {
  name: string;
  repository: GitHubRepository;
  open?: { requestId: string; model: string };
};

export type RepositoryJobUpdate = Partial<
  Omit<RepositoryJob, "jobId" | "projectId" | "sessionId" | "baseBranch" | "headBranch" | "baseSha">
>;

export type GitHubDelivery = { id: string; event: string; payload: unknown };
export type ClaimedGitHubDelivery = GitHubDelivery & { attempts: number };

/** Owner-scoped product reads; unscoped writes are for trusted runtime/webhook services only. */
export interface GitHubStore {
  createState(state: GitHubConnectionState): Promise<void>;
  consumeState(
    hash: string,
    userId: string,
    stage: GitHubConnectionState["stage"],
  ): Promise<GitHubConnectionState | null>;
  /** Installation ownership survives disconnection. A second user can never claim the row. */
  bindInstallation(installation: GitHubInstallation): Promise<boolean>;
  listInstallations(userId: string): Promise<GitHubInstallation[]>;
  installation(userId: string, installationId: number): Promise<GitHubInstallation | null>;
  setInstallationStatus(
    installationId: number,
    status: GitHubInstallation["status"],
  ): Promise<void>;
  disconnect(userId: string, installationId: number): Promise<boolean>;
  importRepository(input: ImportRepository): Promise<ProjectRepository | null>;
  repository(projectId: string, userId: string): Promise<ProjectRepository | null>;
  /** Saved now, applied by the existing lifecycle on the next workspace start. */
  updateEnvironment(
    projectId: string,
    userId: string,
    environment: RepositoryEnvironment,
  ): Promise<boolean>;
  /** A rename can change metadata but never which numeric repository an import authorizes. */
  refreshRepository(installationId: number, repository: GitHubRepository): Promise<void>;
  repositoriesForInstallation(installationId: number): Promise<ProjectRepository[]>;
  createJob(job: RepositoryJob): Promise<RepositoryJob>;
  job(jobId: string): Promise<RepositoryJob | null>;
  jobs(projectId: string, userId: string): Promise<RepositoryJob[]>;
  updateJob(jobId: string, update: RepositoryJobUpdate): Promise<void>;
  /**
   * The newest job on each open pull request that has not been refreshed since
   * `notUpdatedSince`, oldest first. Older jobs on the same pull request are left out: they
   * describe the same remote state, and refreshing each would multiply GitHub calls by the
   * number of follow-ups somebody has run.
   */
  listJobsDueRefresh(limit: number, notUpdatedSince: Date): Promise<RepositoryJob[]>;
  feedbackForProject(projectId: string, userId: string): Promise<RepositoryFeedback[]>;
  feedback(
    projectId: string,
    userId: string,
    feedbackId: string,
  ): Promise<RepositoryFeedback | null>;
  addFeedback(feedback: RepositoryFeedback): Promise<boolean>;
  /** Call only after a complete authoritative read. Approved rows remain replayable. */
  discardStaleFeedback(jobId: string, keepIds: string[]): Promise<void>;
  /** Approval and queue admission commit together; retries return the first request's identity. */
  approveFeedback(
    projectId: string,
    userId: string,
    feedbackId: string,
    queueRequest: EnqueueTurnRequest,
  ): Promise<string | null>;
  receiveDelivery(delivery: GitHubDelivery): Promise<boolean>;
  claimDelivery(): Promise<ClaimedGitHubDelivery | null>;
  /** Attempt number fences a worker whose lease expired. Errors must already be safe to persist. */
  finishDelivery(deliveryId: string, attempts: number, error?: string): Promise<void>;
  /**
   * Extends a lease this attempt still holds, for a batch whose refreshes outlast one lease.
   * False once it has lapsed: another worker may have the delivery, so it is not taken back.
   */
  renewDelivery(deliveryId: string, attempts: number): Promise<boolean>;
}
