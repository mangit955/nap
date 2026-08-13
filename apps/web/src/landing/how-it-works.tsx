"use client";

/**
 * The three beats of a turn, and the turn itself playing beside them.
 *
 * The hero makes a claim — describe an app, go away, come back to it running — and this is the
 * section that has to make it credible. It used to do that with three still pictures, which is a
 * strange way to argue that something works while you are not watching. Now there is one stage
 * playing a whole turn on a loop, and the three beats light up as the act they describe comes
 * round: the copy says what is happening and the demo shows it, at the same moment.
 *
 * **One row, and nothing sticky.** Everything is in a single screen, so no scroll position has to
 * be reached before the section makes sense, and the page scrolls at the speed the reader is
 * scrolling it. Under `lg` the stage goes first and the beats read underneath — the picture is
 * what pulls somebody into a column of text on a phone.
 *
 * The lit beat arrives as a `data-beat` attribute the stage writes onto this section; the
 * stylesheet does the rest. That keeps a change of act to one attribute write instead of a React
 * render of the whole section, and — the part that matters — **with no script, or under reduced
 * motion, no attribute is ever written and every beat simply stays at full strength.**
 */

import { useRef } from "react";
import { LiveStage } from "./demo/live-stage.tsx";
import { SectionHeading } from "./section-heading.tsx";
import { revealProps, useReveal } from "./use-reveal.ts";

const BEATS = [
  {
    title: "Say it in one sentence",
    body: "No stack to choose, no repo to clone, no template to pick. A sentence is the whole setup.",
  },
  {
    title: "Then nod off",
    body: "It works in a sandbox of its own — reading, writing, running commands, fixing what it broke.",
  },
  {
    title: "Wake up to it running",
    body: "The preview updates as it goes, so what you come back to is the app, not a diff to review.",
  },
] as const;

export function HowItWorks() {
  // The section is what the stage writes the lit beat onto: it is the common ancestor of the
  // demo and the copy, and an attribute here is the cheapest thing that can reach both.
  const section = useRef<HTMLElement>(null);
  const { ref, state } = useReveal<HTMLDivElement>();

  return (
    <section ref={section} aria-labelledby="how-it-works" className="px-6 py-24 sm:py-32">
      <div className="mx-auto max-w-5xl">
        <SectionHeading
          id="how-it-works"
          lines={["You describe it. nap builds it.", "You wake up to it running."]}
          emphasis="nap"
          sub="One turn, start to finish. Everything below happens on a machine that is yours for the length of the project."
        />

        <div
          ref={ref}
          {...revealProps(state)}
          className="nap-reveal mt-16 grid items-center gap-12 lg:mt-20 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1fr)] lg:gap-16"
        >
          <ol className="order-2 space-y-10 lg:order-1">
            {BEATS.map((beat, index) => (
              <li
                key={beat.title}
                data-beat-index={index + 1}
                className="nap-beat text-[var(--s-text-muted)]"
              >
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[11px] text-[var(--s-text-subtle)] tabular-nums">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  {/* The rule fills while this beat's act plays — a progress bar the length of the
                      paragraph, and the only thing on the page that says how far through it is. */}
                  <span className="nap-beat-rule relative block h-px w-10 bg-[var(--s-border-1)]" />
                </div>

                <h3 className="nap-beat-title mt-4 font-medium text-[var(--s-text-primary)] text-lg tracking-[-0.01em]">
                  {beat.title}
                </h3>
                <p className="mt-2 max-w-sm text-[15px] leading-relaxed">{beat.body}</p>
              </li>
            ))}
          </ol>

          <div className="order-1 lg:order-2">
            <LiveStage beatRef={section} />
          </div>
        </div>
      </div>
    </section>
  );
}
