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

/**
 * Whether an ignore file excludes a given path — enough of the syntax to answer that honestly.
 *
 * Written for `.dockerignore`, where the question is not stylistic but "does this file end up
 * inside the image?". It was worth writing because the answer was *no* for `.env.local` and
 * nobody knew: the file is Vercel's, it holds an OIDC token, `bun` loads it at startup, and it was
 * being copied into every deployment because the patterns named `.env` and stopped there.
 *
 * Supported, because it is all our ignore files use: a leading `!` to re-include, a leading `/` to
 * anchor, a leading double-star to mean every depth, a bare name which also means every depth, and
 * `*` as a wildcard within one segment. Last match wins, as in gitignore.
 */
export function isIgnored(contents: string, path: string): boolean {
  let ignored = false;

  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    const negated = line.startsWith("!");
    const pattern = negated ? line.slice(1) : line;
    if (pattern === "") continue;

    if (matches(pattern, path)) ignored = !negated;
  }

  return ignored;
}

function matches(pattern: string, path: string): boolean {
  // A pattern that is anchored, or that contains a slash of its own, is relative to the file.
  if (pattern.startsWith("/")) return segmentMatch(pattern.slice(1), path);
  if (pattern.startsWith("**/")) return anyDepth(pattern.slice(3), path);
  if (pattern.includes("/")) return segmentMatch(pattern, path);
  // A bare name means every depth, which is the reading that surprises people.
  return anyDepth(pattern, path);
}

/** The pattern against the whole path, or against any directory prefix of it. */
function segmentMatch(pattern: string, path: string): boolean {
  const parts = path.split("/");
  for (let end = 1; end <= parts.length; end += 1) {
    if (globMatch(pattern, parts.slice(0, end).join("/"))) return true;
  }
  return false;
}

/** The pattern against any single segment, which is what a bare name means. */
function anyDepth(pattern: string, path: string): boolean {
  return path.split("/").some((segment) => globMatch(pattern, segment));
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`).replaceAll("*", "[^/]*");
  return new RegExp(`^${escaped}$`).test(value);
}
