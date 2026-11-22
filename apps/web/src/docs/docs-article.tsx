/**
 * One section as a page: where it sits, its title, its prose, the way on, and where to change it.
 */

import { ArrowLeft, ArrowRight, Pencil } from "lucide-react";
import Link from "next/link";
import { REPO_URL } from "../landing/github-button.tsx";
import { DocsToc, MobileToc } from "./docs-toc.tsx";
import { outlineOf } from "./outline.ts";
import { hrefOf, READING_ORDER } from "./pages.ts";
import type { DocSection } from "./sections.tsx";

/** Where the prose lives, relative to the repository — what the edit link opens. */
export const DOCS_SOURCE_DIR = "apps/web/src/docs";

export function DocsArticle({ section }: { section: DocSection }) {
  const { title, group, file, Body } = section;
  const { headings } = outlineOf(Body);
  const at = READING_ORDER.findIndex((stop) => stop.href === hrefOf(section.id));
  const previous = READING_ORDER[at - 1];
  const next = READING_ORDER[at + 1];
  const editHref = `${REPO_URL}/edit/main/${DOCS_SOURCE_DIR}/${file}`;

  return (
    <div className="docs-page">
      <MobileToc crumb={`${group} › ${title}`} headings={headings} />
      <article className="docs-article">
        <p className="docs-crumb">
          <span>{group}</span>
          <span aria-hidden="true">›</span>
          <span>{title}</span>
        </p>
        <h1 className="lp-serif docs-title">{title}</h1>
        <Body />

        <nav aria-label="Previous and next" className="docs-pager">
          {previous ? (
            <Link href={previous.href} rel="prev">
              <small>
                <ArrowLeft aria-hidden="true" size={13} />
                Previous
              </small>
              <span>{previous.title}</span>
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link href={next.href} rel="next" data-next>
              <small>
                Next
                <ArrowRight aria-hidden="true" size={13} />
              </small>
              <span>{next.title}</span>
            </Link>
          )}
        </nav>

        <footer className="docs-pagefoot">
          <a href={editHref} target="_blank" rel="noreferrer">
            <Pencil aria-hidden="true" size={13} />
            Edit this page on GitHub
          </a>
          <span>
            {DOCS_SOURCE_DIR}/{file}
          </span>
        </footer>
      </article>
      <DocsToc headings={headings} editHref={editHref} />
    </div>
  );
}
