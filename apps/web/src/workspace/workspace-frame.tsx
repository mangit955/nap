"use client";

import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { authClient } from "../auth/client.ts";
import { Dashboard } from "../dashboard/dashboard.tsx";
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
export function WorkspaceFrame({ children }: { children: ReactNode }) {
  const { data, isPending } = authClient.useSession();
  const router = useRouter();
  const params = useParams<{ projectId?: string }>();
  const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
  useEffect(() => {
    if (!isPending && !data) router.replace("/sign-in");
  }, [isPending, data, router]);
  if (!data)
    return (
      <main role="status" className="grid min-h-dvh place-items-center bg-surface text-muted">
        Loading session…
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
