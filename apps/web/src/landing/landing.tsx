"use client";

/**
 * The front page's frame: a thin bar and the hero.
 *
 * Structural only. The hero arrives as a slot so this can be mounted and asserted on without a
 * router, a session or a network, which is the same split the panes and the sign-in form
 * already use.
 *
 * **This page is for people who are not signed in.** Anybody with a session is sent to the
 * dashboard by `LiveLanding`, so there is no signed-in state to draw here and no project list
 * under the hero — that lives on the dashboard now, where there is room for it.
 *
 * **Nothing is drawn on the right of the bar until the session has resolved.** Guessing wrong
 * puts a Sign in link under the cursor of somebody who is already signed in and about to be
 * redirected — the same argument the sign-in form makes about the GitHub button, and the reason
 * a slightly late control beats an early wrong one.
 */

import type { ReactNode } from "react";
import { NapMark } from "../brand/nap-mark.tsx";

export type AuthState = "pending" | "signed-out";

export function Landing({ auth, hero }: { auth: AuthState; hero: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col">
      {/*
        Drawn over the hero rather than above it. The hero is a light stage and the rest of the
        page is near-black, so a header in the normal flow would put a dark strip on top of a
        light band on top of a dark page — three horizontal slabs, which is exactly the reading
        the fade at the stage's foot exists to avoid. It takes the stage's ink, not its surface.
      */}
      <header className="ai-stage-ink absolute inset-x-0 top-0 z-30 flex h-14 items-center justify-between px-6">
        {/* `data-no-trail` on each end rather than the bar: the bar is the width of the page,
            and the hero's badge trail is welcome to the empty middle of it. */}
        <span
          data-no-trail
          className="flex items-center gap-0.5 font-semibold text-[var(--s-text-primary)] text-sm tracking-tight"
        >
          <NapMark className="size-10" />
          nap
        </span>

        {auth === "signed-out" && (
          <a
            data-no-trail
            href="/sign-in"
            className="text-[var(--s-text-muted)] text-xs transition-colors hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
          >
            Sign in
          </a>
        )}
      </header>

      {/*
        No footer here. The hero fills the viewport, so anything after it would be a band of the
        dark page under a full screen of light; the line that lived here is inside the stage.
      */}
      <main className="flex flex-1 flex-col">{hero}</main>
    </div>
  );
}
