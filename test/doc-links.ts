/**
 * Keeps every `docs/….md` a file cites pointing at a file that exists.
 *
 * Comments and docs here send the reader to the reasoning by path — "see `docs/gotchas/model.md`"
 * — and nothing else ever follows those paths. Splitting `docs/GOTCHAS.md` into one file per area
 * left three such citations in code pointing at a file that was gone, and every gate passed: a
 * comment is not compiled, linted for links, or tested. So the citation itself is checked.
 *
 * Historical records are exempt. They describe the repository as it was when they were written,
 * and rewriting their paths would make them say something they did not.
 *
 * Kept pure — files in, dead citations out — so it can be tested against synthetic input as well
 * as against the real tree.
 */

export type CitingFile = { path: string; contents: string };

export type DeadCitation = { path: string; line: number; cited: string };

/** Records of how things were, left as written: the v1 plan and log, research and review notes. */
const HISTORICAL = [/^PROGRESS\.md$/, /^docs\/PLAN\.md$/, /^docs\/research\//, /^docs\/assets\//];

/** This check and its test, which name dead paths on purpose to show them being caught. */
const SELF = /^test\/doc-links(\.test)?\.ts$/;

/** Text the repository writes by hand; generated, binary and vendored files cite nothing. */
const CHECKED = /(\.(ts|tsx|js|mjs|css|md|ya?ml|toml|py)|^Dockerfile|\.env\.example)$/;

/**
 * A repository-root path to a Markdown file under `docs/`. The lookbehind keeps out paths that only
 * end in one, such as `node_modules/next/dist/docs/…` or `apps/web/src/docs/…`.
 */
const CITATION = /(?<![\w./-])docs\/[\w./-]+\.md/g;

export function isCheckedPath(path: string): boolean {
  return (
    CHECKED.test(path) && !SELF.test(path) && !HISTORICAL.some((pattern) => pattern.test(path))
  );
}

export function findDeadCitations(
  files: CitingFile[],
  exists: (path: string) => boolean,
): DeadCitation[] {
  const dead: DeadCitation[] = [];
  for (const file of files) {
    if (!isCheckedPath(file.path)) continue;
    file.contents.split("\n").forEach((text, index) => {
      for (const match of text.matchAll(CITATION)) {
        if (!exists(match[0])) dead.push({ path: file.path, line: index + 1, cited: match[0] });
      }
    });
  }
  return dead;
}
