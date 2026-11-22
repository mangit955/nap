/**
 * The typographic kit the eight sections are written with.
 *
 * It exists so the sections are prose rather than markup: a section file should read as an
 * argument somebody wrote, not as a wall of class strings with sentences hidden in it. The look is
 * the landing page's — its ink ramp and faces, set at reading size — and lives in `docs.css`, so
 * nothing here names a colour.
 *
 * **`outline.ts` reads a section without rendering it**: it calls the section and walks the
 * elements that come back, matching these components by identity and reading their props. That is
 * how the "On this page" list, the heading ids and the search index stay in step with the prose
 * without a second copy of it. These components are never called by that walk, so they may hold
 * state; a section may not (see `outline.ts`).
 */

import type { ReactNode } from "react";
import { CopyButton } from "./copy-button.tsx";
import { hrefOf, type SectionId } from "./pages.ts";
import { slugify, textOf } from "./text.ts";

/** The opening sentence of a section, set a step up from the body. */
export function Lede({ children }: { children: ReactNode }) {
  return <p className="docs-lede">{children}</p>;
}

export function P({ children }: { children: ReactNode }) {
  return <p className="docs-p">{children}</p>;
}

/**
 * A heading inside a section, and an entry in its "On this page" list. A second-level heading,
 * because the page's own title is the first.
 *
 * Its id is derived from its words, so a link to it is a link to what it says. Rewording one
 * changes its anchor; nothing in the repo links to one by hand, and `docs-page.test.tsx` fails if
 * two on a page would collide.
 */
export function Sub({ children }: { children: ReactNode }) {
  const id = slugify(textOf(children));
  return (
    <h2 id={id} className="docs-sub">
      {/* The heading is its own link, as in most docs, so its address can be copied from it; a
          separate "#" beside it would join the heading's accessible name. */}
      <a href={`#${id}`}>{children}</a>
    </h2>
  );
}

/**
 * A term the glossary already owns. Set apart rather than merely bolded, because these words are
 * load-bearing here: `CONTEXT.md` fixes one name per concept and this is where a reader meets
 * them.
 */
export function Term({ children }: { children: ReactNode }) {
  return <strong className="docs-term">{children}</strong>;
}

export function Code({ children }: { children: ReactNode }) {
  return <code className="docs-code">{children}</code>;
}

/** A list of facts, each a short claim with a sentence after it. */
export function Facts({ items }: { items: readonly { term: string; body: ReactNode }[] }) {
  return (
    <dl className="docs-facts">
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd>{item.body}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Fixed-width figures — the plane diagram, a directory tree, a sequence. The caption heads the
 * block, as a code block's file name would, and the drawing can be copied as the text it is.
 */
export function Figure({ children, label }: { children: string; label: string }) {
  return (
    <figure className="docs-figure">
      <figcaption>
        <span>{label}</span>
        <CopyButton text={children} label={`Copy “${label.replace(/\.$/, "")}”`} />
      </figcaption>
      <pre>{children}</pre>
    </figure>
  );
}

/**
 * A screen recording — the one thing in the docs that is evidence rather than argument.
 *
 * It does not autoplay and it is not muted-and-looping wallpaper: it is two minutes long, a reader
 * arrives here mid-sentence, and a page that starts moving on its own costs more attention than the
 * recording is worth. `preload="metadata"` means the poster is what loads with the page and the
 * eight megabytes only follow if somebody presses play.
 *
 * The `src` and `poster` are strings under `apps/web/public` that nothing type-checks, so
 * `docs-page.test.tsx` asserts both resolve to files that exist.
 */
export function Recording({
  src,
  poster,
  label,
  caption,
}: {
  src: string;
  poster: string;
  label: string;
  caption: string;
}) {
  return (
    <figure className="docs-recording" aria-label={label}>
      {/* biome-ignore lint/a11y/useMediaCaption: no speech and no audio track — there is nothing to caption. */}
      <video src={src} poster={poster} controls playsInline preload="metadata" aria-label={label} />
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

/**
 * A pointer at another page of the docs, by id, so a renamed or removed page is a type error
 * rather than a link to nowhere.
 *
 * Separate from `Source` rather than a prop on it, because the two differ in the one way that
 * matters to a reader: `Source` opens a new tab, and doing that for a page of these same docs is
 * how you end up with two copies open and no idea which one you were reading.
 */
export function Jump({ to, children }: { to: SectionId; children: ReactNode }) {
  return (
    <a href={hrefOf(to)} className="docs-link">
      {children}
    </a>
  );
}

/**
 * A pointer out of the docs — usually to the file that actually decides the thing just described.
 * External by default because almost everything worth pointing at is source.
 */
export function Source({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="docs-link">
      {children}
    </a>
  );
}
