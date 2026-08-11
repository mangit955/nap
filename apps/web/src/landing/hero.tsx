"use client";

/**
 * The front page's one screen: a lit stage, a sentence, and an object that keeps changing what
 * it is until you touch it.
 *
 * The stage is light and the rest of the page is near-black, which is not a decoration — it is
 * the reason the rim light is worth building. A pale surface drifting through the same colour
 * arc that lights the card's edge reads as one thing illuminating another; the same effect on a
 * dark page reads as a glow with nowhere to land. The section fades back to the page colour at
 * its foot rather than ending on a line, so nothing about it announces itself as a band.
 *
 * The card cycles through four surfaces while nobody is using it. **Engaging with it settles it
 * for good** — click it, tab to it, or simply start typing — and what was a demonstration
 * becomes the box the whole product starts from. It never resumes cycling.
 *
 * Split the way every pane in this app is split: this renders what it is given, and `LiveHero`
 * owns the requests and the navigation.
 */

import { useRef, useState } from "react";
import { MorphCard } from "../glow/morph-card.tsx";
import { EXAMPLE_PROMPTS } from "./example-prompts.ts";

/** The settled body's corner. A real number, like every other radius here. */
const RADIUS = 20;

export function Hero({
  value,
  busy = false,
  error,
  restored = false,
  onChange,
  onSubmit,
}: {
  value: string;
  /** Set between the press and the navigation, so the box cannot be sent twice. */
  busy?: boolean;
  error?: string | undefined;
  /** True when the text came back from a sign-in detour and deserves the caret. */
  restored?: boolean;
  onChange: (value: string) => void;
  onSubmit: (message: string) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  // The palette is rolled onto the stage, not onto the card: custom properties inherit, so one
  // roll lights the rim *and* the surface it stands on. Two rolls would be two arcs drifting
  // out of step with each other.
  const stage = useRef<HTMLElement>(null);
  const [engaged, setEngaged] = useState(false);

  // Text that arrived on its own — restored across sign-in, or pressed from an example —
  // settles the card without being asked. There is no version of "we have your sentence" that
  // is compatible with still showing a demonstration in the place it belongs.
  const settled = engaged || restored || value !== "";

  const settle = (typed?: string) => {
    setEngaged(true);
    if (typed !== undefined) onChange(value + typed);
  };

  /*
   * Taking the caret is a two-sided handshake, and it has to be, because the two halves happen
   * in an order nothing here controls. The card announces the handover is over; React remounts
   * the arriving contents so their entry animation runs. Whichever lands second is the one that
   * can actually focus something — the announcement may hold a node that is about to be thrown
   * away, and the remount may arrive before anybody has asked for a caret.
   *
   * So the request is a flag, and both sides try. The callback ref clears it, because it is the
   * only one of the two that is holding an element that will still be there afterwards.
   */
  const wantsCaret = useRef(false);

  const focusBox = (element: HTMLTextAreaElement | null) => {
    if (element === null) return;
    element.focus();
    // Caret at the end rather than selecting the lot: the next thing they do is press send, and
    // a fully selected field turns any stray keystroke into a deletion.
    element.setSelectionRange(element.value.length, element.value.length);
  };

  const attachBox = (element: HTMLTextAreaElement | null) => {
    box.current = element;
    if (element === null || !wantsCaret.current) return;
    wantsCaret.current = false;
    focusBox(element);
  };

  const takeCaret = () => {
    wantsCaret.current = true;
    focusBox(box.current);
  };

  const send = () => {
    const message = value.trim();
    if (message === "" || busy) return;
    onSubmit(message);
  };

  return (
    <section
      ref={stage}
      className="ai-stage relative flex flex-col items-center overflow-hidden px-6 pt-24 pb-28 sm:pt-32"
    >
      {/*
        The stage gives way to the page rather than ending: a hard edge under a light band is
        the one thing that would make it read as a slab dropped onto the design.
      */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-[linear-gradient(to_bottom,transparent,var(--color-surface))]"
      />

      <div className="relative z-10 flex w-full max-w-2xl flex-col items-center">
        <h1 className="text-balance text-center font-semibold text-4xl text-[var(--s-text-primary)] leading-[1.05] tracking-[-0.03em] sm:text-6xl">
          Describe an app.
          <br />
          Watch it get built.
        </h1>

        <p className="mt-5 max-w-md text-balance text-center text-[var(--s-text-muted)] text-sm leading-relaxed sm:text-base">
          Nap writes the code in a live sandbox and shows you the result while it works.
        </p>

        {/*
          The halo paints over a hundred pixels outside the body, so this wrapper exists purely
          to keep that clearance — anything that clipped here would cut the soft edge square.
        */}
        <div className="mt-14 flex w-full justify-center px-1">
          <MorphCard
            settled={settled}
            onSettle={settle}
            settledRadius={RADIUS}
            settledLabel="Describe the app you want"
            onSettleComplete={takeCaret}
            paletteRef={stage}
            faceClassName="shadow-[0_1px_2px_rgba(12,38,77,0.06),0_10px_30px_-12px_rgba(12,38,77,0.18)]"
          >
            <div className="w-full">
              <textarea
                ref={attachBox}
                aria-label="Describe the app you want"
                rows={3}
                value={value}
                disabled={busy}
                onChange={(event) => onChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return;
                  // Otherwise the newline is inserted as well as the message being sent.
                  event.preventDefault();
                  send();
                }}
                placeholder="a habit tracker with a weekly grid"
                className="block w-full resize-none bg-transparent px-5 pt-4 pb-2 text-[16px] text-[var(--s-text-primary)] leading-relaxed outline-none placeholder:text-[var(--s-text-subtle)] disabled:text-[var(--s-text-muted)]"
              />

              <div className="flex items-center justify-between px-4 pb-3">
                <span aria-hidden="true" className="text-[12px] text-[var(--s-text-subtle)]">
                  Enter to send
                </span>

                <button
                  type="button"
                  aria-label="Send"
                  onClick={send}
                  disabled={busy || value.trim() === ""}
                  className="grid size-8 place-items-center rounded-[9px] bg-[var(--s-text-primary)] transition-opacity hover:opacity-90 disabled:bg-[var(--s-surface-3)] disabled:text-[var(--s-text-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--s-text-primary)] focus-visible:outline-offset-2"
                >
                  <svg
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                    className="size-4 fill-none stroke-[var(--s-text-inverse)]"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M6 9.5V2.5M6 2.5 3 5.5M6 2.5 9 5.5" />
                  </svg>
                </button>
              </div>
            </div>
          </MorphCard>
        </div>

        {error !== undefined && (
          // `alert` because the message the user just sent has gone nowhere and nothing else on
          // the page says why.
          <p role="alert" className="mt-5 text-[var(--color-danger)] text-sm">
            {error}
          </p>
        )}

        <ul className="mt-10 flex flex-wrap justify-center gap-2">
          {EXAMPLE_PROMPTS.map((prompt) => (
            <li key={prompt}>
              <button
                type="button"
                onClick={() => {
                  // Pressing an example settles the card too, by putting text in the box.
                  onChange(prompt);
                  setEngaged(true);
                }}
                className="rounded-full border border-[var(--s-border-1)] bg-[var(--s-surface-1)]/60 px-3.5 py-1.5 text-[var(--s-text-muted)] text-xs transition-colors hover:border-[var(--s-text-subtle)] hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
              >
                {prompt}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
