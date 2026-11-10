"use client";

import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { authClient } from "../auth/client.ts";
import { TranscriptBlocks } from "../chat/transcript-skeleton.tsx";
import { Dashboard } from "../dashboard/dashboard.tsx";
import type { FetchJson } from "../files/use-project-files.ts";
import { prefetchProject } from "../projects/project-prefetch.ts";
import { SessionSidebar } from "./session-sidebar.tsx";

/**
 * Everything on a project's page that is not the project: the sign-in gate, the frame and the
 * sidebar.
 *
 * Rendered by the `/p` layout rather than by the page, because Next remounts a page whose
 * dynamic segment changed — so a sidebar inside it would be rebuilt, and its list fetched again,
 * on every switch between projects, and the row a double-click's first click opened would be
 * gone before its second. A layout above the segment is kept. The project comes from the URL,
 * since a layout is not handed the params of the segments below it.
 */
export function WorkspaceFrame({
  children,
  fetchJson,
}: {
  children: ReactNode;
  /** How the early project request goes out. Production passes nothing; see `AppShell`. */
  fetchJson?: FetchJson | undefined;
}) {
  const { data, isPending } = authClient.useSession();
  const router = useRouter();
  const params = useParams<{ projectId?: string }>();
  const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
  useEffect(() => {
    if (!isPending && !data) router.replace("/sign-in");
  }, [isPending, data, router]);
  // The project, asked for while the session is still being checked rather than after: the two
  // are independent round trips, and the workspace reads this answer once it mounts. Only while
  // the check is pending — once a session is known the workspace mounts at once and asks itself.
  // See `projects/project-prefetch.ts`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: an inline `fetchJson` is not a new project
  useEffect(() => {
    if (isPending && projectId !== undefined)
      prefetchProject(projectId, fetchJson === undefined ? {} : { fetchJson });
  }, [isPending, projectId]);
  if (!data)
    return (
      <main role="status" aria-label="Loading session…" className="flex min-h-dvh bg-surface">
        <span className="sr-only">Loading session…</span>
        {/* The workspace's shape rather than a line of text, so the real thing lands where this
            was instead of replacing a blank page. */}
        <div className="mx-auto flex w-full max-w-[46rem] flex-col px-5 pt-16">
          <TranscriptBlocks />
        </div>
      </main>
    );
  return (
    <Dashboard
      contentLandmark={false}
      sidebar={({ closeNavigation }) => (
        <SessionSidebar projectId={projectId} onNavigate={closeNavigation} />
      )}
      hero={children}
    />
  );
}
