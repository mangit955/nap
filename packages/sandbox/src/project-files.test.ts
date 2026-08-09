import type { FileNode, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { describe, expect, it } from "vitest";
import { listProjectFiles } from "./project-files.ts";
import { InMemorySandboxManager } from "./testing/in-memory-sandbox-manager.ts";

const ROOT = "/home/user/app";
const SANDBOX = "sbx_1";

function dir(path: string): FileNode {
  return { path, type: "directory" };
}

function file(path: string): FileNode {
  return { path, type: "file" };
}

type Listing = Record<string, FileNode[]>;

/**
 * A listing source with holes in it. `InMemorySandboxManager` cannot fail one directory
 * while succeeding at another — its filesystem either exists or does not — and a folder
 * the walk may not read is the case that decides whether one bad directory costs the user
 * their whole file tree.
 */
function stub(
  listing: Listing,
  opts: { failing?: string[]; onList?: (path: string) => void } = {},
): Pick<SandboxManager, "listFiles"> {
  const failing = new Set(opts.failing ?? []);

  return {
    async listFiles(_sandboxId, path) {
      opts.onList?.(path);
      if (failing.has(path)) {
        return { ok: false, error: { code: "unavailable", message: `cannot list ${path}` } };
      }
      return { ok: true, value: listing[path] ?? [] };
    },
  };
}

/** Shaped like the real template: source, assets, and the noise around them. */
function project(): Listing {
  return {
    [ROOT]: [
      dir(`${ROOT}/src`),
      dir(`${ROOT}/node_modules`),
      dir(`${ROOT}/.git`),
      dir(`${ROOT}/dist`),
      file(`${ROOT}/package.json`),
      file(`${ROOT}/index.html`),
    ],
    [`${ROOT}/src`]: [
      dir(`${ROOT}/src/components`),
      file(`${ROOT}/src/App.tsx`),
      file(`${ROOT}/src/main.tsx`),
    ],
    [`${ROOT}/src/components`]: [file(`${ROOT}/src/components/Header.tsx`)],
    [`${ROOT}/node_modules`]: [dir(`${ROOT}/node_modules/react`)],
    [`${ROOT}/.git`]: [file(`${ROOT}/.git/HEAD`)],
    [`${ROOT}/dist`]: [file(`${ROOT}/dist/index.js`)],
  };
}

async function walk(
  sandbox: Pick<SandboxManager, "listFiles">,
  opts: Parameters<typeof listProjectFiles>[2] = {},
) {
  const result = await listProjectFiles(sandbox, SANDBOX, { root: ROOT, ...opts });
  if (!result.ok) throw new Error(`expected a listing, got ${result.error.code}`);
  return result.value;
}

describe("listProjectFiles", () => {
  it("returns every file in the project, nested ones included", async () => {
    const listing = await walk(stub(project()));

    expect(listing.paths).toContain("package.json");
    expect(listing.paths).toContain("src/App.tsx");
    expect(listing.paths).toContain("src/components/Header.tsx");
  });

  it("reports paths relative to the project root", async () => {
    // The browser is shown these; where the project happens to live inside the sandbox is
    // an execution-plane detail it has no business knowing.
    const listing = await walk(stub(project()));

    expect(listing.paths.every((path) => !path.startsWith("/"))).toBe(true);
  });

  it("omits dependencies, build output and version-control internals", async () => {
    const listing = await walk(stub(project()));

    expect(listing.paths).not.toContain("dist/index.js");
    expect(listing.paths.some((path) => path.startsWith("node_modules"))).toBe(false);
    expect(listing.paths.some((path) => path.startsWith(".git"))).toBe(false);
  });

  it("does not descend into them either", async () => {
    // Stronger than the previous case: a walk that read node_modules and then filtered the
    // result would pass that one while making thousands of calls into a directory holding a
    // hundred thousand files.
    const listed: string[] = [];

    await walk(stub(project(), { onList: (path) => listed.push(path) }));

    expect(listed).toContain(`${ROOT}/src`);
    expect(listed).not.toContain(`${ROOT}/node_modules`);
    expect(listed).not.toContain(`${ROOT}/.git`);
  });

  it("sorts, so the same project always answers the same way", async () => {
    const listing = await walk(stub(project()));

    expect(listing.paths).toEqual([...listing.paths].sort());
  });

  it("says nothing was left out when nothing was", async () => {
    await expect(walk(stub(project()))).resolves.toMatchObject({ truncated: false });
  });

  it("stops at the entry limit and says so", async () => {
    const listing = await walk(stub(project()), { maxEntries: 2 });

    expect(listing.paths).toHaveLength(2);
    expect(listing.truncated).toBe(true);
  });

  it("stops at the depth limit and says so", async () => {
    const listing = await walk(stub(project()), { maxDepth: 1 });

    expect(listing.paths).toContain("src/App.tsx");
    expect(listing.paths).not.toContain("src/components/Header.tsx");
    expect(listing.truncated).toBe(true);
  });

  it("is bounded even when the project is not", async () => {
    const deep: Listing = {};
    let path = ROOT;
    for (let i = 0; i < 500; i += 1) {
      const child = `${path}/d${i}`;
      deep[path] = [dir(child), file(`${path}/f${i}.ts`)];
      path = child;
    }

    const listing = await walk(stub(deep), { maxEntries: 25 });

    expect(listing.paths.length).toBeLessThanOrEqual(25);
  });

  it("keeps going when one directory cannot be read", async () => {
    // An unreadable folder is a gap in a listing. Failing the whole request would replace a
    // usable file tree with an error message over one directory nobody asked about.
    const listing = await walk(stub(project(), { failing: [`${ROOT}/src`] }));

    expect(listing.paths).toContain("package.json");
    expect(listing.paths).not.toContain("src/App.tsx");
    expect(listing.truncated).toBe(true);
  });

  it("fails when the root itself cannot be read", async () => {
    // Distinct from the case above on purpose: nothing readable means the sandbox is gone,
    // and an empty tree would tell the user their project is empty.
    const result = await listProjectFiles(stub({}, { failing: [ROOT] }), SANDBOX, { root: ROOT });

    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });

  it("works against a real SandboxManager", async () => {
    // The stub above answers whatever the test wrote down. This one goes through the fake
    // every other package tests against, which synthesizes directories from file paths —
    // the same shape the E2B adapter is held to by the conformance suite.
    const sandbox = new InMemorySandboxManager();
    const created = await sandbox.create("project-1");
    if (!created.ok) throw new Error("could not create a sandbox");

    await sandbox.writeFile(created.value.id, `${ROOT}/src/App.tsx`, "export default null;");
    await sandbox.writeFile(created.value.id, `${ROOT}/package.json`, "{}");
    await sandbox.writeFile(created.value.id, `${ROOT}/node_modules/react/index.js`, "");

    const result = await listProjectFiles(sandbox, created.value.id, { root: ROOT });

    expect(result).toEqual({
      ok: true,
      value: { paths: ["package.json", "src/App.tsx"], truncated: false },
    });
  });
});
