"use client";

/**
 * The band at the top of the dashboard: a greeting, and the box the whole product starts from.
 *
 * **The rim light comes with it.** `LitBox` is the same component the landing page lights, and
 * it is the one piece of nap that is unmistakably nap — a dashboard that dropped it would be a
 * generic dark admin page. It works on a dark ground unchanged, because `rollPalette` writes the
 * rim's colours inline onto the element `paletteRef` points at before the first pulse; the
 * `.ai-stage` defaults in `globals.css` are never consulted. The ref is this band because
 * `LitBox` asks for one and rolling onto an ancestor is what it documents — the properties
 * inherit down to the rim layers either way.
 *
 * **The band itself is a fixed dark surface, and the light is the only thing that moves.** It
 * used to carry a wash tinted with the rim's own first colour, on the theory that a surface
 * changing colour with the light reads as being lit by it. It does not: it reads as the page
 * tinting itself every few seconds for no reason a viewer can see, and it drags every neutral in
 * the band along with it. That is the identical mistake the landing page's stage made and had
 * removed — see `docs/GOTCHAS.md` § Web and UI. A room does not change colour because something
 * in it lit up.
 *
 * There is exactly one lit object on this page, as there is on the landing page. A second one
 * would be a second arc beating out of step with the first.
 *
 * Split like every pane in this app: this renders what it is given, and `LiveDashboard` owns the
 * request that turns a sentence into a project.
 */

import { useRef } from "react";
import { LitBox } from "../glow/lit-box.tsx";
import { EXAMPLE_PROMPTS } from "./example-prompts.ts";

/** The composer's face when the light is out — it is a control and has to look like one. */
const FACE = "border border-edge bg-field shadow-card";

export function DashboardHero({
  name,
  value,
  busy = false,
  error,
  prompts = EXAMPLE_PROMPTS,
  onChange,
  onSubmit,
}: {
  name: string;
  value: string;
  /** Set between the press and the navigation, so the box cannot be sent twice. */
  busy?: boolean;
  error?: string | undefined;
  prompts?: readonly string[];
  onChange: (value: string) => void;
  onSubmit: (message: string) => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  const band = useRef<HTMLDivElement>(null);

  const send = () => {
    const message = value.trim();
    if (message === "" || busy) return;
    onSubmit(message);
  };

  return (
    // Nothing is clipped here. The rim light's halo paints a hundred pixels outside the box, so
    // an `overflow-hidden` on the band would cut that soft edge square — the same clearance the
    // landing hero keeps around its own lit object.
    //
    // The band owns the first screenful: the grid below it is something you scroll to, not
    // something competing with the box on arrival. `min-h` rather than a fixed height so a long
    // name or a wrapped row of chips can push it taller, and just short of a full viewport so the
    // top edge of the projects section shows and says there is more.
    <div
      ref={band}
      className="relative flex min-h-[88dvh] flex-col justify-center border-edge border-b px-6 py-16"
    >
      <div className="relative mx-auto flex w-full max-w-2xl flex-col items-center">
        <h1 className="mb-8 text-center font-display font-semibold text-3xl text-ink tracking-tight sm:text-4xl">
          Let&rsquo;s build something, {name}
        </h1>

        <LitBox paletteRef={band} radius={18} faceClassName={FACE}>
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
            placeholder="a habit tracker with a weekly grid"
            className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15px] text-ink leading-relaxed outline-none placeholder:text-muted disabled:text-muted"
          />

          <div className="flex items-center justify-between px-3.5 pb-3">
            <span aria-hidden="true" className="text-[11px] text-muted">
              Enter to send
            </span>

            <button
              type="button"
              aria-label="Send"
              onClick={send}
              disabled={busy || value.trim() === ""}
              className="grid size-8 place-items-center rounded-[9px] bg-accent transition-opacity hover:opacity-90 disabled:bg-hover disabled:text-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
            >
              <svg
                viewBox="0 0 12 12"
                aria-hidden="true"
                className="size-4 fill-none stroke-current text-ink"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M6 9.5V2.5M6 2.5 3 5.5M6 2.5 9 5.5" />
              </svg>
            </button>
          </div>
        </LitBox>

        {error !== undefined && (
          // `alert` because the sentence the user just sent has gone nowhere and nothing else on
          // the page says why.
          <p role="alert" className="mt-4 text-danger text-sm">
            {error}
          </p>
        )}

        <ul className="mt-6 flex flex-wrap justify-center gap-2">
          {prompts.map((prompt) => (
            <li key={prompt}>
              <button
                type="button"
                onClick={() => {
                  // A starting point, not a decision: people edit these before sending.
                  onChange(prompt);
                  box.current?.focus();
                }}
                className="rounded-full border border-edge px-3.5 py-1.5 text-muted text-xs transition-colors hover:border-line-strong hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
              >
                {prompt}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
