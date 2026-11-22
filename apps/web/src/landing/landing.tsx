"use client";

/**
 * The front page's frame: the bar, the hero, what nap does, the example apps, what changed lately,
 * one last way in, and the footer.
 *
 * The hero arrives as a slot so this can be mounted and asserted on without a router, a session or
 * a network — the same split the panes and the sign-in form already use. The sections below it do
 * not, because none of them asks the server anything.
 *
 * **This page is for people who are not signed in.** Anybody with a session is sent to the
 * dashboard by `LiveLanding`, so there is no signed-in state to draw here — only the moment before
 * the session has resolved, when the bar offers no way in rather than a wrong one.
 *
 * **It is dark, like the product.** Every colour it uses is declared on `.landing` in
 * `landing.css`, so nothing here can restyle the workspace. The docs wear the same class, so they
 * look like the same site.
 */

import { type ReactNode, useRef } from "react";
import { BuiltWithNap } from "./built-with-nap.tsx";
import { Changelog } from "./changelog.tsx";
import { Features } from "./features.tsx";
import { LandingFooter } from "./landing-footer.tsx";
import { LandingNav } from "./landing-nav.tsx";
import { StartNow } from "./start-now.tsx";
import { useSmoothScroll } from "./use-smooth-scroll.ts";

export type AuthState = "pending" | "signed-out";

export function Landing({ auth, hero }: { auth: AuthState; hero: ReactNode }) {
  const page = useRef<HTMLDivElement>(null);
  useSmoothScroll(page);

  return (
    <div ref={page} data-landing-page className="landing relative min-h-dvh overflow-x-clip">
      <LandingNav auth={auth} />
      {/* Without script nothing measures the demos, which then stay hidden (`demo.css`); this
          shows them at their design size instead, cropped by their frames. */}
      <noscript>
        <style>{".lp-demo-space, .lp-demo-overlay { opacity: 1 !important; }"}</style>
      </noscript>

      <main>
        {hero}
        <Features />
        <BuiltWithNap />
        <Changelog />
        <StartNow />
      </main>

      <LandingFooter />
    </div>
  );
}
