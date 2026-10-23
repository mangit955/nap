import { bundle, currentSha } from "@nap/sandbox/git";
import type {
  GitHubInstallation,
  GitHubRepository,
  RepositoryJob,
} from "@nap/shared/github-protocol";
import { GitHubRepositorySchema } from "@nap/shared/github-protocol";
import { foldJobs } from "@nap/shared/job-state";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { GitHubStore } from "@nap/shared/ports/github-store";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type {
  RepositoryJobOptions,
  RepositoryWorkspace,
} from "@nap/shared/ports/repository-workspace";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import type { LeasedTurnRequest } from "@nap/shared/ports/turn-queue";
import { shellQuote } from "@nap/shared/shell";
import { z } from "zod";
import type { GitHubApp, GitHubResult } from "./app.ts";
import type { GitBroker } from "./git-broker.ts";

const denied = <T>(): GitHubResult<T> => ({
  ok: false,
  error: {
    code: "access_denied",
    message: "Repository access is unavailable. Reconnect GitHub and check selected repositories.",
  },
});
const conflict = <T>(message: string): GitHubResult<T> => ({
  ok: false,
  error: { code: "conflict", message },
});
const success = (): GitHubResult<void> => ({ ok: true, value: undefined });
const stopped = <T>(): GitHubResult<T> => ({
  ok: false,
  error: { code: "cancelled", message: "Repository operation cancelled." },
});

export type GitHubIntegrationDeps = {
  store: GitHubStore;
  app: GitHubApp | null;
  broker: GitBroker;
  sandbox: SandboxManager;
  sessions: SessionStore;
  objects: ObjectStore;
  snapshots: SnapshotStore;
  events: EventStore;
  bus: EventBus;
};

export class GitHubIntegration implements RepositoryWorkspace {
  constructor(readonly deps: GitHubIntegrationDeps) {}

  async installation(userId: string, id: number): Promise<GitHubResult<GitHubInstallation>> {
    const local = await this.deps.store.installation(userId, id);
    if (local === null || local.status !== "active" || this.deps.app === null) return denied();
    const remote = await this.deps.app.installation(id);
    if (!remote.ok) {
      // Only GitHub saying the installation is gone may disconnect it. A 401 is this app's own
      // credentials and a throttled 403 is temporary; persisting either would turn an outage
      // into a disconnection nobody can undo without reinstalling.
      if (remote.status === 404) {
        await this.deps.store.setInstallationStatus(id, "removed");
        return denied();
      }
      return remote.error.code === "access_denied"
        ? { ok: false, error: { code: "unavailable", message: remote.error.message } }
        : remote;
    }
    if (remote.value.app_id !== this.deps.app.config.appId || remote.value.suspended_at !== null) {
      await this.deps.store.setInstallationStatus(id, "suspended");
      return denied();
    }
    return { ok: true, value: local };
  }

  async authorize(
    userId: string,
    installationId: number,
    repository: GitHubRepository,
  ): Promise<GitHubResult<{ installation: GitHubInstallation; repository: GitHubRepository }>> {
    const installation = await this.installation(userId, installationId);
    const app = this.deps.app;
    if (!installation.ok) return installation;
    if (app === null) return denied();
    // Minting again checks today's selection even if a cached token predates a revocation.
    const narrowed = await app.token(installationId, repository.id, { metadata: "read" }, true);
    if (!narrowed.ok) return narrowed;
    const remote = await app.repository(installationId, repository);
    if (!remote.ok) return remote;
    if (remote.value.id !== repository.id || remote.value.archived || remote.value.disabled)
      return denied();
    const canonical = GitHubRepositorySchema.safeParse({
      id: remote.value.id,
      fullName: remote.value.full_name,
      defaultBranch: remote.value.default_branch,
      private: remote.value.private,
    });
    if (!canonical.success) return denied();
    const permission = await app.permission(
      installationId,
      canonical.data,
      installation.value.githubLogin,
    );
    if (!permission.ok) return permission;
    if (
      permission.value.user.id !== installation.value.githubUserId ||
      !["admin", "write", "maintain"].includes(permission.value.permission)
    )
      return denied();
    await this.deps.store.refreshRepository(installationId, canonical.data);
    return { ok: true, value: { installation: installation.value, repository: canonical.data } };
  }

