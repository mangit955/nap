"use client";

import type { ComponentType, ReactNode } from "react";
import { ChecksArt, RepoArt, ReviewArt } from "./feature-art.tsx";
import { useArrivals } from "./use-arrivals.ts";
import { revealProps, useReveal } from "./use-reveal.ts";
import "./features.css";

/**
 * What nap does, one row each: a plain heading, one sentence, a link to how it works, and the
 * product doing it. The pictures sit on the night backdrop, as the hero's session does, and are
 * one story told in order: a repository handed over, a test caught and fixed, a review answered.
 */
const ROWS: readonly {
  id: string;
  title: string;
  body: string;
  link: { label: string; href: string };
  Art: ComponentType;
}[] = [
  {
    id: "repo",
    title: "Hand it your repo. Come back to a pull request.",
    body: "Connect GitHub and give nap a task. It clones the repo into its own sandbox, does the work, and runs your checks. Publish the result as a draft pull request, or have nap open one every time. Close the tab whenever you like.",
    link: { label: "Connect GitHub", href: "/sign-up" },
    Art: RepoArt,
  },
  {
    id: "verification",
    title: "It checks its own work.",
    body: "Your project's tests, typecheck and build decide when a change is done. When one fails, nap reads the error, fixes the code, and runs them again.",
    link: { label: "How verification works", href: "/docs#verification" },
    Art: ChecksArt,
  },
  {
    id: "review",
    title: "Review it like a teammate's work.",
    body: "Review the pull request on GitHub the way you always do. When you want a change, comment /nap with what to do and approve it in nap. It makes the fix and runs your checks, and the verified commit goes to the same pull request.",
    link: { label: "Try it on your repo", href: "/sign-up" },
    Art: ReviewArt,
  },
];

export function Features() {
  return (
    <section id="product" aria-label="Product" className="lp-rows lp-container">
      {ROWS.map(({ id, title, body, link, Art }) => (
        <article key={id} className="lp-row" aria-labelledby={`${id}-title`}>
          <div className="lp-row-copy">
            <h2 id={`${id}-title`}>{title}</h2>
            <p>{body}</p>
            <a href={link.href} className="lp-more">
              {link.label} <span aria-hidden="true">→</span>
            </a>
          </div>
          <RowArt>
            <Art />
          </RowArt>
        </article>
      ))}
    </section>
  );
}

/**
 * The backdrop a row's picture stands on. It rises into place as it is scrolled to, and the
 * picture's rows and panels arrive one after another as it does (`use-arrivals.ts`). It starts
 * visible and is only hidden once something can bring it back (`use-reveal.ts`).
 */
function RowArt({ children }: { children: ReactNode }) {
  const { ref, state } = useReveal<HTMLDivElement>();
  useArrivals(ref, state === "in" ? 1 : 0, "hidden");
  const props = revealProps(state);
  return (
    <div ref={ref} {...props} className={`${props.className} lp-wall lp-row-art`}>
      {children}
    </div>
  );
}
