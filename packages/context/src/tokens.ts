/**
 * How many tokens a piece of text is expected to cost.
 *
 * This is an estimate, deliberately. The exact number is only knowable by asking the model
 * provider — a network call, per string, that would make the token budget untestable offline
 * and turn every assembly into a round trip. A budget built on a cheap local approximation
 * and enforced conservatively is worth far more than an exact number nobody can afford to
 * compute, which is why the assembled context reports `estimatedTokens` rather than claiming
 * a real count.
 *
 * Four characters per token is the usual rule of thumb for English prose and code. It is
 * wrong in both directions — dense punctuation costs more, repeated words less — so callers
 * should leave headroom rather than budget to the last token.
 */

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;

  // Rounded up, so no non-empty string is ever free. Content that estimates to zero can
  // never be removed to save anything, which would hang a loop that truncates until it fits.
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Which end of a text is worth keeping when only some of it fits. */
export type Keep = "head" | "tail";

/**
 * As much of `text` as `tokens` will pay for, marking where it was cut.
 *
 * Here rather than at either call site because it is the estimate's own arithmetic read
 * backwards, and a budget whose two halves disagreed about what a token costs would overrun
 * the number it exists to guarantee. `CHARS_PER_TOKEN` stays private for the same reason.
 *
 * Never returns more than `tokens` estimates to: the marker is paid for out of the ceiling
 * rather than added to it, so a caller shrinking something to fit can trust the result.
 */
export function truncateToTokens(text: string, tokens: number, keep: Keep): string {
  if (tokens <= 0) return "";
  if (estimateTokens(text) <= tokens) return text;

  const room = tokens * CHARS_PER_TOKEN - CUT.length;
  if (room <= 0) return CUT;

  return keep === "head" ? `${text.slice(0, room)}${CUT}` : `${CUT}${text.slice(-room)}`;
}

/**
 * What a cut looks like. The same character `renderCheckOutput` marks a truncated stream with,
 * so a fragment reads as a fragment wherever the model meets one.
 */
const CUT = "…";
