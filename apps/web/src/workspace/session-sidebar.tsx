"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiKeyPanel } from "../account/api-key-panel.tsx";
import { useApiKey } from "../account/use-api-key.ts";
import { authClient } from "../auth/client.ts";
import { type ProjectScope, recentProjects, scopeCounts } from "../dashboard/filters.ts";
import { Sidebar } from "../dashboard/sidebar.tsx";
import { useProjects } from "../projects/use-projects.ts";

export function SessionSidebar({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { data } = authClient.useSession();
  const { projects, status, actionError, rename, remove, close } = useProjects();
  const [scope, setScope] = useState<ProjectScope>("all");
  const [settings, setSettings] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [busyProjectId, setBusyProjectId] = useState<string>();
  const key = useApiKey();
  const run = (id: string, action: (id: string) => Promise<void>) => {
    setBusyProjectId(id);
    void action(id).finally(() => setBusyProjectId(undefined));
  };
  return (
    <>
      <ApiKeyPanel open={settings} onClose={() => setSettings(false)} keyState={key} />
      <Sidebar
        name={data?.user.isAnonymous ? "Guest" : data?.user.name || "Your account"}
        email={data?.user.isAnonymous ? undefined : data?.user.email}
        avatarUrl={data?.user.image ?? undefined}
        scope={scope}
        counts={scopeCounts(projects)}
        recents={recentProjects(projects, projects.length)}
        activeProjectId={projectId}
        onScopeChange={setScope}
        onNewProject={() => router.push("/dashboard")}
        onApiKey={() => setSettings(true)}
        keyHint={key.state?.configured ? key.state.hint : undefined}
        signingOut={signingOut}
        loading={status === "loading"}
        error={actionError ?? (status === "error" ? "Could not load sessions." : undefined)}
        busyProjectId={busyProjectId}
        onRename={(id, name) => void rename(id, name)}
        onDelete={(id) =>
          run(id, async (removedId) => {
            if ((await remove(removedId)) && removedId === projectId) router.replace("/dashboard");
          })
        }
        onClose={(id) => run(id, close)}
        onSignOut={() => {
          setSigningOut(true);
          void authClient
            .signOut()
            .then(() => router.replace("/"))
            .catch(() => setSigningOut(false));
        }}
      />
    </>
  );
}
