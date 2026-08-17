/**
 * Keeps `.vercelignore` from deleting code on its way to the deployment.
 *
 * The file is written in gitignore syntax, where a pattern with no slash in it matches a file or
 * directory of that name *at any depth*. Every entry in ours names something at the repository
 * root, so the recursive reading is never the one intended — and when the two readings differ, the
 * difference is invisible: bare `docs` excluded `apps/web/src/docs` and `apps/web/src/app/docs`
 * along with the root `docs/`, the `/docs` route and every component it imported were dropped
 * together, and so there was no unresolved import for the build to fail on. The header that links
 * to the page is not under a `docs/` path, so it shipped. The deployment was green and the page was
 * a 404.
 *
 * So: every pattern must say which it means. A leading slash anchors it to the root; a leading
 * double-star and slash is deliberately recursive. A bare name is rejected — not because it is
 * wrong, but because it does not say, and the failure when it is wrong is silent.
 *
 * (The recursive prefix is spelled out in words rather than written here, because the two
 * characters it ends with would close this comment.)
 *
 * Kept pure — contents in, violations out — so it can be tested against synthetic input as well as
 * against the real file.
 */

export type IgnoreViolation = {
  line: number;
  pattern: string;
  suggestion: string;
};

/**
 * Every pattern that names something without saying whether it means the root or every depth.
 *
 * Negations keep their `!` while being judged on the rest, since `!foo` has exactly the same
 * ambiguity as `foo`.
 */
export function findUnanchoredPatterns(contents: string): IgnoreViolation[] {
  const violations: IgnoreViolation[] = [];

  contents.split("\n").forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) return;

    const pattern = line.startsWith("!") ? line.slice(1) : line;
    if (pattern === "") return;

    // Anchored to the root, either by a leading slash or by having a slash anywhere but the end —
    // `apps/web` is as unambiguous as `/apps/web`, because a pattern containing a slash is already
    // relative to the file in this syntax.
    if (pattern.startsWith("/")) return;
    if (pattern.startsWith("**/")) return;
    if (pattern.slice(0, -1).includes("/")) return;

    violations.push({
      line: index + 1,
      pattern: line,
      suggestion: `write "/${pattern}" for the one at the repository root, or "**/${pattern}" to mean every depth`,
    });
  });

  return violations;
}
