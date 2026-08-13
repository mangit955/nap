"use client";

/**
 * The one moving thing on the page below the hero: a whole turn of nap, played on a loop.
 *
 * The choreography is not here — it is in `script.ts`, as a function of time. This file is the
 * hands: every frame it asks what the world looks like, traces the shape with `liquid/skin.ts`,
 * and writes the result onto elements it already rendered.
 *
 * **Nothing in the loop goes through React.** A frame moves a pointer, a path, four opacities and
 * a string; doing that through state would reconcile the whole subtree sixty times a second for
 * a handful of attribute writes. The badge trail on the hero writes its transforms directly for
 * the same reason. React renders this once, and after that the loop owns the DOM inside it.
 *
 * **The first paint is a still, not an empty box.** The markup is server-rendered from one chosen
 * frame in the middle of the working act, so a visitor with no JavaScript, a reader who asked for
 * less motion, and the instant before the first `requestAnimationFrame` all show a turn in
 * progress rather than a blank stage or a bar with nothing in it.
 *
 * It is `aria-hidden` in one piece. It is an illustration of what the copy beside it says, none
 * of it is operable, and a demo that announced a new tool call every second would be unusable.
 */

import { type CSSProperties, type RefObject, useEffect, useMemo, useRef } from "react";
import { skinPath } from "../../liquid/skin.ts";
import { CheckIcon, EyeIcon, FileIcon, PencilIcon, TerminalIcon } from "../../ui/icons.tsx";
import { useSpaceScale } from "../use-space-scale.ts";
import { DemoCursor } from "./cursor.tsx";
import { type Box, type Frame, frameAt, SPACE, STEPS, STILL_MS } from "./script.ts";
import { usePlaying } from "./use-playing.ts";

/** The icons, in the order the steps run. Same set the real transcript uses. */
const STEP_ICONS = [TerminalIcon, FileIcon, PencilIcon, EyeIcon] as const;

/**
 * Grid step for the trace. Six is the coarsest that still reads as a curve once Chaikin has been
 * over it, and it is a quarter of the cost of four — this runs every frame.
 */
const CELL = 6;

function skinFor(frame: Frame, cell: number): string {
  return skinPath(
    [
      { id: "body", ...frame.body, cornerRadius: frame.bodyRadius },
      { id: "tab", ...frame.tab, cornerRadius: frame.tabRadius },
    ],
    { k: frame.k, cell },
  ).d;
}

/** Where the traced path is drawn from. The skin bulges outside the boxes, so this is padded. */
const VIEW = { x: -80, y: -80, w: SPACE.w + 160, h: SPACE.h + 160 };

/** The design space, handed to the stylesheet. Unitless — see `.nap-space` in `globals.css`. */
const spaceVars = { "--space-w": SPACE.w, "--space-h": SPACE.h } as CSSProperties;

const boxStyle = (box: Box): CSSProperties => ({
  left: box.x,
  top: box.y,
  width: box.w,
  height: box.h,
});

