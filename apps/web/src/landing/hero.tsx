"use client";

/**
 * The one thing on the page: a sentence, and a box to type one into.
 *
 * The box is the only lit object on a near-black page, which is the whole composition — there
 * is no gradient behind it and no decoration around it, because the colour in this section is
 * light coming off the box itself. Everything else is set in one ink ramp so nothing competes
 * with it.
 *
 * Split the way every pane in this app is split: this renders what it is given, and
 * `LiveHero` owns the requests and the navigation. Enter sends and Shift+Enter makes a
 * newline, matching the input inside the workspace — a prompt is often several sentences and
 * losing one to a stray Enter is what people stop trusting an input over.
 *
 * The textarea deliberately does **not** grow with its content. The rim light is masked by a
 * raster drawn for one specific box, so a box that changed size on every keystroke would mean
 * redrawing five of them per frame — or hiding the light while someone types, which is exactly
 * when they are looking at it.
 */

import { useEffect, useRef } from "react";
import { GlowBox, useGlow } from "../glow/glow-box.tsx";
import { EXAMPLE_PROMPTS } from "./example-prompts.ts";

/** Corner radius of the body. The face sits a pixel inside it, at one less. */
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
  const glow = useGlow(RADIUS);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = box.current;
    if (!restored || element === null) return;
    element.focus();
    // Caret at the end rather than selecting the lot: the next thing they do is press send,
    // and a fully selected field turns any stray keystroke into a deletion.
    element.setSelectionRange(element.value.length, element.value.length);
  }, [restored]);

  const send = () => {
    const message = value.trim();
    if (message === "" || busy) return;
    // Answered by light before it is answered by anything else — the request behind this takes
    // a moment, and a press with no response for half a second reads as a dropped click.
    glow.pulse();
    onSubmit(message);
  };

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col items-center px-6 pt-24 pb-16 sm:pt-32">
      <h1 className="text-balance text-center font-semibold text-4xl text-ink leading-[1.05] tracking-[-0.03em] sm:text-6xl">
        Describe an app.
        <br />
        Watch it get built.
      </h1>

      <p className="mt-5 max-w-md text-balance text-center text-muted text-sm leading-relaxed sm:text-base">
        Nap writes the code in a live sandbox and shows you the result while it works.
      </p>

      {/*
        The halo paints over a hundred pixels outside the box, so this wrapper exists purely to
        keep that clearance — anything that clipped here would cut the soft edge off square.
      */}
      <div className="mt-12 w-full px-1">
        <GlowBox
          glow={glow}
          className="w-full"
          faceClassName="overflow-hidden bg-panel shadow-[0_24px_60px_-24px_rgba(0,0,0,0.9)]"
        >
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
              send();
            }}
            placeholder="a pomodoro timer with a circular countdown"
            className="block w-full resize-none bg-transparent px-5 pt-4 pb-2 text-ink text-base leading-relaxed outline-none placeholder:text-muted/70 disabled:text-muted"
          />

          <div className="flex items-center justify-between px-4 pb-3">
            <span aria-hidden="true" className="text-muted/70 text-xs">
              Enter to send
            </span>

            <button
              type="button"
              aria-label="Send"
              onClick={send}
              disabled={busy || value.trim() === ""}
              className="grid size-9 place-items-center rounded-full bg-ink text-surface transition-opacity hover:opacity-90 disabled:bg-edge disabled:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            >
              <svg
                viewBox="0 0 12 12"
                aria-hidden="true"
                className="size-4 fill-none stroke-current"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 9.5V2.5M6 2.5 3 5.5M6 2.5 9 5.5" />
              </svg>
            </button>
          </div>
        </GlowBox>
      </div>

      {error !== undefined && (
        // `alert` because the message the user just sent has gone nowhere and nothing else on
        // the page says why.
        <p role="alert" className="mt-4 text-danger text-sm">
          {error}
        </p>
      )}

      <ul className="mt-8 flex flex-wrap justify-center gap-2">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <li key={prompt}>
            <button
              type="button"
              onClick={() => {
                onChange(prompt);
                box.current?.focus();
              }}
              className="rounded-full border border-edge px-3.5 py-1.5 text-muted text-xs transition-colors hover:border-muted/60 hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              {prompt}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
