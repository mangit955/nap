"use client";

import {
  type ProjectGitHub,
  type PullRequestInspection,
  PullRequestInspectionSchema,
} from "@nap/shared/github-protocol";
import {
  ArrowUpRight,
  Check,
  Circle,
  Columns2,
  GitPullRequest,
  List,
  RotateCw,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { FetchJson } from "../files/use-project-files.ts";
import { DiffFile } from "../workspace/changes-panel.tsx";
import { githubRequest } from "./request.ts";

type InspectionState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; value: PullRequestInspection };
const VIEWS = ["Summary", "Timeline", "Code", "Settings"] as const;
export function PullRequestsPanel({
  state,
  projectId,
  fetchJson,
  baseUrl,
  refreshKey,
  active,
  manage,
}: {
  state: ProjectGitHub;
  projectId: string;
  fetchJson: FetchJson;
  baseUrl: string;
  refreshKey: number;
  active: boolean;
  manage: ReactNode;
}) {
  const [chosen, setChosen] = useState<number | null>(null);
  const numbers = [
    ...new Set(state.jobs.flatMap((job) => (job.pullRequestNumber ? [job.pullRequestNumber] : []))),
  ];
  const number = chosen !== null && numbers.includes(chosen) ? chosen : numbers[0];
  const [view, setView] = useState<(typeof VIEWS)[number]>("Summary");
  const [inspection, setInspection] = useState<InspectionState>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [split, setSplit] = useState(false);
  const [filter, setFilter] = useState("");
  useEffect(() => {
    if (number === undefined || !active) return;
    void refreshKey;
    void refresh;
    let cancelled = false;
    setInspection({ kind: "loading" });
    void githubRequest(
      fetchJson,
      `${baseUrl}/projects/${encodeURIComponent(projectId)}/github/pull-requests/${number}`,
      PullRequestInspectionSchema,
    ).then((result) => {
      if (!cancelled)
        setInspection(
          result.ok
            ? { kind: "ready", value: result.value }
            : { kind: "error", message: result.error },
        );
    });
    return () => {
      cancelled = true;
    };
  }, [number, active, refreshKey, refresh, fetchJson, baseUrl, projectId]);
  const pr =
    inspection.kind === "ready" && inspection.value.number === number ? inspection.value : null;
  if (number === undefined)
    return (
      <div className="t3-pr-panel nap-scroll">
        <div className="t3-pr-heading">
          <GitPullRequest size={14} />
          <span>Pull requests</span>
        </div>
        {manage}
      </div>
    );
  return (
    <div className="t3-pr-inspection">
      <div className="t3-pr-toolbar">
        <GitPullRequest size={14} />
        <select
          aria-label="Pull request"
          value={number}
          onChange={(event) => {
            setChosen(Number(event.target.value));
            setFilter("");
          }}
        >
          {numbers.map((value) => (
            <option value={value} key={value}>
              #{value} · {state.jobs.find((job) => job.pullRequestNumber === value)?.headBranch}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="t3-icon-button"
          aria-label="Refresh pull request"
          title="Refresh pull request"
          onClick={() => setRefresh((value) => value + 1)}
        >
          <RotateCw />
        </button>
        {pr && (
          <a
            className="t3-icon-button"
            aria-label="Open pull request on GitHub"
            title="Open on GitHub"
            href={pr.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            <ArrowUpRight />
          </a>
        )}
      </div>
      {pr && (
        <div className="t3-pr-title">
          <h2>{pr.title}</h2>
          <div>
            <span className="t3-pr-state">{pr.draft ? "Draft" : pr.state}</span>
            <span>#{pr.number}</span>
            <span>{pr.author}</span>
          </div>
          <p title={`${pr.head.sha} → ${pr.base.sha}`}>
            {pr.head.ref} <span>→</span> {pr.base.ref} <span>· {pr.head.sha.slice(0, 7)}</span>
          </p>
        </div>
      )}
      <div className="t3-pr-tabs" role="tablist" aria-label="Pull request views">
        {VIEWS.map((item) => (
          <button
            type="button"
            key={item}
            role="tab"
            id={`pr-tab-${item}`}
            aria-selected={view === item}
            aria-controls={`pr-view-${item}`}
            onClick={() => setView(item)}
          >
            {item}
            {item === "Code" && pr ? <span>{pr.files.length}</span> : null}
          </button>
        ))}
      </div>
      <div className="t3-pr-views nap-scroll">
        <section
          role="tabpanel"
          id="pr-view-Settings"
          aria-labelledby="pr-tab-Settings"
          hidden={view !== "Settings"}
          className="t3-pr-panel"
        >
          {manage}
        </section>
        {view !== "Settings" &&
          (inspection.kind === "loading" ? (
            <div className="t3-panel-empty" role="status">
              Loading pull request…
            </div>
          ) : inspection.kind === "error" ? (
            <div className="t3-panel-empty" role="alert">
              <p>Could not load pull request</p>
              <span>{inspection.message}</span>
              <button type="button" onClick={() => setRefresh((value) => value + 1)}>
                Try again
              </button>
            </div>
          ) : null)}
        {pr && (
          <>
            <section
              role="tabpanel"
              id="pr-view-Summary"
              aria-labelledby="pr-tab-Summary"
              hidden={view !== "Summary"}
              className="t3-pr-summary"
            >
              <div className="t3-pr-description">
                <h3>Description</h3>
                <div className="chat-markdown">
                  <Markdown remarkPlugins={[remarkGfm]}>
                    {pr.body || "No description provided."}
                  </Markdown>
                </div>
              </div>
              <div className="t3-pr-checks">
                <h3>
                  Checks <span>{pr.checks.length}</span>
                </h3>
                {pr.checks.length === 0 ? (
                  <p>No checks reported</p>
                ) : (
                  pr.checks.map((check, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: GitHub permits duplicate check names; rows have no local state.
                    <div key={`${check.name}:${index}`}>
                      {["success", "neutral", "skipped"].includes(check.conclusion ?? "") ? (
                        <Check size={13} className="t3-additions" />
                      ) : (
                        <Circle size={12} />
                      )}
                      <span>{check.name}</span>
                      <span>{check.conclusion ?? check.status}</span>
                    </div>
                  ))
                )}
              </div>
              {pr.comments.length > 0 && (
                <div className="t3-pr-reviews">
                  <h3>Review comments</h3>
                  {pr.comments.map((comment) => (
                    <button
                      type="button"
                      key={comment.id}
                      onClick={() => {
                        setFilter(comment.path);
                        setView("Code");
                      }}
                    >
                      <span>{comment.author}</span>
                      <code>
                        {comment.path}:{comment.line ?? comment.originalLine}
                      </code>
                      <span>
                        {comment.outdated
                          ? "Outdated"
                          : comment.side === "LEFT"
                            ? "Before"
                            : "After"}
                      </span>
                      <p>{comment.body}</p>
                    </button>
                  ))}
                </div>
              )}
            </section>
            <section
              role="tabpanel"
              id="pr-view-Timeline"
              aria-labelledby="pr-tab-Timeline"
              hidden={view !== "Timeline"}
              className="t3-pr-timeline"
            >
              {pr.timeline.length === 0 ? (
                <p className="t3-diff-notice">No comments or reviews yet.</p>
              ) : (
                pr.timeline.map((item) => (
                  <article key={item.id}>
                    <div>
                      <span className="t3-timeline-avatar">
                        {item.author.slice(0, 1).toUpperCase()}
                      </span>
                      <strong>{item.author}</strong>
                      <span>{item.state?.toLowerCase().replaceAll("_", " ") ?? "commented"}</span>
                    </div>
                    <div className="chat-markdown">
                      <Markdown remarkPlugins={[remarkGfm]}>
                        {item.body || "No review text."}
                      </Markdown>
                    </div>
                    {item.at && (
                      <time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>
                    )}
                  </article>
                ))
              )}
            </section>
            <section
              role="tabpanel"
              id="pr-view-Code"
              aria-labelledby="pr-tab-Code"
              hidden={view !== "Code"}
              className="t3-pr-code"
            >
              <div className="t3-diff-toolbar">
                <input
                  aria-label="Filter pull request files"
                  placeholder="Filter files…"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
                <button
                  className="t3-icon-button"
                  type="button"
                  title="Unified diff"
                  aria-label="Unified PR diff"
                  aria-pressed={!split}
                  onClick={() => setSplit(false)}
                >
                  <List />
                </button>
                <button
                  className="t3-icon-button"
                  type="button"
                  title="Split diff"
                  aria-label="Split PR diff"
                  aria-pressed={split}
                  onClick={() => setSplit(true)}
                >
                  <Columns2 />
                </button>
              </div>
              <p className="t3-diff-revisions">
                PR #{pr.number} · {pr.head.sha.slice(0, 7)} · GitHub comparison
              </p>
              {pr.files
                .filter((file) => file.path.toLowerCase().includes(filter.toLowerCase()))
                .map((file) => (
                  <div key={`${pr.head.sha}:${file.path}`}>
                    <DiffFile file={file} split={split} />
                    {pr.comments
                      .filter((comment) => comment.path === file.path)
                      .map((comment) => (
                        <article className="t3-anchored-comment" key={comment.id}>
                          <div>
                            <strong>{comment.author}</strong>
                            <a href={comment.url} target="_blank" rel="noopener noreferrer">
                              {comment.outdated ? "Outdated · " : ""}
                              {comment.side === "LEFT" ? "Before" : "After"} line{" "}
                              {comment.line ?? comment.originalLine ?? "unknown"}
                            </a>
                          </div>
                          <div className="chat-markdown">
                            <Markdown remarkPlugins={[remarkGfm]}>{comment.body}</Markdown>
                          </div>
                        </article>
                      ))}
                  </div>
                ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
