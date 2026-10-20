import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  ProjectRepository,
  RepositoryFeedback,
  RepositoryJob,
} from "@nap/shared/github-protocol";
import { z } from "zod";
import type { GitHubResult } from "./app.ts";
import type { GitHubIntegration } from "./integration.ts";

export function verifyWebhook(raw: string, signature: string | undefined, secret: string): boolean {
  if (signature === undefined || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(7), "hex"));
}

const Delivery = z.object({
  installation: z.object({ id: z.number().int().positive() }).optional(),
  repository: z.object({ id: z.number().int().positive() }).optional(),
});
const PullRequestRef = z.object({ number: z.number().int().positive() });
/** Every place GitHub names the pull requests an event is about. Status events name none. */
const NamedPullRequests = z.object({
  pull_request: PullRequestRef.optional(),
  issue: PullRequestRef.optional(),
  check_run: z.object({ pull_requests: z.array(PullRequestRef) }).optional(),
  check_suite: z.object({ pull_requests: z.array(PullRequestRef) }).optional(),
});

/**
 * Parsed apart from the routing fields, so an unexpected shape here costs only the hint, never the
 * delivery.
 */
function namedPullRequests(payload: unknown): Set<number> {
  const parsed = NamedPullRequests.safeParse(payload);
  if (!parsed.success) return new Set();
  const { pull_request, issue, check_run, check_suite } = parsed.data;
  return new Set(
    [
      pull_request,
      issue,
      ...(check_run?.pull_requests ?? []),
      ...(check_suite?.pull_requests ?? []),
    ].flatMap((entry) => (entry === undefined ? [] : [entry.number])),
  );
}

const RELEVANT_EVENTS = new Set([
  "installation",
  "installation_repositories",
  "repository",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "issue_comment",
  "check_run",
  "check_suite",
  "status",
]);

/**
 * How long a pull request may go unrefreshed before the backstop sweep reads it again.
 *
 * Webhooks are how changes arrive; this only catches deliveries GitHub never made. Each refresh
 * costs about ten API calls against an installation's hourly allowance of 5,000, so refreshing
 * every open pull request on every 15-second tick would spend that allowance on two of them.
 */
export const RECONCILE_AFTER_MS = 5 * 60_000;

type Authorize = GitHubIntegration["authorize"];

export class GitHubEventProcessor {
  constructor(
    readonly integration: GitHubIntegration,
    readonly now: () => number = Date.now,
  ) {}

