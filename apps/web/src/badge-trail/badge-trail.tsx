"use client";

/**
 * A trail of tiny die-cut badges dropped behind the cursor across the hero.
 *
 * It is a background layer, so it never receives a pointer event of its own — the listeners are
 * on the window and the coordinates are taken against this element's own box. Attaching them to
 * the layer instead would mean the trail died the moment the cursor crossed the headline or the
 * prompt box, which is most of the screen and exactly where people move.
 *
 * **DOM spans, not canvas.** The whole point is 11px monospace text, and text drawn into a canvas
 * is resampled at every device pixel ratio while a span is not. Twenty-odd absolutely positioned
 * spans is also cheaper than it sounds: nothing here reflows, because every one of them is out of
 * flow and animated on `transform` and `opacity` only.
 *
 * **The density limit is a collision test, not a timer.** A cadence alone still stacks badges into
 * a solid block when the cursor circles a small area. Each candidate is AABB-tested against every
 * live badge inflated by a gap and simply *skipped* if it would touch one, so the trail thins out
 * by itself where the path doubles back and no two badges ever overlap. Skipping rather than
 * nudging matters: a nudged badge lands somewhere the cursor never went, and the trail stops
 * being a record of the path.
 *
 * **It keeps moving when nobody does.** After the cursor leaves, a slow phantom point drifts the
 * trail around the stage, so the hero is alive on arrival rather than waiting to be discovered.
 * That is only affordable because the loop stops dead when the section scrolls out of view or the
 * tab is hidden — an animation nobody can see is pure cost.
 *
 * Touch and reduced motion get four static badges instead. A trail needs a hovering cursor to be
 * a trail at all; on a touchscreen it would be a smear under a fingertip, and the fallback says
 * what the effect is made of without moving.
 */

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { COLORS, makeHueWalker, shuffle, WORDS } from "./badges.ts";
import { BADGE_H, badgeW, FONT_PX, overlaps, PAD_X, PAD_Y, RADIUS } from "./geometry.ts";

const DROP_MS = 45;
const MIN_TRAVEL = 14;
const APPEAR_MS = 110;
const HOLD_MS = 480;
const FADE_MS = 240;
const LIFE_MS = APPEAR_MS + HOLD_MS + FADE_MS;
const MAX_LIVE = 22;

/** The entrance: a badge arrives from behind the cursor and overshoots slightly on landing. */
const SLAM_OFFSET = 5;
const SLAM_OVERSHOOT = 1.03;

/** Sub-pixel drift and breath while a badge is held, so a paused trail is not a frozen one. */
const IDLE_WOBBLE = 0.35;
const IDLE_BREATH = 0.01;

/** Every so often a badge comes out as an outline instead of a fill, to break the rhythm. */
const SPECIAL_EVERY = 15;

/** The text settles from noise into the word, in about the time it takes to notice it appeared. */
const SCRAMBLE_MS = 130;
const SCRAMBLE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/#*";

/** Pointer speed, in px/frame, at which colour intensity is full. */
const SPEED_FULL = 40;
const INTENSITY_FLOOR = 0.35;

/** A new badge shoves its neighbours a few pixels away, and they drift back. */
const REPEL_PX = 3;
const REPEL_RANGE = 64;
const REPEL_CHASE = 0.16;
const REPEL_DECAY = 0.05;

/** How long the cursor must be gone before the phantom takes over, and how long the handover is. */
const GHOST_IDLE_MS = 600;
const GHOST_BLEND_MS = 420;

/*
 * Two incommensurable sine pairs per axis, so the phantom's path never repeats within a visit and
 * never reads as an orbit. The amplitudes keep it inside the middle 80% of the box.
 */
const GHOST_FX = 0.00156;
const GHOST_FX2 = 0.00465;
const GHOST_AX = 0.3;
const GHOST_AX2 = 0.11;
const GHOST_FY = 0.00219;
const GHOST_FY2 = 0.0063;
const GHOST_AY = 0.3;
const GHOST_AY2 = 0.12;

type Badge = {
  id: number;
  /** Top-left of the box, in layer coordinates. Fixed at birth — motion is all transform. */
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: string;
  born: number;
  /** Unit vector of cursor travel at birth, which is the direction the entrance comes from. */
  dirX: number;
  dirY: number;
  exitRot: number;
  seed: number;
  /** 0 for the newest badge, 1 for the oldest: older ones sit back and dim slightly. */
  depth: number;
  special: boolean;
  /** What is actually rendered — noise for the first frames, then `text`. */
  scram: string;
  /** Current and target displacement from being shoved by a later badge. */
  offX: number;
  offY: number;
  tgtX: number;
  tgtY: number;
};

