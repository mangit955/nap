"use client";

/**
 * The Account row of a provider's editor: whether it is signed in, the step to take while it is
 * signing in, and the buttons that start, cancel or end a sign-in. T3 Code's
 * `ProviderAuthenticationSection`, in Nap's palette.
 *
 * The provider runs its own login, and this row only relays it. Claude Code signs in through its
 * terminal login, so its step is that terminal's output; ChatGPT signs in in a browser tab, so its
 * step is a link. Nap never asks for a password or a token here.
 *
 * Adapted from T3 Code (MIT); see `THIRD_PARTY_NOTICES.md`.
 */

import type { ProviderAccountView } from "@nap/shared/provider-accounts-protocol";
import { useEffect, useState } from "react";
import { CopyIcon } from "../ui/icons.tsx";
import { isSigningIn } from "./account-status.ts";
import { accountName, DRIVERS } from "./drivers.tsx";
import {
  ACCENT_BUTTON,
  GHOST_BUTTON,
  ICON_BUTTON,
  OUTLINE_BUTTON,
  ProviderRow,
} from "./provider-settings-ui.tsx";
import type { Outcome } from "./use-provider-accounts.ts";

export function AccountSignIn({
  account,
  signInAvailable,
  onStart,
  onCancel,
  onSignOut,
  startError = null,
  confirm = (message) => window.confirm(message),
}: {
  account: ProviderAccountView;
  signInAvailable: boolean;
  onStart: () => Promise<Outcome<unknown>>;
  onCancel: () => Promise<Outcome<unknown>>;
  onSignOut: () => Promise<Outcome<unknown>>;
  startError?: string | null;
  /** Injected so a test can answer the sign-out question without a browser dialog. */
  confirm?: (message: string) => boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(startError), [startError]);
  const driver = DRIVERS[account.driver];
  const flow = account.signIn;
  const interaction = flow?.interaction ?? null;
  const active = isSigningIn(flow);
  const signedIn = account.auth.status === "authenticated";
  const url =
    interaction?.type === "browser" || interaction?.type === "deviceCode" ? interaction.url : null;

  async function run(command: () => Promise<Outcome<unknown>>) {
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await command();
    if (!result.ok) setError(result.error);
    setPending(false);
  }

  const description = active
    ? flow?.phase === "starting"
      ? "Starting sign-in…"
      : flow?.phase === "verifying"
        ? "Checking your account…"
        : interaction?.type === "terminal"
          ? "Complete sign-in in the terminal below."
          : interaction?.type === "deviceCode"
            ? "Enter the code below in your browser."
            : "Finish signing in in your browser."
    : signedIn
      ? null
      : !account.enabled
        ? "Switch this provider on to sign in."
        : !signInAvailable
          ? "Signing in to a provider isn't available on this deployment yet."
          : account.auth.status === "expired"
            ? "Your session expired. Sign in again to keep using it."
            : driver.pitch;
  const failure = flow?.phase === "failed" ? flow.message : null;
  const disabled = pending || !account.enabled || !signInAvailable;

  return (
    <ProviderRow
      title={driver.account}
      description={
        signedIn && !active ? (
          <span>
            Signed in as <span className="text-ink-2">{account.auth.email ?? "your account"}</span>
            {account.auth.plan ? ` · ${account.auth.plan}` : null}
          </span>
        ) : (
          <span role="status">{description}</span>
        )
      }
      status={
        failure ? (
          <p role="status" className="text-danger [overflow-wrap:anywhere]">
            {failure}
          </p>
        ) : undefined
      }
      control={
        <>
          {url ? (
            <>
              <a href={url} target="_blank" rel="noopener noreferrer" className={OUTLINE_BUTTON}>
                Open browser
              </a>
              <button
                type="button"
                aria-label="Copy sign-in link"
                title="Copy sign-in link"
                className={ICON_BUTTON}
                onClick={() => {
                  void navigator.clipboard
                    ?.writeText(url)
                    .catch(() => setError("Could not copy the sign-in link."));
                }}
              >
                <CopyIcon className="size-3.5" />
              </button>
            </>
          ) : null}
          {active ? (
            <button
              type="button"
              aria-label="Cancel sign-in"
              disabled={pending}
              className={GHOST_BUTTON}
              onClick={() => void run(onCancel)}
            >
              Cancel
            </button>
          ) : signedIn ? (
            <button
              type="button"
              disabled={disabled}
              className={OUTLINE_BUTTON}
              onClick={() => void run(onStart)}
            >
              Change account
            </button>
          ) : (
            <button
              type="button"
              disabled={disabled}
              className={ACCENT_BUTTON}
              onClick={() => void run(onStart)}
            >
              {driver.icon("size-3.5 shrink-0")}
              {flow?.phase === "failed" || flow?.phase === "cancelled"
                ? "Retry sign-in"
                : driver.signIn}
            </button>
          )}
          {signedIn && !active ? (
            <button
              type="button"
              disabled={pending}
              className={GHOST_BUTTON}
              onClick={() => {
                if (
                  confirm(
                    `Sign out of ${accountName(account)}? This stops running turns that use this sign-in. Session history is kept.`,
                  )
                )
                  void run(onSignOut);
              }}
            >
              Sign out
            </button>
          ) : null}
        </>
      }
    >
      {interaction?.type === "deviceCode" || interaction?.type === "terminal" || error ? (
        <div className="pb-2">
          {interaction?.type === "deviceCode" ? (
            <p className="py-2 text-sm text-muted">
              Enter code{" "}
              <code className="select-all font-mono text-ink">{interaction.userCode}</code> in your
              browser.
            </p>
          ) : null}
          {interaction?.type === "terminal" ? (
            <pre
              role="log"
              aria-label={`${driver.runtime} sign-in`}
              aria-live="polite"
              className="my-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-edge bg-surface px-3 py-2.5 font-mono text-xs leading-relaxed text-ink-2 [overflow-wrap:anywhere]"
            >
              {interaction.output}
            </pre>
          ) : null}
          {error ? (
            <p role="alert" className="py-1 text-xs text-danger">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </ProviderRow>
  );
}
