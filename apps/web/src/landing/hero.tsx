"use client";

import { useCallback, useState } from "react";
import { ArrowRightIcon } from "../ui/icons.tsx";
import { HeroDemo } from "./hero-demo.tsx";
import { useArrivals } from "./use-arrivals.ts";
import { type DemoStage, useDemoStage } from "./use-demo-stage.ts";

const BEATS: readonly DemoStage[] = ["working", "verifying", "verified"];

/**
 * The first screen: what nap is, the two ways in, and the product doing it.
 *
 * The session window sits on the night backdrop, never under it. An earlier hero laid a mountain
 * mask across the window, which hid most of the product on a phone; the product is the proof, so
 * nothing is drawn in front of it but the product's own Changes panel.
 */
export function Hero() {
  // The clock waits for the first beat's diff to draw (`use-demo-stage.ts`).
  const [drawn, setDrawn] = useState(false);
  const firstFrame = useCallback(() => setDrawn(true), []);
  const { ref, stage } = useDemoStage<HTMLDivElement>(drawn);
  useArrivals(ref, BEATS.indexOf(stage), "shown");
  return (
    <section aria-labelledby="hero-title" className="lp-hero lp-container">
      <h1 id="hero-title" className="lp-serif">
        Describe an app.
        <br /> Then go take a nap.
      </h1>
      <p>
        Start from an idea or your GitHub repo. Nap builds the frontend and the backend in a cloud
        sandbox, runs your checks, fixes what fails, and hands back the code.
      </p>
      <div className="lp-actions">
        <a href="/sign-up" className="lp-button lp-button-light lp-button-large">
          Start building <ArrowRightIcon className="size-4" />
        </a>
        <a href="/sign-up" className="lp-button lp-button-ghost lp-button-large">
          Connect a repo
        </a>
      </div>
      <div ref={ref} className="lp-wall lp-hero-wall" data-stage={stage}>
        <HeroDemo stage={stage} onFirstFrame={firstFrame} />
      </div>
    </section>
  );
}