function useMedia(query: string, server: boolean): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => server,
  );
}

export function BadgeTrail() {
  const host = useRef<HTMLDivElement>(null);
  const [badges, setBadges] = useState<Badge[]>([]);
  const reduced = useMedia("(prefers-reduced-motion: reduce)", false);
  // Assume a mouse on the server: the trail's first frame is empty, so guessing wrong costs a
  // hydration pass with nothing in it, where guessing the other way flashes the static fallback
  // onto every desktop visit.
  const fine = useMedia("(hover: hover) and (pointer: fine)", true);
  const running = fine && !reduced;

  useEffect(() => {
    const layer = host.current;
    if (!layer || !running) return;

    const rnd = Math.random;
    const alive: Badge[] = [];
    let seq = 0;
    let raf = 0;

    let onScreen = false;
    let hidden = false;

    /* Raw pointer position, or -1 when the cursor is elsewhere. */
    let rawX = -1;
    let rawY = -1;
    /* The point the trail actually follows: the cursor, or the phantom once it has taken over. */
    let px = -1;
    let py = -1;
    let prevX = -1;
    let prevY = -1;

    let lastDropT = 0;
    let lastDropX = 0;
    let lastDropY = 0;
    let dropped = false;
    let dropCount = 0;

    let leftAt = Number.NEGATIVE_INFINITY;
    let blendFromX = 0;
    let blendFromY = 0;

    let bag: string[] = [];
    let lastWord = "";
    const nextWord = (): string => {
      const word = bag.pop();
      if (word !== undefined) {
        lastWord = word;
        return word;
      }
      bag = shuffle(WORDS, rnd);
      // A refilled bag can hand back the word that emptied the last one, which is the only
      // back-to-back repeat a bag cannot rule out on its own. Take the one below it instead.
      if (bag[bag.length - 1] === lastWord) bag.reverse();
      return nextWord();
    };

    const nextColor = makeHueWalker(rnd() * 360);

    const leave = () => {
      if (rawX < 0) return;
      if (px >= 0) {
        blendFromX = px;
        blendFromY = py;
      }
      rawX = -1;
      rawY = -1;
      leftAt = performance.now();
    };

    const onMove = (event: PointerEvent) => {
      // A touch drag would lay a trail under the finger that nobody can see past, and a stylus
      // hovering is close enough to a mouse to be welcome.
      if (event.pointerType === "touch") return;
      const box = layer.getBoundingClientRect();
      const x = event.clientX - box.left;
      const y = event.clientY - box.top;
      if (x < 0 || y < 0 || x > box.width || y > box.height) {
        leave();
        return;
      }
      rawX = x;
      rawY = y;
    };

    const ghostPoint = (t: number, w: number, h: number): [number, number] => [
      w * 0.5 + (Math.sin(t * GHOST_FX) * GHOST_AX + Math.sin(t * GHOST_FX2 + 2.3) * GHOST_AX2) * w,
      h * 0.5 +
        (Math.sin(t * GHOST_FY + 1.7) * GHOST_AY + Math.cos(t * GHOST_FY2 + 0.6) * GHOST_AY2) * h,
    ];

    let lastNow = 0;
    let published = false;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!onScreen || hidden) return;

      // Everything below eases per frame, so a dropped frame has to count double or the trail
      // moves at whatever rate the machine happens to be running at.
      const frames = lastNow === 0 ? 1 : Math.min(4, (now - lastNow) / 16.6667);
      lastNow = now;

      const box = layer.getBoundingClientRect();
      if (rawX >= 0) {
        px = rawX;
        py = rawY;
      } else if (now - leftAt >= GHOST_IDLE_MS) {
        const [gx, gy] = ghostPoint(now, box.width, box.height);
        const k = Math.min(1, (now - leftAt - GHOST_IDLE_MS) / GHOST_BLEND_MS);
        // Blend out of wherever the cursor was last seen, so the trail does not teleport across
        // the stage the moment the phantom takes over.
        if (Number.isFinite(leftAt) && k < 1) {
          px = blendFromX + (gx - blendFromX) * k;
          py = blendFromY + (gy - blendFromY) * k;
        } else {
          px = gx;
          py = gy;
        }
      } else {
        px = -1;
        py = -1;
      }

      for (let i = alive.length - 1; i >= 0; i--) {
        const b = alive[i];
        if (b !== undefined && now - b.born >= LIFE_MS) alive.splice(i, 1);
      }

      if (px >= 0 && alive.length < MAX_LIVE) {
        const travelled = dropped
          ? Math.hypot(px - lastDropX, py - lastDropY)
          : Number.POSITIVE_INFINITY;
        if (now - lastDropT >= DROP_MS && travelled >= MIN_TRAVEL) {
          const text = nextWord();
          const w = badgeW(text);
          const h = BADGE_H;
          const x = Math.max(0, Math.min(box.width - w, px - w / 2));
          const y = Math.max(0, Math.min(box.height - h, py - h / 2));

          if (!alive.some((b) => overlaps({ x, y, w, h }, b))) {
            let dx = prevX >= 0 ? px - prevX : 0;
            let dy = prevY >= 0 ? py - prevY : -1;
            const speed = Math.hypot(prevX >= 0 ? px - prevX : 0, prevY >= 0 ? py - prevY : 0);
            const mag = Math.hypot(dx, dy) || 1;
            dx /= mag;
            dy /= mag;

            const cx = x + w / 2;
            const cy = y + h / 2;
            for (const b of alive) {
              const vx = b.x + b.w / 2 - cx;
              const vy = b.y + b.h / 2 - cy;
              const d = Math.hypot(vx, vy) || 1;
              if (d >= REPEL_RANGE) continue;
              const push = REPEL_PX * (1 - d / REPEL_RANGE);
              b.tgtX += (vx / d) * push;
              b.tgtY += (vy / d) * push;
            }

            alive.push({
              id: seq++,
              x,
              y,
              w,
              h,
              text,
              color: nextColor(
                INTENSITY_FLOOR + (1 - INTENSITY_FLOOR) * Math.min(1, speed / SPEED_FULL),
              ),
              born: now,
              dirX: dx,
              dirY: dy,
              exitRot: (rnd() < 0.5 ? -1 : 1) * (4 + rnd() * 5),
              seed: rnd() * 1000,
              depth: 0,
              special: dropCount % SPECIAL_EVERY === SPECIAL_EVERY - 1,
              scram: text,
              offX: 0,
              offY: 0,
              tgtX: 0,
              tgtY: 0,
            });
            dropCount++;
            lastDropT = now;
            lastDropX = px;
            lastDropY = py;
            dropped = true;
          }
        }
      }
      prevX = px;
      prevY = py;

      const chase = 1 - (1 - REPEL_CHASE) ** frames;
      const decay = 1 - (1 - REPEL_DECAY) ** frames;
      const last = alive.length - 1;
      for (const [i, b] of alive.entries()) {
        b.depth = last > 0 ? 1 - i / last : 0;

        b.offX += (b.tgtX - b.offX) * chase;
        b.offY += (b.tgtY - b.offY) * chase;
        b.tgtX *= 1 - decay;
        b.tgtY *= 1 - decay;

        const age = now - b.born;
        if (age < SCRAMBLE_MS && b.text.length > 1) {
          const locked = Math.floor((age / SCRAMBLE_MS) * b.text.length);
          let s = "";
          for (let c = 0; c < b.text.length; c++) {
            s +=
              c < locked
                ? (b.text[c] ?? "")
                : (SCRAMBLE_CHARS[Math.floor(rnd() * SCRAMBLE_CHARS.length)] ?? "#");
          }
          b.scram = s;
        } else {
          b.scram = b.text;
        }
      }

      // One render per frame while anything is on screen, and none at all once the last badge
      // has gone — an empty trail should cost nothing but the rAF callback.
      if (alive.length > 0 || published) {
        published = alive.length > 0;
        setBadges(alive.slice());
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        onScreen = entries[0]?.isIntersecting ?? false;
      },
      { threshold: 0 },
    );
    observer.observe(layer);

    const onVisibility = () => {
      hidden = document.hidden;
      // The clock kept running while the tab was away; without this the first frame back counts
      // as minutes of easing.
      lastNow = 0;
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onMove, { passive: true });
    window.addEventListener("blur", leave);
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onMove);
      window.removeEventListener("blur", leave);
      setBadges([]);
    };
  }, [running]);

  const clock = typeof performance === "undefined" ? 0 : performance.now();

  return (
    <div
      ref={host}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{ fontFamily: "var(--font-mono)" }}
    >
      {running
        ? badges.map((b) => {
            const m = motion(b, clock);
            const depthScale = 1 - b.depth * 0.06;
            const depthDim = 1 - b.depth * 0.12;
            return (
              <span
                key={b.id}
                style={{
                  ...FACE,
                  left: b.x,
                  top: b.y,
                  background: b.special ? "transparent" : b.color,
                  boxShadow: b.special
                    ? `inset 0 0 0 1px ${b.color}`
                    : "0 1px 2px -1px rgba(20,20,30,0.35)",
                  color: b.special ? b.color : "#000",
                  opacity: m.opacity * depthDim,
                  transform: `translate(${m.dx + b.offX}px, ${m.dy + b.offY}px) scale(${m.scale * depthScale}) rotate(${m.rot}deg)`,
                  transformOrigin: "center",
                  willChange: "opacity, transform",
                }}
              >
                {b.scram}
              </span>
            );
          })
        : STATIC.map((b) => (
            <span
              key={b.text}
              style={{
                ...FACE,
                left: `${b.left}%`,
                top: `${b.top}%`,
                background: b.color,
                color: "#000",
                boxShadow: "0 1px 2px -1px rgba(20,20,30,0.35)",
                transform: `rotate(${b.rot}deg)`,
              }}
            >
              {b.text}
            </span>
          ))}
    </div>
  );
}

