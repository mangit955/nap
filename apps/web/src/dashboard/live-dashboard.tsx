"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiKeyPanel } from "../account/api-key-panel.tsx";
import { useApiKey } from "../account/use-api-key.ts";
import { authClient } from "../auth/client.ts";
import { useModels } from "../chat/use-models.ts";
import { ComposerDraftStore } from "../projects/composer-draft.ts";
import { useSessionNavigation } from "../projects/use-session-navigation.ts";
import { SpinnerIcon } from "../ui/icons.tsx";
import {
  type DraftSource,
  DraftThreadDetails,
  ThreadDetailsToggle,
  useThreadDetails,
} from "../workspace/thread-details.tsx";
import { Dashboard } from "./dashboard.tsx";
import { greetingName, recentProjects } from "./filters.ts";
import { NewSessionComposer } from "./new-session-composer.tsx";
import { Sidebar } from "./sidebar.tsx";

export function LiveDashboard() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && session == null) router.replace("/sign-in");
  }, [isPending, session, router]);

  if (isPending) {
    return (
      <main
        aria-label="Loading dashboard"
        aria-live="polite"
        className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface text-ink-2"
        role="status"
      >
        <SpinnerIcon className="size-5 text-muted" />
        <p className="text-sm">Getting your workspace ready…</p>
      </main>
    );
  }

  // **The page below is mounted only once there is somebody to draw it for**, and that is about
  // requests rather than about looks: `useProjects` asks on mount, the list endpoint answers 401
  // to a caller it does not recognise, and a 401 sends the browser to `/sign-in?expired=1` —
  // telling a visitor who has never signed in that their session ran out. Rendering the shell
  // and ignoring the answer would still make the request.
  if (session == null) return <div className="min-h-dvh bg-surface" />;

  return <SignedInDashboard user={session.user} />;
}

/** The dashboard proper. Everything here may assume there is a session behind it. */
function SignedInDashboard({
  user,
}: {
  user: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null | undefined;
    isAnonymous?: boolean | null | undefined;
  };
}) {
  const router = useRouter();
  const navigation = useSessionNavigation();
  const { projects, status, actionError, close, remove, rename } = navigation;
  const { models, loading: modelsLoading } = useModels();
  // The same hook the welcome step uses, so the rail's label and that page cannot disagree
  // about whether a key is saved.
  const key = useApiKey();
  const [keyPanelOpen, setKeyPanelOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const [draftVersion, setDraftVersion] = useState(0);
  const [draftSource, setDraftSource] = useState<DraftSource | null>(null);
  const [settingsRequest, setSettingsRequest] = useState(0);
  const details = useThreadDetails(`${user.id}:new-session`);
  const [busyProjectId, setBusyProjectId] = useState<string | undefined>(undefined);

  /** Runs one action against one project, with that card held still while it is in flight. */
  const run = (projectId: string, action: (id: string) => Promise<unknown>) => {
    setBusyProjectId(projectId);
    void action(projectId).finally(() => setBusyProjectId(undefined));
  };

  return (
    <>
      <ApiKeyPanel open={keyPanelOpen} onClose={() => setKeyPanelOpen(false)} keyState={key} />

      <Dashboard
        fading={signingOut}
        contentRef={details.ref}
        detailsCard={details.open ? details.presentation : undefined}
        details={
          <>
            <ThreadDetailsToggle
              className="t3-icon-button dashboard-details-toggle"
              open={details.open}
              onToggle={details.toggle}
            />
            {details.open && (
              <DraftThreadDetails
                source={draftSource}
                presentation={details.presentation}
                onDismiss={details.dismiss}
                onEditSource={() => setSettingsRequest((count) => count + 1)}
              />
            )}
          </>
        }
        sidebar={
          <Sidebar
            navigation={navigation}
            ownerId={user.id}
            name={user.isAnonymous ? "Guest" : user.name || greetingName(user)}
            email={user.isAnonymous ? undefined : (user.email ?? undefined)}
            avatarUrl={user.image ?? undefined}
            onRename={(id, name) => void rename(id, name)}
            onDelete={(id) => run(id, remove)}
            onClose={(id) => run(id, close)}
            error={actionError ?? (status === "error" ? "Could not load sessions." : undefined)}
            loading={status === "loading"}
            busyProjectId={navigation.busyProjectId ?? busyProjectId}
            recents={recentProjects(projects, projects.length)}
            onApiKey={() => setKeyPanelOpen(true)}
            keyHint={key.state?.configured === true ? key.state.hint : undefined}
            onNewProject={() => {
              window.history.replaceState(null, "", "/dashboard");
              sessionStorage.removeItem(`nap.composer.${user.id}`);
              setDraftVersion((version) => version + 1);
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLTextAreaElement>(
                    'textarea[aria-label="Describe the app you want"]',
                  )
                  ?.focus(),
              );
            }}
            signingOut={signingOut}
            onSignOut={() => {
              setSigningOut(true);
              void authClient
                .signOut()
                .then(async () => {
                  await new ComposerDraftStore().clearOwner(user.id).catch(() => {});
                  sessionStorage.removeItem(`nap.composer.${user.id}`);
                  // The session hook and the project list both hold answers that are now wrong,
                  // and the landing page is where a signed-out visitor belongs. The rail is left
                  // marked busy through the redirect: releasing it first invites a second press
                  // on a page that is already on its way out.
                  router.replace("/");
                })
                .catch(() => {
                  // A sign-out that cannot reach the server has not happened, and the honest
                  // thing is to hand the button back rather than spin forever on a session the
                  // person is still inside.
                  setSigningOut(false);
                });
            }}
          />
        }
        hero={
          <NewSessionComposer
            key={draftVersion}
            ownerId={user.id}
            models={models?.models ?? []}
            modelsLoading={modelsLoading}
            fallback={models?.fallback}
            onAddKey={() => setKeyPanelOpen(true)}
            onSourceChange={setDraftSource}
            settingsRequest={settingsRequest}
          />
        }
      />
    </>
  );
}
