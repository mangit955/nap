"use client";

/**
 * "On this page": the current page's headings down the right-hand side, with the one being read
 * marked, and the same list behind a button in the bar a phone gets instead.
 *
 * The single-page docs this replaced had no scroll-spy, on the argument that marking the section
 * you are in is misleading when several are on screen at once. Splitting into one page per topic
 * changed the arithmetic: a page now holds a handful of subheadings of a few screens each, so at
 * most one crosses the reading line at a time and the mark is right.
 */

import { ArrowUp, ChevronDown, List, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import type { Heading } from "./outline.ts";
import { useActiveHeading } from "./use-active-heading.ts";

export function DocsToc({ headings, editHref }: { headings: Heading[]; editHref: string }) {
  const active = useActiveHeading(headings.map((heading) => heading.id));

  return (
    <aside className="docs-toc">
      {headings.length > 0 && (
        <nav aria-label="On this page">
          <h2>
            <List aria-hidden="true" size={15} />
            On this page
          </h2>
          <ol>
            {headings.map((heading) => (
              <li key={heading.id}>
                <a
                  href={`#${heading.id}`}
                  aria-current={heading.id === active ? "location" : undefined}
                >
                  {heading.text}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="docs-toc-extra">
        <a href={editHref} target="_blank" rel="noreferrer">
          <Pencil aria-hidden="true" size={14} />
          Edit on GitHub
        </a>
        <button type="button" onClick={backToTop}>
          <ArrowUp aria-hidden="true" size={14} />
          Back to top
        </button>
      </div>
    </aside>
  );
}

function backToTop() {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
}

/** The phone's version: where you are, and the headings behind a button. */
export function MobileToc({ crumb, headings }: { crumb: string; headings: Heading[] }) {
  const [open, setOpen] = useState(false);
  const active = useActiveHeading(headings.map((heading) => heading.id));

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="docs-mobile-bar">
      <p>{crumb}</p>
      {headings.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={open}
            aria-controls="docs-mobile-toc"
            onClick={() => setOpen((value) => !value)}
          >
            On this page
            <ChevronDown aria-hidden="true" size={15} data-open={open} />
          </button>
          {open && (
            <nav id="docs-mobile-toc" aria-label="On this page" className="docs-mobile-toc">
              <ol>
                {headings.map((heading) => (
                  <li key={heading.id}>
                    <a
                      href={`#${heading.id}`}
                      aria-current={heading.id === active ? "location" : undefined}
                      onClick={() => setOpen(false)}
                    >
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ol>
            </nav>
          )}
        </>
      )}
    </div>
  );
}
