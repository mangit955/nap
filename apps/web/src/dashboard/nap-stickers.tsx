"use client";

/**
 * Four small versions of Nap caught between prompts.
 *
 * These belong in the roomy edges of the dashboard hero, not in the composer itself: they make
 * the otherwise blank band feel inhabited without asking somebody to look through decoration
 * to find the one thing they came here to do. They reuse the real mark rather than a second
 * approximation of it, so a change to Nap's silhouette reaches the stickers too.
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
      {/* Nap, headphones on, quietly listening while an idea lands. */}
      <Sticker className="top-[15%] left-[5%] -rotate-6" awake>
        <NapMark className="size-20" />
        <svg viewBox="0 0 96 96" className="absolute inset-0 size-20 text-accent/70" {...PEN} strokeWidth="2.2">
          <path d="M24 50c0-18 10-29 24-29s24 11 24 29" />
          <path d="M22 49c-4 1-6 5-6 10v8c0 4 3 7 7 7h4V52h-5ZM74 49c4 1 6 5 6 10v8c0 4-3 7-7 7h-4V52h5Z" />
          <path d="M82 28c4-4 7-5 10-5M85 35c4-1 7-1 10 1" />
        </svg>
      </Sticker>

      {/* Nap at a laptop: a proper tiny coding session, not an extra interactive control. */}
      <Sticker className="top-[22%] right-[6%] rotate-5" awake>
        <NapMark className="size-[4.6rem]" />
        <svg viewBox="0 0 110 104" className="absolute -right-8 bottom-0 size-20 text-muted" {...PEN} strokeWidth="2">
          <path d="M32 29h51c2 0 4 2 4 4v31H28V33c0-2 2-4 4-4Z" />
          <path d="M21 67h73l-6 8H27l-6-8Z" />
          <path d="m47 42-7 7 7 7M67 42l7 7-7 7M61 39l-5 21" />
        </svg>
      </Sticker>

      {/* A pause between ideas: this one is the mark in its natural sleeping state. */}
      <Sticker className="bottom-[16%] left-[10%] rotate-3">
        <NapMark className="size-[4.8rem] text-muted" />
        <svg viewBox="0 0 112 94" className="absolute -bottom-3 -left-7 size-[5.4rem] text-muted/80" {...PEN} strokeWidth="2">
          <path d="M18 72c15 3 30 3 45 0 12-3 22-2 31 2" />
          <path d="M25 78c18 4 37 4 57 0" />
        </svg>
      </Sticker>

      {/* Nap making something: a little spark is enough to imply the next project. */}
      <Sticker className="right-[12%] bottom-[15%] -rotate-8" awake>
        <NapMark className="size-[4.5rem]" />
        <svg viewBox="0 0 88 92" className="absolute -top-4 -right-6 size-16 text-accent/80" {...PEN} strokeWidth="2.1">
          <path d="M45 8c1 10 1 20-1 30M29 23c10 1 20 1 30-1M34 12c7 7 13 14 18 22" />
          <path d="m21 64 15-16 7 7-15 16-10 3 3-10Z" />
          <path d="m37 47 7 7M18 78l-4 5" />
        </svg>
      </Sticker>
    </div>
  );
}

function Sticker({
  className,
  awake = false,
  children,
}: {
  className: string;
  awake?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`nap-sticker absolute grid size-24 place-items-center rounded-[1.5rem] border border-edge/70 bg-panel/45 shadow-card backdrop-blur-[1px] ${
        awake ? "nap-sticker-awake" : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}
