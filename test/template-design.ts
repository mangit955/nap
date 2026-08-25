/**
 * Keeps the project template's palette accessible.
 *
 * Every generated app inherits `packages/sandbox/template/src/index.css` and is then graded
 * by an axe audit it never asked for. A colour edit that looks like taste — softening a
 * muted text tone, warming a surface — is the cheapest way to fail that audit on decisions
 * the model did not make, and nothing else in the repo would notice: the template is outside
 * every tsconfig, and the only thing that runs it is a sandbox.
 *
 * So the requirement is written down as pairs. It is deliberately not "check every token
 * against every other" — most combinations are never put together, and a check that flags
 * imaginary pairings gets suppressed rather than fixed. These are the pairs the primitives
 * in `src/components/ui` actually produce.
 *
 * Kept pure — it takes CSS text and returns violations — so the failure modes can be tested
 * against synthetic input rather than only against a palette that currently passes.
 */

/** A pair the primitives put together, and the ratio it has to clear. */
export type ContrastRequirement = {
  /** Token name without the `--color-` prefix. */
  foreground: string;
  background: string;
  /** 4.5 for body text, 3 for large text and for the boundary of a control. */
  minimum: number;
  /** Where the pair occurs, so a failure says what to look at. */
  where: string;
};

export type PaletteViolation = ContrastRequirement & {
  /** `missing` when a named token is not defined at all; `contrast` when it is too weak. */
  reason: "missing" | "contrast";
  /** The measured ratio, or 0 when a token was missing. */
  actual: number;
};

/**
 * WCAG AA, by usage.
 *
 * The `-soft` backgrounds are here because they are the tempting place to cheat: a tint pale
 * enough to look delicate stops carrying its own text long before it looks wrong.
 */
export const PALETTE_CONTRACT: ContrastRequirement[] = [
  { foreground: "ink", background: "canvas", minimum: 4.5, where: "body text on the page" },
  { foreground: "ink", background: "surface", minimum: 4.5, where: "text on a card" },
  { foreground: "ink", background: "surface-muted", minimum: 4.5, where: "text on a tinted row" },
  { foreground: "ink-muted", background: "canvas", minimum: 4.5, where: "secondary text" },
  {
    foreground: "ink-muted",
    background: "surface-muted",
    minimum: 4.5,
    where: "secondary text on a tinted row",
  },
  { foreground: "ink-subtle", background: "canvas", minimum: 4.5, where: "labels and captions" },
  {
    foreground: "ink-subtle",
    background: "surface",
    minimum: 4.5,
    where: "input placeholders, select chevron",
  },
  {
    foreground: "on-accent",
    background: "accent",
    minimum: 4.5,
    where: "the primary button's label",
  },
  {
    foreground: "on-accent",
    background: "accent-hover",
    minimum: 4.5,
    // Hover states are checked too. A label that only clears AA until a pointer arrives is a
    // label that fails for as long as anyone is actually looking at it.
    where: "the primary button's label, hovered",
  },
  {
    foreground: "on-danger",
    background: "danger",
    minimum: 4.5,
    where: "the destructive button's label",
  },
  {
    foreground: "on-danger",
    background: "danger-hover",
    minimum: 4.5,
    where: "the destructive button's label, hovered",
  },
  { foreground: "accent", background: "canvas", minimum: 4.5, where: "links and accented text" },
  { foreground: "accent", background: "accent-soft", minimum: 4.5, where: "the accent badge" },
  { foreground: "danger", background: "canvas", minimum: 4.5, where: "an inline error" },
  { foreground: "danger", background: "danger-soft", minimum: 4.5, where: "the danger badge" },
  { foreground: "success", background: "success-soft", minimum: 4.5, where: "the success badge" },
  { foreground: "warning", background: "warning-soft", minimum: 4.5, where: "the warning badge" },
  {
    // Not text: WCAG 1.4.11, the boundary a person needs to see to know a control is there.
    // This is the one most palettes fail, because a hairline border looks tidier.
    foreground: "border-strong",
    background: "surface",
    minimum: 3,
    where: "the outline of an input, checkbox or secondary button",
  },
  {
    foreground: "border-strong",
    background: "canvas",
    minimum: 3,
    where: "the outline of a control sitting directly on the page",
  },
  {
    // The pair that is easy to forget and the one that fails first: a border tone picked
    // against white is measured against the *darkest* surface it ever sits on, which is
    // this one, under a secondary button's hover.
    foreground: "border-strong",
    background: "surface-muted",
    minimum: 3,
    where: "the outline of a secondary button, hovered",
  },
  { foreground: "ring", background: "canvas", minimum: 3, where: "the focus outline" },
];

/** `--color-<name>: <hex>` pairs from a `@theme` block, keyed without the prefix. */
export function parseColorTokens(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  for (const match of css.matchAll(/--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    const [, name, value] = match;
    if (name !== undefined && value !== undefined) tokens[name] = value;
  }
  return tokens;
}

/** Relative luminance, per WCAG 2.1 — the sRGB channels linearised and weighted. */
function luminance(hex: string): number {
  const digits = hex.slice(1);
  const expanded =
    digits.length === 3 || digits.length === 4
      ? digits
          .slice(0, 3)
          .split("")
          .map((d) => d + d)
          .join("")
      : digits.slice(0, 6);

  const channels = [0, 2, 4].map((offset) => {
    const value = Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  // Non-null would be an assertion, and the slice above guarantees three channels anyway.
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

/**
 * WCAG contrast ratio, between 1 and 21. Order-independent by construction.
 *
 * Alpha is ignored: a token with one would need a compositing context to evaluate, and none
 * of the pairs above use one.
 */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((lighter ?? 0) + 0.05) / ((darker ?? 0) + 0.05);
}

/** Every requirement in `PALETTE_CONTRACT` the given stylesheet does not meet. */
export function checkPalette(css: string): PaletteViolation[] {
  const tokens = parseColorTokens(css);

  return PALETTE_CONTRACT.flatMap((requirement): PaletteViolation[] => {
    const foreground = tokens[requirement.foreground];
    const background = tokens[requirement.background];

    if (foreground === undefined || background === undefined) {
      return [{ ...requirement, reason: "missing", actual: 0 }];
    }

    const actual = contrastRatio(foreground, background);
    if (actual >= requirement.minimum) return [];
    return [{ ...requirement, reason: "contrast", actual }];
  });
}
