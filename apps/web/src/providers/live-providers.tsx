"use client";

/**
 * The Providers page behind the account it belongs to.
 *
 * A guest is shown why it cannot connect a subscription rather than the page: an anonymous account
 * goes with its cookie, and a Claude or ChatGPT login left signed in under it is one nobody could
 * find again to sign out of. The API refuses a guest for the same reason; this says so first.
 */

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { authClient } from "../auth/client.ts";
import { BUTTON, PRIMARY_BUTTON } from "../settings/settings-ui.tsx";
import { ArrowLeftIcon } from "../ui/icons.tsx";
import { ClaudeIcon, OpenAIIcon } from "./provider-icons.tsx";
import { ProvidersPage } from "./providers-page.tsx";

export function LiveProviders() {
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
        Loading providers…
      </main>
    );
  if (session.user.isAnonymous) return <GuestProviders />;
  return <ProvidersPage />;
}

export function GuestProviders() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-surface px-4 py-16 text-ink">
      <section
        aria-labelledby="guest-providers-title"
        className="nap-pop w-full max-w-md rounded-2xl border border-edge bg-panel shadow-raised"
      >
        <div className="flex items-start gap-4 px-6 pt-6 pb-5">
          <span
            aria-hidden="true"
            className="flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-edge bg-field px-3 text-ink"
          >
            <OpenAIIcon className="size-4" />
            <ClaudeIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <h1 id="guest-providers-title" className="text-[15px] font-medium text-ink">
              Use your Claude or ChatGPT subscription
            </h1>
            <p className="mt-0.5 text-[13px] text-muted">
              Run turns on the plan you already pay for.
            </p>
          </div>
        </div>
        <div className="border-edge border-t px-6 py-5">
          <p className="text-[13px] leading-relaxed text-ink-2">
            You're using nap as a guest. Connecting a subscription needs a permanent account, so you
            can find it again to sign out.
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-muted">
            Your guest projects stay behind with the guest session; you won't be able to open them
            from your account.
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 border-edge border-t px-6 py-4">
          <a href="/dashboard" className={BUTTON}>
            Back to workspace
          </a>
          <a href="/sign-in?upgrade=1" className={PRIMARY_BUTTON}>
            Sign in
            <ArrowLeftIcon className="size-3.5 rotate-180" />
          </a>
        </div>
      </section>
    </main>
  );
}
