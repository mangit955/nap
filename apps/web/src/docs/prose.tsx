/**
 * The typographic kit the eight sections are written with.
 *
 * It exists so the sections are prose rather than markup: a section file should read as an
 * argument somebody wrote, not as a wall of class strings with sentences hidden in it. Nothing
 * here is clever — it is the landing page's ink ramp and type scale, set once at document rather
 * than at pitch size.
 *
 * **No reveal-on-scroll, and no scroll-spy.** Both are on the landing page for good reasons and
 * neither survives the move: content that fades in as you reach it is hostile to somebody using
 * find-in-page to answer one question, which is what a reference page is *for*. The whole route
 * renders on the server and ships no script of its own.
 */

import type { ReactNode } from "react";

/** The opening sentence of a section, set a step up from the body. */
export function Lede({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 max-w-2xl text-[17px] text-[var(--s-text-body)] leading-relaxed">
      {children}
    </p>
  );
}

export function P({ children }: { children: ReactNode }) {
  return (
    <p className="mt-5 max-w-2xl text-[15px] text-[var(--s-text-muted)] leading-[1.75]">
      {children}
    </p>
  );
}

/** A run-in heading inside a section — the level below the eight, and never in the sidebar. */
export function Sub({ children }: { children: ReactNode }) {
  return (
    <h3 className="mt-10 font-medium text-[15px] text-[var(--s-text-primary)] tracking-[-0.01em]">
      {children}
    </h3>
  );
}

/**
 * A term the glossary already owns. Set apart rather than merely bolded, because these words are
 * load-bearing here: `CONTEXT.md` fixes one name per concept and this is where a reader meets
 * them.
 */
export function Term({ children }: { children: ReactNode }) {
  return <strong className="font-medium text-[var(--s-text-primary)]">{children}</strong>;
}

export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-[4px] bg-[var(--s-surface-3)] px-1.5 py-0.5 font-mono text-[0.85em] text-[var(--s-text-body)]">
      {children}
    </code>
  );
}

/** A list of facts, each a short claim with a sentence after it. */
export function Facts({ items }: { items: readonly { term: string; body: ReactNode }[] }) {
  return (
    <dl className="mt-6 max-w-2xl space-y-4">
      {items.map((item) => (
        <div key={item.term} className="border-[var(--s-border-1)] border-l pl-4">
          <dt className="font-medium text-[14px] text-[var(--s-text-primary)]">{item.term}</dt>
          <dd className="mt-1 text-[15px] text-[var(--s-text-muted)] leading-[1.7]">{item.body}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Fixed-width figures — the plane diagram, a directory tree, a sequence. */
export function Figure({ children, label }: { children: string; label: string }) {
  return (
    <figure className="mt-7 max-w-2xl">
      <pre className="overflow-x-auto rounded-md border border-[var(--s-border-1)] bg-[var(--s-surface-2)] p-4 font-mono text-[12px] text-[var(--s-text-body)] leading-[1.65]">
        {children}
      </pre>
      <figcaption className="mt-2 text-[var(--s-text-subtle)] text-xs">{label}</figcaption>
    </figure>
  );
}

/**
 * A screen recording — the one thing on this page that is evidence rather than argument.
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
    <figure className="mt-7 max-w-3xl" aria-label={label}>
      {/* biome-ignore lint/a11y/useMediaCaption: no speech and no audio track — there is nothing to caption. */}
      <video
        src={src}
        poster={poster}
        controls
        playsInline
        preload="metadata"
        aria-label={label}
        className="w-full rounded-lg border border-[var(--s-border-1)] bg-[var(--s-surface-2)]"
      />
      <figcaption className="mt-2 text-[var(--s-text-subtle)] text-xs">{caption}</figcaption>
    </figure>
  );
}

/**
 * A pointer out of the page — usually to the file that actually decides the thing just described.
 * External by default because almost everything worth pointing at is source.
 */
export function Source({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-[var(--s-text-body)] underline decoration-[var(--s-border-1)] underline-offset-4 transition-colors hover:decoration-[var(--s-text-subtle)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
    >
      {children}
    </a>
  );
}
