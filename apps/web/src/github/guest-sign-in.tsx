import type { ReactNode } from "react";
import { PRIMARY_BUTTON } from "../settings/settings-ui.tsx";
import { ArrowLeftIcon, CheckIcon } from "../ui/icons.tsx";

/** What a permanent account adds, for the guest who came looking for GitHub to find out. */
const GUEST_GAINS = [
  "Import a repository and work on it on its own branch",
  "Publish verified work as a draft pull request",
  "Bring /nap comments and failed checks back here for your approval",
];

/**
 * What a guest sees instead of GitHub's controls: what an account would add, what it costs, and
 * the one way to get it. The project's GitHub dialog and the Connections page both show it, so a
 * guest is told the same thing wherever they reach for GitHub.
 *
 * Signing in from a guest session moves the browser to the account and leaves the guest behind,
 * projects and all — the server keeps them rather than deleting them, but nothing moves them
 * across — so this says so before anybody presses the button.
 */
export function GuestSignIn({ dismiss }: { dismiss: ReactNode }) {
  return (
    <>
      <div className="border-edge border-t px-6 py-5">
        <p className="text-[13px] leading-relaxed text-ink-2">
          You're using nap as a guest. Connecting GitHub needs a permanent account.
        </p>
        <ul className="mt-4 space-y-2.5">
          {GUEST_GAINS.map((gain) => (
            <li key={gain} className="flex gap-2.5 text-[13px] leading-snug text-muted">
              <CheckIcon className="mt-px size-3.5 shrink-0 text-ink-2" />
              {gain}
            </li>
          ))}
        </ul>
        <p className="mt-5 text-xs leading-relaxed text-muted">
          Your guest projects stay behind with the guest session; you won't be able to open them
          from your account.
        </p>
      </div>
      <div className="flex items-center justify-end gap-2 border-edge border-t px-6 py-4">
        {dismiss}
        <a href="/sign-in?upgrade=1" className={PRIMARY_BUTTON}>
          Sign in
          <ArrowLeftIcon className="size-3.5 rotate-180" />
        </a>
      </div>
    </>
  );
}
