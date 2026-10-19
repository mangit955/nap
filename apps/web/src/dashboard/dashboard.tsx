"use client";

/**
 * The dashboard's frame: a fixed viewport, with scrolling confined to its content column.
 *
 * Structural only. The three parts arrive as slots so this can be mounted and asserted on
 * without a router, a session or a network — the same split the landing page and every pane in
 * the workspace use.
 *
 * The rail is a sibling of `main` rather than a child of it: a `nav` nested inside the main
 * landmark is not something a reader can skip to, which is most of what a landmark is for.
 *
 * **A box that clips has to be positioned, or it clips nothing.** `overflow: hidden` only applies
 * to descendants this element is the containing block for, and a `static` one is the containing
 * block for none of the absolutely positioned ones — they resolve against the initial containing
 * block and escape. Every `sr-only` label is absolutely positioned, so the third row of project
 * cards put one a few hundred pixels below the fold, outside every clamp on this page, and the
 * *window* scrolled to reach it: the rail and the whole frame slid up with it. `relative` here
 * and on the column is what contains them; `useDocumentScrollLock` is the belt to that pair of
 * braces.
 */

import { type ReactNode, useState } from "react";
import { useDocumentScrollLock } from "../ui/use-document-scroll-lock.ts";

export function Dashboard({
  sidebar,
  hero,
  grid,
  fading = false,
  contentLandmark = true,
}: {
  sidebar: ReactNode;
  hero: ReactNode;
  grid?: ReactNode;
  /** A session-ending request is still in flight; dim the frame until navigation takes over. */
  fading?: boolean;
  contentLandmark?: boolean;
}) {
  const Content = contentLandmark ? "main" : "div";
  useDocumentScrollLock();
  const [navigationOpen, setNavigationOpen] = useState(false);

  return (
    <div
      aria-busy={fading}
      className={`relative grid h-dvh overflow-hidden bg-surface transition-opacity duration-200 ease-out grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)] ${
        fading ? "opacity-60" : "opacity-100"
      }`}
      data-signing-out={fading}
    >
      {/* Below the breakpoint the rail would take a third of a phone; the grid and the composer
          are the page, and both work without it. */}
      <button
        type="button"
        aria-label={navigationOpen ? "Close sessions" : "Open sessions"}
        aria-expanded={navigationOpen}
        onClick={() => setNavigationOpen(!navigationOpen)}
        className="fixed top-3 left-3 z-50 grid size-9 place-items-center rounded-lg border border-edge bg-panel text-ink md:hidden"
      >
        {navigationOpen ? "×" : "☰"}
      </button>
      {navigationOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setNavigationOpen(false)}
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
        />
      )}
      <div
        className={`${navigationOpen ? "fixed inset-y-0 left-0 z-40 w-[280px] pt-12" : "hidden"} min-h-0 md:static md:block md:w-auto md:pt-0`}
      >
        {sidebar}
      </div>

      <Content className="nap-scroll-hidden relative min-h-0 overflow-y-auto">
        {hero}
        {grid}
      </Content>
    </div>
  );
}