  /**
   * One selected repository, authorized for this user — what import needs. It lists the selection
   * (one call per hundred repositories) and checks permission on the requested one alone, where
   * `repositories` checks every one, which on a large installation is hundreds of calls.
   */
  async selectedRepository(
    userId: string,
    installationId: number,
    repositoryId: number,
  ): Promise<GitHubResult<{ installation: GitHubInstallation; repository: GitHubRepository }>> {
    const installation = await this.installation(userId, installationId);
    if (!installation.ok || this.deps.app === null)
      return installation.ok ? denied() : installation;
    const all = await this.deps.app.repositories(installationId);
    if (!all.ok) return all;
    const repository = all.value.find((entry) => entry.id === repositoryId);
    if (repository === undefined) return denied();
    return this.authorize(userId, installationId, repository);
  }

  async repositories(
    userId: string,
    installationId: number,
  ): Promise<GitHubResult<GitHubRepository[]>> {
    const installation = await this.installation(userId, installationId);
    if (!installation.ok || this.deps.app === null)
      return installation.ok ? denied() : installation;
    const all = await this.deps.app.repositories(installationId);
    if (!all.ok) return all;
    const permissions = await this.deps.app.permissions(
      installationId,
      all.value,
      installation.value.githubLogin,
    );
    if (!permissions.ok) return permissions;
    return {
      ok: true,
      value: all.value.filter((_, index) => {
        const permission = permissions.value[index];
        return (
          permission !== null &&
          permission !== undefined &&
          permission.user.id === installation.value.githubUserId &&
          ["admin", "write", "maintain"].includes(permission.permission)
        );
      }),
    };
  }

  async source(session: SessionRecord, signal?: AbortSignal) {
    const binding = await this.deps.store.repository(session.projectId, session.userId);
    if (binding === null) return { ok: true as const, value: null };
    if (binding.sessionId !== session.sessionId) return denied<never>();
    if (signal?.aborted) return stopped<never>();
    const access = await this.authorize(session.userId, binding.installationId, binding.repository);
    if (!access.ok) return access;
    return {
      ok: true as const,
      value: {
        ...binding.environment,
        initialBundle: async () => {
          if (signal?.aborted) return stopped<Uint8Array>();
          const app = this.deps.app;
          if (app === null) return denied<Uint8Array>();
          const current = await this.authorize(
            session.userId,
            binding.installationId,
            binding.repository,
          );
          if (!current.ok) return current;
          const token = await app.token(
            binding.installationId,
            binding.repository.id,
            { contents: "read" },
            true,
          );
          if (!token.ok) return token;
          return this.deps.broker.fetch({
            fullName: current.value.repository.fullName,
            branch: binding.baseBranch,
            token: token.value,
            signal,
          });
        },
      },
    };
  }

