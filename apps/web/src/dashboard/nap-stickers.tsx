"use client";

/**
 * Four small versions of Nap caught between prompts.
 *
 * These belong in the roomy edges of the dashboard hero, not in the composer itself: they make
 * the otherwise blank band feel inhabited without asking somebody to look through decoration
 * to find the one thing they came here to do. They reuse the real mark rather than a second
 * approximation of it, so a change to Nap's silhouette reaches the stickers too.
 *
 * **Each one is doing something, and each one does something different when you point at it.**
 * Four stills of a character read as clip art; four characters mid-task read as a place with
 * somebody in it. So one nods to a beat with notes leaving its head, one types in bursts at a
 * laptop whose screen breathes, one sleeps and is startled awake, and one twinkles a spark it
 * then throws. The idle loops are deliberately slow and small — under three pixels of travel —
 * because the box below is what someone came here to look at; the *hover* is where each one is
 * allowed to be playful, and no two hovers do the same thing.
 *
 * **The layer stays click-through; the four boxes do not.** Hover needs a hit area, so each
 * sticker takes the mouse while the sheet it sits on keeps `pointer-events-none` — otherwise a
 * transparent full-band overlay would swallow every click meant for the composer. They stay
 * `aria-hidden` and unfocusable: there is nothing here to operate, only something to notice.
 *
 * `kind` names the behaviour, and all of the timing for it lives in `globals.css` beside the
 * mark's own animations rather than in inline styles here.
 */

import type { CSSProperties } from "react";
import { NapMark } from "../brand/nap-mark.tsx";

/**
 * The three sparks the wand throws on hover, in the spark sticker's own 88×92 user units — the
 * distances are SVG coordinates, not CSS pixels, so they read smaller on screen than they look.
 */
const SPARKS = [
  { d: "M62 20h.01", delay: "0ms", x: "14px", y: "-14px" },
  { d: "M70 34h.01", delay: "80ms", x: "17px", y: "5px" },
  { d: "M54 32h.01", delay: "160ms", x: "-13px", y: "-11px" },
] as const;

