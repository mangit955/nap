"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { authClient } from "../auth/client.ts";
import { GitHubConnections } from "./connections.tsx";

export function LiveGitHubConnections({
  callbackStatus,
  draftId,
}: {
  callbackStatus?: string | undefined;
  draftId?: string | undefined;
}) {
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
          <a href="/sign-in" className="text-sm underline">
            Sign in
          </a>
          <a href="/dashboard" className="ml-5 text-sm underline">
            Back to workspace
          </a>
        </div>
      </main>
    );
  return <GitHubConnections callbackStatus={callbackStatus} draftId={draftId} />;
}
