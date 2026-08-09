import type { FileNode } from "@nap/shared/ports/sandbox-manager";
import { describe, expect, it } from "vitest";
import { buildFileTreeDigest } from "./file-tree.ts";
import { type FileTree, stubSandbox } from "./testing/stub-sandbox.ts";

const ROOT = "/home/user/app";
const SANDBOX = "sbx_1";

function dir(path: string): FileNode {
  return { path, type: "directory" };
}

function file(path: string): FileNode {
  return { path, type: "file" };
}

/** A project shaped like the real template: source, assets, and the noise around them. */
function projectTree(): FileTree {
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
    [`${ROOT}/.git`]: [file(`${ROOT}/.git/HEAD`)],
    [`${ROOT}/dist`]: [file(`${ROOT}/dist/index.js`)],
  };
}

describe("buildFileTreeDigest", () => {
  it("lists the project's files", async () => {
    const digest = await buildFileTreeDigest(stubSandbox(projectTree()), SANDBOX, { root: ROOT });

    expect(digest).toContain("src/App.tsx");
    expect(digest).toContain("src/main.tsx");
    expect(digest).toContain("src/components/Header.tsx");
    expect(digest).toContain("package.json");
  });

  it("reports paths relative to the project root", async () => {
    // The absolute prefix is the same on every line and is already stated in the stack
    // contract, so repeating it costs tokens on every entry and tells the model nothing.
    const digest = await buildFileTreeDigest(stubSandbox(projectTree()), SANDBOX, { root: ROOT });

    expect(digest).not.toContain(ROOT);
  });

  it("excludes directories the agent must never touch", async () => {
    const digest = await buildFileTreeDigest(stubSandbox(projectTree()), SANDBOX, { root: ROOT });

    expect(digest).not.toContain("node_modules");
    expect(digest).not.toContain(".git");
    expect(digest).not.toContain("dist");
  });

  it("does not descend into excluded directories", async () => {
    // Stronger than the name check above: an implementation that walked node_modules and
    // then filtered the output would pass that one, while making thousands of calls into a
    // directory with a hundred thousand files in it.
    const listed: string[] = [];
    const sandbox = stubSandbox(projectTree(), { onList: (path) => listed.push(path) });

    await buildFileTreeDigest(sandbox, SANDBOX, { root: ROOT });

    expect(listed).toContain(`${ROOT}/src`);
    expect(listed).not.toContain(`${ROOT}/node_modules`);
    expect(listed).not.toContain(`${ROOT}/.git`);
    expect(listed).not.toContain(`${ROOT}/dist`);
  });

  it("stops at the entry limit", async () => {
    const digest = await buildFileTreeDigest(stubSandbox(projectTree()), SANDBOX, {
      root: ROOT,
      maxEntries: 3,
    });

    expect(digest.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(3);
  });

  it("stops at the depth limit", async () => {
    const digest = await buildFileTreeDigest(stubSandbox(projectTree()), SANDBOX, {
      root: ROOT,
      maxDepth: 1,
    });

    expect(digest).toContain("src/App.tsx");
    expect(digest).not.toContain("components/Header.tsx");
  });

  it("is bounded even when the tree is not", async () => {
    // A generated project can nest arbitrarily deep; the walk must not be the thing that
    // decides how much of it reaches the prompt.
    const deep: FileTree = {};
    let path = ROOT;
    for (let i = 0; i < 500; i += 1) {
      const child = `${path}/d${i}`;
      deep[path] = [dir(child), file(`${path}/f${i}.ts`)];
      path = child;
    }

    const digest = await buildFileTreeDigest(stubSandbox(deep), SANDBOX, {
      root: ROOT,
      maxEntries: 25,
    });

    expect(digest.split("\n").filter((line) => line.startsWith("- ")).length).toBeLessThanOrEqual(
      25,
    );
  });

  it("degrades to a partial digest when a directory cannot be listed", async () => {
    // One unreadable directory must not fail the turn. The agent can still work from what
    // was readable, and can always list the rest itself with a tool.
    const sandbox = stubSandbox(projectTree(), { failing: [`${ROOT}/src`] });

    const digest = await buildFileTreeDigest(sandbox, SANDBOX, { root: ROOT });

    expect(digest).toContain("package.json");
    expect(digest).not.toContain("App.tsx");
  });

  it("returns an empty digest when the root itself cannot be listed", async () => {
    const sandbox = stubSandbox({}, { failing: [ROOT] });

    await expect(buildFileTreeDigest(sandbox, SANDBOX, { root: ROOT })).resolves.toBe("");
  });

  it("is deterministic", async () => {
    // The digest sits in a cacheable prefix; two identical projects must produce identical
    // bytes or the cache never hits.
    const first = await buildFileTreeDigest(stubSandbox(projectTree()), SANDBOX, { root: ROOT });
    const second = await buildFileTreeDigest(stubSandbox(projectTree()), SANDBOX, { root: ROOT });

    expect(first).toBe(second);
  });
});
