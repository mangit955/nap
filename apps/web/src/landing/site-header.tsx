/**
 * The bar at the top of `/docs`.
 *
 * The front page has a bar of its own now (`landing-nav.tsx`): it is dark, glass once scrolled, and
 * links to sections of itself, none of which belong on a light reference page. This one carries no
 * state and no hooks, so it renders on the server.
 *
 * **Positioning is the caller's.** `/docs` makes it sticky; that is a fact about the page, not
 * about the bar, which is why it arrives as a class rather than as a variant this file has to know
 * the names of.
 *
 * **The way *into* the product stays last, nearest the corner the eye lands on.** That is why
 * `wayIn` is a slot — `/docs` offers none today, and a page that did would decide when.
 */

import type { ReactNode } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import { GithubButton } from "./github-button.tsx";

export function SiteHeader({
  className = "",
  wayIn,
  current,
}: {
  className?: string;
  /**
   * The rightmost control, if there is one. Absent while a session is still resolving: guessing
   * puts a Sign in link under the cursor of somebody who is already signed in and about to be
   * redirected, and a slightly late control beats an early wrong one.
   */
  wayIn?: ReactNode;
  /** Set on the page the reader is already on, so the bar says where they are. */
  current?: "docs";
}) {
  return (
    <header className={`z-30 flex h-14 items-center justify-between px-6 ${className}`}>
      <a
        href="/"
        className="flex items-center gap-0.5 font-semibold text-[var(--s-text-primary)] text-sm tracking-tight focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
      >
        <NapMark className="size-10" />
        nap
      </a>

      <span className="flex items-center gap-4">
        <GithubButton />

        <a
          href="/docs"
          aria-current={current === "docs" ? "page" : undefined}
          className={`text-xs transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)] ${
            current === "docs"
              ? "text-[var(--s-text-primary)]"
              : "text-[var(--s-text-muted)] hover:text-[var(--s-text-primary)]"
          }`}
        >
          Docs
        </a>

        {wayIn}
      </span>
    </header>
  );
}
