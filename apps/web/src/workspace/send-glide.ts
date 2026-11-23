"use client";

/**
 * Sending from the dashboard: the composer glides from where it was on the dashboard into its
 * place in the workspace, and the conversation and the right panel fade in behind it.
 *
 * A FLIP: the dashboard measures its composer just before it enters the workspace (`departFrom`);
 * the workspace frame, once its composer is laid out, translates it back to that spot and lets it
 * go (`useSendGlide`). Why not a view transition is in `docs/gotchas/web.md`.
 *
 * **The record lives here, in module state, and is good for one glide on the way in.** It only
 * has to cross one client-side navigation in one tab, as `workspace-entry.ts`'s does, so another
 * tab never sees it and a reload has nothing to replay. Only a frame drawn at the dashboard's way
 * in, entered by a start (`enteringByStart`), may play it: a project opened from the dashboard, a
 * sidebar switch and Forward onto a project's address never do. The first frame claims it, within
 * `CLAIM_WITHIN_MS` of `departFrom`; after that it is good only for the rest of the glide, and any
 * mount after that finds it spent. A refused start forgets its own record, in case the refusal
 * beat the workspace to the screen.
 *
 * **A frame that goes mid-glide hands over where it drew the composer.** The starting workspace
 * gives way to the project's own (`live-workspace.tsx`), often mid-glide, and the two can lay the
 * column out differently (one panel saved shut, the other open). So the frame leaving records the
 * composer's drawn box and how far through the glide it was, and the next frame carries on from
 * exactly there, on the same timeline, to its own composer's place.
 *
 * **Only the composer moves, and it is never cut off or scrolled.** The translate is clamped to
 * every box that clips the composer, so it cannot start under the right panel and be cut at the
 * column's edge, and cannot reach outside a scroll container's viewport and flash a scrollbar. The
 * conversation and the panel only fade, so they overflow nothing either. Nothing outside the
 * animated elements is touched, so there is nothing to restore: an unmount — a start the server
 * refused, which sends the tab back to the dashboard — cancels the animations, and an animation
 * that fills only backwards leaves nothing behind once it ends.
 *
 * Under `prefers-reduced-motion` nothing moves: the cut.
 */

import { type RefObject, useLayoutEffect } from "react";
import { enteringByStart } from "./workspace-entry.ts";

type Box = { left: number; top: number; right: number; bottom: number };
/** Where the composer was drawn, and how far through the glide (eased, 0 to 1) that was. */
type Anchor = { box: Box; progress: number };
type Departure = { anchor: Anchor; at: number; claimedAt: number | undefined };

/** How long the composer takes to settle into its place. */
export const GLIDE_MS = 300;
/**
 * The send-to-workspace budget. A prefetched `/p/new` mounts in about 0.1s; a workspace that
 * arrives later than this is drawn with the cut rather than gliding from a spot long left.
 */
export const CLAIM_WITHIN_MS = 1000;
/** Short and decelerating, like the landing page's arrivals (`landing/use-arrivals.ts`). */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";

let departure: Departure | undefined;

/**
 * Records where the composer was, just before the dashboard enters the workspace. Returns what
 * forgets this record again, and only this one: a later send's is not this refusal's to clear.
 */
export function departFrom(composer: Element | null): () => void {
  if (composer === null) return () => {};
  const { left, top, right, bottom } = composer.getBoundingClientRect();
  const own: Departure = {
    anchor: { box: { left, top, right, bottom }, progress: 0 },
    at: performance.now(),
    claimedAt: undefined,
  };
  departure = own;
  return () => {
    if (departure === own) departure = undefined;
  };
}

/**
 * Where the glide carries on from for a frame mounting now, and how far into it that is;
 * `undefined` when nothing was just sent. Spends the record once the glide it describes is over.
 */
export function claimGlide(now: number): { anchor: Anchor; elapsed: number } | undefined {
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
  return { anchor: current.anchor, elapsed };
}

/** A frame leaving mid-glide: where it drew the composer, for the frame that takes over. */
function handOver(anchor: Anchor): void {
  if (departure?.claimedAt !== undefined) departure.anchor = anchor;
}

/** Forgets any glide not yet played; for tests. */
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

/** Where the layout puts `element`: its box less the translate the glide is drawing it at. */
function layoutBox(element: HTMLElement): Box {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  const transform = getComputedStyle(element).transform;
  if (transform === "none") return { left, top, right, bottom };
  const { m41: x, m42: y } = new DOMMatrixReadOnly(transform);
  return { left: left - x, top: top - y, right: right - x, bottom: bottom - y };
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
 * the conversation, the conversation itself, and the right panel. The conversation rather than
 * the prompt in it, because the prompt is replaced mid-glide when the log replays it, and a
 * replacement would appear at full strength in the middle of the fade.
 */
export function useSendGlide(root: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const frame = root.current;
    if (frame === null || !enteringByStart()) return;
    const glide = claimGlide(performance.now());
    if (glide === undefined) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const { anchor, elapsed } = glide;
    const playing: Animation[] = [];
    const play = (element: HTMLElement, keyframes: Keyframe[], delay = 0) => {
      const animation = element.animate(keyframes, {
        duration: GLIDE_MS - delay,
        delay: delay - elapsed,
        easing: EASE,
        fill: "backwards",
      });
      playing.push(animation);
      return animation;
    };

    let watching: ResizeObserver | undefined;
    let leave = () => {};
    const composer = frame.querySelector<HTMLElement>(".chat-composer-dock .workspace-composer");
    // Nothing left to travel once the glide is all but over.
    if (composer !== null && anchor.progress < 1) {
      // The translate that puts the composer at the anchor's box at the anchor's point of the
      // glide: the offset left there, stretched over what remains of the eased path.
      const rest = 1 - anchor.progress;
      const aim = (): Keyframe[] => {
        const { x, y } = glideOffset(anchor.box, layoutBox(composer), clipsOf(composer, frame));
        return [{ transform: `translate(${x / rest}px, ${y / rest}px)` }, { transform: "none" }];
      };
      const moving = play(composer, aim());
      leave = () => {
        const progress = moving.effect?.getComputedTiming().progress;
        if (typeof progress !== "number" || progress >= 1) return;
        const { left, top, right, bottom } = composer.getBoundingClientRect();
        handOver({ box: { left, top, right, bottom }, progress });
      };
      // The frame is laid out again after this runs: the panel's saved width, or a panel the last
      // start closed, is restored by an effect, which moves the composer across its column and
      // moves the column's edge. Aimed and clamped again on each resize of the composer or the
      // column — after layout, before paint — so it still starts from where it was sent and is
      // never cut off, until it lands.
      const observer = new ResizeObserver(() => {
        if (moving.effect instanceof KeyframeEffect) moving.effect.setKeyframes(aim());
      });
      observer.observe(composer);
      const column = composer.closest(".t3-chat-column");
      if (column !== null) observer.observe(column);
      const stop = () => observer.disconnect();
      moving.finished.then(stop, stop);
      watching = observer;
    }
    const fade = [{ opacity: 0 }, { opacity: 1 }];
    const conversation = frame.querySelector<HTMLElement>(".t3-chat-column .chat-scroller");
    if (conversation !== null) play(conversation, fade, 60);
    const panel = frame.querySelector<HTMLElement>(".t3-workbench");
    if (panel !== null) play(panel, fade, 40);
    return () => {
      watching?.disconnect();
      // Still laid out and still drawn mid-glide: React runs this before it removes the frame.
      leave();
      for (const animation of playing) animation.cancel();
    };
  }, [root]);
}
