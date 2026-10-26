"use client";

import { useRef } from "react";
import { ArrowRightIcon } from "../ui/icons.tsx";
import { SessionPreview } from "./session-preview.tsx";
import { useHeroReveal } from "./use-hero-reveal.ts";

export function Hero() {
  const section = useRef<HTMLElement>(null);
  const demoStage = useHeroReveal(section);
  return (
    <section ref={section} aria-labelledby="hero-title" className="lp-hero">
      <div className="lp-hero-rail">
        <div className="lp-hero-stage">
          <div className="lp-hero-scenery" aria-hidden="true">
            <div className="lp-scene" />
            <div className="lp-hero-sky" />
            <div className="lp-hero-mountains">
              <div className="lp-mountain-texture" />
              <div className="lp-mountain-texture lp-mountain-texture-right" />
            </div>
          </div>
          <div className="lp-hero-copy">
            <span className="lp-eyebrow">
              <span className="lp-status-dot" /> Open-source AI app builder
            </span>
            <h1 id="hero-title" className="lp-serif">
              Describe an app.
              <br /> Then go take a nap.
            </h1>
            <p>
              An idea from you. The building, checking,
              <br className="hidden sm:block" /> and figuring it out from nap.
            </p>
            <div className="lp-hero-actions">
              <a href="/sign-up" className="lp-pill lp-pill-light">
                Start building <ArrowRightIcon className="size-4" />
              </a>
              <a href="#why" className="lp-text-link">
                See how it works <span aria-hidden="true">↘</span>
              </a>
            </div>
          </div>
          <div className="lp-hero-product">
            <div className="lp-product-caption">
              <span>
                <span className="lp-status-dot" /> An idea becomes a working app.
              </span>
              <span>A LIVE SESSION</span>
            </div>
            <SessionPreview stage={demoStage} />
          </div>
          <span className="lp-hero-scroll-hint">
            SCROLL TO WATCH IT COME TOGETHER <span aria-hidden="true">↓</span>
          </span>
        </div>
      </div>
    </section>
  );
}
