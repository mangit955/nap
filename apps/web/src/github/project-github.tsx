"use client";

import {
  type ProjectGitHub,
  ProjectGitHubSchema,
  type RepositoryEnvironment,
  type RepositoryJob,
} from "@nap/shared/github-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { CloseIcon } from "../ui/icons.tsx";
import { EnvironmentSettings } from "./environment-settings.tsx";
import { GITHUB_API_URL, githubRequest } from "./request.ts";

const admittedSchema = z.object({ requestId: z.uuid() });
const environmentSavedSchema = z.object({ saved: z.literal(true) });
const BUTTON =
  "rounded-lg border border-edge px-3 py-2 text-xs font-medium text-ink hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-accent";
const PUBLISH_LABEL = {
  working: "Working",
  ready: "Ready to publish",
  publishing: "Publishing",
  published: "Published",
  failed: "Publishing failed",
};
const CHECK_LABEL = {
  unknown: "No checks reported",
  pending: "Checks pending",
  passed: "Checks passed",
  failed: "Checks failed",
};
const REVIEW_LABEL = {
  unknown: "No review yet",
  approved: "Approved",
  changes_requested: "Changes requested",
  commented: "Reviewed with comments",
};

export function ProjectGitHubControl({
  projectId,
  refreshKey,
  fetchJson = credentialedFetch,
  baseUrl = GITHUB_API_URL,
  onRepository,
}: {
  projectId: string;
  refreshKey: number;
  fetchJson?: FetchJson;
  baseUrl?: string;
  onRepository?: (
    repository: ProjectGitHub["repository"],
    runningPreviewPort?: number | null,
  ) => void;
}) {
  const [state, setState] = useState<ProjectGitHub>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [queuedJobs, setQueuedJobs] = useState<Map<string, string>>(new Map());
  const [queuedFeedback, setQueuedFeedback] = useState<Set<string>>(new Set());
  const dialog = useRef<HTMLDialogElement>(null);
  const latestRequest = useRef(0);

  useEffect(() => {
    if (state !== undefined) onRepository?.(state.repository, state.runningPreviewPort);
  }, [state, onRepository]);

  const reload = useCallback(async () => {
    const request = ++latestRequest.current;
    const result = await githubRequest(
      fetchJson,
      `${baseUrl}/projects/${projectId}/github`,
      ProjectGitHubSchema,
    );
    if (request !== latestRequest.current) return;
    if (result.ok) {
      setState(result.value);
      setError(undefined);
      setQueuedJobs(
        (current) =>
          new Map(
            [...current].filter(([jobId, previousUpdate]) => {
              const job = result.value.jobs.find((item) => item.jobId === jobId);
              return (
                job !== undefined &&
                job.publishState !== "published" &&
                !(job.publishState === "failed" && job.updatedAt !== previousUpdate)
              );
            }),
          ),
      );
    } else setError(result.error);
  }, [baseUrl, projectId, fetchJson]);

  useEffect(() => {
    void refreshKey;
    void reload();
    return () => {
      latestRequest.current += 1;
    };
  }, [reload, refreshKey]);
  useEffect(() => {
    const refresh = () => {
      void reload();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [reload]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  const act = async (path: string, body: object, accepted: () => void, message: string) => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    const result = await githubRequest(
      fetchJson,
      `${baseUrl}/projects/${projectId}/github/${path}`,
      admittedSchema,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (result.ok) {
      accepted();
      setNotice(message);
      await reload();
    } else setError(result.error);
    setBusy(false);
  };

  const saveEnvironment = async (environment: RepositoryEnvironment): Promise<boolean> => {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    const result = await githubRequest(
      fetchJson,
      `${baseUrl}/projects/${projectId}/github/environment`,
      environmentSavedSchema,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(environment),
      },
    );
    if (result.ok) {
      setState((current) =>
        current?.repository
          ? { ...current, repository: { ...current.repository, environment } }
          : current,
      );
      setNotice("Environment saved. Put the project away and reopen it to apply these settings.");
      await reload();
    } else setError(result.error);
    setBusy(false);
    return result.ok;
  };

  if (state?.repository === null) return null;
  if (state === undefined && error === undefined) return null;
  const repository = state?.repository;
  const pending =
    state?.feedback.filter(
      (item) => item.kind !== "review" && item.requestId === null && !queuedFeedback.has(item.id),
    ).length ?? 0;

  return (
    <>
      <button
        type="button"
        aria-label="GitHub pull requests"
        onClick={() => {
          setOpen(true);
          void reload();
        }}
        className={BUTTON}
      >
        GitHub{pending > 0 ? ` · ${pending} pending` : ""}
      </button>
      <dialog
        ref={dialog}
        aria-label="GitHub pull requests"
        closedby="any"
        onClose={() => setOpen(false)}
        className="nap-dialog m-auto max-h-[85dvh] w-[calc(100%-2rem)] max-w-2xl overflow-y-auto rounded-2xl border border-edge bg-panel p-5 text-ink shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm sm:p-7"
      >
        <div className="flex items-start justify-between gap-5">
          <div>
            <h2 className="text-xl font-medium">Pull requests</h2>
            <p className="mt-2 text-sm text-muted">
              {repository?.repository.fullName ?? "GitHub repository"}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close pull requests"
            onClick={() => setOpen(false)}
            className="rounded-full p-2 text-muted hover:bg-hover hover:text-ink"
          >
            <CloseIcon className="size-4" />
          </button>
        </div>
        {repository && (
          <div className="mt-5 rounded-xl border border-edge bg-field p-4">
            <p className="text-sm">
              Base branch <code>{repository.baseBranch}</code>
            </p>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              {repository.autoPublish
                ? "Verified work opens a draft pull request automatically."
                : "Publish verified work when you are ready."}{" "}
              Review and merge on GitHub.
            </p>
          </div>
        )}
        <p className="mt-4 text-xs leading-relaxed text-muted">
          Only /nap comments from the GitHub account that connected this installation and failed CI
          checks appear for your approval. Review decisions are shown as status; review text is not
          sent to the agent. Approved follow-ups use nap's existing job limits and Stop control.
        </p>
        {repository && (
          <EnvironmentSettings
            environment={repository.environment}
            busy={busy}
            onSave={saveEnvironment}
          />
        )}
        <div className="my-5 flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">Repository jobs</h3>
          <button type="button" className={BUTTON} disabled={busy} onClick={() => void reload()}>
            Refresh GitHub status
          </button>
        </div>
        {error && (
          <p role="alert" className="mb-4 text-sm text-danger">
            {error}
          </p>
        )}
        {notice && (
          <p
            role="status"
            aria-label="GitHub action"
            className="mb-4 rounded-lg bg-field p-3 text-sm"
          >
            {notice}
          </p>
        )}
        {state?.jobs.length === 0 && (
          <p className="py-3 text-sm text-muted">
            Send a task in chat to start work on a dedicated branch.
          </p>
        )}
        <ul className="space-y-4">
          {state?.jobs.map((job) => (
            <li key={job.jobId} className="rounded-xl border border-edge p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="break-all font-mono text-xs">
                  {job.headBranch} → {job.baseBranch}
                </p>
                <span className="text-xs text-muted">{PUBLISH_LABEL[job.publishState]}</span>
              </div>
              {job.pullRequestUrl && (
                <a
                  href={job.pullRequestUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-block text-sm underline underline-offset-4"
                >
                  PR #{job.pullRequestNumber} · {job.pullRequestState}
                </a>
              )}
              <p className="mt-3 text-xs text-muted">
                {CHECK_LABEL[job.checkState]} · {REVIEW_LABEL[job.reviewState]}
              </p>
              {job.pushedSha && (
                <p className="mt-2 text-xs text-muted">
                  Pushed {job.pushedSha.slice(0, 12)}. This commit is saved on GitHub.
                </p>
              )}
              {job.error && <p className="mt-3 text-sm text-danger">{job.error}</p>}
              {queuedJobs.has(job.jobId) && job.publishState !== "publishing" ? (
                <p className="mt-3 text-xs text-muted">
                  Publication queued. Refresh to check progress.
                </p>
              ) : (
                canPublish(job) && (
                  <button
                    type="button"
                    disabled={busy}
                    className={`${BUTTON} mt-3`}
                    onClick={() =>
                      void act(
                        "publish",
                        { jobId: job.jobId },
                        () =>
                          setQueuedJobs((current) =>
                            new Map(current).set(job.jobId, job.updatedAt),
                          ),
                        "Publishing queued. Your existing branch and pull request will be reused.",
                      )
                    }
                  >
                    {job.publishState === "publishing"
                      ? "Check or retry publication"
                      : job.publishState === "failed"
                        ? "Retry publishing"
                        : job.pullRequestNumber === null
                          ? "Open draft pull request"
                          : "Update pull request"}
                  </button>
                )
              )}
            </li>
          ))}
        </ul>
        {(state?.feedback.length ?? 0) > 0 && (
          <section className="mt-7">
            <h3 className="text-sm font-medium">Feedback</h3>
            <ul className="mt-3 space-y-3">
              {state?.feedback.map((item) => (
                <li key={item.id} className="rounded-xl border border-edge p-4">
                  <p className="mb-2 text-xs text-muted">
                    {item.kind === "checks"
                      ? "CI checks"
                      : item.kind === "comment"
                        ? "Authorized GitHub comment"
                        : "Pull request review"}
                  </p>
                  <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-2">
                    {item.summary}
                  </p>
                  {item.kind === "review" ? (
                    <p className="mt-3 text-xs text-muted">Review status only</p>
                  ) : item.requestId || queuedFeedback.has(item.id) ? (
                    <p className="mt-3 text-xs text-muted">Follow-up queued</p>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      className={`${BUTTON} mt-3`}
                      onClick={() =>
                        void act(
                          `feedback/${encodeURIComponent(item.id)}`,
                          {},
                          () => setQueuedFeedback((current) => new Set(current).add(item.id)),
                          "Follow-up accepted. Track the job and stop it from chat.",
                        )
                      }
                    >
                      Ask nap to address feedback
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
        <a
          href="/settings/connections/github"
          className="mt-6 inline-block text-xs text-muted underline underline-offset-4"
        >
          Manage GitHub access
        </a>
      </dialog>
    </>
  );
}

function canPublish(job: RepositoryJob): boolean {
  return (
    (job.publishState === "ready" ||
      job.publishState === "publishing" ||
      job.publishState === "failed" ||
      job.publishState === "published") &&
    job.pullRequestState !== "closed" &&
    job.pullRequestState !== "merged"
  );
}
