"use client";

/**
 * Sending from the dashboard: the composer glides from where it was on the dashboard into its
 * place in the workspace, and the first message and the right panel ease in behind it.
 *
 * A FLIP: the dashboard measures its composer just before it enters the workspace (`departFrom`);
 * the workspace frame, once its composer is laid out, translates it back to that spot and lets it
 * go (`useSendGlide`). Why not a view transition is in `docs/gotchas/web.md`.
 *
 * **The record lives here, in module state, and is good for one glide.** It only has to cross one
 * client-side navigation in one tab, as `workspace-entry.ts`'s does, so another tab never sees it
 * and a reload has nothing to replay. It is claimed by the first workspace frame that mounts
 * within `CLAIM_WITHIN_MS` of the press, and after that only for the rest of the glide: the
 * starting workspace hands over to the project's own (`live-workspace.tsx`) and the frame mounts
 * again, often mid-glide, so the second mount picks up the same timeline at the time already
 * spent. Any mount after that — Back and then Forward into the project, a sidebar switch, an
 * unrelated open — finds it spent and forgets it, so nothing glides that was not just sent. A
 * refused start forgets it at once, in case the refusal beat the workspace to the screen.
 *
 * **Moved, never cut off and never scrolled.** The translate is clamped to every box that clips
 * the composer, so it cannot start under the right panel and be cut at the column's edge, and
 * cannot reach outside a scroll container's viewport and flash a scrollbar while it moves. Nothing
 * outside the animated elements is touched, so there is nothing to restore: an unmount — a start
 * the server refused, which sends the tab back to the dashboard — cancels the animations, and an
 * animation that fills only backwards leaves no transform behind once it ends.
 *
 * Under `prefers-reduced-motion` nothing moves: the cut.
 */

import { type RefObject, useLayoutEffect } from "react";

type Box = { left: number; top: number; right: number; bottom: number };
type Departure = { from: Box; at: number; claimedAt: number | undefined };

/** How long the composer takes to settle into its place. */
export const GLIDE_MS = 300;
/**
 * The press-to-workspace budget. A prefetched `/p/new` mounts in about 0.1s; a workspace that
 * arrives later than this is drawn with the cut rather than gliding from a spot long left.
 */
export const CLAIM_WITHIN_MS = 1000;
/** Short and decelerating, like the landing page's arrivals (`landing/use-arrivals.ts`). */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

let departure: Departure | undefined;

/** Records where the composer was, just before the dashboard enters the workspace. */
export function departFrom(composer: Element | null, now = performance.now()): void {
  if (composer === null) return;
  const { left, top, right, bottom } = composer.getBoundingClientRect();
  departure = { from: { left, top, right, bottom }, at: now, claimedAt: undefined };
}

/**
 * Where the glide starts for a frame mounting now, and how far into it that is; `undefined` when
 * nothing was just sent. Spends the record once the glide it describes is over.
 */
export function claimGlide(now: number): { from: Box; elapsed: number } | undefined {
  const current = departure;
  if (current === undefined) return undefined;
  if (current.claimedAt === undefined) {
    if (now - current.at > CLAIM_WITHIN_MS) {
      departure = undefined;
      return undefined;
    }
    current.claimedAt = now;
  }
  const elapsed = now - current.claimedAt;
  if (elapsed >= GLIDE_MS) {
    departure = undefined;
    return undefined;
  }
  return { from: current.from, elapsed };
}

/** Forgets a glide not yet played: the start it was for was refused. */
export function forgetSendGlide(): void {
  departure = undefined;
}

/**
 * The translate that puts the composer at `to` back where it was at `from`, clamped so that the
 * moved box stays inside every box in `clips`.
 *
 * Centred across and level at the bottom: the dashboard's composer is taller than the workspace's,
 * and the toolbar along both bottoms is what the eye follows from one to the other.
 */
export function glideOffset(from: Box, to: Box, clips: readonly Box[]): { x: number; y: number } {
  let x = (from.left + from.right) / 2 - (to.left + to.right) / 2;
  let y = from.bottom - to.bottom;
  for (const clip of clips) {
    x = clamp(x, clip.left - to.left, clip.right - to.right);
    y = clamp(y, clip.top - to.top, clip.bottom - to.bottom);
  }
  return { x, y };
}

/** `value` within `[low, high]`; a range with no room (a box wider than its clip) is no move. */
function clamp(value: number, low: number, high: number): number {
  if (low > high) return 0;
  return Math.min(Math.max(value, low), high);
}

/**
 * The viewport of each ancestor below `root` (and of `root` itself) that clips its contents:
 * the padding box, which is where both clipping and a scroll container's overflow are measured.
 */
function clipsOf(element: HTMLElement, root: HTMLElement): Box[] {
  const clips: Box[] = [];
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") {
      const box = node.getBoundingClientRect();
      const left = box.left + node.clientLeft;
      const top = box.top + node.clientTop;
      clips.push({ left, top, right: left + node.clientWidth, bottom: top + node.clientHeight });
    }
    if (node === root) break;
  }
  return clips;
}

/**
 * Plays the glide in the workspace frame under `root`, when its composer was just sent from the
 * dashboard. Runs as the frame mounts, after its children are laid out and before it paints.
 *
 * What moves is found by structure, because it belongs to the panes: the composer docked under
 * the conversation, the first prompt (`data-turn-prompt`, on both the optimistic bubble and the
 * logged one), and the right panel.
 */
export function useSendGlide(root: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const frame = root.current;
    if (frame === null) return;
    const glide = claimGlide(performance.now());
    if (glide === undefined) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const { from, elapsed } = glide;
    const playing: Animation[] = [];
    const play = (
      element: HTMLElement | null,
      keyframes: Keyframe[],
      timing: { duration: number; delay?: number },
    ) => {
      // Optional: jsdom implements no Web Animations, and a test that sends and then draws the
      // workspace must not throw for it.
      const animation = element?.animate?.(keyframes, {
        ...timing,
        delay: (timing.delay ?? 0) - elapsed,
        easing: EASE,
        fill: "backwards",
      });
      if (animation) playing.push(animation);
    };

    const composer = frame.querySelector<HTMLElement>(".chat-composer-dock .workspace-composer");
    if (composer !== null) {
      const { x, y } = glideOffset(
        from,
        composer.getBoundingClientRect(),
        clipsOf(composer, frame),
      );
      play(composer, [{ transform: `translate(${x}px, ${y}px)` }, { transform: "none" }], {
        duration: GLIDE_MS,
      });
    }
    play(
      frame.querySelector<HTMLElement>(".t3-chat-column [data-turn-prompt]"),
      [
        { opacity: 0, transform: "translateY(8px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: GLIDE_MS - 60, delay: 60 },
    );
    play(
      frame.querySelector<HTMLElement>(".t3-workbench"),
      [
        { opacity: 0, transform: "translateX(16px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: GLIDE_MS - 40, delay: 40 },
    );
    return () => {
      for (const animation of playing) animation.cancel();
    };
  }, [root]);
}
