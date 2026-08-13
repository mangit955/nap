/**
 * Reading a key somebody pasted, and deciding which vendor it belongs to.
 *
 * **The prefix chooses the platform, and nothing else does.** The alternative — a radio button
 * in the browser saying which kind it is — is a second source of truth that disagrees with the
 * key itself the moment somebody picks wrong, and the symptom is a 401 from a vendor several
 * steps away from the mistake. The prefixes are stable and vendor-assigned, so the key already
 * knows what it is.
 *
 * A key that matches neither is refused *here*, before anything is stored or sent anywhere.
 * That matters more than it looks: the usual paste is not a key at all but a whole shell line,
 * a quoted value, or a URL, and every one of those would otherwise be sealed, stored, and then
 * fail on every turn with nothing on screen connecting the two.
 */

/** Which vendor a key belongs to, and therefore which client a turn on it builds. */
export type KeyPlatform = "openrouter" | "anthropic";

export type ParsedApiKey = { platform: KeyPlatform; apiKey: string };

export type ParseKeyResult = { ok: true; value: ParsedApiKey } | { ok: false; message: string };

/**
 * Vendor prefixes, longest first.
 *
 * Order is load-bearing rather than cosmetic: `sk-ant-` and `sk-or-` do not overlap today, but
 * a table matched by prefix that is not sorted by length is one vendor id away from resolving
 * the wrong way, and the failure would be silent.
 */
const PREFIXES: readonly (readonly [string, KeyPlatform])[] = [
  ["sk-ant-", "anthropic"],
  ["sk-or-", "openrouter"],
];

/**
 * Long enough that a truncated paste is caught, short enough that no real key is refused.
 *
 * Both vendors issue keys far longer than this; the number exists to reject "sk-or-" typed by
 * hand, not to validate a format neither vendor documents as stable.
 */
const MINIMUM_LENGTH = 20;

export function parseApiKey(input: string): ParseKeyResult {
  // Trimmed before anything else. A key copied out of a terminal or a dashboard arrives with a
  // newline or a stray space about half the time, and that is not something to make a person
  // debug — but only the ends, since whitespace *inside* a key means the paste is not a key.
  const key = input.trim();

  if (key === "") return { ok: false, message: "Paste a key first." };

  if (/\s/.test(key)) {
    return {
      ok: false,
      message: "That looks like more than just a key — paste only the key itself.",
    };
  }

  const matched = PREFIXES.find(([prefix]) => key.startsWith(prefix));
  if (matched === undefined) {
    return {
      ok: false,
      message: "That is not a key we recognise. OpenRouter keys start sk-or-, Anthropic sk-ant-.",
    };
  }

  if (key.length < MINIMUM_LENGTH) {
    return { ok: false, message: "That key looks incomplete. Copy the whole thing and try again." };
  }

  return { ok: true, value: { platform: matched[1], apiKey: key } };
}

/**
 * What is safe to show back: the vendor prefix and the last four characters.
 *
 * Enough to recognise which of your own keys this is, and useless to anyone else. The middle
 * is dropped rather than starred out at its real width, because the length of a secret is
 * itself a small hint and displaying it buys nothing.
 */
export function hintFor(key: string): string {
  const prefix = PREFIXES.find(([candidate]) => key.startsWith(candidate))?.[0] ?? "";
  return `${prefix}…${key.slice(-4)}`;
}