  async tick(): Promise<void> {
    const { store, app } = this.integration.deps;
    if (app === null) return;
    // One authorization per repository per tick, however many jobs and deliveries share it.
    const authorize = this.#memoizedAuthorize();
    const installationStatus = new Map<number, Promise<string | undefined>>();
    // Deliveries arrive in bursts — one per check run — and all describe the same pull request.
    // Each job is refreshed once, after the whole batch is claimed.
    const targets = new Map<
      string,
      { binding: ProjectRepository; job: RepositoryJob; deliveries: string[] }
    >();
    const claimed: { id: string; attempts: number; failure?: string }[] = [];
    // A tick is bounded. The inbox lease survives process restarts and duplicate deliveries.
    for (let count = 0; count < 10; count += 1) {
      const delivery = await store.claimDelivery();
      if (delivery === null) break;
      const entry: (typeof claimed)[number] = { id: delivery.id, attempts: delivery.attempts };
      claimed.push(entry);
      try {
        if (!RELEVANT_EVENTS.has(delivery.event)) continue;
        const parsed = Delivery.safeParse(delivery.payload);
        if (!parsed.success || parsed.data.installation === undefined) continue;
        const installationId = parsed.data.installation.id;
        const named = namedPullRequests(delivery.payload);
        let status = installationStatus.get(installationId);
        if (status === undefined) {
          status = this.#refreshInstallation(installationId);
          installationStatus.set(installationId, status);
        }
        const failure = await status;
        if (failure !== undefined) {
          entry.failure = failure;
          continue;
        }
        const bindings = await store.repositoriesForInstallation(installationId);
        for (const binding of bindings
          .filter(
            (item) =>
              parsed.data.repository === undefined ||
              item.repository.id === parsed.data.repository.id,
          )
          .slice(0, 20)) {
          const jobs = await store.jobs(binding.projectId, binding.userId);
          for (const job of this.#webhookTargets(jobs, named)) {
            const target = targets.get(job.jobId) ?? { binding, job, deliveries: [] };
            target.deliveries.push(delivery.id);
            targets.set(job.jobId, target);
          }
        }
      } catch {
        entry.failure = "GitHub delivery processing was interrupted.";
      }
    }
    // Every claim's lease started above, but the refreshes below add up across every repository
    // the batch names and can outlast it. A delivery is acknowledged as soon as its own targets are
    // done, and the ones still waiting have their leases renewed before each refresh, so finished
    // work is never handed to the next tick to repeat.
    const remaining = new Map(claimed.map((entry) => [entry.id, 0]));
    for (const { deliveries } of targets.values())
      for (const id of new Set(deliveries)) remaining.set(id, (remaining.get(id) ?? 0) + 1);
    const finish = async (entry: (typeof claimed)[number]) =>
      await store.finishDelivery(entry.id, entry.attempts, entry.failure);
    for (const entry of claimed) if (remaining.get(entry.id) === 0) await finish(entry);
    for (const { binding, job, deliveries } of targets.values()) {
      for (const entry of claimed)
        if ((remaining.get(entry.id) ?? 0) > 0) await store.renewDelivery(entry.id, entry.attempts);
      let failure: string | undefined;
      try {
        const result = await this.#refresh(binding, job, authorize);
        if (!result.ok && result.error.code !== "access_denied") failure = result.error.message;
      } catch {
        failure = "GitHub delivery processing was interrupted.";
      }
      for (const entry of claimed) {
        if (!deliveries.includes(entry.id)) continue;
        if (failure !== undefined) entry.failure ??= failure;
        const left = (remaining.get(entry.id) ?? 1) - 1;
        remaining.set(entry.id, left);
        if (left === 0) await finish(entry);
      }
    }

    const stale = new Date(this.now() - RECONCILE_AFTER_MS);
    for (const job of await store.listReconcileJobs(10, stale)) {
      if (targets.has(job.jobId)) continue;
      const session = await this.integration.deps.sessions.get(job.sessionId);
      if (session === null) continue;
      const binding = await store.repository(job.projectId, session.userId);
      if (binding === null) continue;
      await this.#refresh(binding, job, authorize);
    }
  }