  async prepareJob(options: RepositoryJobOptions): Promise<GitHubResult<void>> {
    const { session, sandboxId, jobId, signal } = options;
    const binding = await this.deps.store.repository(session.projectId, session.userId);
    if (binding === null) return success();
    if (binding.sessionId !== session.sessionId) return denied();
    const access = await this.authorize(session.userId, binding.installationId, binding.repository);
    if (!access.ok) return access;
    if (signal?.aborted) return stopped();
    const status = await this.#git(sandboxId, "status --porcelain");
    if (!status.ok) return status;
    const sha = await this.#git(sandboxId, "rev-parse HEAD");
    if (!sha.ok) return sha;
    let job = await this.deps.store.job(jobId);
    const created = job === null;
    if (job === null) {
      let prior: RepositoryJob | null = null;
      if (options.requestId !== undefined) {
        const feedback = (
          await this.deps.store.feedbackForProject(session.projectId, session.userId)
        ).find((entry) => entry.requestId === options.requestId);
        if (feedback !== undefined) prior = await this.deps.store.job(feedback.jobId);
      }
      if (prior !== null && status.value !== "")
        return conflict(
          "The workspace has unfinished edits from other work. Finish them in chat before applying this PR feedback.",
        );
      if (prior !== null && prior.pushedSha !== sha.value)
        return conflict(
          "The workspace has moved since this PR feedback arrived. Open the linked branch before applying it.",
        );
      if (prior === null && status.value !== "") {
        // A stopped or failed job leaves its edits in the workspace. The next message continues
        // them on the branch they were started on — and that branch's pull request, if it has
        // one — rather than refusing every message until somebody discards the work.
        const current = await this.#git(sandboxId, "symbolic-ref --short HEAD");
        if (current.ok)
          prior =
            (await this.deps.store.jobs(session.projectId, session.userId)).find(
              (entry) => entry.headBranch === current.value,
            ) ?? null;
      }
      job = await this.deps.store.createJob({
        jobId,
        projectId: session.projectId,
        sessionId: session.sessionId,
        baseBranch: prior?.baseBranch ?? binding.baseBranch,
        headBranch: prior?.headBranch ?? `nap/${jobId}`,
        baseSha: prior?.baseSha ?? sha.value,
        headSha: null,
        pushedSha: prior?.pushedSha ?? null,
        pullRequestNumber: prior?.pullRequestNumber ?? null,
        pullRequestUrl: prior?.pullRequestUrl ?? null,
        pullRequestState: prior?.pullRequestState ?? "none",
        publishState: "working",
        checkState: "unknown",
        reviewState: "unknown",
        error: null,
        updatedAt: new Date().toISOString(),
      });
    }
    if (job.projectId !== session.projectId || job.sessionId !== session.sessionId) return denied();
    const branch = await this.#git(sandboxId, "symbolic-ref --short HEAD");
    if (branch.ok && branch.value === job.headBranch) return success();
    // A new branch from the current commit carries uncommitted edits with it unchanged. An
    // existing job whose branch is not checked out is a different matter: switching would mix
    // these edits into somebody else's branch.
    if (!created && status.value !== "")
      return conflict("The workspace has unfinished edits. Its branch was not changed.");
    if (sha.value !== job.baseSha)
      return conflict(
        "The workspace branch changed. Nap will not reset your work to start this job.",
      );
    const switched = await this.#git(sandboxId, `checkout -b ${shellQuote(job.headBranch)}`);
    return switched.ok ? success() : switched;
  }

  async finishJob(
    options: Parameters<RepositoryWorkspace["finishJob"]>[0],
  ): Promise<GitHubResult<void>> {
    const binding = await this.deps.store.repository(
      options.session.projectId,
      options.session.userId,
    );
    if (binding === null) return success();
    const job = await this.deps.store.job(options.jobId);
    if (job === null) return success();
    if (
      job.projectId !== options.session.projectId ||
      job.sessionId !== options.session.sessionId ||
      binding.sessionId !== options.session.sessionId
    )
      return denied();
    if (options.outcome !== "verified") {
      await this.deps.store.updateJob(job.jobId, {
        publishState: "failed",
        error: "This job did not reach a verified commit. No changes were published.",
        updatedAt: new Date().toISOString(),
      });
      return success();
    }
    const sha = await currentSha(this.deps.sandbox, options.sandboxId);
    if (!sha.ok) return conflict("Could not read the verified commit.");
    await this.deps.store.updateJob(job.jobId, {
      headSha: sha.value,
      publishState: "ready",
      error: null,
      updatedAt: new Date().toISOString(),
    });
    if (!binding.autoPublish || options.signal?.aborted) return success();
    return this.publish({
      session: options.session,
      jobId: job.jobId,
      sandboxId: options.sandboxId,
      signal: options.signal,
    });
  }

