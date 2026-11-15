import { posix } from "node:path";

/**
 * Keeps every `docs/….md` a file cites, and every relative link between Markdown files, pointing
 * at a file that exists.
 *
 * Comments and docs here send the reader to the reasoning by path — "see `docs/gotchas/model.md`"
 * — and nothing else ever follows those paths. Splitting `docs/GOTCHAS.md` into one file per area
 * left three such citations in code pointing at a file that was gone, and every gate passed: a
 * comment is not compiled, linted for links, or tested. The same split moved seventeen relative
 * links one folder down without rewriting them, so `[…](compaction.md)` written beside
 * `docs/compaction.md` came to mean `docs/gotchas/compaction.md`. Both shapes are checked.
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
const CHECKED = /(\.(ts|tsx|js|mjs|css|md|ya?ml|toml|py|json|sh)|^Dockerfile|\.env\.example)$/;

/**
 * A repository-root path to a Markdown file under `docs/`. The lookbehind keeps out paths that only
 * end in one, such as `node_modules/next/dist/docs/…` or `apps/web/src/docs/…`.
 */
const CITATION = /(?<![\w./-])docs\/[\w./-]+\.md/g;

/**
 * A Markdown link to another Markdown file, which resolves against the linking file's own folder.
 * The target stops at `#`, so an anchor is ignored rather than read as part of the name.
 */
const RELATIVE_LINK = /\]\(([^)\s#:]+\.md)(?:#[^)\s]*)?\)/g;

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
    const folder = posix.dirname(file.path);
    file.contents.split("\n").forEach((text, index) => {
      const cited = [...text.matchAll(CITATION)].map((match) => match[0]);
      if (file.path.endsWith(".md")) {
        for (const match of text.matchAll(RELATIVE_LINK)) {
          const target = match[1] ?? "";
          // `/…` is a site path, not a file. Anything else is resolved from this file's folder,
          // as a Markdown renderer resolves it, even when it starts with `docs/`.
          if (!target.startsWith("/")) cited.push(posix.normalize(posix.join(folder, target)));
        }
      }
      for (const path of cited)
        if (!exists(path)) dead.push({ path: file.path, line: index + 1, cited: path });
    });
  }
  return dead;
}
