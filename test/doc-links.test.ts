import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CitingFile, findDeadCitations, isCheckedPath } from "./doc-links.ts";

const repoRoot = join(import.meta.dirname, "..");

function readTrackedFiles(): CitingFile[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
    .split("\0")
    .filter((path) => isCheckedPath(path) && existsSync(join(repoRoot, path)))
    .map((path) => ({ path, contents: readFileSync(join(repoRoot, path), "utf8") }));
}

describe("every docs/ citation resolves", () => {
  it("holds across the real tree", () => {
    const dead = findDeadCitations(readTrackedFiles(), (path) => existsSync(join(repoRoot, path)));
    expect(dead).toEqual([]);
  });

  it("actually reads files that cite docs", () => {
    // Guards against the check going quiet because the file listing broke and returned nothing.
    const citing = readTrackedFiles().filter((file) =>
      /(?<![\w./-])docs\/\S+\.md/.test(file.contents),
    );
    expect(citing.length).toBeGreaterThanOrEqual(50);
  });
});

describe("the checker catches a dead citation", () => {
  const only =
    (...paths: string[]) =>
    (path: string) =>
      paths.includes(path);

  it("reports a citation in a code comment, with its line", () => {
    const dead = findDeadCitations(
      [{ path: "apps/web/src/app/globals.css", contents: "a\n/* see `docs/GOTCHAS.md` */" }],
      only("docs/gotchas/web.md"),
    );
    expect(dead).toEqual([
      { path: "apps/web/src/app/globals.css", line: 2, cited: "docs/GOTCHAS.md" },
    ]);
  });

  it("passes a citation that resolves", () => {
    const files = [{ path: "CLAUDE.md", contents: "Read `docs/gotchas/web.md` first." }];
    expect(findDeadCitations(files, only("docs/gotchas/web.md"))).toEqual([]);
  });

  it("ignores paths that only end in docs/, like a package's own", () => {
    const files = [
      { path: "apps/web/src/a.tsx", contents: "// node_modules/next/dist/docs/01-app/page.md" },
    ];
    expect(findDeadCitations(files, only())).toEqual([]);
  });

  it("leaves historical records as written", () => {
    const files = [
      { path: "PROGRESS.md", contents: "docs/GOTCHAS.md" },
      { path: "docs/research/x/notes.md", contents: "docs/GOTCHAS.md" },
    ];
    expect(findDeadCitations(files, only())).toEqual([]);
  });

  it("resolves a Markdown link from its own folder, so text moved down a level is caught", () => {
    const moved = [{ path: "docs/gotchas/model.md", contents: "see [compaction](compaction.md)" }];
    expect(findDeadCitations(moved, only("docs/compaction.md"))).toEqual([
      { path: "docs/gotchas/model.md", line: 1, cited: "docs/gotchas/compaction.md" },
    ]);
    const fixed = [{ path: "docs/gotchas/model.md", contents: "see [it](../compaction.md#d4)" }];
    expect(findDeadCitations(fixed, only("docs/compaction.md"))).toEqual([]);
  });

  it("leaves web links and site paths to the browser", () => {
    const files = [
      { path: "docs/DEPLOY.md", contents: "[a](https://render.com/docs/x.md) [b](/docs/x.md)" },
    ];
    expect(findDeadCitations(files, only())).toEqual([]);
  });

  it("still checks an ADR, whose links are kept current", () => {
    const files = [{ path: "docs/adr/0030-x.md", contents: "now in `docs/GOTCHAS.md`." }];
    expect(findDeadCitations(files, only())).toHaveLength(1);
  });
});
