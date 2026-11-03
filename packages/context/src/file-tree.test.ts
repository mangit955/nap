import type { FileNode, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { describe, expect, it } from "vitest";
import { buildFileTreeDigest, FILE_LIST_UNAVAILABLE } from "./file-tree.ts";
import { type ListTreeCall, stubSandbox } from "./testing/stub-sandbox.ts";

const ROOT = "/home/user/app";
const SANDBOX = "sbx_1";

/** Directory path → its direct children: the shape the old folder-by-folder walk was fed. */
type Folders = Record<string, FileNode[]>;

function dir(path: string): FileNode {
  return { path, type: "directory" };
}

function file(path: string): FileNode {
  return { path, type: "file" };
}

/** A project shaped like the real template: source, assets, and the noise around them. */
function projectTree(): Folders {
  return {
    [ROOT]: [
      dir(`${ROOT}/src`),
      dir(`${ROOT}/public`),
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
    [`${ROOT}/public`]: [file(`${ROOT}/public/favicon.svg`)],
    [`${ROOT}/node_modules`]: [dir(`${ROOT}/node_modules/react`)],
    [`${ROOT}/node_modules/react`]: [file(`${ROOT}/node_modules/react/index.js`)],
    [`${ROOT}/.git`]: [file(`${ROOT}/.git/HEAD`)],
    [`${ROOT}/dist`]: [file(`${ROOT}/dist/index.js`)],
  };
}

/** Every file the folders hold, which is what a sandbox has before anything filters it. */
function filesOf(folders: Folders): string[] {
  return Object.values(folders)
    .flat()
    .filter((node) => node.type === "file")
    .map((node) => node.path);
}

function workspace(folders: Folders = projectTree()): SandboxManager {
  return stubSandbox(filesOf(folders));
}

function entries(digest: string): string[] {
  return digest.split("\n").filter((line) => line.startsWith("- "));
}

/**
 * The digest as it was built before it became one call: a `listFiles` per folder, in turn.
 * Kept verbatim, minus the sandbox, so the new version can be held to its output exactly.
 */
function legacyDigest(
  folders: Folders,
  opts: { maxEntries?: number; maxDepth?: number } = {},
): string {
  const excluded = new Set(["node_modules", ".git", "dist", ".vite", ".next", "coverage"]);
  const maxEntries = opts.maxEntries ?? 200;
  const maxDepth = opts.maxDepth ?? 6;
  const paths: string[] = [];
  let queue: string[] = [ROOT];
  for (let depth = 0; depth <= maxDepth && queue.length > 0; depth += 1) {
    const next: string[] = [];
    for (const directory of queue) {
      if (paths.length >= maxEntries) break;
      const children = [...(folders[directory] ?? [])].sort((a, b) => a.path.localeCompare(b.path));
      for (const child of children) {
        if (paths.length >= maxEntries) break;
        if (excluded.has(child.path.slice(child.path.lastIndexOf("/") + 1))) continue;
        if (child.type === "directory") {
          next.push(child.path);
          continue;
        }
        paths.push(child.path);
      }
    }
    queue = next;
  }
  return paths.map((path) => `- ${path.slice(ROOT.length + 1)}`).join("\n");
}

/**
 * Wide, deep, awkwardly named and full of things to ignore: every way the two walks could
 * disagree — sibling order under `localeCompare`, the entry ceiling landing mid-folder, the depth
 * ceiling, an excluded name as a file rather than a folder, an excluded folder nested deep.
 */
function awkwardTree(): Folders {
  const folders: Folders = projectTree();
  const add = (parent: string, node: FileNode): void => {
    folders[parent] = [...(folders[parent] ?? []), node];
  };
  for (const name of ["Zeta.ts", "alpha.ts", "Alpha.ts", "_x.ts", "my file.ts", "naïve.ts"])
    add(`${ROOT}/src`, file(`${ROOT}/src/${name}`));
  add(`${ROOT}/src`, file(`${ROOT}/src/coverage`));
  add(`${ROOT}/src`, dir(`${ROOT}/src/deep`));
  let path = `${ROOT}/src/deep`;
  for (let level = 0; level < 9; level += 1) {
    add(path, file(`${path}/level${level}.ts`));
    add(path, dir(`${path}/node_modules`));
    add(`${path}/node_modules`, file(`${path}/node_modules/x.js`));
    add(path, dir(`${path}/next`));
    path = `${path}/next`;
  }
  add(ROOT, dir(`${ROOT}/wide`));
  for (let index = 0; index < 250; index += 1)
    add(`${ROOT}/wide`, file(`${ROOT}/wide/f${index}.ts`));
  return folders;
}

describe("buildFileTreeDigest", () => {
  it("lists the project's files", async () => {
    const digest = await buildFileTreeDigest(workspace(), SANDBOX, { root: ROOT });

    expect(digest).toContain("src/App.tsx");
    expect(digest).toContain("src/main.tsx");
    expect(digest).toContain("src/components/Header.tsx");
    expect(digest).toContain("package.json");
  });

  it("reports paths relative to the project root", async () => {
    // The absolute prefix is the same on every line and is already stated in the stack
    // contract, so repeating it costs tokens on every entry and tells the model nothing.
    const digest = await buildFileTreeDigest(workspace(), SANDBOX, { root: ROOT });

    expect(digest).not.toContain(ROOT);
  });

  it("excludes directories the agent must never touch", async () => {
    const digest = await buildFileTreeDigest(workspace(), SANDBOX, { root: ROOT });

    expect(digest).not.toContain("node_modules");
    expect(digest).not.toContain(".git");
    expect(digest).not.toContain("dist");
  });

  it("asks the sandbox once, with an explicit deadline, to leave the excluded folders out", async () => {
    // One call is the whole point: the listing runs before anything reaches the model, and it
    // used to be a round trip per folder. Asking the sandbox to prune is what keeps a
    // `node_modules` with a hundred thousand files out of the transfer, not just the prompt.
    const calls: ListTreeCall[] = [];
    const sandbox = stubSandbox(filesOf(projectTree()), { onListTree: (call) => calls.push(call) });

    await buildFileTreeDigest(sandbox, SANDBOX, { root: ROOT });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.root).toBe(ROOT);
    expect(calls[0]?.exclude).toEqual(expect.arrayContaining(["node_modules", ".git", "dist"]));
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(calls[0]?.timeoutMs).toBeLessThan(60_000);
  });

  it("renders exactly what the folder-by-folder walk rendered, for the same tree", async () => {
    // The model must not see a different digest because of how it was gathered.
    const folders = awkwardTree();
    for (const opts of [{}, { maxEntries: 3 }, { maxEntries: 40 }, { maxDepth: 2 }]) {
      const digest = await buildFileTreeDigest(workspace(folders), SANDBOX, {
        root: ROOT,
        ...opts,
      });

      expect(digest).toBe(legacyDigest(folders, opts));
    }
  });

  it("stops at the entry limit", async () => {
    const digest = await buildFileTreeDigest(workspace(), SANDBOX, { root: ROOT, maxEntries: 3 });

    expect(entries(digest)).toHaveLength(3);
  });

  it("stops at the depth limit", async () => {
    const digest = await buildFileTreeDigest(workspace(), SANDBOX, { root: ROOT, maxDepth: 1 });

    expect(digest).toContain("src/App.tsx");
    expect(digest).not.toContain("components/Header.tsx");
  });

  it("is bounded even when the tree is not", async () => {
    // A generated project can nest arbitrarily deep; the listing must not be the thing that
    // decides how much of it reaches the prompt.
    const deep: string[] = [];
    let path = ROOT;
    for (let i = 0; i < 500; i += 1) {
      deep.push(`${path}/f${i}.ts`);
      path = `${path}/d${i}`;
    }

    const digest = await buildFileTreeDigest(stubSandbox(deep), SANDBOX, {
      root: ROOT,
      maxEntries: 25,
    });

    expect(entries(digest).length).toBeLessThanOrEqual(25);
  });

  it("says the listing is unavailable when the sandbox cannot give one, rather than failing", async () => {
    // A timed-out listing must not fail the turn, and must not read as an empty project
    // either — the model would start writing files that already exist.
    const sandbox = stubSandbox(filesOf(projectTree()), { failing: true });

    await expect(buildFileTreeDigest(sandbox, SANDBOX, { root: ROOT })).resolves.toBe(
      FILE_LIST_UNAVAILABLE,
    );
  });

  it("returns an empty digest for an empty project", async () => {
    await expect(buildFileTreeDigest(stubSandbox([]), SANDBOX, { root: ROOT })).resolves.toBe("");
  });

  it("is deterministic whatever order the sandbox lists in", async () => {
    // Requests that repeat each other byte for byte are what a prompt cache reads; a listing in
    // a different order must not produce a different digest.
    const files = filesOf(awkwardTree());
    const first = await buildFileTreeDigest(stubSandbox(files), SANDBOX, { root: ROOT });
    const second = await buildFileTreeDigest(stubSandbox([...files].reverse()), SANDBOX, {
      root: ROOT,
    });

    expect(first).toBe(second);
  });
});