  /** The installation's current state, written down; a message when GitHub could not say. */
  async #refreshInstallation(installationId: number): Promise<string | undefined> {
    const { store, app } = this.integration.deps;
    if (app === null) return undefined;
    app.invalidate(installationId);
    const remote = await app.installation(installationId);
    if (remote.ok) {
      await store.setInstallationStatus(
        installationId,
        remote.value.suspended_at === null ? "active" : "suspended",
      );
      return undefined;
    }
    // Only a 404 says the installation is gone; anything else is GitHub being unable to answer.
    if (remote.status === 404) {
      await store.setInstallationStatus(installationId, "removed");
      return undefined;
    }
    return remote.error.message;
  }

  #memoizedAuthorize(): Authorize {
    const seen = new Map<string, ReturnType<Authorize>>();
    return (userId, installationId, repository) => {
      const key = `${userId}:${installationId}:${repository.id}`;
      let result = seen.get(key);
      if (result === undefined) {
        result = this.integration.authorize(userId, installationId, repository);
        seen.set(key, result);
      }
      return result;
    };
  }

  /**
   * The jobs a delivery refreshes: the latest on each branch whose pull request is open, or that the
   * delivery names — a reopened one included — named first, so the cap never crowds out the very
   * pull request the event is about. Closed and merged ones are otherwise skipped: every message
   * starts a new branch, so they soon outnumber the open ones and would leave an older open pull
   * request waiting for the backstop.
   */
  #webhookTargets(jobs: RepositoryJob[], named: Set<number>): RepositoryJob[] {
    const isNamed = (job: RepositoryJob) =>
      job.pullRequestNumber !== null && named.has(job.pullRequestNumber);
    return this.#latestBranches(jobs)
      .filter((job) => job.pullRequestState === "open" || isNamed(job))
      .sort((a, b) => Number(isNamed(b)) - Number(isNamed(a)))
      .slice(0, 5);
  }

  #latestBranches(jobs: RepositoryJob[]): RepositoryJob[] {
    const seen = new Set<string>();
    return jobs.filter((job) => {
      if (job.pullRequestNumber === null || seen.has(job.headBranch)) return false;
      seen.add(job.headBranch);
      return true;
    });
  }

  async reconcile(binding: ProjectRepository, job: RepositoryJob): Promise<GitHubResult<void>> {
    const result = await this.#refresh(
      binding,
      job,
      this.integration.authorize.bind(this.integration),
    );
    return result.ok ? { ok: true, value: undefined } : result;
  }

  async approve(
    binding: ProjectRepository,
    job: RepositoryJob,
    feedback: RepositoryFeedback,
  ): Promise<GitHubResult<void>> {
    const result = await this.#refresh(
      binding,
      job,
      this.integration.authorize.bind(this.integration),
    );
    if (!result.ok) return result;
    return feedback.projectId === binding.projectId &&
      feedback.jobId === job.jobId &&
      result.value.includes(feedback.id)
      ? { ok: true, value: undefined }
      : {
          ok: false,
          error: {
            code: "conflict",
            message:
              "This feedback or pull request has changed. Refresh the GitHub panel before continuing.",
          },
        };
  }

  async #refresh(
    binding: ProjectRepository,
    job: RepositoryJob,
    authorize: Authorize,
  ): Promise<GitHubResult<string[]>> {
    const result = await this.#reconcile(binding, job, authorize);
    if (!result.ok)
      await this.integration.deps.store.updateJob(job.jobId, {
        checkState: "unknown",
        reviewState: "unknown",
        error: result.error.message,
        updatedAt: new Date(this.now()).toISOString(),
      });
    return result;
  }

  async #reconcile(
    binding: ProjectRepository,
    job: RepositoryJob,
    authorize: Authorize,
  ): Promise<GitHubResult<string[]>> {
    const { store, app } = this.integration.deps;
    if (app === null || job.pullRequestNumber === null) return { ok: true, value: [] };
    const currentFeedback: string[] = [];
    const authorized = await authorize(binding.userId, binding.installationId, binding.repository);
    if (!authorized.ok) {
      await store.updateJob(job.jobId, {
        error: authorized.error.message,
        updatedAt: new Date(this.now()).toISOString(),
      });
      return authorized;
    }
    const repository = authorized.value.repository;
    const remote = await app.pullRequest(binding.installationId, repository, job.pullRequestNumber);
    if (!remote.ok) return remote;
    if (
      remote.value.head.repo?.id !== repository.id ||
      remote.value.base.repo.id !== repository.id ||
      remote.value.head.ref !== job.headBranch ||
      remote.value.base.ref !== job.baseBranch
    )
      return {
        ok: false,
        error: {
          code: "access_denied",
          message: "Pull request identity changed. Reconnect before continuing.",
        },
      };
    const state = remote.value.merged_at === null ? remote.value.state : "merged";
    const update: Partial<RepositoryJob> = {
      pullRequestState: state,
      ...(job.publishState === "failed" ? {} : { error: null }),
      updatedAt: new Date(this.now()).toISOString(),
    };
    let changed = state !== job.pullRequestState;
    if (state === "open") {
      const checks = await app.checks(binding.installationId, repository, remote.value.head.sha);
      const statuses = await app.statuses(
        binding.installationId,
        repository,
        remote.value.head.sha,
      );
      const reviews = await app.reviews(binding.installationId, repository, job.pullRequestNumber);
      const comments = await app.comments(
        binding.installationId,
        repository,
        job.pullRequestNumber,
      );
      const inline = await app.reviewComments(
        binding.installationId,
        repository,
        job.pullRequestNumber,
      );
      if (!checks.ok) return checks;
      if (!statuses.ok) return statuses;
      if (!reviews.ok) return reviews;
      if (!comments.ok) return comments;
      if (!inline.ok) return inline;
      const failed = checks.value.check_runs.filter((check) =>
        ["failure", "cancelled", "timed_out", "action_required", "startup_failure"].includes(
          check.conclusion ?? "",
        ),
      );
      const badStatuses = statuses.value.statuses.filter((status) =>
        ["failure", "error"].includes(status.state),
      );
      update.checkState =
        failed.length + badStatuses.length > 0
          ? "failed"
          : checks.value.check_runs.some((check) => check.status !== "completed") ||
              statuses.value.statuses.some((status) => status.state === "pending")
            ? "pending"
            : checks.value.check_runs.length + statuses.value.statuses.length === 0
              ? "unknown"
              : "passed";
      const byReviewer = new Map<number, string>();
      for (const review of reviews.value)
        if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(review.state))
          byReviewer.set(review.user.id, review.state);
      update.reviewState = [...byReviewer.values()].includes("CHANGES_REQUESTED")
        ? "changes_requested"
        : [...byReviewer.values()].includes("APPROVED")
          ? "approved"
          : reviews.value.length === 0
            ? "unknown"
            : "commented";
      changed ||= update.checkState !== job.checkState || update.reviewState !== job.reviewState;
      if (update.checkState === "failed" && remote.value.head.sha === job.pushedSha) {
        const key = `checks:${repository.id}:${job.pullRequestNumber}:${remote.value.head.sha}`;
        currentFeedback.push(key);
        changed =
          (await store.addFeedback({
            id: key,
            projectId: job.projectId,
            jobId: job.jobId,
            kind: "checks",
            summary: `Address failing GitHub checks for commit ${remote.value.head.sha}: ${[...failed.map((entry) => entry.name), ...badStatuses.map((entry) => entry.context)].join(", ").slice(0, 3000)}.`,
            requestId: null,
            createdAt: new Date(this.now()).toISOString(),
          })) || changed;
      }
      for (const comment of [...comments.value, ...inline.value]) {
        if (
          remote.value.head.sha !== job.pushedSha ||
          comment.user.id !== authorized.value.installation.githubUserId ||
          !/^\s*\/nap\s+\S/i.test(comment.body)
        )
          continue;
        const digest = createHash("sha256")
          .update(`${comment.updated_at}:${comment.body}`)
          .digest("hex")
          .slice(0, 16);
        const key = `comment:${repository.id}:${comment.id}:${digest}`;
        currentFeedback.push(key);
        changed =
          (await store.addFeedback({
            id: key,
            projectId: job.projectId,
            jobId: job.jobId,
            kind: "comment",
            summary: comment.body.replace(/^\s*\/nap\s+/i, "").slice(0, 4000),
            requestId: null,
            createdAt: new Date(this.now()).toISOString(),
          })) || changed;
      }
    }
    await store.discardStaleFeedback(job.jobId, currentFeedback);
    await store.updateJob(job.jobId, update);
    if (state !== "open") {
      // Earlier jobs on this pull request are no longer reconciled, so they learn it closed here.
      for (const earlier of await store.jobs(binding.projectId, binding.userId))
        if (
          earlier.jobId !== job.jobId &&
          earlier.pullRequestNumber === job.pullRequestNumber &&
          earlier.pullRequestState === "open"
        )
          await store.updateJob(earlier.jobId, { pullRequestState: state });
    }
    if (changed)
      await this.integration.notice(
        binding.sessionId,
        "GitHub pull request status or feedback changed. Review it in the GitHub panel.",
      );
    return { ok: true, value: currentFeedback };
  }
}
