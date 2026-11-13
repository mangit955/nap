import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { describe, expect, it } from "vitest";
import { listProjectFiles } from "./project-files.ts";
import { InMemorySandboxManager } from "./testing/in-memory-sandbox-manager.ts";

const ROOT = "/home/user/app";

/** One call the listing made on the sandbox, by method, with what it was given. */
type Call = { method: string; args: unknown[] };

/**
 * The fake every other package tests against, with each call it receives written down.
 *
 * Recorded by method name across the whole port rather than by spying on the one method the
 * listing is meant to use: what this guards against is a listing that goes back to asking the
 * sandbox about one folder at a time, by whichever method, and only a record of everything shows
 * that.
 */
async function workspace(files: readonly string[]) {
  const inner = new InMemorySandboxManager();
  const created = await inner.create("project-1");
  if (!created.ok) throw new Error("could not create a sandbox");
  for (const path of files) await inner.writeFile(created.value.id, `${ROOT}/${path}`, "");

  const calls: Call[] = [];
  const sandbox = new Proxy(inner, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push({ method: String(property), args });
        return value.apply(target, args);
      };
    },
  }) as SandboxManager;
  return { sandbox, sandboxId: created.value.id, calls };
}

/** Shaped like the real template: source, assets, and the noise around them. */
const PROJECT = [
  "package.json",
  "index.html",
  "src/App.tsx",
  "src/main.tsx",
  "src/components/Header.tsx",
  "node_modules/react/index.js",
  ".git/HEAD",
  "dist/index.js",
  "src/.vite/deps.json",
];

async function list(files: readonly string[], opts: { maxEntries?: number } = {}) {
  const { sandbox, sandboxId } = await workspace(files);
  const result = await listProjectFiles(sandbox, sandboxId, { root: ROOT, ...opts });
  if (!result.ok) throw new Error(`expected a listing, got ${result.error.code}`);
  return result.value;
}

/** A sandbox whose one listing method fails, as a sandbox that is gone or timed out does. */
function failing(error: SandboxError): Pick<SandboxManager, "listTree"> {
  return { listTree: async () => ({ ok: false, error }) };
}

describe("listProjectFiles", () => {
  it("asks the sandbox once, however many folders the project has", async () => {
    // The point of the change: the walk this replaced was a round trip per folder, one after
    // another, every time the files panel opened or a file changed.
    const deep = Array.from({ length: 12 }, (_, level) => `${"d/".repeat(level)}f${level}.ts`);
    const { sandbox, sandboxId, calls } = await workspace([...PROJECT, ...deep]);

    await listProjectFiles(sandbox, sandboxId, { root: ROOT });

    expect(calls.map((call) => call.method)).toEqual(["listTree"]);
  });

  it("asks with an explicit deadline, shorter than the provider's minute", async () => {
    const { sandbox, sandboxId, calls } = await workspace(PROJECT);

    await listProjectFiles(sandbox, sandboxId, { root: ROOT });

    const options = calls[0]?.args[2] as { timeoutMs: number };
    expect(options.timeoutMs).toBeGreaterThan(0);
    expect(options.timeoutMs).toBeLessThan(60_000);
  });

  it("asks the sandbox to leave dependencies, build output and version control out", async () => {
    // Asked of the sandbox rather than filtered afterwards, so a `node_modules` with a hundred
    // thousand files is never walked or sent, not merely not shown.
    const { sandbox, sandboxId, calls } = await workspace(PROJECT);

    await listProjectFiles(sandbox, sandboxId, { root: ROOT });

    const options = calls[0]?.args[2] as { exclude: readonly string[] };
    expect(options.exclude).toEqual(
      expect.arrayContaining(["node_modules", ".git", "dist", ".vite", ".next", "coverage"]),
    );
  });

  it("returns every file of the project, relative to its root, sorted, and nothing excluded", async () => {
    // Relative because the browser is shown these, and where the project lives inside the
    // sandbox is an execution-plane detail it has no business knowing.
    await expect(list(PROJECT)).resolves.toEqual({
      paths: [
        "index.html",
        "package.json",
        "src/App.tsx",
        "src/components/Header.tsx",
        "src/main.tsx",
      ],
      truncated: false,
    });
  });

  it("lists a file however deep it is, now that depth costs nothing", async () => {
    // The walk stopped six folders down because each folder was a round trip. A file the agent
    // just changed eight folders down is one the panel has to be able to show.
    const deep = "a/b/c/d/e/f/g/h/Deep.tsx";

    await expect(list(["package.json", deep])).resolves.toEqual({
      paths: [deep, "package.json"],
      truncated: false,
    });
  });

  it("stops at the entry limit and says so", async () => {
    const listing = await list(PROJECT, { maxEntries: 2 });

    expect(listing.paths).toHaveLength(2);
    expect(listing.truncated).toBe(true);
  });

  it("keeps the shallowest files when the limit bites", async () => {
    // `src/App.tsx` matters more than the tenth level of a nested component tree, whatever
    // order the sandbox happened to list them in.
    const nested = Array.from({ length: 10 }, (_, i) => `src/deep/nest/${String(i)}.tsx`);

    const listing = await list([...nested, "package.json", "src/App.tsx", "src/main.tsx"], {
      maxEntries: 3,
    });

    expect(listing).toEqual({
      paths: ["package.json", "src/App.tsx", "src/main.tsx"],
      truncated: true,
    });
  });

  it("is bounded even when the project is not", async () => {
    const deep = Array.from({ length: 300 }, (_, level) => `${"d/".repeat(level)}f${level}.ts`);

    const listing = await list(deep, { maxEntries: 25 });

    expect(listing.paths).toHaveLength(25);
    expect(listing.truncated).toBe(true);
  });

  it("answers an empty project with an empty listing", async () => {
    await expect(list([])).resolves.toEqual({ paths: [], truncated: false });
  });

  it("fails, rather than answering empty, when the root cannot be listed", async () => {
    // Distinct from the case above on purpose: nothing readable means the sandbox is gone or
    // did not answer in time, and an empty tree would tell the user their project is empty.
    for (const error of [
      { code: "timeout", message: "listing timed out" },
      { code: "file_not_found", message: "no such directory" },
    ] as const) {
      await expect(listProjectFiles(failing(error), "sbx_1", { root: ROOT })).resolves.toEqual({
        ok: false,
        error,
      });
    }
  });

  it("fails when the sandbox is gone", async () => {
    const { sandbox, sandboxId } = await workspace(PROJECT);
    await sandbox.destroy(sandboxId);

    await expect(listProjectFiles(sandbox, sandboxId, { root: ROOT })).resolves.toMatchObject({
      ok: false,
    });
  });
});
