"use client";

import { ArrowRightIcon } from "../ui/icons.tsx";
import { REPO_URL } from "./github-button.tsx";
import { SessionPreview } from "./session-preview.tsx";
import { useDemoStage } from "./use-demo-stage.ts";

/**
 * The first screen: what nap is, the way in, and the product doing it.
 *
 * The session window sits on the dusk photograph, never under it. An earlier hero laid a mountain
 * mask across the window, which hid most of the product on a phone; the product is the proof, so
 * nothing is drawn in front of it.
 */
export function Hero() {
  const { ref, stage } = useDemoStage<HTMLDivElement>();
  return (
    <section aria-labelledby="hero-title" className="lp-hero lp-container">
      <h1 id="hero-title" className="lp-serif">
        Describe an app.
        <br /> Then go take a nap.
      </h1>
      <p>
        Nap writes the code in a cloud sandbox, runs your typecheck and build, fixes what fails, and
        hands you the repo.
      </p>
      <div className="lp-actions">
        <a href="/sign-up" className="lp-button lp-button-light lp-button-large">
          Start building <ArrowRightIcon className="size-4" />
        </a>
        <a
          href={REPO_URL}
          target="_blank"
          rel="noreferrer"
          className="lp-button lp-button-ghost lp-button-large"
        >
          Star on GitHub
        </a>
      </div>
      <div ref={ref} className="lp-wall lp-hero-wall">
        <SessionPreview stage={stage} />
      </div>
    </section>
  );
}
