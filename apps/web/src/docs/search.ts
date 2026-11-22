/**
 * Search over the docs: every page and every subheading, matched against the words under them.
 *
 * The whole corpus is a few dozen kilobytes of text that changes only when the site is deployed, so
 * the index is built from the prose at render time (`search-index.ts`) and searched in the browser.
 * There is no server to ask and nothing to wait for between keystrokes.
 *
 * Matching is deliberately plain: every word typed must appear, in any order, in the title or the
 * text. No fuzzing — a reader searching docs this size is looking for a word they have seen, and a
 * fuzzy hit for a word that is not there is a wrong answer delivered with confidence.
 */

export type SearchEntry = {
  kind: "page" | "section";
  href: string;
  title: string;
  /** Where it sits: a page's group, or the page a section belongs to. */
  context: string;
  /** Which page it is on, to pick its icon. `null` for the docs home. */
  pageId: string | null;
  text: string;
};

export type Hit = { entry: SearchEntry; snippet: string };

export type Results = { pages: Hit[]; sections: Hit[] };

const MAX_PAGES = 5;
const MAX_SECTIONS = 8;
const SNIPPET_BEFORE = 48;
const SNIPPET_LENGTH = 150;

/**
 * Lower case, with curly quotes folded to straight ones, so "repository's" finds "repository’s".
 * Every replacement is one character for one, which is what lets a match found in the folded text
 * be highlighted at the same offsets in the original.
 */
export function fold(text: string): string {
  return text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

export function termsOf(query: string): string[] {
  return [...new Set(fold(query).split(/\s+/).filter(Boolean))];
}

export function search(entries: readonly SearchEntry[], query: string): Results {
  const terms = termsOf(query);
  if (terms.length === 0) {
    // Nothing typed yet: the pages themselves, as a keyboard way to jump anywhere.
    return {
      pages: entries
        .filter((entry) => entry.kind === "page")
        .map((entry) => ({ entry, snippet: snippetOf(entry.text, []) })),
      sections: [],
    };
  }

  const scored = entries.flatMap((entry, order) => {
    const title = fold(entry.title);
    const text = fold(entry.text);
    if (!terms.every((term) => title.includes(term) || text.includes(term))) return [];
    const inTitle = terms.filter((term) => title.includes(term)).length;
    return [{ entry, order, score: inTitle * 2 + (title.startsWith(terms[0] ?? "") ? 1 : 0) }];
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);

  const hits = scored.map(({ entry }) => ({ entry, snippet: snippetOf(entry.text, terms) }));
  return {
    pages: hits.filter((hit) => hit.entry.kind === "page").slice(0, MAX_PAGES),
    sections: hits.filter((hit) => hit.entry.kind === "section").slice(0, MAX_SECTIONS),
  };
}

/** A window of the text around the first match, cut at word boundaries. */
export function snippetOf(text: string, terms: readonly string[]): string {
  const folded = fold(text);
  const positions = terms.map((term) => folded.indexOf(term)).filter((at) => at >= 0);
  const first = positions.length > 0 ? Math.min(...positions) : 0;

  let start = Math.max(0, first - SNIPPET_BEFORE);
  if (start > 0) start = text.indexOf(" ", start) + 1 || start;
  let end = Math.min(text.length, start + SNIPPET_LENGTH);
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start) end = space;
  }

  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** The text split into runs, each marked as matching a term or not, for drawing highlights. */
export function highlight(
  text: string,
  terms: readonly string[],
): { text: string; match: boolean }[] {
  const folded = fold(text);
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    for (let at = folded.indexOf(term); at >= 0; at = folded.indexOf(term, at + term.length)) {
      marked.fill(true, at, at + term.length);
    }
  }

  const runs: { text: string; match: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = runs.at(-1);
    if (last && last.match === marked[i]) last.text += text[i];
    else runs.push({ text: text[i] ?? "", match: marked[i] ?? false });
  }
  return runs;
}