export function LiveStage({ beatRef }: { beatRef?: RefObject<HTMLElement | null> }) {
  const root = useRef<HTMLDivElement>(null);
  const playing = usePlaying(root);
  useSpaceScale(root, SPACE.w);

  const skin = useRef<SVGPathElement>(null);
  const bodyLayer = useRef<HTMLDivElement>(null);
  const tabLayer = useRef<HTMLDivElement>(null);
  const promptGroup = useRef<HTMLDivElement>(null);
  const panelGroup = useRef<HTMLDivElement>(null);
  const previewGroup = useRef<HTMLDivElement>(null);
  const workingLabel = useRef<HTMLDivElement>(null);
  const readyLabel = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLSpanElement>(null);
  const caret = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLSpanElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const rows = useRef<(HTMLLIElement | null)[]>([]);

  /** The frame the markup is rendered from, and the one the loop falls back to. */
  const still = useMemo(() => frameAt(STILL_MS), []);
  const stillPath = useMemo(() => skinFor(still, 4), [still]);

  useEffect(() => {
    // Painting is defined inside the effect because it only ever runs from here, and because
    // every ref it reads is only meaningful once mounted.
    const paint = (frame: Frame) => {
      skin.current?.setAttribute("d", skinFor(frame, CELL));

      for (const [element, box] of [
        [bodyLayer.current, frame.body],
        [tabLayer.current, frame.tab],
      ] as const) {
        if (element === null) continue;
        element.style.left = `${box.x}px`;
        element.style.top = `${box.y}px`;
        element.style.width = `${box.w}px`;
        element.style.height = `${box.h}px`;
      }

      setOpacity(promptGroup.current, frame.prompt);
      setOpacity(panelGroup.current, frame.panel);
      setOpacity(previewGroup.current, frame.preview > 0 ? 1 : 0);
      setOpacity(workingLabel.current, frame.panel);
      setOpacity(readyLabel.current, frame.preview > 0.15 ? 1 : 0);

      if (line.current !== null && line.current.textContent !== frame.typed) {
        line.current.textContent = frame.typed;
      }
      setOpacity(caret.current, frame.caret ? 1 : 0);

      if (button.current !== null) {
        // A dip rather than a colour change: the button is already the darkest thing on the
        // stage, so there is nowhere darker for it to go.
        button.current.style.transform = `scale(${1 - frame.send * 0.14})`;
      }

      if (cursor.current !== null) {
        cursor.current.style.transform = `translate(${frame.cursor.x}px, ${frame.cursor.y}px)`;
        cursor.current.style.opacity = `${frame.cursor.alpha}`;
        cursor.current.dataset.press = frame.cursor.press > 0.2 ? "true" : "false";
      }

      frame.steps.forEach((state, index) => {
        const row = rows.current[index];
        // Only when it changes: a dataset write is a style recalculation, and four of them per
        // frame for values that turn over twice a second is work for nothing.
        if (row != null && row.dataset.state !== state) row.dataset.state = state;
      });

      previewGroup.current?.style.setProperty("--preview", `${frame.preview}`);
    };

    // Not playing means the still, and no loop at all — cancelled rather than a tick that returns
    // early, because a rAF that runs to do nothing is still a rAF sixty times a second.
    if (!playing) {
      paint(still);
      return;
    }

    let raf = 0;
    const started = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const frame = frameAt(now - started);
      paint(frame);

      // The copy column lights up with the act — one attribute on the section, and the stylesheet
      // does the rest, rather than this component re-rendering its parent every act.
      //
      // **Only from here, never from the still.** Written while nothing is playing, it would dim
      // two of the three beats permanently for the reader who asked for less motion, waiting on a
      // highlight that is never going to move. No attribute at all means all three at full ink.
      if (beatRef?.current != null) beatRef.current.dataset.beat = `${frame.beat}`;
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [playing, still, beatRef]);

  return (
    <div
      ref={root}
      aria-hidden="true"
      // The design space, scaled to whatever width the column gives it — the same pair of classes
      // the poured bento uses, and the reason every number in `script.ts` can be a plain pixel.
      className="nap-space-host relative w-full"
      style={spaceVars}
    >
      <div className="nap-space">
        <svg
          className="pointer-events-none absolute overflow-visible"
          style={{ left: VIEW.x, top: VIEW.y, width: VIEW.w, height: VIEW.h }}
          viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`}
          aria-hidden="true"
        >
          <path
            ref={skin}
            d={stillPath}
            fill="var(--s-surface-1)"
            stroke="var(--s-border-1)"
            strokeWidth={1}
          />
        </svg>

        {/* The tab: a label while it works, the address once it is up. */}
        <div ref={tabLayer} className="absolute" style={boxStyle(still.tab)}>
          <div
            ref={workingLabel}
            className="absolute inset-0 flex items-center justify-center gap-2"
            style={{ opacity: still.panel }}
          >
            <span className="nap-spin size-3 rounded-full border-[1.5px] border-[var(--s-border-1)] border-t-[var(--s-text-body)]" />
            <span className="text-[13px] text-[var(--s-text-body)]">Working</span>
          </div>
          <div
            ref={readyLabel}
            className="absolute inset-0 flex items-center justify-center"
            style={{ opacity: 0 }}
          >
            {/* `max-w-full` as well as `truncate`: an element whose own content is wider than
                its parent clips at its *own* box, so the text simply spills out of the pill. */}
            <span className="max-w-full truncate px-3 text-[11px] text-[var(--s-text-muted)]">
              habit-tracker.nap.run
            </span>
          </div>
        </div>

        {/* Everything that lives inside the body, which is the box that morphs. */}
        <div ref={bodyLayer} className="absolute" style={boxStyle(still.body)}>
          <div
            ref={promptGroup}
            className="absolute inset-0 flex items-center gap-2 pr-3 pl-5"
            style={{ opacity: still.prompt }}
          >
            <span className="flex min-w-0 flex-1 items-center text-[15px] text-[var(--s-text-body)]">
              <span ref={line}>{still.typed}</span>
              <span
                ref={caret}
                className="nap-caret ml-[1px] inline-block h-[17px] w-[1.5px] bg-[var(--s-text-primary)] align-middle"
                style={{ opacity: still.caret ? 1 : 0 }}
              />
            </span>
            <span
              ref={button}
              className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-[var(--s-text-primary)]"
            >
              <svg
                viewBox="0 0 12 12"
                className="size-4 fill-none stroke-[var(--s-text-inverse)]"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M6 9.5V2.5M6 2.5 3 5.5M6 2.5 9 5.5" />
              </svg>
            </span>
          </div>

          <div
            ref={panelGroup}
            className="absolute inset-0 px-5 py-4"
            style={{ opacity: still.panel }}
          >
            <ul className="space-y-3">
              {STEPS.map((step, index) => {
                const Icon = STEP_ICONS[index] ?? TerminalIcon;
                return (
                  <li
                    key={step.target}
                    ref={(element) => {
                      rows.current[index] = element;
                    }}
                    data-state={still.steps[index]}
                    className="nap-demo-step flex items-center gap-2.5"
                  >
                    <Icon className="size-3.5 shrink-0 text-[var(--s-text-subtle)]" />
                    <span className="shrink-0 text-[13px] text-[var(--s-text-body)]">
                      {step.verb}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--s-text-muted)]">
                      {step.target}
                    </span>
                    <span className="nap-demo-running size-3.5 shrink-0">
                      <span className="nap-spin block size-3.5 rounded-full border-[1.5px] border-[var(--s-border-1)] border-t-[var(--s-text-body)]" />
                    </span>
                    <CheckIcon className="nap-demo-done size-3.5 shrink-0 text-[var(--s-text-subtle)]" />
                  </li>
                );
              })}
            </ul>
          </div>

          <div
            ref={previewGroup}
            className="nap-demo-preview absolute inset-0 px-5 py-4"
            style={{ opacity: 0 }}
          >
            <span className="block h-2.5 w-24 rounded-full bg-[var(--s-text-subtle)]/60" />
            <div className="mt-3 flex gap-3">
              <span className="h-16 flex-1 rounded-xl bg-[var(--s-surface-3)]" />
              <span className="h-16 flex-1 rounded-xl bg-[var(--s-surface-3)]" />
            </div>
            <div className="mt-3 space-y-2">
              {["78%", "58%", "40%"].map((width) => (
                <span
                  key={width}
                  className="block h-2.5 rounded-full bg-[var(--s-surface-3)]"
                  style={{ width }}
                />
              ))}
            </div>
          </div>
        </div>

        <DemoCursor ref={cursor} frame={still} />
      </div>
    </div>
  );
}

function setOpacity(element: HTMLElement | null, value: number) {
  if (element === null) return;
  const next = `${Math.max(0, Math.min(1, value))}`;
  if (element.style.opacity !== next) element.style.opacity = next;
}
