"use client";

/**
 * The front page's frame: a thin bar, the hero, and the story under it.
 *
 * The hero arrives as a slot so this can be mounted and asserted on without a router, a session
 * or a network — the same split the panes and the sign-in form already use. The sections below it
 * do not, because none of them asks the server anything: they are copy, and threading them
 * through a prop would be ceremony around three constants.
 *
 * **This page is for people who are not signed in.** Anybody with a session is sent to the
 * dashboard by `LiveLanding`, so there is no signed-in state to draw here.
 *
 * **Nothing is drawn on the right of the bar until the session has resolved.** Guessing wrong
 * puts a Sign in link under the cursor of somebody who is already signed in and about to be
 * redirected — the same argument the sign-in form makes about the GitHub button, and the reason a
 * slightly late control beats an early wrong one. The repository link does not wait: it is the
 * right answer either way.
 *
 * **The whole page is a light sheet now, not a lit stage on a dark page.** The hero keeps its own
 * gradient — it is a room with a light in it — and everything after it sits on the flat surface
 * that room stands on. The ink ramp is scoped to a class rather than declared at `:root`, so it
 * reaches this page and cannot restyle the dark workspace by accident.
 */

import type { ReactNode } from "react";
import { Capabilities } from "./capabilities.tsx";
import { ClosingCta } from "./closing-cta.tsx";
import { HowItWorks } from "./how-it-works.tsx";
import { SiteFooter } from "./site-footer.tsx";
import { SiteHeader } from "./site-header.tsx";

export type AuthState = "pending" | "signed-out";

export function Landing({ auth, hero }: { auth: AuthState; hero: ReactNode }) {
  return (
    <div className="ai-stage-ink relative flex min-h-dvh flex-col bg-[var(--s-surface-1)]">
      {/*
        Drawn over the hero rather than above it, which is why the positioning is passed in here
        rather than living in the bar: the stage is meant to be the first thing on the page. It
        scrolls away with everything else — the closing band is what offers the way in again.
      */}
      <SiteHeader
        className="absolute inset-x-0 top-0"
        wayIn={
          auth === "signed-out" ? (
            <a
              href="/sign-in"
              className="text-[var(--s-text-muted)] text-xs transition-colors hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
            >
              Sign in
            </a>
          ) : undefined
        }
      />

      <main className="flex flex-1 flex-col">
        {hero}
        <HowItWorks />
        <Capabilities />
        <ClosingCta />
      </main>

      <SiteFooter />
    </div>
  );
}
