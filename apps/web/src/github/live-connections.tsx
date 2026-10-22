"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { authClient } from "../auth/client.ts";
import { ConnectionsOverview } from "../settings/connections-overview.tsx";
import { GitHubConnections } from "./connections.tsx";

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
      <main className="min-h-dvh bg-surface px-6 py-16 text-ink">
        <div className="mx-auto max-w-lg">
          <h1 className="text-2xl font-medium">Connect GitHub</h1>
          <p className="my-5 text-sm text-muted">
            Sign in with a permanent nap account before connecting your repositories.
          </p>
          <a href="/sign-in?upgrade=1" className="text-sm underline">
            Sign in
          </a>
          <a href="/dashboard" className="ml-5 text-sm underline">
            Back to workspace
          </a>
        </div>
      </main>
    );
  return children;
}
