/**
 * The frame every docs page sits in: the bar, the sidebar and the search, around the page itself.
 *
 * **One route per topic, where the docs used to be one long page.** One page suited eight sections
 * read top to bottom; it stopped suiting them as they grew — Verification alone runs to a dozen
 * screens — and a reader who came for one mechanism had to find it in all of them. A page each
 * gives every topic an address, a title in the tab and a search result of its own, and the sidebar
 * keeps the whole map in view, so splitting them costs the skimming reader nothing.
 *
 * **The surface is the landing page's**, its dark ground, ink ramp and faces, because the docs are
 * reached from its bar by somebody who has not signed in; anything else reads as having left the
 * site. That is why the route sits in the `(landing)` group, which loads those faces.
 *
 * This is the docs' route layout, so it renders once and stays mounted while a reader moves between
 * pages: the search index and the sidebar cross the wire once, not on every page.
 */

import type { ReactNode } from "react";
import { DocsHeader } from "./docs-header.tsx";
import { SearchProvider } from "./docs-search.tsx";
import { DocsSidebar, type HeadingsByPage } from "./docs-sidebar.tsx";
import { outlineOf } from "./outline.ts";
import { buildSearchIndex } from "./search-index.ts";
import { SECTIONS } from "./sections.tsx";

export function DocsShell({ children }: { children: ReactNode }) {
  const headings: HeadingsByPage = Object.fromEntries(
    SECTIONS.map(({ id, Body }) => [id, outlineOf(Body).headings]),
  );

  return (
    <div className="landing docs" data-docs>
      <a href="#docs-content" className="docs-skip">
        Skip to content
      </a>
      <SearchProvider entries={buildSearchIndex()}>
        <DocsHeader headings={headings} />
        <div className="docs-body" data-docs-body>
          {/* The aside runs the full height of the page and draws the rule; the sidebar inside it
              is what sticks, so the rule does not end where the first screen did. */}
          <aside className="docs-side">
            <div className="docs-side-sticky">
              <DocsSidebar headings={headings} />
            </div>
          </aside>
          <main id="docs-content" className="docs-main">
            {children}
          </main>
        </div>
      </SearchProvider>
    </div>
  );
}
