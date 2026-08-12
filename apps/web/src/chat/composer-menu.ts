/**
 * The `@` and `/` menus behind the composer.
 *
 * Both are the same shape — a trigger character being typed, a query growing after it, and a
 * list narrowing as it does — so they are one fold rather than two. What differs is only what
 * the rows are: `@` names files that exist in the sandbox right now, `/` names prompt openings.
 *
 * **`/` inserts text and promises nothing else.** There is no command dispatch behind it and
 * there should not be one: the agent reads plain English, so a command is a phrase somebody
 * would otherwise type out. That is why they read as sentence openings rather than verbs —
 * what lands in the box is the beginning of a prompt the user finishes.
 *
 * Pure, so the interesting parts — a trigger that is part of an email address, a query with a
 * slash in it, a pick that has to replace exactly the token and nothing before it — are tested
 * without a DOM.
 */

/** What is being typed after a trigger, and where the trigger starts. */
export type ComposerToken = {
  kind: "file" | "command";
  query: string;
  /** Index of the trigger character, so a pick replaces the token and leaves the rest alone. */
  start: number;
};

export type MenuRow = {
  key: string;
  /** What is inserted, and what the row is identified by. */
  name: string;
  detail: string;
};

/**
 * Openings, not commands.
 *
 * Each one is the start of a sentence the user completes, because a prompt the model receives
 * as a bare verb ("/refactor") is a prompt with no object. The trailing space is deliberate —
 * the caret lands where the next word goes.
 */
export const COMMANDS: MenuRow[] = [
  { key: "add", name: "/add", detail: "Add a feature or a page" },
  { key: "fix", name: "/fix", detail: "Something is broken" },
  { key: "restyle", name: "/restyle", detail: "Change how it looks" },
  { key: "explain", name: "/explain", detail: "Ask how something works" },
  { key: "tidy", name: "/tidy", detail: "Clean up without changing behaviour" },
];

/** The sentence each opening drops into the box. */
const COMMAND_TEXT: Record<string, string> = {
  add: "Add ",
  fix: "Fix the ",
  restyle: "Restyle the ",
  explain: "Explain how ",
  tidy: "Tidy up ",
};

/**
 * The trigger being typed at the caret, if there is one.
 *
 * Anchored to the end because that is where the caret is, and preceded by a space or the very
 * start so an address in the middle of a sentence does not open the file menu. A query stops
 * at whitespace — `@src/App.tsx and` is a finished mention followed by a word.
 */
export function parseToken(draft: string): ComposerToken | undefined {
  const match = /(^|\s)([@/])([^\s]*)$/.exec(draft);
  if (match === null) return undefined;

  const lead = match[1] ?? "";
  const trigger = match[2] ?? "";
  const query = match[3] ?? "";

  return {
    kind: trigger === "@" ? "file" : "command",
    query,
    start: match.index + lead.length,
  };
}

/**
 * The rows a token should offer.
 *
 * Files are matched anywhere in the path rather than only at the start: people reach for a
 * file by its name, and every path here begins `src/`, which would make a prefix match mean
 * "type the directory first".
 */
export function menuRows(token: ComposerToken, files: readonly string[], limit = 8): MenuRow[] {
  const query = token.query.toLowerCase();

  if (token.kind === "command") {
    return COMMANDS.filter((row) => row.name.slice(1).startsWith(query)).slice(0, limit);
  }

  return files
    .filter((path) => path.toLowerCase().includes(query))
    .slice(0, limit)
    .map((path) => ({ key: path, name: path, detail: leaf(path) }));
}

/** The filename, which is what a row is recognised by when every path shares a prefix. */
function leaf(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] ?? path;
}

/**
 * The draft with the token replaced by what was picked.
 *
 * Only the token goes — anything typed before it survives, which is what makes a mention
 * usable in the middle of a sentence rather than only at the start.
 */
export function applyPick(draft: string, token: ComposerToken, row: MenuRow): string {
  const before = draft.slice(0, token.start);
  const inserted =
    token.kind === "file" ? `@${row.name} ` : (COMMAND_TEXT[row.key] ?? `${row.name} `);
  return before + inserted;
}
