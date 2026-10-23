"use client";

import {
  type GitComparison,
  GitComparisonSchema,
  type GitScope,
  GitScopeSchema,
} from "@nap/shared/git-protocol";
import {
  ChevronDown,
  Columns2,
  FileCode2,
  GitCompareArrows,
  List,
  RotateCw,
  Search,
} from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { githubRequest } from "../github/request.ts";

const PierrePatch = dynamic(() => import("./pierre-patch.tsx"), {
  ssr: false,
  loading: () => <p className="t3-diff-notice">Loading diff…</p>,
});

type ComparisonState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; value: GitComparison };
export function ChangesPanel({
  sessionId,
  baseBranch,
  revision,
  active,
  onOpenFile,
  fetchJson = credentialedFetch,
}: {
  sessionId: string | undefined;
  baseBranch?: string | undefined;
  revision: number;
  active: boolean;
  onOpenFile: (path: string) => void;
  fetchJson?: FetchJson | undefined;
}) {
  const [scope, setScope] = useState<GitScope>("branch");
  const [state, setState] = useState<ComparisonState>({ kind: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState("");
  const [split, setSplit] = useState(false);
  useEffect(() => {
    if (!active || !sessionId) return;
    void revision;
    void refresh;
    let cancelled = false;
    setState({ kind: "loading" });
    const query = new URLSearchParams({ scope });
    if (scope === "branch" && baseBranch) query.set("base", baseBranch);
    void githubRequest(
      fetchJson,
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001"}/sessions/${encodeURIComponent(sessionId)}/changes?${query}`,
      GitComparisonSchema,
    ).then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { kind: "ready", value: result.value }
          : { kind: "error", message: result.error },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, baseBranch, revision, active, scope, refresh, fetchJson]);
  const comparison = state.kind === "ready" ? state.value : null;
  const files =
    comparison?.files.filter((file) => file.path.toLowerCase().includes(search.toLowerCase())) ??
    [];
  return (
    <div className="t3-changes">
      <div className="t3-diff-toolbar">
        <GitCompareArrows size={14} />
        <select
          aria-label="Diff scope"
          value={scope}
          onChange={(event) => {
            const parsed = GitScopeSchema.safeParse(event.target.value);
            if (parsed.success) setScope(parsed.data);
          }}
        >
          <option value="branch">Changes</option>
          <option value="uncommitted">Uncommitted</option>
          <option value="commit">Latest commit</option>
        </select>
        <div className="ml-auto flex gap-0.5">
          <button
            type="button"
            className="t3-icon-button"
            aria-label="Unified diff"
            aria-pressed={!split}
            title="Unified diff"
            onClick={() => setSplit(false)}
          >
            <List />
          </button>
          <button
            type="button"
            className="t3-icon-button"
            aria-label="Split diff"
            aria-pressed={split}
            title="Split diff"
            onClick={() => setSplit(true)}
          >
            <Columns2 />
          </button>
          <button
            type="button"
            className="t3-icon-button"
            aria-label="Refresh changes"
            title="Refresh changes"
            onClick={() => setRefresh((value) => value + 1)}
          >
            <RotateCw />
          </button>
        </div>
      </div>
      {comparison && (
        <>
          <div className="t3-diff-summary">
            <span>
              {comparison.files.length}{" "}
              {comparison.truncated ? "files shown · partial totals" : "files changed"}
            </span>
            <span className="t3-additions">
              +{comparison.files.reduce((sum, file) => sum + file.additions, 0)}
            </span>
            <span className="t3-deletions">
              −{comparison.files.reduce((sum, file) => sum + file.deletions, 0)}
            </span>
          </div>
          <p className="t3-diff-revisions" title={`${comparison.base} → ${comparison.head}`}>
            {comparison.baseLabel} · {comparison.base.slice(0, 7)} →{" "}
            {scope === "commit" ? comparison.head.slice(0, 7) : "working tree"}
          </p>
          <label className="t3-file-search">
            <Search size={14} />
            <input
              aria-label="Filter changed files"
              placeholder="Filter files…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </>
      )}
      <div className="t3-diff-scroll nap-scroll">
        {!sessionId ? (
          <div className="t3-panel-empty">
            <GitCompareArrows />
            <p>No changes yet</p>
            <span>Start a task to create the workspace.</span>
          </div>
        ) : state.kind === "loading" ? (
          <div className="t3-panel-empty" role="status">
            Loading changes…
          </div>
        ) : state.kind === "error" ? (
          <div className="t3-panel-empty" role="alert">
            <p>Could not load changes</p>
            <span>{state.message}</span>
            <button type="button" onClick={() => setRefresh((value) => value + 1)}>
              Try again
            </button>
          </div>
        ) : (
          <>
            {comparison?.truncated && (
              <p className="t3-diff-notice">
                This comparison is too large to show in full. Totals include only the files shown;
                some patches or files may be omitted.
              </p>
            )}
            {files.length === 0 && (
              <div className="t3-panel-empty">
                <GitCompareArrows size={28} strokeWidth={1} />
                <p>
                  {search
                    ? "No matching files"
                    : comparison?.truncated
                      ? "No file changes shown"
                      : "No changes"}
                </p>
                <span>
                  {comparison?.truncated
                    ? "This partial comparison may omit changed files."
                    : scope === "uncommitted"
                      ? "The working tree matches HEAD. Committed work appears under Changes or Latest commit."
                      : "These revisions have no file differences."}
                </span>
              </div>
            )}
            {files.map((file) => (
              <DiffFile
                key={`${scope}:${file.path}`}
                file={file}
                split={split}
                onOpenFile={onOpenFile}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
export function DiffFile({
  file,
  split,
  onOpenFile,
}: {
  file: GitComparison["files"][number];
  split: boolean;
  onOpenFile?: ((path: string) => void) | undefined;
}) {
  return (
    <details className="t3-diff-file" open>
      <summary>
        <ChevronDown className="t3-disclosure" size={12} />
        <FileCode2 size={13} />
        <span
          title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
          className="truncate"
        >
          {file.path}
        </span>
        <span className="t3-file-status">{file.status}</span>
        <span className="t3-additions">+{file.additions}</span>
        <span className="t3-deletions">−{file.deletions}</span>
        {file.status !== "deleted" && onOpenFile && (
          <button
            type="button"
            title="Open file"
            aria-label={`Open ${file.path}`}
            onClick={(event) => {
              event.preventDefault();
              onOpenFile(file.path);
            }}
          >
            <FileCode2 size={12} />
          </button>
        )}
      </summary>
      {file.binary ? (
        <p className="t3-diff-notice">Binary file changed</p>
      ) : !file.patch.includes("@@") ? (
        <p className="t3-diff-notice">
          {file.truncated
            ? "Patch unavailable or omitted because this comparison exceeds the display limit."
            : file.status === "renamed"
              ? `Renamed from ${file.previousPath}`
              : "No text changes"}
        </p>
      ) : (
        <PierrePatch
          patch={file.patch}
          path={file.path}
          previousPath={file.previousPath}
          split={split}
        />
      )}
      {file.truncated && file.patch.includes("@@") && (
        <p className="t3-diff-notice">
          Patch truncated. The complete comparison is available in Git.
        </p>
      )}
    </details>
  );
}
