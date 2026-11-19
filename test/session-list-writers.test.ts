import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every file that writes what a session card draws announces it to the owner's open tabs, and boot
 * hands every such writer the announcer.
 *
 * A tab no longer reads its session list every ten seconds: it waits for a notice, with a read
 * minutes apart behind it for the ones that get lost (`@nap/shared/ports/session-list-channel`).
 * That backstop is what makes a writer that forgets invisible — the change still shows up, minutes
 * late, and nothing fails. `packages/db/src/session-list-announcements.db.test.ts` proves each
 * writer that exists announces after its commit; this notices a new one, and a boot that forgets to
 * wire one, neither of which that file can know about.
 *
 * Deliberately crude, as `claim-writers.test.ts` is: a file that inserts, updates or deletes a row
 * in a table the list reads must call `sessionList.announce` somewhere, or be listed below with the
 * reason it changes nothing a card draws. A wrong demand costs a line; a missing one costs every
 * change that writer makes a few minutes.
 */

const repoRoot = join(import.meta.dirname, "..");

/** The tables `PostgresSessionNavigationStore.list` builds a row from, as drizzle and as SQL. */
const DRIZZLE_TABLES =
  "projects|sessions|turnRequests|repositoryJobs|repositoryFeedback|projectRepositories";
const SQL_TABLES =
  "projects|sessions|turn_requests|repository_jobs|repository_feedback|project_repositories";
const WRITES = new RegExp(
  [
    `\\.(?:insert|update|delete)\\(\\s*(?:${DRIZZLE_TABLES})\\s*\\)`,
    `\\b(?:insert\\s+into|update|delete\\s+from)\\s+(?:\\$\\{(?:${DRIZZLE_TABLES})\\}|"?(?:${SQL_TABLES})"?\\b)`,
  ].join("|"),
  "i",
);
const ANNOUNCES = /sessionList\??\.announce\(/;

/** Writers of those tables that change nothing a card draws, each with the reason. */
const QUIET: Record<string, string> = {
  "packages/db/src/postgres-event-store.ts":
    "moves a session's sequence counter; the events a card reads are appended before the request settles, or before the janitor marks a reclaimed one finished, and each of those announces",
};

type Source = { path: string; contents: string };

function shippedSources(): Source[] {
  return ["packages", "apps"].flatMap((group) =>
    readdirSync(join(repoRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const srcDir = join(repoRoot, group, entry.name, "src");
        if (!existsSync(srcDir)) return [];
        return readdirSync(srcDir, { recursive: true, withFileTypes: true })
          .filter((f) => f.isFile() && /\.tsx?$/.test(f.name))
          .map((f) => join(f.parentPath, f.name))
          .filter((path) => !/\.test(-d)?\.tsx?$|\/testing\//.test(path))
          .map((path) => ({
            path: path.slice(repoRoot.length + 1),
            contents: readFileSync(path, "utf8"),
          }));
      }),
  );
}

function silentWriters(sources: Source[]): string[] {
  return sources
    .filter(
      ({ path, contents }) =>
        WRITES.test(contents) && !ANNOUNCES.test(contents) && QUIET[path] === undefined,
    )
    .map(({ path }) => path);
}

/** The classes and functions an announcing writer exports: what boot must hand the announcer. */
function writerNames(sources: Source[]): string[] {
  return sources
    .filter(({ contents }) => WRITES.test(contents) && ANNOUNCES.test(contents))
    .flatMap(({ contents }) =>
      Array.from(contents.matchAll(/export (?:class|async function|function) (\w+)/g), (m) =>
        String(m[1]),
      ),
    );
}

/** The argument text of every call of `name` in `source`, matched to its closing parenthesis. */
function callsOf(source: string, name: string): string[] {
  const calls: string[] = [];
  for (const match of source.matchAll(new RegExp(`\\b${name}\\(`, "g"))) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let end = start;
    while (end < source.length && depth > 0) {
      if (source[end] === "(") depth += 1;
      else if (source[end] === ")") depth -= 1;
      end += 1;
    }
    calls.push(source.slice(start, end - 1));
  }
  return calls;
}

/** Writers built in `source` without the announcer. */
function unwiredWriters(source: string, writers: readonly string[]): string[] {
  return writers.flatMap((name) =>
    callsOf(source, name)
      .filter((args) => !/\bsessionList\b/.test(args))
      .map(() => name),
  );
}

describe("every writer of a session card announces it", () => {
  it("holds across the real workspace", () => {
    expect(silentWriters(shippedSources())).toEqual([]);
  });

  it("lists no exemption for a file that no longer exists or no longer writes", () => {
    const sources = new Map(shippedSources().map((source) => [source.path, source.contents]));
    for (const path of Object.keys(QUIET)) {
      const contents = sources.get(path);
      expect(contents, path).toBeDefined();
      expect(WRITES.test(contents ?? ""), path).toBe(true);
    }
  });

  it("is wired with the announcer everywhere boot builds one", () => {
    const writers = writerNames(shippedSources());
    // The list is derived, so check it found the writers it exists for.
    expect(writers).toEqual(
      expect.arrayContaining(["PostgresTurnQueue", "PostgresGitHubStore", "createProjectSession"]),
    );
    const boot = readFileSync(join(repoRoot, "apps/api/src/boot.ts"), "utf8");
    expect(unwiredWriters(boot, writers)).toEqual([]);
  });

  describe("the checks themselves", () => {
    it("catches a file that writes a card's table and never announces", () => {
      expect(
        silentWriters([
          { path: "a.ts", contents: "await db.update(projects).set({ name });" },
          { path: "b.ts", contents: "await tx`update turn_requests set state = 'done'`;" },
          {
            path: "c.ts",
            contents: `await sql\`delete from \${repositoryFeedback} where id = 1\`;`,
          },
          {
            path: "d.ts",
            contents: "await db.update(projects).set({}); this.#sessionList?.announce({ userId });",
          },
          { path: "e.ts", contents: "await db.update(users).set({ name });" },
        ]),
      ).toEqual(["a.ts", "b.ts", "c.ts"]);
    });

    it("catches a writer boot builds without the announcer", () => {
      const boot = `
        queue: new PostgresTurnQueue(db, { claims }),
        store: new PostgresGitHubStore(db, { claims, sessionList }),
        createProject: (options) => createProjectSession(db, options),
      `;
      expect(
        unwiredWriters(boot, ["PostgresTurnQueue", "PostgresGitHubStore", "createProjectSession"]),
      ).toEqual(["PostgresTurnQueue", "createProjectSession"]);
    });
  });
});
