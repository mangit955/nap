"use client";

import {
  type ProjectGitHub,
  ProjectGitHubSchema,
  type RepositoryEnvironment,
  type RepositoryJob,
} from "@nap/shared/github-protocol";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { BUTTON, FOCUS } from "../settings/settings-ui.tsx";
import { CloseIcon, GithubIcon } from "../ui/icons.tsx";
import { EnvironmentSettings } from "./environment-settings.tsx";
import { GuestSignIn } from "./guest-sign-in.tsx";
import { GITHUB_API_URL, githubRequest } from "./request.ts";

const admittedSchema = z.object({ requestId: z.uuid() });
const environmentSavedSchema = z.object({ saved: z.literal(true) });
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
  // A guest is refused every GitHub request. That is a question of who they are, not something
  // that went wrong, so it gets its own dialog rather than an error inside this one.
  const [signIn, setSignIn] = useState(false);
  const titleId = useId();
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
      setSignIn(false);
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
    } else if (result.code === "sign_in_required") {
      setSignIn(true);
      setError(undefined);
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
    if (open && !element.open) {
      element.showModal();
      // The dialog takes focus itself, rather than its first control, so opening it with a click
      // does not paint a focus ring on ✕. Tab still moves straight into it.
      element.focus();
    }
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
  if (state === undefined && error === undefined && !signIn) return null;
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
        aria-labelledby={titleId}
        tabIndex={-1}
        closedby="any"
        onClose={() => setOpen(false)}
        className={`nap-dialog m-auto max-h-[85dvh] w-[calc(100%-2rem)] overflow-y-auto rounded-2xl border border-edge bg-panel p-0 text-ink shadow-raised outline-none backdrop:bg-black/60 backdrop:backdrop-blur-sm ${signIn ? "max-w-md" : "max-w-2xl"}`}
      >
        <DialogHeader
          titleId={titleId}
          title={signIn ? "Connect GitHub" : "Pull requests"}
          subtitle={
            signIn
              ? "Open pull requests, and answer review comments and CI failures."
              : (repository?.repository.fullName ?? "GitHub repository")
          }
          closeLabel={signIn ? "Close" : "Close pull requests"}
          onClose={() => setOpen(false)}
        />
        {signIn ? (
          <GuestSignIn
            dismiss={
              <button type="button" onClick={() => setOpen(false)} className={BUTTON}>
                Not now
              </button>
            }
          />
        ) : (
          <div className="border-edge border-t px-6 pt-1 pb-6">
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
              Only /nap comments from the GitHub account that connected this installation and failed
              CI checks appear for your approval. Review decisions are shown as status; review text
              is not sent to the agent. Approved follow-ups use nap's existing job limits and Stop
              control.
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
              <button
                type="button"
                className={BUTTON}
                disabled={busy}
                onClick={() => void reload()}
              >
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
              className={`mt-6 inline-block rounded text-xs text-muted underline underline-offset-4 hover:text-ink ${FOCUS}`}
            >
              Manage GitHub access
            </a>
          </div>
        )}
      </dialog>
    </>
  );
}

/** Devin's shape — the provider's mark, what it is, what it does — in nap's own tokens. */
function DialogHeader({
  titleId,
  title,
  subtitle,
  closeLabel,
  onClose,
}: {
  titleId: string;
  title: string;
  subtitle: string;
  closeLabel: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start gap-4 px-6 pt-6 pb-5">
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-full border border-edge bg-field text-ink"
      >
        <GithubIcon className="size-5" />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <h2 id={titleId} className="text-[15px] font-medium text-ink">
          {title}
        </h2>
        <p className="mt-0.5 break-words text-[13px] text-muted">{subtitle}</p>
      </div>
      <button
        type="button"
        aria-label={closeLabel}
        onClick={onClose}
        className={`-mt-1 -mr-2 flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-hover hover:text-ink ${FOCUS}`}
      >
        <CloseIcon className="size-4" />
      </button>
    </div>
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