  async publishQueued(request: LeasedTurnRequest, signal: AbortSignal): Promise<boolean> {
    const session = await this.deps.sessions.get(request.sessionId);
    const jobId = z.uuid().safeParse(request.message);
    if (session === null || session.userId !== request.userId || !jobId.success) return false;
    const result = await this.publish({
      session,
      jobId: jobId.data,
      sandboxId: session.sandboxId,
      signal,
    });
    await this.notice(
      session.sessionId,
      result.ok ? "GitHub pull request is up to date." : result.error.message,
    );
    return result.ok;
  }

  async publish(options: {
    session: SessionRecord;
    jobId: string;
    sandboxId: string | null;
    signal?: AbortSignal | undefined;
  }): Promise<GitHubResult<void>> {
    const { session, jobId, signal } = options;
    const binding = await this.deps.store.repository(session.projectId, session.userId);
    const job = await this.deps.store.job(jobId);
    if (
      binding === null ||
      job === null ||
      job.projectId !== session.projectId ||
      job.sessionId !== session.sessionId ||
      binding.sessionId !== session.sessionId
    )
      return denied();
    const access = await this.authorize(session.userId, binding.installationId, binding.repository);
    if (!access.ok) return this.#publicationFailed(jobId, access);
    const repository = access.value.repository;
    const state = foldJobs(await this.deps.events.readFrom(session.sessionId, 0)).jobs.find(
      (entry) => entry.jobId === jobId,
    );
    if (state?.phase !== "verified" || state.checkpointSha === null)
      return this.#publicationFailed(
        jobId,
        conflict("Only a verified job can publish a pull request."),
      );
    if (signal?.aborted) return stopped();
    const app = this.deps.app;
    if (app === null) return denied();
    // A retry after the push landed and the pull request did not. GitHub already holds exactly the
    // verified commit on the job's branch, so the workspace has nothing left to prove — and it may
    // rightly have moved on to later work since. Any other remote head goes the long way round.
    const remoteHead =
      job.pushedSha === state.checkpointSha
        ? await app.branch(binding.installationId, repository, job.headBranch)
        : null;
    const alreadyPushed = remoteHead?.ok === true && remoteHead.value.object.sha === job.pushedSha;
    let bytes: Uint8Array | null = null;
    if (!alreadyPushed) {
      const live =
        options.sandboxId === null ? null : await this.deps.sandbox.resume(options.sandboxId);
      if (live?.ok) {
        const status = await this.#git(live.value.id, "status --porcelain");
        const sha = await currentSha(this.deps.sandbox, live.value.id);
        if (!status.ok || status.value !== "" || !sha.ok || sha.value !== state.checkpointSha)
          return this.#publicationFailed(
            jobId,
            conflict(
              "The workspace has changed since this job was verified. Finish and verify the current work before publishing.",
            ),
          );
        const captured = await bundle(this.deps.sandbox, live.value.id, { signal });
        if (!captured.ok)
          return this.#publicationFailed(
            jobId,
            conflict("Could not read the workspace Git bundle."),
          );
        bytes = captured.value;
      } else {
        const snapshot = await this.deps.snapshots.latestFor(session.projectId);
        if (snapshot === null || snapshot.gitSha !== state.checkpointSha)
          return this.#publicationFailed(
            jobId,
            conflict(
              "This job's verified snapshot is unavailable. Open the project before publishing.",
            ),
          );
        const stored = await this.deps.objects.get(snapshot.key);
        if (!stored.ok)
          return this.#publicationFailed(
            jobId,
            conflict("The saved repository could not be read. Your project was not changed."),
          );
        bytes = stored.value;
      }
    }
    await this.deps.store.updateJob(jobId, {
      publishState: "publishing",
      headSha: state.checkpointSha,
      error: null,
      updatedAt: new Date().toISOString(),
    });
    const existing = await app.findPullRequests(
      binding.installationId,
      repository,
      job.headBranch,
      job.baseBranch,
    );
    if (!existing.ok) return this.#publicationFailed(jobId, existing);
    const known = existing.value.find(
      (entry) =>
        entry.head.repo?.id === repository.id &&
        entry.base.repo.id === repository.id &&
        entry.head.ref === job.headBranch &&
        entry.base.ref === job.baseBranch,
    );
    if (known?.state === "closed")
      return this.#publicationFailed(
        jobId,
        conflict("This pull request is closed or merged. Start a new job to propose more changes."),
      );
    if (signal?.aborted) return this.#publicationFailed(jobId, stopped());
    if (bytes !== null) {
      const fresh = await this.authorize(session.userId, binding.installationId, repository);
      if (!fresh.ok) return this.#publicationFailed(jobId, fresh);
      const token = await app.token(
        binding.installationId,
        repository.id,
        { contents: "write" },
        true,
      );
      if (!token.ok) return this.#publicationFailed(jobId, token);
      const pushed = await this.deps.broker.push({
        fullName: repository.fullName,
        branch: job.headBranch,
        sha: state.checkpointSha,
        bytes,
        token: token.value,
        signal,
      });
      if (!pushed.ok) return this.#publicationFailed(jobId, pushed);
      await this.deps.store.updateJob(jobId, {
        pushedSha: state.checkpointSha,
        updatedAt: new Date().toISOString(),
      });
      if (signal?.aborted) return this.#publicationFailed(jobId, stopped());
    }
    let pr = known;
    if (pr === undefined) {
      const current = await this.authorize(session.userId, binding.installationId, repository);
      if (!current.ok) return this.#publicationFailed(jobId, current);
      const created = await app.createPullRequest(binding.installationId, repository, {
        head: job.headBranch,
        base: job.baseBranch,
        title: `Nap changes ${job.jobId.slice(0, 8)}`,
        body: `Changes prepared and checked in Nap.\n\nJob: ${job.jobId}\nVerified commit: ${state.checkpointSha}\n\nReview this draft before merging.`,
        signal,
      });
      if (created.ok) pr = created.value;
      else {
        // A timeout may have lost the response after GitHub committed the PR.
        const found = await app.findPullRequests(
          binding.installationId,
          repository,
          job.headBranch,
          job.baseBranch,
        );
        pr = found.ok
          ? found.value.find(
              (entry) =>
                entry.head.repo?.id === repository.id &&
                entry.base.repo.id === repository.id &&
                entry.head.ref === job.headBranch &&
                entry.base.ref === job.baseBranch,
            )
          : undefined;
        if (pr === undefined) return this.#publicationFailed(jobId, created);
      }
    }
    await this.deps.store.updateJob(jobId, {
      pullRequestNumber: pr.number,
      pullRequestUrl: pr.html_url,
      pullRequestState: pr.merged_at !== null ? "merged" : pr.state,
      publishState: "published",
      error: null,
      updatedAt: new Date().toISOString(),
    });
    return success();
  }

  async notice(sessionId: string, text: string): Promise<void> {
    const event = await this.deps.events.append({
      sessionId,
      turnId: crypto.randomUUID(),
      type: "system.notice",
      payload: { level: "info", text },
      createdAt: new Date().toISOString(),
    });
    await this.deps.bus.publish(event);
  }

  async #publicationFailed<T>(
    jobId: string,
    result: GitHubResult<T>,
  ): Promise<GitHubResult<never>> {
    if (result.ok) throw new Error("Publication failure requires an error");
    await this.deps.store.updateJob(jobId, {
      publishState: "failed",
      error: result.error.message,
      updatedAt: new Date().toISOString(),
    });
    return result;
  }
  async #git(sandboxId: string, command: string): Promise<GitHubResult<string>> {
    const result = await this.deps.sandbox.exec(
      sandboxId,
      `cd /home/user/app && git -c core.hooksPath=/dev/null ${command}`,
    );
    return result.ok && result.value.exitCode === 0
      ? { ok: true, value: result.value.stdout.trim() }
      : conflict("Could not read or change the repository branch. Existing work was kept.");
  }
}