const PEN = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function NapStickers() {
  return (
    <div
      aria-hidden="true"
      data-testid="nap-stickers"
      className="pointer-events-none absolute inset-0 hidden overflow-hidden lg:block"
    >
      {/* Nap, headphones on, eyes shut, nodding along while an idea lands. */}
      <Sticker kind="music" className="top-[15%] left-[5%] -rotate-6" awake>
        <NapMark className="size-20" />
        <svg
          aria-hidden="true"
          viewBox="0 0 96 96"
          className="absolute inset-0 size-20 text-accent"
          {...PEN}
          strokeWidth="2.2"
        >
          {/*
            The cups are solid and the band is a line, which is how a real pair of headphones
            reads: the ear pads are the only part with any bulk to them. Left as outlines the
            whole thing sat on the ghost's white silhouette as four thin arcs and dissolved into
            it — a filled pad is the one bit of colour that survives at this size.
          */}
          <g>
            <path d="M24 50c0-18 10-29 24-29s24 11 24 29" />
            <path
              fill="currentColor"
              d="M22 49c-4 1-6 5-6 10v8c0 4 3 7 7 7h4V52h-5ZM74 49c4 1 6 5 6 10v8c0 4-3 7-7 7h-4V52h5Z"
            />
          </g>
          <path d="M82 28c4-4 7-5 10-5M85 35c4-1 7-1 10 1" />

          {/*
            Two notes rather than a stream: each carries its own delay, exactly like the mark's
            z's, so they leave one at a time. One shared animation moves them in lockstep, which
            reads as a decoration blinking rather than as music coming out of somebody's head.
          */}
          <g className="nap-notes" strokeWidth="2">
            <path className="nap-note" d="M70 20v-9l7-2v9" style={{ animationDelay: "0ms" }} />
            <path className="nap-note" d="M82 14v-7l6-2v7" style={{ animationDelay: "900ms" }} />
          </g>
        </svg>
      </Sticker>

      {/*
        Nap at a laptop, seen from the far side of the desk: the machine is *in front of* him and
        opaque, so it covers the bottom of his body and he reads as sitting behind it rather than
        next to a drawing of one. Beside him the laptop was just a prop; occluding him is the
        whole trick, and it is why the lid is filled with the page's own panel colour instead of
        being an outline you can see straight through.
      */}
      <Sticker kind="code" className="top-[22%] right-[6%] rotate-5" awake>
        <div className="-translate-y-2 relative">
          <NapMark className="size-[4.2rem]" />

          {/*
            Glasses, on the mark's own 24-grid so the lenses land on the eyes: same viewBox as
            `NapMark`, same size, laid over the top. They are drawn *over* rather than cut out
            because they are a thing he is wearing, not a hole in him — and the accent is what
            makes them read as glasses at this size instead of as a second pair of eyebrows.
          */}
          <svg
            aria-hidden="true"
            viewBox="-1 -6 32 32"
            className="absolute inset-0 size-[4.2rem] text-accent"
            {...PEN}
            strokeWidth="0.85"
          >
            <rect x="5.9" y="10.3" width="5.4" height="4.4" rx="1.5" />
            <rect x="12.7" y="10.3" width="5.4" height="4.4" rx="1.5" />
            <path d="M11.3 12.2h1.4M5.9 12.1 3.6 11M18.1 12.1l2.3-1.1" />
            {/*
              A short highlight in the corner of each lens — the difference between glass and two
              empty rings. It has to stay in the corner: drawn across the middle it reads as a
              line struck through the eye rather than as a reflection.
            */}
            <path strokeWidth="0.7" d="m6.9 12.4 1.1-1.3M13.7 12.4l1.1-1.3" />
          </svg>
        </div>

        <svg
          aria-hidden="true"
          viewBox="0 0 120 62"
          className="-translate-x-1/2 absolute bottom-1 left-1/2 w-[5rem] text-muted"
          {...PEN}
          strokeWidth="2.4"
        >
          {/* Back of the lid and the base under it, both filled: what makes this a desk rather
              than a sticker of a wireframe laid over a ghost. */}
          <path className="fill-panel" d="M22 6h76c2.2 0 4 1.8 4 4v32H18V10c0-2.2 1.8-4 4-4Z" />
          <path
            className="fill-panel"
            d="M14 42h92l8 10c0 2-1.6 3.4-3.6 3.4H9.6C7.6 55.4 6 54 6 52l8-10Z"
          />
          <path d="M50 49h20" />
        </svg>

        {/*
          The code he is writing, thrown up beside the screen because the screen itself is facing
          away. It is the only part that brightens — a whole laptop pulsing reads as the drawing
          fading rather than as something being worked on.
        */}
        <svg
          aria-hidden="true"
          viewBox="0 0 48 32"
          className="absolute top-1 right-1 w-8 text-accent"
          {...PEN}
          strokeWidth="2.6"
        >
          <g className="nap-screen">
            <path d="m14 8-7 8 7 8M34 8l7 8-7 8M28 5l-8 22" />
          </g>
        </svg>
      </Sticker>

      {/* A pause between ideas: this one is the mark in its natural sleeping state. */}
      <Sticker kind="sleep" className="bottom-[16%] left-[10%] rotate-3">
        <NapMark className="size-[4.8rem] text-muted" />
        <svg
          aria-hidden="true"
          viewBox="0 0 112 94"
          className="absolute -bottom-3 -left-7 size-[5.4rem] text-muted/80"
          {...PEN}
          strokeWidth="2"
        >
          <g className="nap-blanket">
            <path d="M18 72c15 3 30 3 45 0 12-3 22-2 31 2" />
            <path d="M25 78c18 4 37 4 57 0" />
          </g>
        </svg>
      </Sticker>

      {/* Nap making something: a little spark is enough to imply the next project. */}
      <Sticker kind="spark" className="right-[12%] bottom-[15%] -rotate-8" awake>
        <NapMark className="size-[4.5rem]" />
        <svg
          aria-hidden="true"
          viewBox="0 0 88 92"
          className="absolute -top-4 -right-6 size-16 text-accent/80"
          {...PEN}
          strokeWidth="2.1"
        >
          <g className="nap-star">
            <path d="M45 8c1 10 1 20-1 30M29 23c10 1 20 1 30-1M34 12c7 7 13 14 18 22" />
          </g>
          <g className="nap-wand">
            <path d="m21 64 15-16 7 7-15 16-10 3 3-10Z" />
            <path d="m37 47 7 7M18 78l-4 5" />
          </g>

          {/* Thrown only on hover — an idle sticker firing sparks every few seconds is a
              notification, and there is nothing here to be notified about. */}
          <g className="nap-sparks" strokeWidth="3.4">
            {SPARKS.map((spark) => (
              <path
                key={spark.d}
                className="nap-spark"
                d={spark.d}
                // Direction per dot, read by `nap-spark-fly`: three sparks leaving one point on
                // the same vector look swept, and only a fan of them looks thrown.
                style={
                  {
                    animationDelay: spark.delay,
                    "--spark-x": spark.x,
                    "--spark-y": spark.y,
                  } as CSSProperties
                }
              />
            ))}
          </g>
        </svg>
      </Sticker>
    </div>
  );
}

function Sticker({
  kind,
  className,
  awake = false,
  children,
}: {
  /** Which idle loop and which hover reaction this one gets; the rules live in `globals.css`. */
  kind: "music" | "code" | "sleep" | "spark";
  className: string;
  awake?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`nap-sticker nap-sticker-${kind} pointer-events-auto absolute grid size-24 place-items-center rounded-[1.5rem] border border-edge/70 bg-panel/45 shadow-card backdrop-blur-[1px] ${
        awake ? "nap-sticker-awake" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}
