"use client";

/**
 * The front page, Num1's: the bar, the hero, the agent at work, the four numbered sections, a
 * dark closing band and the footer.
 *
 * **This page is for people who are not signed in.** Anybody with a session is sent to the
 * dashboard by `LiveLanding`, so there is no signed-in state to draw here — only the moment before
 * the session has resolved, when the bar offers no way in rather than a wrong one.
 *
 * **It is light, and only it is.** Every colour and face it uses is declared on `.num1` in
 * `num1.css`, so nothing here restyles the workspace, and the docs and sign-in pages, which still
 * wear the older dark `.landing` theme, are untouched by it.
 *
 * **Its product pictures are stand-ins** (`showcase/`): static drawings, one module each, to be
 * swapped for the real components once the dashboard is redrawn in this style.
 */

import { useRef } from "react";
import { Capabilities } from "./capabilities.tsx";
import { Changelog } from "./changelog.tsx";
import { Hero } from "./hero.tsx";
import { LandingFooter } from "./landing-footer.tsx";
import { LandingNav } from "./landing-nav.tsx";
import { LiveStage } from "./live-stage.tsx";
import { Loop } from "./loop.tsx";
import { SessionShowcase } from "./session-showcase.tsx";
import { StartNow } from "./start-now.tsx";
import { useSmoothScroll } from "./use-smooth-scroll.ts";
import "./num1.css";
import "./showcase/showcase.css";

export type AuthState = "pending" | "signed-out";

export function Landing({ auth }: { auth: AuthState }) {
  const page = useRef<HTMLDivElement>(null);
  useSmoothScroll(page);

  return (
    <div ref={page} data-landing-page className="num1">
      <LandingNav auth={auth} />
      <main>
        <Hero />
        <LiveStage />
        <Loop />
        <Capabilities />
        <SessionShowcase />
        <Changelog />
        <StartNow />
      </main>
      <LandingFooter />
    </div>
  );
}