/** Everything a badge's box looks like, live or static. */
const FACE = {
  position: "absolute",
  fontSize: FONT_PX,
  lineHeight: 1,
  whiteSpace: "nowrap",
  padding: `${PAD_Y}px ${PAD_X}px`,
  borderRadius: RADIUS,
  textTransform: "uppercase",
  pointerEvents: "none",
} as const satisfies React.CSSProperties;

/**
 * What touch and reduced motion see. Placed out at the edges for the same reason the doodles
 * are: the middle of the stage belongs to the card's halo, and anything sitting under coloured
 * light reads as a smudge rather than as a badge.
 */
const STATIC = [
  { text: "kerning", color: COLORS[0], left: 7, top: 22, rot: -4 },
  { text: "baseline", color: COLORS[2], left: 74, top: 15, rot: 3 },
  { text: "bezier", color: COLORS[4], left: 12, top: 78, rot: 5 },
  { text: "gamut", color: COLORS[1], left: 78, top: 71, rot: -3 },
];

/**
 * A badge's motion for this frame, derived from its age and seed rather than stored, so nothing
 * has to be stepped and a dropped frame cannot desynchronise it.
 *
 * Three layers, and the entrance and the exit are deliberately *different verbs*: it arrives by
 * sliding in from behind the cursor and springing to a stop, and it leaves by shrinking and
 * tipping over. Reversing the entrance on the way out would read as an undo.
 */
