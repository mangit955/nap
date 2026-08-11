/**
 * The colours the rim light is painted in, re-rolled before every pulse.
 *
 * A fixed rainbow reads as a logo; a palette that moves reads as something thinking. So each
 * roll picks one anchor hue and walks a bounded *arc* away from it — never the full wheel,
 * because six hues spread over 360° is every colour at once, which is the one thing that looks
 * cheap. The arc runs in either direction, so consecutive rolls do not drift steadily around
 * the wheel in a way the eye starts to predict.
 *
 * Saturation and lightness are pinned per stop rather than rolled with the hue: they are what
 * make the arc read as *light* rather than as paint, and a dark stop anywhere in the sequence
 * puts a hole in the middle of the highlight.
 *
 * The values go on as custom properties rather than into a stylesheet, because the element
 * they belong to is the only thing that should change colour — a `:root` write would restyle
 * everything else on the page by accident.
 */

/** The narrowest and widest hue span a single roll may cover. */
export const ARC_MIN = 90;
export const ARC_MAX = 190;

/**
 * Anything with a style object — which is every `HTMLElement`, and also a plain object, so the
 * roll can be checked without a DOM.
 */
export type StyleTarget = {
  style: { setProperty: (name: string, value: string) => void };
};

/**
 * The properties a roll writes: six stops and a tail for the rim, then three for the wash the
 * box throws onto the section behind it. The wash is drawn from the same arc as the rim, which
 * is the whole point — the section is lit *by* the box rather than decorated to match it.
 */
export const PALETTE_PROPERTIES = [
  "--ai-c1",
  "--ai-c2",
  "--ai-c3",
  "--ai-c4",
  "--ai-c5",
  "--ai-c6",
  "--ai-tail",
  "--ai-bg1",
  "--ai-bg2",
  "--ai-bg3",
] as const;

export function hsl(hue: number, saturation: number, lightness: number, alpha = 1): string {
  const wrapped = ((hue % 360) + 360) % 360;
  return alpha === 1
    ? `hsl(${wrapped.toFixed(1)} ${saturation}% ${lightness}%)`
    : `hsl(${wrapped.toFixed(1)} ${saturation}% ${lightness}% / ${alpha})`;
}

/**
 * `random` is an argument so a test can pin the roll. Nothing in the app passes it.
 */
export function rollPalette(target: StyleTarget, random: () => number = Math.random): void {
  const anchor = random() * 360;
  const span = ARC_MIN + random() * (ARC_MAX - ARC_MIN);
  const arc = random() < 0.5 ? -span : span;
  const at = (position: number) => anchor + arc * position;

  const style = target.style;
  style.setProperty("--ai-c1", hsl(at(0), 96, 48));
  // The second stop is deliberately the palest: it is the shoulder of the highlight, and a
  // fully saturated one there makes the arc read as two bands rather than one.
  style.setProperty("--ai-c2", hsl(at(0.18), 52, 80));
  style.setProperty("--ai-c3", hsl(at(0.4), 98, 55));
  style.setProperty("--ai-c4", hsl(at(0.66), 96, 52));
  style.setProperty("--ai-c5", hsl(at(0.88), 94, 50));
  style.setProperty("--ai-c6", hsl(at(1), 90, 72, 0.8));
  // Behind the anchor rather than ahead of it: the tail is what the light has already passed.
  style.setProperty("--ai-tail", hsl(at(-0.12), 70, 76, 0.63));

  /*
   * The stage the box stands on: the same arc again, but barely tinted — a few points of
   * saturation at the very top of the lightness range. It is the only part of the effect that
   * is on screen continuously, so it has to be a colour you notice having changed rather than
   * one you notice. Anything stronger stops being light in a room and becomes a coloured page.
   */
  style.setProperty("--ai-bg1", hsl(at(0), 62, 97));
  style.setProperty("--ai-bg2", hsl(at(0.5), 54, 95));
  style.setProperty("--ai-bg3", hsl(at(1), 58, 93));
}
