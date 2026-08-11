"use client";

/**
 * The front page's frame: a thin bar, the hero, and — once we know there is somebody to show
 * them to — their projects.
 *
 * Structural only. The hero and the list arrive as slots so this can be mounted and asserted on
 * without a router, a session or a network, which is the same split the panes and the sign-in
 * form already use.
 *
 * **Nothing is drawn on the right of the bar until the session has resolved.** Guessing wrong
 * puts a Sign in link under the cursor of somebody who is already signed in and then swaps it
 * for Sign out — the same argument the sign-in form makes about the GitHub button, and the
 * reason a slightly late control beats an early wrong one.
 */

import type { ReactNode } from "react";

export type AuthState = "pending" | "signed-in" | "signed-out";

export function Landing({
  auth,
  hero,
  projects,
  onSignOut,
}: {
  auth: AuthState;
  hero: ReactNode;
  /** Rendered only when there is a session; it is a request nobody else may make. */
  projects: ReactNode;
  onSignOut: () => void;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between px-6">
        <span className="font-semibold text-ink text-sm tracking-tight">nap</span>

        {auth === "signed-out" && (
          <a
            href="/sign-in"
            className="text-muted text-xs transition-colors hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            Sign in
          </a>
        )}

        {auth === "signed-in" && (
          <button
            type="button"
            onClick={onSignOut}
            className="text-muted text-xs transition-colors hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            Sign out
          </button>
        )}
      </header>

      <main className="flex flex-1 flex-col">
        {hero}
        {auth === "signed-in" && projects}
      </main>

      <footer className="shrink-0 px-6 py-6 text-center text-muted/70 text-xs">
        Every app is built in its own sandbox, and only you can open it.
      </footer>
    </div>
  );
}
