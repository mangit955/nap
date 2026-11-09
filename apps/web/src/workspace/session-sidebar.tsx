"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApiKeyPanel } from "../account/api-key-panel.tsx";
import { useApiKey } from "../account/use-api-key.ts";
import { authClient } from "../auth/client.ts";
import { recentProjects } from "../dashboard/filters.ts";
import { seenChange } from "../dashboard/session-rows.ts";
import { Sidebar } from "../dashboard/sidebar.tsx";
import { ComposerDraftStore } from "../projects/composer-draft.ts";
import { useSessionNavigation } from "../projects/use-session-navigation.ts";

/**
 * The workspace's sidebar. It lives in the `/p` layout, so it outlives every switch between
 * projects: the list is not fetched again and the row just opened is still the one clicked.
 */
export function SessionSidebar({
  projectId,
  onNavigate,
}: {
  /** The open project, if the route has one. */
  projectId: string | undefined;
  /** Called on every selection, so a mobile drawer can close: navigation here prevents the click. */
  onNavigate?: (() => void) | undefined;
}) {
  const router = useRouter();
  const { data } = authClient.useSession();
  const navigation = useSessionNavigation();
  const { projects, status, actionError, rename, remove, close } = navigation;
  const lastRead = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (projectId === undefined) return;
    const row = projects.find((item) => item.projectId === projectId);
    if (!row || document.hidden) return;
    const stamp = `${projectId}:${row.activityAt}:${row.navigation.snoozedUntil}`;
    if (lastRead.current === stamp) return;
    lastRead.current = stamp;
    // The open session is being looked at, which also ends a Woke.
    const seen = seenChange(row, Date.now());
    if (seen) void navigation.change(projectId, seen, { quiet: true });
  }, [projectId, projects, navigation]);
  const [settings, setSettings] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const key = useApiKey();
  return (
    <>
      <ApiKeyPanel open={settings} onClose={() => setSettings(false)} keyState={key} />
      <Sidebar
        navigation={navigation}
        ownerId={data?.user.id}
        name={data?.user.isAnonymous ? "Guest" : data?.user.name || "Your account"}
        email={data?.user.isAnonymous ? undefined : data?.user.email}
        avatarUrl={data?.user.image ?? undefined}
        recents={recentProjects(projects, projects.length)}
        activeProjectId={projectId}
        onNewProject={() => router.push("/dashboard")}
        // Client-side, so switching projects keeps this page: no new document, no auth refetch,
        // no sidebar reload. The workspace under it is keyed by project and starts over.
        onSelectProject={(id) => {
          if (id !== projectId) router.push(`/p/${id}`);
          onNavigate?.();
        }}
        onApiKey={() => setSettings(true)}
        keyHint={key.state?.configured ? key.state.hint : undefined}
        signingOut={signingOut}
        loading={status === "loading"}
        error={actionError ?? (status === "error" ? "Could not load sessions." : undefined)}
        onRename={(id, name) => void rename(id, name)}
        onDelete={(id) =>
          void remove(id).then((removed) => {
            if (removed && id === projectId) router.replace("/dashboard");
          })
        }
        onClose={(id) => void close(id)}
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
