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
