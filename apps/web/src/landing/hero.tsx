"use client";

/**
 * The front page's one screen: a lit stage, a sentence, and an object that keeps changing what
 * it is.
 *
 * The stage is light and the rest of the page is near-black, which is not a decoration — it is
 * what gives the rim light somewhere to land. On a dark page a coloured glow is just a glow; on
 * a pale one it reads as light falling on a surface. The surface itself is a fixed neutral and
 * deliberately so: it used to drift through the same arc as the rim, which read as the page
 * tinting itself rather than as anything being lit.
 *
 * **The card is a picture, not a control.** It cycles through four surfaces from the sort of
 * interface that sits around a model while it works, and nothing about it responds to a cursor.
 * What you can act on sits under it, and differs by who is looking: somebody signed in gets the
 * box that starts a project; somebody who is not gets the way in. There is deliberately no
 * input before sign-in — a prompt typed by a stranger would have to be stored somewhere, carried
 * across an authentication redirect and handed back, and every one of those steps is a place to
 * lose somebody's sentence.
 *
 * Split the way every pane in this app is split: this renders what it is given, and `LiveHero`
 * owns the requests and the navigation.
 */

import { useRef } from "react";
import { BadgeTrail } from "../badge-trail/badge-trail.tsx";
import { MorphCard } from "../glow/morph-card.tsx";
import { Doodles } from "./doodles.tsx";
import { EXAMPLE_PROMPTS } from "./example-prompts.ts";
import { Headline } from "./headline.tsx";

/**
 * The sentence, and where it breaks.
 *
 * It is an instruction and a joke in that order, which is the order that works: the first line
 * says what to do here and the second says what the product is *for*, by name. Written the other
 * way round the name lands before anything has explained it, and reads as whimsy rather than as
 * a claim. The old pair — describe an app, watch it get built — was accurate about the mechanism
 * and said nothing about why anybody would want it.
 */
const LINES = ["Describe an app.", "Then go take a nap."] as const;
const SUB = "It'll be running by the time you're back — written in a live sandbox you can watch.";
/** The word the sentence turns on, and the only one set heavy. */
const EMPHASIS = "nap";

export function Hero({
  signedIn,
  value,
  busy = false,
  error,
  onChange,
  onSubmit,
}: {
  /** Decides what sits below the card: a prompt box, or a way in. */
  signedIn: boolean;
  value: string;
  /** Set between the press and the navigation, so the box cannot be sent twice. */
  busy?: boolean;
  error?: string | undefined;
  onChange: (value: string) => void;
  onSubmit: (message: string) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  // The palette is rolled onto the stage, not onto the card: custom properties inherit, so one
  // roll lights the rim *and* the surface it stands on. Two rolls would be two arcs drifting
  // out of step with each other.
  const stage = useRef<HTMLElement>(null);

  const send = () => {
    const message = value.trim();
    if (message === "" || busy) return;
    onSubmit(message);
  };

  return (
    <section
      ref={stage}
      className="ai-stage relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 py-24"
    >
      <Doodles />
      <BadgeTrail />

      {/*
        `data-no-trail`: the badge trail drops nothing that would land on this column. It is one
        attribute on the whole column rather than one per element, because the gaps between a
        headline, a card and a button are not places a badge should sit either.
      */}
      <div data-no-trail className="relative z-10 flex w-full max-w-2xl flex-col items-center">
        <Headline lines={LINES} sub={SUB} emphasis={EMPHASIS} />

        {/*
          The halo paints over a hundred pixels outside the body, so this wrapper exists purely
          to keep that clearance — anything that clipped here would cut the soft edge square.
        */}
        <div className="mt-14 flex w-full justify-center px-1">
          <MorphCard
            paletteRef={stage}
            faceClassName="shadow-[0_1px_2px_rgba(12,38,77,0.06),0_10px_30px_-12px_rgba(12,38,77,0.18)]"
          />
        </div>

        {signedIn ? (
          <PromptBox box={box} value={value} busy={busy} onChange={onChange} onSend={send} />
        ) : (
          <WayIn />
        )}

        {error !== undefined && (
          // `alert` because the message the user just sent has gone nowhere and nothing else on
          // the page says why.
          <p role="alert" className="mt-5 text-[var(--color-danger)] text-sm">
            {error}
          </p>
        )}

        {signedIn && (
          <ul className="mt-8 flex flex-wrap justify-center gap-2">
            {EXAMPLE_PROMPTS.map((prompt) => (
              <li key={prompt}>
                <button
                  type="button"
                  onClick={() => {
                    // A starting point, not a decision: people edit these before sending.
                    onChange(prompt);
                    box.current?.focus();
                  }}
                  className="rounded-full border border-[var(--s-border-1)] bg-[var(--s-surface-1)]/60 px-3.5 py-1.5 text-[var(--s-text-muted)] text-xs transition-colors hover:border-[var(--s-text-subtle)] hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--s-text-primary)]"
                >
                  {prompt}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        Inside the stage rather than under it. The hero fills the viewport, so anything placed
        after it would be a strip of the dark page at the foot of the first screen — which is
        the one thing this section is not supposed to have.
      */}
      <p className="absolute inset-x-0 bottom-6 text-center text-[var(--s-text-subtle)] text-xs">
        {/* The span, not the paragraph: the paragraph is the full width of the stage and would
            cost the trail the whole bottom band to protect one sentence. */}
        <span data-no-trail>Every app is built in its own sandbox, and only you can open it.</span>
      </p>
    </section>
  );
}

/** What a signed-in visitor gets: the box the whole product starts from. */
function PromptBox({
  box,
  value,
  busy,
  onChange,
  onSend,
}: {
  box: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}) {
  return (
    <div className="mt-10 w-full rounded-[20px] border border-[var(--s-border-1)] bg-[var(--s-surface-1)] shadow-[0_1px_2px_rgba(12,38,77,0.05)]">
      <textarea
        ref={box}
        aria-label="Describe the app you want"
        rows={3}
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          // Otherwise the newline is inserted as well as the message being sent.
          event.preventDefault();
          onSend();
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
          onClick={onSend}
          disabled={busy || value.trim() === ""}
          className="grid size-8 place-items-center rounded-[9px] bg-[var(--s-text-primary)] transition-opacity hover:opacity-90 disabled:bg-[var(--s-surface-3)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--s-text-primary)] focus-visible:outline-offset-2"
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
  );
}

/**
 * What everybody else gets. Two links rather than one: signing up and signing in are different
 * intentions, and a single button asks the person who already has an account to guess that it
 * means them too. They lead to the same page, which opens on the half they asked for.
 */
function WayIn() {
  return (
    <div className="mt-10 flex items-center gap-3">
      <a
        href="/sign-up"
        className="rounded-full bg-[var(--s-text-primary)] px-5 py-2.5 font-medium text-[var(--s-text-inverse)] text-sm transition-opacity hover:opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--s-text-primary)] focus-visible:outline-offset-2"
      >
        Sign up
      </a>
      <a
        href="/sign-in"
        className="rounded-full border border-[var(--s-border-1)] px-5 py-2.5 font-medium text-[var(--s-text-body)] text-sm transition-colors hover:border-[var(--s-text-subtle)] hover:text-[var(--s-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--s-text-primary)] focus-visible:outline-offset-2"
      >
        Sign in
      </a>
    </div>
  );
}
