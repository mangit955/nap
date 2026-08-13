"use client";

/**
 * What you get, drawn as one poured surface.
 *
 * Five separate cards would say five separate things. These are fused — the joints between them
 * curve inward, the way two drops of the same liquid meet — because the claim the section makes
 * is that this is *one* thing that holds together end to end, and a shape can make that claim
 * faster than a sentence can. The geometry is in `liquid/`.
 *
 * **There is one set of markup, not one per layout.** A phone gets five ordinary cards and no
 * field is sampled at all: fusing needs neighbours, and a single column has none. Everything that
 * differs between the two is a class or a custom property on the same list — a second copy hidden
 * at each breakpoint would be two places for the copy to drift apart, and every heading in the
 * document twice for anything reading the markup rather than looking at it.
 *
 * The tiles are placed in a fixed design space that the wide layout scales to fit, which is what
 * `skinPath` is built for: geometry passed in rather than measured, so the skin is right on the
 * first frame and on the server, with no layout pass and no resize observer.
 */

import { type CSSProperties, useMemo, useRef } from "react";
import { type SkinBox, skinPath } from "../liquid/skin.ts";
import { EyeIcon, FileIcon, ListIcon, ReloadIcon, TerminalIcon } from "../ui/icons.tsx";
import { SectionHeading } from "./section-heading.tsx";
import { revealProps, useReveal } from "./use-reveal.ts";
import { useSpaceScale } from "./use-space-scale.ts";

/**
 * The design space the tiles are placed in. Scaled to the container, never re-measured.
 *
 * Exported because it is written down twice and cannot be: the wide layout's box is a Tailwind
 * class, and a class has to be a literal string in the source for the compiler to see it at all.
 * So a test asserts the classes still quote these numbers — drift here would scale the skin to a
 * box the tiles are no longer in, and the tiles would sit off the shape drawn for them.
 */
export const SPACE = { w: 880, h: 492 };
/**
 * The blend, and it is not a taste setting. Two tiles fuse only where the blended field goes
 * negative between them, which for a gap of `g` needs a blend of more than `2g` — at exactly `2g`
 * the neck is zero-width, and just above it the neck is a hairline the trace can miss on one seam
 * while catching another, so the section renders four tiles joined and one adrift. The margin
 * here is deliberate: `GAP` is 20, the floor is 40, and anything under about 56 is fragile. Going
 * much *higher* is not free either — a blend of 100 rounds the whole silhouette until the waists
 * flatten out, which is the effect disappearing from the other end.
 */
const BLEND = 64;
/** The gap between neighbours. See `BLEND` — these two are a pair and cannot be tuned apart. */
const GAP = 20;

const TOP_H = 212;
const BOTTOM_Y = TOP_H + GAP;
const BOTTOM_H = SPACE.h - BOTTOM_Y;
const THIRD = (SPACE.w - GAP * 2) / 3;

type Capability = {
  id: string;
  Icon: typeof EyeIcon;
  title: string;
  body: string;
  box: { x: number; y: number; w: number; h: number };
};

const CAPABILITIES: readonly Capability[] = [
  {
    id: "sandbox",
    Icon: TerminalIcon,
    title: "A room of its own",
    body: "Every project gets its own machine, with its own filesystem and its own git history. Nothing it does can reach anything else, and only you can open its preview.",
    box: { x: 0, y: 0, w: 470, h: TOP_H },
  },
  {
    id: "log",
    Icon: ListIcon,
    title: "It talks in its sleep",
    body: "The transcript is a live event log, not a spinner: every command, every file it touched, every result, in the order it happened.",
    box: { x: 470 + GAP, y: 0, w: SPACE.w - 470 - GAP, h: TOP_H },
  },
  {
    id: "snapshot",
    Icon: ReloadIcon,
    title: "It remembers where you dozed off",
    body: "Close the tab and the sandbox is committed and snapshotted. Open it again and you are back where you were.",
    box: { x: 0, y: BOTTOM_Y, w: THIRD, h: BOTTOM_H },
  },
  {
    id: "cancel",
    Icon: EyeIcon,
    title: "Shake it awake",
    body: "Stop a turn mid-thought. What it finished is kept, and the sandbox is left consistent.",
    box: { x: THIRD + GAP, y: BOTTOM_Y, w: THIRD, h: BOTTOM_H },
  },
  {
    id: "files",
    Icon: FileIcon,
    title: "No sleepwalking",
    body: "A real file tree, and the real files behind it. You can read every line it wrote.",
    box: { x: (THIRD + GAP) * 2, y: BOTTOM_Y, w: THIRD, h: BOTTOM_H },
  },
];

