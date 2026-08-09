import { describe, expect, it } from "vitest";
import { ancestorsOf, buildTree, type TreeNode } from "./tree.ts";

/** A shape that is easy to read in a failure: "src/", "src/App.tsx", … in render order. */
function flatten(nodes: readonly TreeNode[], depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.type === "file"
      ? [`${"  ".repeat(depth)}${node.name}`]
      : [`${"  ".repeat(depth)}${node.name}/`, ...flatten(node.children, depth + 1)],
  );
}

describe("buildTree", () => {
  it("nests a flat list of paths", () => {
    const tree = buildTree(["index.html", "src/App.tsx", "src/components/Header.tsx"]);

    expect(flatten(tree)).toEqual([
      "src/",
      "  components/",
      "    Header.tsx",
      "  App.tsx",
      "index.html",
    ]);
  });

  it("puts directories before files and sorts each group", () => {
    // The layout of a project is read top-down; interleaving folders with files by name
    // turns finding one into a scan.
    const tree = buildTree(["z.ts", "a.ts", "b/x.ts", "a/y.ts"]);

    expect(flatten(tree)).toEqual(["a/", "  y.ts", "b/", "  x.ts", "a.ts", "z.ts"]);
  });

  it("carries the full path on every node, so a click knows what to fetch", () => {
    const tree = buildTree(["src/components/Header.tsx"]);
    const src = tree[0];

    expect(src).toMatchObject({ type: "directory", path: "src" });
    if (src?.type !== "directory") throw new Error("expected a directory");
    expect(src.children[0]).toMatchObject({ type: "directory", path: "src/components" });
  });

  it("merges files that share a directory into one node", () => {
    const tree = buildTree(["src/a.ts", "src/b.ts"]);

    expect(tree).toHaveLength(1);
  });

  it("is empty for no paths", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("does not care what order it is given paths in", () => {
    const paths = ["src/components/Header.tsx", "index.html", "src/App.tsx"];

    expect(flatten(buildTree(paths))).toEqual(flatten(buildTree([...paths].reverse())));
  });
});

describe("ancestorsOf", () => {
  it("names every directory a file sits in", () => {
    expect(ancestorsOf("src/components/ui/Button.tsx")).toEqual([
      "src",
      "src/components",
      "src/components/ui",
    ]);
  });

  it("is empty for a file at the root", () => {
    expect(ancestorsOf("index.html")).toEqual([]);
  });
});
