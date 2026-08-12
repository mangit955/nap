"use client";

/**
 * The dashboard's frame: a rail that stays put, and a column that scrolls.
 *
 * Structural only. The three parts arrive as slots so this can be mounted and asserted on
 * without a router, a session or a network — the same split the landing page and every pane in
 * the workspace use.
 *
 * The rail is a sibling of `main` rather than a child of it: a `nav` nested inside the main
 * landmark is not something a reader can skip to, which is most of what a landmark is for.
 */

import type { ReactNode } from "react";

export function Dashboard({
  sidebar,
  hero,
  grid,
}: {
  sidebar: ReactNode;
  hero: ReactNode;
  grid: ReactNode;
}) {
  return (
    <div className="grid h-dvh grid-cols-1 bg-surface md:grid-cols-[248px_1fr]">
      {/* Below the breakpoint the rail would take a third of a phone; the grid and the composer
          are the page, and both work without it. */}
      <div className="hidden md:block">{sidebar}</div>

      <main className="min-h-0 overflow-y-auto">
        {hero}
        {grid}
      </main>
    </div>
  );
}
