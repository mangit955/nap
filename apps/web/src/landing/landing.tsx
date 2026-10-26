"use client";

/**
 * The front page's frame: the bar, the hero, the story under it, and the footer.
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
 * `landing.css`, so nothing here can restyle the workspace or the docs, which keep their own.
 */

import type { ReactNode } from "react";
import { Features } from "./features.tsx";
import { LandingFooter } from "./landing-footer.tsx";
import { LandingNav } from "./landing-nav.tsx";
import { Measurements } from "./measurements.tsx";
import { ProductStory } from "./product-story.tsx";
import { StartNow } from "./start-now.tsx";

export type AuthState = "pending" | "signed-out";

export function Landing({ auth, hero }: { auth: AuthState; hero: ReactNode }) {
  return (
    <div className="landing relative min-h-dvh overflow-x-clip">
      <LandingNav auth={auth} />

      <main>
        {hero}
        <ProductStory />
        <Features />
        <Measurements />
        <StartNow />
      </main>

      <LandingFooter />
    </div>
  );
}
