/**
 * The vocabulary and the colour of the badge trail.
 *
 * The words are all typography and drawing terms, which is not decoration: the trail sits on a
 * page about building interfaces, and a stream of *nouns from that trade* reads as the machine
 * thinking out loud rather than as lorem ipsum with a hue applied.
 *
 * Colour is a walk rather than a list. Picking at random from a fixed palette puts two greens
 * next to each other about as often as not, and a trail whose neighbours match reads as one
 * smeared shape; stepping a fixed distance around the wheel means consecutive badges can never
 * be the same colour. `COLORS` still exists because the static fallback has no walk to take —
 * it renders four badges once and wants four deliberately chosen, vivid ones.
 */

export const WORDS = [
  "kerning",
  "baseline",
  "leading",
  "tracking",
  "x-height",
  "ligature",
  "serif",
  "grotesk",
  "bezier",
  "raster",
  "vector",
  "stroke",
  "gamut",
  "bleed",
  "weight",
  "grid",
  "hue",
  "counter",
  "ascender",
  "hinting",
  "widow",
  "orphan",
  "gutter",
  "opacity",
] as const;

export const COLORS = ["#c6ff3d", "#ff3d81", "#38e0ff", "#ff8a3d", "#b56bff", "#ffe234"] as const;

/**
 * Far enough round the wheel that neighbours are plainly different hues, and coprime enough with
 * 360 that the walk takes fifteen steps to come back to where it started.
 */
const HUE_STEP = 24;

function hslHex(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const channel = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * Returns the next colour in the walk. `intensity` is how fast the cursor was moving when the
 * badge dropped, and it drives saturation and lightness rather than hue: a slow drift lays down
 * pale badges, a flick lays down loud ones, so the trail records the gesture and not just the
 * path. Hue advances every call regardless, which is what keeps neighbours distinct.
 */
export function makeHueWalker(seedHue: number): (intensity: number) => string {
  let h = seedHue;
  return (intensity: number) => {
    h += HUE_STEP;
    const t = Math.max(0, Math.min(1, intensity));
    return hslHex(h, 0.32 + 0.53 * t, 0.78 - 0.16 * t);
  };
}

/**
 * Sorts by a random key rather than swapping in place. Fisher–Yates is the usual answer and is
 * fine, but under `noUncheckedIndexedAccess` every swap needs two undefined checks that can
 * never fire, and the arrays here are two dozen items long once every two dozen badges.
 */
export function shuffle<T>(items: readonly T[], rnd: () => number): T[] {
  return items
    .map((value) => ({ value, key: rnd() }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.value);
}
