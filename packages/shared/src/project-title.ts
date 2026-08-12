/**
 * Naming a project after the first thing somebody asked it for.
 *
 * Every project used to be called "Untitled project", which makes a dashboard a grid of
 * identical tiles and the workspace bar say nothing at all. The prompt is right there when the
 * first turn starts, and the useful part of it is almost always the first few words.
 *
 * **This is deliberately arithmetic on a string and not a model call.** A name is a convenience;
 * paying for a round trip and adding a failure path to project creation to get a slightly nicer
 * one is a bad trade, and the whole derivation is one function — so a model-named version could
 * replace it later without anything else moving.
 *
 * It lives in `shared` because both ends need it: the API names the project on the first turn,
 * and the sentinel below has to mean the same thing to whatever *creates* a project and whatever
 * later asks whether it has been named. Two copies of that string is how the auto-namer silently
 * stops firing.
 */

/** What a project is called before anybody, or anything, has named it. */
export const UNTITLED_PROJECT = "Untitled project";

/**
 * How somebody asks, as opposed to what they are asking for.
 *
 * Stripped once rather than repeatedly: "build a build log" is a real prompt, and a loop here
 * would eat the subject and leave "Log". Ordered longest-first so "build me a" is matched before
 * "build".
 */
const OPENINGS = [
  "can you please build",
  "can you please make",
  "can you please create",
  "can you build",
  "can you make",
  "can you create",
  "i would like",
  "i want you to build",
  "i want you to make",
  "i want to build",
  "i want",
  "i need",
  "please build",
  "please make",
  "please create",
  "build me",
  "make me",
  "create me",
  "build",
  "make",
  "create",
  "generate",
  "design",
  "write",
  "please",
];

/** Where the subject ends and the specification begins. */
const CLAUSE_BREAKS = [
  " with ",
  " that ",
  " which ",
  " where ",
  " so i ",
  " so that ",
  " using ",
  " to help ",
  " for me",
  " for my ",
  " please",
];

/** Kept lowercase inside a name, because a title that capitalises them reads as a headline. */
const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/** Long enough to say what the thing is, short enough for the bar and the card to show it whole. */
const MAX_LENGTH = 40;

export function titleFromPrompt(prompt: string): string {
  const subject = capitalise(cap(clause(opening(normalise(prompt)))));

  // **Never an empty string.** `ProjectSummarySchema` requires at least one character, so an
  // empty name would not fail here — it would fail at the far end, where it reads as a corrupt
  // record rather than as a prompt made entirely of punctuation.
  return subject === "" ? UNTITLED_PROJECT : subject;
}

/**
 * Whether a project still carries the name it was created with.
 *
 * Compared loosely — trimmed and case-insensitive — because the alternative is a rename that
 * fails to fire because something round-tripped the string through a form field. An empty name
 * counts as unnamed: nothing should produce one, but a project showing a blank bar is precisely
 * the case where naming it from the next prompt helps.
 */
export function isUnnamed(name: string): boolean {
  const trimmed = name.trim();
  return trimmed === "" || trimmed.toLowerCase() === UNTITLED_PROJECT.toLowerCase();
}

/** One line, single-spaced, so everything downstream can assume plain words and gaps. */
function normalise(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim();
}

function opening(text: string): string {
  const lower = text.toLowerCase();

  for (const phrase of OPENINGS) {
    // The space matters: it is what stops "makeshift" being read as "make" plus "shift".
    if (lower === phrase || lower.startsWith(`${phrase} `)) {
      return article(text.slice(phrase.length).trim());
    }
  }

  return article(text);
}

/**
 * "a to-do app" is a to-do app. The article is never part of what the thing is called.
 *
 * `\s+|$` rather than a plain space, so an article with nothing after it goes too: "build me a"
 * strips to "a", and a name of "A" is worse than admitting the prompt named nothing.
 */
function article(text: string): string {
  return text.replace(/^(?:an?|the)(?:\s+|$)/i, "").trim();
}

function clause(text: string): string {
  // The sentence first: everything after a full stop is elaboration, whatever it contains.
  let cut = text.split(/[.!?;\n]/)[0] ?? "";

  const comma = cut.indexOf(",");
  if (comma > 0) cut = cut.slice(0, comma);

  const lower = cut.toLowerCase();
  for (const marker of CLAUSE_BREAKS) {
    const at = lower.indexOf(marker);
    if (at > 0) cut = cut.slice(0, at);
  }

  // Trailing punctuation the cuts above did not own — "generator!" is a generator.
  return cut.replace(/[\s\p{P}]+$/u, "").trim();
}

/** Cut on a word boundary: a name ending "…tracking ever" reads as a typo, not an abbreviation. */
function cap(text: string): string {
  if (text.length <= MAX_LENGTH) return text;

  const clipped = text.slice(0, MAX_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");

  // A single word longer than the whole allowance has no boundary to cut on, so it is taken
  // whole rather than truncated into something unreadable.
  return (lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trim();
}

function capitalise(text: string): string {
  if (text === "") return "";

  return text
    .split(" ")
    .map((word, index) => {
      // **A word carrying its own capitals is left exactly as it is.** Re-casing "iOS" to "Ios"
      // and "GitHub" to "Github" reads as a mistake, and the person who typed them meant them.
      if (/[A-Z]/.test(word.slice(1))) return word;

      const lower = word.toLowerCase();
      // The first word is always capitalised, even when it is a small one: a name beginning
      // "of" reads as a fragment of a longer sentence that got lost.
      if (index > 0 && SMALL_WORDS.has(lower)) return lower;

      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}
