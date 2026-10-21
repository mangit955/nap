"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiKeyPanel } from "../account/api-key-panel.tsx";
import { useApiKey } from "../account/use-api-key.ts";
import { authClient } from "../auth/client.ts";
import { type ProjectScope, recentProjects, scopeCounts } from "../dashboard/filters.ts";
import { Sidebar } from "../dashboard/sidebar.tsx";
import { ComposerDraftStore } from "../projects/composer-draft.ts";
import { useSessionNavigation } from "../projects/use-session-navigation.ts";

export function SessionSidebar({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { data } = authClient.useSession();
  const navigation = useSessionNavigation();
  const { projects, status, actionError, rename, remove, close } = navigation;
  const lastRead = useRef<string | undefined>(undefined);
  useEffect(() => {
    const row = projects.find((item) => item.projectId === projectId);
    if (!row || document.hidden) return;
    const stamp = `${projectId}:${row.activityAt}`;
    if (lastRead.current === stamp) return;
    lastRead.current = stamp;
    if (
      row.navigation.unread ||
      (row.activityAt && (!row.navigation.readAt || row.activityAt > row.navigation.readAt))
    )
      void navigation.change(projectId, { kind: "read", at: row.activityAt, unread: false });
  }, [projectId, projects, navigation]);
  const [scope, setScope] = useState<ProjectScope>("all");
  const [settings, setSettings] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [busyProjectId, setBusyProjectId] = useState<string>();
  const key = useApiKey();
  const run = (id: string, action: (id: string) => Promise<unknown>) => {
    setBusyProjectId(id);
    void action(id).finally(() => setBusyProjectId(undefined));
  };
  return (
    <>
      <ApiKeyPanel open={settings} onClose={() => setSettings(false)} keyState={key} />
      <Sidebar
        navigation={navigation}
        ownerId={data?.user.id}
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
        busyProjectId={navigation.busyProjectId ?? busyProjectId}
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
            .then(async () => {
              if (data?.user.id) {
                await new ComposerDraftStore().clearOwner(data.user.id).catch(() => {});
                sessionStorage.removeItem(`nap.composer.${data.user.id}`);
              }
              router.replace("/");
            })
            .catch(() => setSigningOut(false));
        }}
      />
    </>
  );
}
