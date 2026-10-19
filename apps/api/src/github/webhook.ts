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

export class GitHubEventProcessor {
  constructor(readonly integration: GitHubIntegration) {}

  async tick(): Promise<void> {
    const { store, app } = this.integration.deps;
    if (app === null) return;
    // A tick is bounded. The inbox lease survives process restarts and duplicate deliveries.
    for (let count = 0; count < 10; count += 1) {
      const delivery = await store.claimDelivery();
      if (delivery === null) break;
      let failure: string | undefined;
      try {
        if (RELEVANT_EVENTS.has(delivery.event)) {
          const parsed = Delivery.safeParse(delivery.payload);
          if (parsed.success && parsed.data.installation !== undefined) {
            const installationId = parsed.data.installation.id;
            app.invalidate(installationId);
            const remote = await app.installation(installationId);
            if (remote.ok)
              await store.setInstallationStatus(
                installationId,
                remote.value.suspended_at === null ? "active" : "suspended",
              );
            else if (remote.error.code === "access_denied")
              await store.setInstallationStatus(installationId, "removed");
            else failure = remote.error.message;
            if (failure === undefined) {
              const bindings = await store.repositoriesForInstallation(installationId);
              for (const binding of bindings
                .filter(
                  (entry) =>
                    parsed.data.repository === undefined ||
                    entry.repository.id === parsed.data.repository.id,
                )
                .slice(0, 20)) {
                const jobs = await store.jobs(binding.projectId, binding.userId);
                for (const job of this.#latestBranches(jobs).slice(0, 5)) {
                  const result = await this.reconcile(binding, job);
                  if (!result.ok && result.error.code !== "access_denied")
                    failure = result.error.message;
                }
              }
            }
          }
        }
      } catch {
        failure = "GitHub delivery processing was interrupted.";
      }
      await store.finishDelivery(delivery.id, delivery.attempts, failure);
    }
    for (const job of await store.listReconcileJobs(10)) {
      const session = await this.integration.deps.sessions.get(job.sessionId);
      if (session === null) continue;
      const binding = await store.repository(job.projectId, session.userId);
      if (binding === null) continue;
      await this.reconcile(binding, job);
    }
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
    const result = await this.#refresh(binding, job);
    return result.ok ? { ok: true, value: undefined } : result;
  }

  async approve(
    binding: ProjectRepository,
    job: RepositoryJob,
    feedback: RepositoryFeedback,
  ): Promise<GitHubResult<void>> {
    const result = await this.#refresh(binding, job);
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

  async #refresh(binding: ProjectRepository, job: RepositoryJob): Promise<GitHubResult<string[]>> {
    const result = await this.#reconcile(binding, job);
    if (!result.ok)
      await this.integration.deps.store.updateJob(job.jobId, {
        checkState: "unknown",
        reviewState: "unknown",
        error: result.error.message,
        updatedAt: new Date().toISOString(),
      });
    return result;
  }

  async #reconcile(
    binding: ProjectRepository,
    job: RepositoryJob,
  ): Promise<GitHubResult<string[]>> {
    const { store, app } = this.integration.deps;
    if (app === null || job.pullRequestNumber === null) return { ok: true, value: [] };
    const currentFeedback: string[] = [];
    const authorized = await this.integration.authorize(
      binding.userId,
      binding.installationId,
      binding.repository,
    );
    if (!authorized.ok) {
      await store.updateJob(job.jobId, {
        error: authorized.error.message,
        updatedAt: new Date().toISOString(),
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
      updatedAt: new Date().toISOString(),
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
            createdAt: new Date().toISOString(),
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
            createdAt: new Date().toISOString(),
          })) || changed;
      }
    }
    await store.discardStaleFeedback(job.jobId, currentFeedback);
    await store.updateJob(job.jobId, update);
    if (changed)
      await this.integration.notice(
        binding.sessionId,
        "GitHub pull request status or feedback changed. Review it in the GitHub panel.",
      );
    return { ok: true, value: currentFeedback };
  }
}
