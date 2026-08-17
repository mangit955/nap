/**
 * The bar at the top of every public page.
 *
 * Extracted because there are two public pages now and a second copy of a nav is how two pages
 * stop agreeing about where things are. It carries no state and no hooks, so it renders on the
 * server for `/docs` and inside the landing's client tree without either having to care.
 *
 * **Positioning is the caller's.** On the landing it is drawn *over* the hero — a header in the
 * normal flow would put a strip above the stage, and the stage is meant to be the first thing on
 * the page. On `/docs` there is no stage to sit over, so it sits in the flow and sticks. Those are
 * facts about the page, not about the bar, which is why they arrive as a class rather than as a
 * variant this file has to know the names of.
 *
 * **The way *into* the product stays last, nearest the corner the eye lands on.** Everything left
 * of it is somewhere else to read: the repository, then the docs. That ordering is why `wayIn` is
 * a slot — the landing only knows whether to offer Sign in after the session resolves, and `/docs`
 * never offers it at all.
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
      {/* `data-no-trail` on each end rather than the bar: the bar is the width of the page,
          and the hero's badge trail is welcome to the empty middle of it. */}
      <a
        data-no-trail
        href="/"
        className="flex items-center gap-0.5 font-semibold text-[var(--s-text-primary)] text-sm tracking-tight focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
      >
        <NapMark className="size-10" />
        nap
      </a>

      <span data-no-trail className="flex items-center gap-4">
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
