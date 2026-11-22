/**
 * The search index, built from the prose itself: one entry per page (its lede and the text before
 * its first subheading) and one per subheading (the text under it).
 *
 * Built on the server and handed to the search box as data, so the prose ships once, as HTML, and
 * the index is the only copy of it the browser holds.
 */

import { HOME_INTRO } from "./home-copy.ts";
import { outlineOf } from "./outline.ts";
import { DOCS_HOME, hrefOf, OVERVIEW } from "./pages.ts";
import type { SearchEntry } from "./search.ts";
import { SECTIONS } from "./sections.tsx";

export function buildSearchIndex(): SearchEntry[] {
  const home: SearchEntry = {
    kind: "page",
    href: DOCS_HOME,
    title: OVERVIEW.title,
    context: OVERVIEW.group,
    pageId: null,
    text: `${HOME_INTRO.title} ${HOME_INTRO.body}`,
  };

  return [
    home,
    ...SECTIONS.flatMap(({ id, title, group, Body }) => {
      const outline = outlineOf(Body);
      const page: SearchEntry = {
        kind: "page",
        href: hrefOf(id),
        title,
        context: group,
        pageId: id,
        text: outline.blocks.find((block) => block.heading === null)?.text ?? outline.lede,
      };
      const sections = outline.blocks.flatMap((block): SearchEntry[] =>
        block.heading
          ? [
              {
                kind: "section",
                href: `${hrefOf(id)}#${block.heading.id}`,
                title: block.heading.text,
                context: title,
                pageId: id,
                text: block.text,
              },
            ]
          : [],
      );
      return [page, ...sections];
    }),
  ];
}
