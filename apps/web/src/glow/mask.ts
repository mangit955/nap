/**
 * The mask is the whole trick, and it is not CSS.
 *
 * Each glow layer is a coloured conic gradient — a small bright arc with a long transparent
 * tail — masked by a PNG this module draws. Take the element's measured box and its computed
 * corner radius, `roundRect` it, *stroke* it with a conic gradient, blur the stroke, and use
 * the result as `mask-image`. A stroke of width 20 blurred by 32px is a soft band hugging the
 * shape, and that reads as light; a bordered box with a CSS blur reads as a lit border. Nothing
 * in CSS produces the first from the second.
 *
 * Two details carry it:
 *
 * The conic painting the stroke is a gradient of **opacity**, not colour — opaque over roughly
 * a third of the circle and gone across the rest. That partial coverage is where "a highlight
 * travelling along an edge" comes from. Light the whole rim evenly and it stops being a
 * highlight and becomes a glowing border.
 *
 * The lit arc therefore sits on one side, so every layer is drawn twice, the second copy
 * mirrored — one copy alone leaves the other half of the element dark.
 *
 * The innermost layer has no stroke width at all: it fills the shape and punches a 1px hole
 * inside it, and the carved band that leaves *is* the coloured border. Carved from a fill
 * rather than stroked at width 1, or the line straddles the edge and half of it lands outside
 * the shape.
 */

export type MaskStop = { color: string; stop: number };

export type MaskOptions = {
  width: number;
  height: number;
  radius: number;
  strokeWidth: number;
  blur: number;
  // Spelled `| undefined` rather than left optional: under `exactOptionalPropertyTypes` an
  // absent property and a present undefined one are different types, and the layer table
  // passes the second.
  alpha?: number | undefined;
  stops: MaskStop[];
  /** Width of the band carved out of a filled shape, for the border layer. */
  ring?: number | undefined;
};

/** Opacity around the rim: present for about a third of the circle, absent for the rest. */
export const RIM_STOPS: MaskStop[] = [
  { color: "#000", stop: 54 },
  { color: "transparent", stop: 126 },
  { color: "transparent", stop: 333 },
  { color: "rgba(0,0,0,0.10)", stop: 347 },
  { color: "#000", stop: 360 },
];

/**
 * The falloff, from the hard border outwards. Rising stroke width against rising blur is what
 * makes the light fade with distance instead of stopping at an edge.
 */
export const RIM_LAYERS: { strokeWidth: number; blur: number; alpha: number; ring?: number }[] = [
  { strokeWidth: 0, blur: 0, alpha: 1, ring: 1 },
  { strokeWidth: 4, blur: 4, alpha: 0.3 },
  { strokeWidth: 8, blur: 8, alpha: 0.2 },
  { strokeWidth: 16, blur: 12, alpha: 0.1 },
  { strokeWidth: 20, blur: 32, alpha: 0.32 },
];

/** How far outside the element a layer paints. Anything less and the blur is clipped square. */
export function padOf(strokeWidth: number, blur: number): number {
  return Math.ceil(strokeWidth + blur * 3);
}

/** A radius can never exceed half the shorter side, whatever the stylesheet asked for. */
export function clampRadius(radius: number, width: number, height: number): number {
  return Math.max(0, Math.min(radius, width / 2, height / 2));
}

export function radiusOf(element: HTMLElement): number {
  const radius = Number.parseFloat(getComputedStyle(element).borderRadius) || 0;
  const { width, height } = element.getBoundingClientRect();
  return clampRadius(radius, width, height);
}

/**
 * Safari's canvas blur is far stronger at the same radius, so the same number would put the
 * outermost layer most of the way across the page there.
 */
function blurScale(): number {
  if (typeof navigator === "undefined") return 1;
  return /^((?!chrome|android).)*safari/i.test(navigator.userAgent) ? 0.25 : 1;
}

/**
 * One scratch canvas for every draw, and a cache keyed by geometry: the box returns to the
 * same shape forever, so after the first build every rebuild is a lookup.
 */
let scratch: HTMLCanvasElement | null = null;
const cache = new Map<string, string>();
const CACHE_MAX = 24;

/** Returns a `data:` URL, or an empty string where there is no canvas to draw on. */
export function buildMask(options: MaskOptions): string {
  if (typeof document === "undefined") return "";

  const key = [
    Math.round(options.width),
    Math.round(options.height),
    Math.round(options.radius),
    options.strokeWidth,
    options.blur,
    options.alpha ?? 1,
    options.ring ?? 0,
    options.stops.map((s) => `${s.color}@${s.stop}`).join(","),
  ].join("|");
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const pad = padOf(options.strokeWidth, options.blur);
  const width = Math.max(1, Math.ceil(options.width) + pad * 2);
  const height = Math.max(1, Math.ceil(options.height) + pad * 2);

  if (scratch === null) scratch = document.createElement("canvas");
  const canvas = scratch;
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  // jsdom has no 2d context, and neither does a browser that has run out of them. The caller
  // renders an unlit box rather than failing.
  if (ctx === null) return "";
  ctx.clearRect(0, 0, width, height);

  if (options.blur > 0) ctx.filter = `blur(${options.blur * blurScale()}px)`;

  const gradient = ctx.createConicGradient(0, width / 2, height / 2);
  for (const stop of options.stops) gradient.addColorStop(stop.stop / 360, stop.color);
  ctx.strokeStyle = gradient;
  ctx.fillStyle = gradient;
  if (options.alpha != null) ctx.globalAlpha = options.alpha;

  const x = (width - options.width) / 2;
  const y = (height - options.height) / 2;
  const radius = clampRadius(options.radius, options.width, options.height);

  ctx.beginPath();
  if (radius > 0) ctx.roundRect(x, y, options.width, options.height, radius);
  else ctx.rect(x, y, options.width, options.height);

  if (options.strokeWidth > 0) {
    ctx.lineWidth = options.strokeWidth;
    ctx.stroke();
  } else {
    ctx.fill();

    if (options.ring != null && options.ring > 0) {
      // Punching the middle out of the fill, unblurred, so the band that remains is exactly
      // the border and sits wholly inside the shape.
      ctx.globalCompositeOperation = "destination-out";
      ctx.globalAlpha = 1;
      ctx.filter = "none";
      ctx.beginPath();
      ctx.roundRect(
        x + options.ring,
        y + options.ring,
        Math.max(0, options.width - options.ring * 2),
        Math.max(0, options.height - options.ring * 2),
        clampRadius(
          radius - options.ring,
          options.width - options.ring * 2,
          options.height - options.ring * 2,
        ),
      );
      ctx.fill();
      ctx.globalCompositeOperation = "source-over";
    }
  }

  const url = canvas.toDataURL("image/png");
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, url);
  return url;
}
