"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { authClient } from "../auth/client.ts";
import { ConnectionsOverview } from "../settings/connections-overview.tsx";
import { BUTTON } from "../settings/settings-ui.tsx";
import { GithubIcon } from "../ui/icons.tsx";
import { GitHubConnections } from "./connections.tsx";
import { GuestSignIn } from "./guest-sign-in.tsx";

export function LiveGitHubConnections({
  callbackStatus,
  draftId,
}: {
  callbackStatus?: string | undefined;
  draftId?: string | undefined;
}) {
  return (
    <AccountGate>
      <GitHubConnections callbackStatus={callbackStatus} draftId={draftId} />
    </AccountGate>
  );
}

export function LiveConnectionsOverview({ draftId }: { draftId?: string | undefined }) {
  return (
    <AccountGate>
      <ConnectionsOverview draftId={draftId} />
    </AccountGate>
  );
}

/** Connections belong to a permanent account, so nothing is fetched until one is known. */
function AccountGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  useEffect(() => {
    if (!isPending && session === null) router.replace("/sign-in");
  }, [isPending, session, router]);
  if (isPending || !session)
    return (
      <main
        role="status"
        className="flex min-h-dvh items-center justify-center bg-surface text-muted"
      >
        Loading connections…
      </main>
    );
  if (session.user.isAnonymous)
    return (
      <main className="flex min-h-dvh items-center justify-center bg-surface px-4 py-16 text-ink">
        <section
          aria-labelledby="connect-github-title"
          className="nap-pop w-full max-w-md rounded-2xl border border-edge bg-panel shadow-raised"
        >
          <div className="flex items-start gap-4 px-6 pt-6 pb-5">
            <span
              aria-hidden="true"
              className="grid size-10 shrink-0 place-items-center rounded-full border border-edge bg-field text-ink"
            >
              <GithubIcon className="size-5" />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <h1 id="connect-github-title" className="text-[15px] font-medium text-ink">
                Connect GitHub
              </h1>
              <p className="mt-0.5 text-[13px] text-muted">
                Open pull requests, and answer review comments and CI failures.
              </p>
            </div>
          </div>
          <GuestSignIn
            dismiss={
              <a href="/dashboard" className={BUTTON}>
                Back to workspace
              </a>
            }
          />
        </section>
      </main>
    );
  return children;
}
