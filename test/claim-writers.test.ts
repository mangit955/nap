import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every file that writes a turn request into the queue also announces a claim wake-up.
 *
 * An idle worker waits for a wake-up rather than polling the queue several times a second, with a
 * slow poll behind it for the ones that get lost (`docs/adr/0027`). That fallback is exactly what
 * makes a writer that forgets invisible: its requests are still claimed, seconds late, and nothing
 * fails. `packages/db/src/claim-announcements.db.test.ts` proves each writer that exists announces
 * after its commit; this is what notices a new one, which that file cannot know to test.
 *
 * Deliberately crude — a file inserting into `turn_requests` must call `.announce()` somewhere — and
 * so it errs towards demanding an announcement. A wrong demand costs a line; a missing one costs
 * every request that writer makes a few seconds.
 */

const repoRoot = join(import.meta.dirname, "..");

type Source = { path: string; contents: string };

/** Writes that put a request in the queue: drizzle's insert, or a raw statement. */
const INSERTS_A_REQUEST =
  /\.insert\(\s*turnRequests\s*\)|insert\s+into\s+(?:["\w]+\.)?"?turn_requests"?/gi;
const ANNOUNCES = /\.announce\(\s*\)/;

function silentWriters(sources: Source[]): string[] {
  return sources
    .filter(
      (source) =>
        Array.from(source.contents.matchAll(INSERTS_A_REQUEST)).length > 0 &&
        !ANNOUNCES.test(source.contents),
    )
    .map((source) => source.path);
}

/** Shipped source only: a test or a fake may write rows however it likes. */
function shippedSources(): Source[] {
  return ["packages", "apps"].flatMap((group) =>
    readdirSync(join(repoRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const srcDir = join(repoRoot, group, entry.name, "src");
        if (!existsSync(srcDir)) return [];
        return readdirSync(srcDir, { recursive: true, withFileTypes: true })
          .filter((f) => f.isFile() && f.name.endsWith(".ts"))
          .map((f) => join(f.parentPath, f.name))
          .filter((path) => !/\.test(-d)?\.ts$|\/testing\//.test(path))
          .map((path) => ({
            path: path.slice(repoRoot.length + 1),
            contents: readFileSync(path, "utf8"),
          }));
      }),
  );
}

describe("every writer of a turn request announces a claim wake-up", () => {
  it("holds across the real workspace", () => {
    expect(silentWriters(shippedSources())).toEqual([]);
  });

  it("requires explicit coverage when another insert is added, including in an existing writer", () => {
    const inserts = Object.fromEntries(
      shippedSources().flatMap((source) => {
        const count = Array.from(source.contents.matchAll(INSERTS_A_REQUEST)).length;
        return count ? [[source.path, count]] : [];
      }),
    );
    expect(inserts).toEqual({
      "packages/db/src/postgres-turn-queue.ts": 1,
      "packages/db/src/session-start-store.ts": 1,
      "packages/db/src/github-store.ts": 2,
    });
  });

  it("actually finds the writers it is guarding", () => {
    // Guards against the check going quiet because the walk or the pattern broke: these are the
    // three writers that exist today, and each must still be recognised as one.
    const writers = shippedSources()
      .filter((source) => Array.from(source.contents.matchAll(INSERTS_A_REQUEST)).length > 0)
      .map((source) => source.path);
    expect(writers).toEqual(
      expect.arrayContaining([
        "packages/db/src/postgres-turn-queue.ts",
        "packages/db/src/session-start-store.ts",
        "packages/db/src/github-store.ts",
      ]),
    );
  });

  it("catches a writer that inserts and says nothing", () => {
    const silent = { path: "packages/db/src/new.ts", contents: "await tx.insert(turnRequests)" };
    const raw = { path: "packages/db/src/raw.ts", contents: "sql`INSERT INTO turn_requests`" };
    const announcing = {
      path: "packages/db/src/ok.ts",
      contents: "await tx.insert(turnRequests); this.#claims?.announce();",
    };

    expect(silentWriters([silent, raw, announcing])).toEqual([silent.path, raw.path]);
  });
});
