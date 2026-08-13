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

import { NapMark } from "../brand/nap-mark.tsx";

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
        Nap peeking over a laptop he is holding, with two paws hooked over the lid.
        *
        The paws are the whole sticker. A ghost behind a large machine is a scene with a mascot
        somewhere in it — accurate, and lifeless, because he is not doing anything to the thing
        in front of him. Two blunt paws over the top edge make it something he is *holding*, and
        they cost two rounded shapes. So the laptop is small and soft rather than a correct
        drawing of a computer, and he stays the largest thing on the sticker.
        *
        The lid is filled with the page's own panel colour so it genuinely covers his hem — the
        occlusion is what puts him behind it — and the paws are filled in the ink he is drawn in,
        so they read as his and not as two more props.
      */}
      <Sticker kind="code" className="top-[22%] right-[6%] rotate-5" awake>
        {/*
          Nudged right, because the ghost is not centred in its own viewBox — the box is grown up
          and to the right to give the z's room to rise into, so centring the *svg* leaves the
          drawing sitting left of centre and the two paws land lopsided on the lid.

          The wrapper exists so that the two things he does can happen on two elements: it owns
          the slide down out of sight, the mark inside it owns the typing. Both on one element,
          the jitter's `transform` outranks the slide's — so leaving the sticker snapped him back
          to the keyboard the instant the animation resumed, instead of letting him climb.
        */}
        <div className="nap-hider -translate-y-2 translate-x-[0.36rem]">
          <NapMark className="size-[4.4rem]" />
        </div>

        <svg
          aria-hidden="true"
          viewBox="0 0 100 52"
          className="-translate-x-1/2 absolute bottom-2 left-1/2 w-[4.6rem] text-muted"
          {...PEN}
          strokeWidth="2.6"
        >
          <path
            className="fill-panel"
            d="M16 4h68c2.4 0 4.4 2 4.4 4.4V34H11.6V8.4C11.6 6 13.6 4 16 4Z"
          />
          <path
            className="fill-panel"
            d="M9 34h82l6.4 8.6c0 2-1.6 3.4-3.6 3.4H6.2C4.2 46 2.6 44.6 2.6 42.6L9 34Z"
          />
          <path d="M42 40h16" />

          {/*
            Hooked over the lid, half above the edge and half behind it, and out at the corners
            rather than in the middle: he is drawn in the same ink they are, so a paw in front of
            his body is a white shape on a white shape and disappears. Out here each one has dark
            behind it and reads as a paw. Drawn last so the lid's stroke passes underneath and
            they look like they are gripping.
          */}
          <g className="nap-paws fill-ink stroke-panel" strokeWidth="2.4">
            <rect x="14" y="-7" width="17" height="15" rx="7.5" />
            <rect x="69" y="-7" width="17" height="15" rx="7.5" />
          </g>
        </svg>

        {/*
          The code he is writing, thrown up beside the lid because the screen faces away. It is
          the only part that brightens — a whole laptop pulsing reads as the drawing fading
          rather than as something being worked on.
        */}
        <svg
          aria-hidden="true"
          viewBox="0 0 48 32"
          className="absolute top-1.5 right-1.5 w-7 text-accent"
          {...PEN}
          strokeWidth="2.8"
        >
          <g className="nap-screen">
            <path d="m14 8-7 8 7 8M34 8l7 8-7 8M28 5l-8 22" />
          </g>
        </svg>
      </Sticker>

      {/*
        A pause between ideas: this one is the mark in its natural sleeping state.

        He is drawn in the same ink as the other three. Greyed down he read as the disabled one
        of the set rather than as the sleeping one — asleep is what the shut eyes and the z's are
        for, and dimming him on top of that says "unavailable", which is a different word.
      */}
      <Sticker kind="sleep" className="bottom-[16%] left-[10%] rotate-3">
        <NapMark className="size-[4.8rem]" />
        <svg
          aria-hidden="true"
          viewBox="0 0 112 94"
          className="absolute -bottom-3 -left-7 size-[5.4rem] text-muted"
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

        {/*
          The vein: the comic shorthand for somebody's patience running out, popped **on his
          head** rather than in the corner of the card. In the corner it was a badge, and a red
          badge on a dashboard tile is an error; on the temple of a character it is a mood. It is
          the one place in this app the danger colour means something other than a failure, and
          it exists only while the cursor is on him.
        */}
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="nap-anger absolute top-[1.6rem] left-[1.2rem] w-[1.05rem] text-danger"
        >
          {/*
            Four arms around a hollow middle, drawn as one closed outline. Filled it was a solid
            red blob at this size — the notches between the arms close up and it reads as a cross
            in a corner, which on a dashboard is a delete button rather than a temper. The empty
            centre is what makes it legible, and it matches every other prop on these stickers,
            all of which are line drawings.
          */}
          <path
            {...PEN}
            strokeWidth="2.3"
            d="M19.1 4.9 15.2 12l3.9 7.1L12 15.2l-7.1 3.9L8.8 12 4.9 4.9 12 8.8Z"
          />
        </svg>
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
