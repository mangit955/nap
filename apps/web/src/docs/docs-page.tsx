/**
 * The documentation page: one route, eight sections, a sidebar of anchors.
 *
 * **One page rather than eight routes.** Somebody arriving here is deciding whether the
 * engineering is real, and that reader scrolls — a route per topic charges them a navigation per
 * section and shows them two of the eight. A single scroll puts every heading past their eye, and
 * a link to one heading still lands on it. The sections are separate components all the same, so
 * splitting this into routes later is composition rather than surgery.
 *
 * **Nothing here is a client component.** No reveal-on-scroll, no scroll-spy, no state: a
 * reference page is read with find-in-page as often as with the eye, and content that fades in as
 * you reach it is hostile to exactly that. The route ships no JavaScript of its own.
 *
 * The surface is the landing page's — this is reached from its header, by somebody who has not
 * signed in, and dropping them onto the dark workspace chrome would read as having left the
 * product.
 */

import { SiteFooter } from "../landing/site-footer.tsx";
import { SiteHeader } from "../landing/site-header.tsx";
import { DocsNav } from "./docs-nav.tsx";
import { SECTIONS } from "./sections.tsx";

export function DocsPage() {
  return (
    <div className="ai-stage-ink flex min-h-dvh flex-col bg-[var(--s-surface-1)]">
      {/*
        In the flow and sticky, where the landing's is drawn over its hero: there is no stage here
        for a bar to sit over, and a document is long enough that the way back out should not
        require scrolling to the top to find it.
      */}
      <SiteHeader
        className="sticky top-0 border-[var(--s-border-1)] border-b bg-[var(--s-surface-1)]/85 backdrop-blur"
        current="docs"
        wayIn={
          // Not a Sign in link. This page never resolves a session — anybody signed in would be
          // offered the wrong control, and the front door is the right answer either way.
          <a
            href="/"
            className="text-[var(--s-text-muted)] text-xs transition-colors hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
          >
            Open nap
          </a>
        }
      />

      {/* `5xl`, not wider: the prose is capped at `2xl` because a 90-character line is not read,
          so a roomier container buys nothing but a gulf between the text and its own index. */}
      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-16 sm:py-20">
        <div className="max-w-2xl">
          <h1 className="font-display font-extralight text-[2.6rem] text-[var(--s-text-body)] leading-[1.05] tracking-[-0.035em] sm:text-[3.2rem]">
            Docs
          </h1>
          {/* The one joke on the page, told once, where no term is at stake. */}
          <p className="mt-5 text-[17px] text-[var(--s-text-muted)] leading-relaxed">
            How it keeps working while you don&rsquo;t.
          </p>
        </div>

        <div className="mt-14 gap-12 lg:grid lg:grid-cols-[minmax(0,1fr)_13rem] lg:gap-16">
          {/* The document first in source order, so a screen reader and a phone both reach the
              content before the index of it. The sidebar is placed to the right by the grid. */}
          <div className="order-1 min-w-0">
            {SECTIONS.map(({ id, title, Body }) => (
              <section
                key={id}
                id={id}
                aria-labelledby={`${id}-heading`}
                // Clears the sticky bar when an anchor lands here — without it the heading arrives
                // underneath the header and the reader thinks the link went to the wrong place.
                className="scroll-mt-20 border-[var(--s-border-1)] border-t py-14 first:border-t-0 first:pt-0"
              >
                <h2
                  id={`${id}-heading`}
                  className="font-display font-extralight text-[1.9rem] text-[var(--s-text-primary)] leading-[1.15] tracking-[-0.03em] sm:text-[2.2rem]"
                >
                  {title}
                </h2>
                <Body />
              </section>
            ))}
          </div>

          <DocsNav className="order-2" />
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
