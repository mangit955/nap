/**
 * The index of the page, derived from the same list the page itself is built from.
 *
 * **No scroll-spy.** Highlighting the section you are "in" needs an observer, a client component
 * and a rule for what to do when three sections are on screen at once — and on a page whose
 * sections differ this much in length, that rule is wrong often enough to be misleading. A list
 * that says what is on the page is honest without any of it.
 *
 * On narrow screens it sits under the document rather than above it: a phone reader wants the
 * first section, not a table of contents standing between them and it. It is still a `nav`
 * landmark either way, so anybody navigating by landmark reaches it immediately.
 */

import { SECTIONS } from "./sections.tsx";

export function DocsNav({ className = "" }: { className?: string }) {
  return (
    <nav
      aria-label="On this page"
      className={`mt-16 lg:mt-0 lg:sticky lg:top-24 lg:self-start ${className}`}
    >
      <p className="text-[11px] text-[var(--s-text-subtle)] uppercase tracking-[0.18em]">
        On this page
      </p>

      <ol className="mt-4 space-y-2.5">
        {SECTIONS.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className="text-[13px] text-[var(--s-text-muted)] leading-snug transition-colors hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
            >
              {section.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
