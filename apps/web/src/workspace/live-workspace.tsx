"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { authClient } from "../auth/client.ts";
import { AppShell } from "../components/app-shell.tsx";
import { Dashboard } from "../dashboard/dashboard.tsx";
import { SessionSidebar } from "./session-sidebar.tsx";

export function LiveWorkspace({ projectId }: { projectId: string }) {
  const { data, isPending } = authClient.useSession();
  const router = useRouter();
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
      sidebar={<SessionSidebar projectId={projectId} />}
      hero={<AppShell key={projectId} projectId={projectId} ownerId={data.user.id} />}
    />
  );
}
