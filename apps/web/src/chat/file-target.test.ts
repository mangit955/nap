import { describe, expect, it } from "vitest";
import { buildFileTree, fileTarget } from "./file-target.ts";

/**
 * Which bits of an agent's reply are paths into the project, and the changed-files tree.
 *
 * A path the agent mentions becomes a chip that opens the file, so a false positive is a chip on
 * a word that opens nothing, and a false negative is a filename nobody can click.
 */

describe("fileTarget", () => {
  const files = ["src/App.tsx", "src/main.tsx", "package.json", "index.html"];

  it("recognises a project path, however the agent wrote it", () => {
    expect(fileTarget("src/App.tsx", files)).toBe("src/App.tsx");
    expect(fileTarget("./src/App.tsx", files)).toBe("src/App.tsx");
    expect(fileTarget("/home/user/app/src/App.tsx", files)).toBe("src/App.tsx");
    expect(fileTarget("src/App.tsx:14", files)).toBe("src/App.tsx");
    expect(fileTarget("src/App.tsx#L14", files)).toBe("src/App.tsx");
  });

  it("finds a bare filename the project has exactly one of", () => {
    expect(fileTarget("package.json", files)).toBe("package.json");
    expect(fileTarget("App.tsx", files)).toBe("src/App.tsx");
  });

  it("finds a bare filename given with a line number, which looks like a URL scheme", () => {
    expect(fileTarget("App.tsx:14", files)).toBe("src/App.tsx");
    expect(fileTarget("package.json:3:5", files)).toBe("package.json");
  });

  it("takes a path-shaped mention even before the file listing is in", () => {
    expect(fileTarget("src/components/Header.tsx", [])).toBe("src/components/Header.tsx");
  });

  it("trusts the listing over the shape once it has arrived", () => {
    expect(fileTarget("node_modules/react/index.js", files)).toBeUndefined();
    expect(fileTarget("example.com/index.html", files)).toBeUndefined();
  });

  it("strips the sandbox's project root only where a path starts with it", () => {
    expect(fileTarget("vendor/home/user/app/x.ts", [])).toBe("vendor/home/user/app/x.ts");
  });

  it("leaves everything else as code", () => {
    expect(fileTarget("useState", files)).toBeUndefined();
    expect(fileTarget("bun run build", files)).toBeUndefined();
    expect(fileTarget("https://example.com/a.ts", files)).toBeUndefined();
    expect(fileTarget("http://localhost:3000", files)).toBeUndefined();
    expect(fileTarget("Header.tsx", files)).toBeUndefined();
    expect(fileTarget("1.5", files)).toBeUndefined();
  });
});

describe("buildFileTree", () => {
  it("nests files under their folders, folding a chain of single folders into one row", () => {
    const tree = buildFileTree([
      { path: "src/components/Header.tsx", added: 3, removed: 1 },
      { path: "src/components/Footer.tsx", added: 2, removed: 0 },
      { path: "package.json", added: 1, removed: 1 },
    ]);

    expect(tree).toEqual([
      {
        kind: "directory",
        name: "src/components",
        path: "src/components",
        added: 5,
        removed: 1,
        children: [
          {
            kind: "file",
            name: "Header.tsx",
            path: "src/components/Header.tsx",
            added: 3,
            removed: 1,
          },
          {
            kind: "file",
            name: "Footer.tsx",
            path: "src/components/Footer.tsx",
            added: 2,
            removed: 0,
          },
        ],
      },
      { kind: "file", name: "package.json", path: "package.json", added: 1, removed: 1 },
    ]);
  });
});
