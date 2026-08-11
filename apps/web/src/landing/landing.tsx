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
    <div className="relative flex min-h-dvh flex-col">
      {/*
        Drawn over the hero rather than above it. The hero is a light stage and the rest of the
        page is near-black, so a header in the normal flow would put a dark strip on top of a
        light band on top of a dark page — three horizontal slabs, which is exactly the reading
        the fade at the stage's foot exists to avoid. It takes the stage's ink, not its surface.
      */}
      <header className="ai-stage-ink absolute inset-x-0 top-0 z-30 flex h-14 items-center justify-between px-6">
        <span className="font-semibold text-[var(--s-text-primary)] text-sm tracking-tight">
          nap
        </span>

        {auth === "signed-out" && (
          <a
            href="/sign-in"
            className="text-[var(--s-text-muted)] text-xs transition-colors hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
          >
            Sign in
          </a>
        )}

        {auth === "signed-in" && (
          <button
            type="button"
            onClick={onSignOut}
            className="text-[var(--s-text-muted)] text-xs transition-colors hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
          >
            Sign out
          </button>
        )}
      </header>

      {/*
        No footer here. The hero fills the viewport, so anything after it would be a band of the
        dark page under a full screen of light; the line that lived here is inside the stage.
      */}
      <main className="flex flex-1 flex-col">
        {hero}
        {auth === "signed-in" && projects}
      </main>
    </div>
  );
}
