"use client";

/**
 * The dashboard, wired to the session and the server.
 *
 * One question is asked here and answered for the whole page — who is signed in — and one list
 * is loaded, because the rail's recents and the grid's cards are the same projects shown twice.
 * Two subscriptions would be two answers that can disagree for a frame, and two requests would
 * be two lists that disagree for longer.
 *
 * **The scope and the search live here**, above both halves, for the same reason: the rail says
 * which scope is showing and the grid does the showing.
 *
 * Somebody who is not signed in is sent to the sign-in page — but only once the session has
 * resolved. Redirecting while it is still pending signs out anybody who arrives with a perfectly
 * good cookie, which is the same mistake as drawing a Sign in link over a live session.
 *
 * It is split in two for the same reason, and the split is load-bearing rather than tidy: hooks
 * cannot be skipped, so a single component would fire the project request before it knew whether
 * there was anybody to make it for — see the note on the early return below.
 */

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { authClient } from "../auth/client.ts";
import { useProjects } from "../projects/use-projects.ts";
import { useStartProject } from "../projects/use-start-project.ts";
import { Dashboard } from "./dashboard.tsx";
import { DashboardHero } from "./dashboard-hero.tsx";
import {
  filterProjects,
  greetingName,
  type ProjectScope,
  recentProjects,
  scopeCounts,
} from "./filters.ts";
import { ProjectGrid } from "./project-grid.tsx";
import { Sidebar } from "./sidebar.tsx";

export function LiveDashboard() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && session == null) router.replace("/sign-in");
  }, [isPending, session, router]);

  // **The page below is mounted only once there is somebody to draw it for**, and that is about
  // requests rather than about looks: `useProjects` asks on mount, the list endpoint answers 401
  // to a caller it does not recognise, and a 401 sends the browser to `/sign-in?expired=1` —
  // telling a visitor who has never signed in that their session ran out. Rendering the shell
  // and ignoring the answer would still make the request.
  if (session == null) return <div className="min-h-dvh bg-surface" />;

  return <SignedInDashboard user={session.user} />;
}

/** The dashboard proper. Everything here may assume there is a session behind it. */
function SignedInDashboard({ user }: { user: { name?: string | null; email?: string | null } }) {
  const router = useRouter();
  const { projects, status, actionError, create, close, remove } = useProjects();
  const { busy, error, start } = useStartProject();

  const [prompt, setPrompt] = useState("");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<ProjectScope>("all");
  const [busyProjectId, setBusyProjectId] = useState<string | undefined>(undefined);
  const search = useRef<HTMLInputElement>(null);

  /** Runs one action against one project, with that card held still while it is in flight. */
  const run = (projectId: string, action: (id: string) => Promise<void>) => {
    setBusyProjectId(projectId);
    void action(projectId).finally(() => setBusyProjectId(undefined));
  };

  return (
    <Dashboard
      sidebar={
        <Sidebar
          name={greetingName(user)}
          email={user.email ?? undefined}
          scope={scope}
          counts={scopeCounts(projects)}
          recents={recentProjects(projects)}
          onScopeChange={setScope}
          onSearch={() => search.current?.focus()}
          onNewProject={() => {
            void create().then((projectId) => {
              // Straight into the new project: nobody makes one in order to look at it in a grid.
              if (projectId !== undefined) router.push(`/p/${projectId}`);
            });
          }}
          onSignOut={() => {
            void authClient.signOut().then(() => {
              // The session hook and the project list both hold answers that are now wrong, and
              // the landing page is where a signed-out visitor belongs.
              router.replace("/");
            });
          }}
        />
      }
      hero={
        <DashboardHero
          name={greetingName(user)}
          value={prompt}
          busy={busy}
          error={error}
          onChange={setPrompt}
          onSubmit={(message) => void start(message)}
        />
      }
      grid={
        <ProjectGrid
          projects={filterProjects(projects, { query, scope })}
          status={status}
          actionError={actionError}
          query={query}
          scope={scope}
          counts={scopeCounts(projects)}
          searchRef={search}
          busyProjectId={busyProjectId}
          onQueryChange={setQuery}
          onScopeChange={setScope}
          onOpen={(projectId) => router.push(`/p/${projectId}`)}
          onClose={(projectId) => run(projectId, close)}
          onDelete={(projectId) => run(projectId, remove)}
        />
      }
    />
  );
}