const BOXES: readonly SkinBox[] = CAPABILITIES.map((capability) => ({
  id: capability.id,
  ...capability.box,
}));

/**
 * A tile's own box, handed to the stylesheet as custom properties. The positions are data — they
 * are the same numbers the skin is traced from — so a class per tile would be a second copy of
 * the layout, free to drift from the shape drawn behind it. The cast is what React's types want
 * for a custom property.
 */
function tileStyle(box: Capability["box"]): CSSProperties {
  return {
    "--x": `${box.x}px`,
    "--y": `${box.y}px`,
    "--w": `${box.w}px`,
    "--h": `${box.h}px`,
  } as CSSProperties;
}

export function Capabilities() {
  const { ref, state } = useReveal<HTMLDivElement>();
  const host = useRef<HTMLDivElement>(null);
  useSpaceScale(host, SPACE.w);
  // Constant input, so this runs once for the life of the page; the memo is here to say that the
  // grid sample is not free rather than to save a recompute anybody would notice.
  const skin = useMemo(() => skinPath(BOXES, { k: BLEND, radius: 22, cell: 6 }), []);

  return (
    // The band is the darkest surface on the page on purpose: the poured skin is white, and
    // against the next shade up the shape it makes is invisible — which is the whole section.
    <section
      aria-labelledby="capabilities"
      className="border-[var(--s-border-1)] border-y bg-[var(--s-surface-3)] px-6 py-24 sm:py-32"
    >
      <div className="mx-auto max-w-5xl">
        <SectionHeading
          id="capabilities"
          eyebrow="Sleep on it"
          lines={["It keeps its head while you don't."]}
          emphasis="head"
          sub="The parts that make walking away from a half-built app a reasonable thing to do."
        />

        <div ref={ref} {...revealProps(state)}>
          {/*
            Below `md` this is an ordinary stack. From `md` it becomes the fixed design space,
            scaled to whatever width the column has — `aspect-ratio` holds the box's proportions
            so the tiles and the traced skin stay in the same space at every width.
          */}
          <div
            ref={host}
            className="nap-space-host-md relative mt-16"
            style={{ "--space-w": SPACE.w, "--space-h": SPACE.h } as CSSProperties}
          >
            <div className="nap-space-md">
              {/*
                The skin sits at the path's own origin, which is outside the space: the blend
                paints past every tile. It is colour and nothing else, so it is hidden from
                anything reading the page rather than looking at it.
              */}
              <svg
                aria-hidden="true"
                viewBox={`${skin.minX} ${skin.minY} ${skin.width} ${skin.height}`}
                className="pointer-events-none absolute hidden md:block"
                style={{
                  left: skin.minX,
                  top: skin.minY,
                  width: skin.width,
                  height: skin.height,
                  overflow: "visible",
                }}
              >
                {/* Filled *and* stroked. Unstroked, a white shape on a pale band has no edge at
                    the places the shape is most interesting — the waists — and the whole thing
                    reads as a soft rectangle rather than as a surface with joints in it. */}
                <path
                  d={skin.d}
                  fill="var(--s-surface-1)"
                  stroke="var(--s-border-1)"
                  strokeWidth={1}
                />
              </svg>

              <ul className="space-y-3 md:space-y-0">
                {CAPABILITIES.map((capability) => (
                  <li
                    key={capability.id}
                    style={tileStyle(capability.box)}
                    className="rounded-2xl border border-[var(--s-border-1)] bg-[var(--s-surface-1)] p-6 md:absolute md:top-[var(--y)] md:left-[var(--x)] md:h-[var(--h)] md:w-[var(--w)] md:rounded-none md:border-0 md:bg-transparent md:p-8"
                  >
                    {/* Pushed to the foot of the tile at wide sizes: the tops are different
                        heights and the eye reads a ragged row of headings as a mistake. */}
                    <div className="flex h-full flex-col md:justify-end">
                      <capability.Icon className="size-4 text-[var(--s-text-subtle)]" />
                      <h3 className="mt-4 font-medium text-[var(--s-text-primary)] text-lg tracking-[-0.01em]">
                        {capability.title}
                      </h3>
                      <p className="mt-2 max-w-sm text-[14px] text-[var(--s-text-muted)] leading-relaxed">
                        {capability.body}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
