/**
 * How every section below the hero introduces itself: an eyebrow, a sentence, and a line of plain
 * copy under it.
 *
 * The eyebrow is doing real work rather than decorating. The headings on this page are jokes —
 * "sleep on it", "while you're out" — and a joke as the only label leaves somebody skimming with
 * no idea which part of the page they are in. The small tracked line above says what the section
 * is; the heading is then free to be funny, and the sentence under it is free to be plain.
 *
 * One heavy word per heading, never two: the emphasis is a pointer, and a page that points at
 * everything points at nothing. See `emphasis.tsx`.
 */

import { Fragment } from "react";
import { Emphasised } from "./emphasis.tsx";

export function SectionHeading({
  id,
  eyebrow,
  lines,
  emphasis,
  sub,
}: {
  /** The section labels itself with this, so a screen reader's landmark list is readable. */
  id: string;
  eyebrow: string;
  /**
   * One string per visual line. Where a heading breaks is a decision, not an outcome: left to
   * `text-balance` these headings break mid-sentence, which reads as a typo rather than a rhythm.
   */
  lines: readonly string[];
  emphasis: string;
  sub?: string;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <p className="text-[11px] text-[var(--s-text-subtle)] uppercase tracking-[0.18em]">
        {eyebrow}
      </p>

      <h2
        id={id}
        className="mt-4 text-balance font-display font-extralight text-[2rem] text-[var(--s-text-body)] leading-[1.1] tracking-[-0.03em] sm:text-[2.6rem]"
      >
        {lines.map((line, index) => (
          // Fixed content in source order, and nothing else to key a line on.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <Fragment key={index}>
            <span className="block">
              <Emphasised text={line} emphasis={emphasis} />
            </span>
            {/* A block boundary is a line break on screen and nothing at all in the accessible
                name — without this the heading is announced as "builds it.You wake". */}{" "}
          </Fragment>
        ))}
      </h2>

      {sub !== undefined && (
        <p className="mt-4 max-w-lg text-balance text-[15px] text-[var(--s-text-muted)] leading-relaxed">
          {sub}
        </p>
      )}
    </div>
  );
}
