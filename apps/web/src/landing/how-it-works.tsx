"use client";

/**
 * The three beats of a turn, in the order somebody lives them.
 *
 * The hero makes a claim — describe an app, go away, come back to it running — and this is the
 * section that has to make the claim credible. So each beat pairs one plain sentence with a
 * picture of the surface it is talking about: the box you type in, the log of what it did, the
 * app serving. Nothing here is a feature list; that is the section below.
 *
 * The rows alternate sides so the eye zig-zags down the page rather than running down a single
 * column of pictures — and they stack copy-first on a phone, because a picture with no sentence
 * yet is a puzzle.
 */

import type { ReactElement } from "react";
import { PreviewPanel, PromptPanel, TranscriptPanel } from "./panels.tsx";
import { SectionHeading } from "./section-heading.tsx";
import { revealProps, useReveal } from "./use-reveal.ts";

const BEATS = [
  {
    title: "Say it in one sentence",
    body: "No stack to choose, no repo to clone, no template to pick. A sentence is the whole setup.",
    Panel: PromptPanel,
  },
  {
    title: "Then nod off",
    body: "It works in a sandbox of its own — reading, writing, running commands, fixing what it broke.",
    Panel: TranscriptPanel,
  },
  {
    title: "Wake up to it running",
    body: "The preview updates as it goes, so what you come back to is the app, not a diff to review.",
    Panel: PreviewPanel,
  },
] as const;

export function HowItWorks() {
  return (
    <section aria-labelledby="how-it-works" className="px-6 py-24 sm:py-32">
      <div className="mx-auto max-w-4xl">
        <SectionHeading
          id="how-it-works"
          eyebrow="How it works"
          lines={["You describe it. nap builds it.", "You wake up to it running."]}
          emphasis="nap"
          sub="One turn, start to finish. Everything below happens on a machine that is yours for the length of the project."
        />

        <ol className="mt-20 space-y-20 sm:space-y-24">
          {BEATS.map((beat, index) => (
            <Beat key={beat.title} index={index} {...beat} />
          ))}
        </ol>
      </div>
    </section>
  );
}

function Beat({
  index,
  title,
  body,
  Panel,
}: {
  index: number;
  title: string;
  body: string;
  Panel: () => ReactElement;
}) {
  const { ref, state } = useReveal<HTMLLIElement>();
  const flipped = index % 2 === 1;

  return (
    <li ref={ref} {...revealProps(state)}>
      <div
        className={`flex flex-col items-center gap-10 sm:gap-14 md:flex-row md:items-center md:gap-16 ${
          flipped ? "md:flex-row-reverse" : ""
        }`}
      >
        {/* Copy first in source order on every row, so the stacked reading order is the one the
            beat is written in — the alternation is a desktop effect only. */}
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[11px] text-[var(--s-text-subtle)] tabular-nums">
            {String(index + 1).padStart(2, "0")}
          </p>
          <span aria-hidden="true" className="mt-3 block h-px w-8 bg-[var(--s-border-1)]" />

          <h3 className="mt-5 font-medium text-[var(--s-text-primary)] text-lg tracking-[-0.01em]">
            {title}
          </h3>
          <p className="mt-3 max-w-sm text-[15px] text-[var(--s-text-muted)] leading-relaxed">
            {body}
          </p>
        </div>

        <div className="flex shrink-0 justify-center">
          <Panel />
        </div>
      </div>
    </li>
  );
}