function motion(
  b: Badge,
  clock: number,
): { dx: number; dy: number; scale: number; rot: number; opacity: number } {
  const age = clock - b.born;
  let opacity = 1;
  let scale = 1;
  let rot = 0;
  let dx = 0;
  let dy = 0;

  if (age < APPEAR_MS) {
    const t = age / APPEAR_MS;
    const spring = 1 - (1 - t) ** 3;
    // Opaque before it has finished landing: a badge still fading while it settles reads as
    // sluggish at this size.
    opacity = Math.min(1, t * 1.4);
    scale = 0.9 + 0.1 * spring + (SLAM_OVERSHOOT - 1) * Math.sin(Math.PI * t);
    const back = (1 - spring) * SLAM_OFFSET;
    dx = -b.dirX * back;
    dy = -b.dirY * back;
  } else if (age > APPEAR_MS + HOLD_MS) {
    const t = Math.min(1, (age - APPEAR_MS - HOLD_MS) / FADE_MS);
    const e = t * t;
    opacity = 1 - t;
    scale = 1 - 0.2 * e;
    rot = b.exitRot * e;
  }

  if (age >= APPEAR_MS) {
    // Scaled by opacity so the wobble leaves with the badge instead of shaking a ghost.
    const idle = opacity;
    const p = clock * 0.004 + b.seed;
    dx += Math.sin(p) * IDLE_WOBBLE * idle;
    dy += Math.cos(p * 1.3 + 0.7) * IDLE_WOBBLE * idle;
    scale += Math.sin(p * 0.9) * IDLE_BREATH * idle;
  }

  return { dx, dy, scale, rot, opacity };
}
