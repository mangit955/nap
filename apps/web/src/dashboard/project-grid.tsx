"use client";

/**
 * Everything you have made, under the box you start a new one in.
 *
 * It renders what it is handed: the filtering is `filters.ts`, which needs no DOM to be checked,
 * and the requests are `LiveDashboard`'s. The tabs here and the scopes in the rail are the same
 * selection shown twice — one state, passed down to both, because two components each holding
 * their own would show two different answers to the same question.
 *
 * **An empty grid is three different sentences.** Nothing here yet is a fact about the account;
 * no matches is a fact about the search box; nothing running is a fact about the scope. Printing
 * the first while either of the others is what emptied the grid tells somebody with nine
 * projects that they have none — see `emptyReason` at the foot of this file.
 */

import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import type { RefObject } from "react";
import type { ProjectsStatus } from "../projects/use-projects.ts";
import type { ProjectScope } from "./filters.ts";
import { ProjectCard } from "./project-card.tsx";

const TABS: readonly { id: ProjectScope; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "put-away", label: "Put away" },
];

export function ProjectGrid({
  projects,
  status,
  actionError,
  query,
  scope,
  counts,
  searchRef,
  busyProjectId,
  onQueryChange,
  onScopeChange,
  onOpen,
  onClose,
  onDelete,
}: {
  /** Already filtered — the grid does not decide what belongs in it. */
  projects: readonly ProjectSummaryPayload[];
  status: ProjectsStatus;
  actionError: string | undefined;
  query: string;
  scope: ProjectScope;
  counts: Record<ProjectScope, number>;
  /** The rail's Search button focuses this field; there is only one box filtering this grid. */
  searchRef?: RefObject<HTMLInputElement | null>;
  busyProjectId?: string | undefined;
  onQueryChange: (query: string) => void;
  onScopeChange: (scope: ProjectScope) => void;
  onOpen: (projectId: string) => void;
  onClose: (projectId: string) => void;
  onDelete: (projectId: string) => void;
}) {
  return (
    <section aria-label="Your projects" className="mx-auto w-full max-w-5xl px-6 py-10">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <input
          ref={searchRef}
          type="search"
          aria-label="Search your projects"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search"
          className="w-56 rounded-chip border border-edge bg-field px-3 py-1.5 text-ink text-sm outline-none placeholder:text-muted focus-visible:border-line-strong"
        />

        {/*
          A tablist rather than three buttons: these swap what the region below shows without
          navigating, which is what the pattern is for — and it gives every tab an
          `aria-selected` a reader can hear.
        */}
        <div role="tablist" aria-label="Filter projects" className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={scope === tab.id}
              onClick={() => onScopeChange(tab.id)}
              className={`rounded-chip px-3 py-1.5 text-sm transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${
                scope === tab.id ? "bg-hover font-medium text-ink" : "text-muted hover:text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <span className="ml-auto font-mono text-[11px] text-muted">
          {counts[scope]} {counts[scope] === 1 ? "project" : "projects"}
        </span>
      </div>

      {actionError !== undefined && (
        // A live region: this appears in response to something the user just pressed, and a
        // message that only changes visually is one a screen reader never mentions.
        <p role="alert" className="mb-4 font-mono text-danger text-xs">
          {actionError}
        </p>
      )}

      {status === "loading" && <p className="text-muted text-sm">Loading your projects…</p>}

      {status === "error" && (
        <p className="text-danger text-sm">
          Could not reach the server. Check that the API is running, then reload.
        </p>
      )}

      {status === "ready" && projects.length === 0 && (
        <p className="text-muted text-sm">{emptyReason(query, scope)}</p>
      )}

      {projects.length > 0 && (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.projectId}
              project={project}
              busy={busyProjectId === project.projectId}
              onOpen={onOpen}
              onClose={onClose}
              onDelete={onDelete}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Why the grid is empty, in the words of whatever actually emptied it.
 *
 * Three different facts get one sentence each, and printing the wrong one is a small lie about
 * the account: "nothing here yet" in front of somebody with nine projects — none of them running,
 * or none matching what they just typed — reads as their work having disappeared.
 */
function emptyReason(query: string, scope: ProjectScope): string {
  const needle = query.trim();
  if (needle !== "") return `No projects match “${needle}”.`;
  if (scope === "running") return "Nothing is running right now. Open a project to wake it up.";
  if (scope === "put-away") return "Nothing is put away — everything you have is running.";
  return "Nothing here yet. Describe an app in the box above and it will be built for you.";
}
