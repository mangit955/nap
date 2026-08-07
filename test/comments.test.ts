import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkNoTaskIds, isCheckedSourcePath, type SourceFile } from "./comments.ts";

const repoRoot = join(import.meta.dirname, "..");

function readWorkspaceSources(): SourceFile[] {
  return ["packages", "apps"].flatMap((group) =>
    readdirSync(join(repoRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const srcDir = join(repoRoot, group, entry.name, "src");
        return (
          readdirSync(srcDir, { recursive: true, withFileTypes: true })
            // `.tsx` as well as `.ts`: React components are shipped source too, and the
            // rule was blind to every one of them until the web app existed to notice.
            .filter((f) => f.isFile() && (f.name.endsWith(".ts") || f.name.endsWith(".tsx")))
            .map((f) => {
              const absolute = join(f.parentPath, f.name);
              return {
                path: `${group}/${entry.name}/src/${absolute.slice(srcDir.length + 1)}`,
                contents: readFileSync(absolute, "utf8"),
              };
            })
        );
      }),
  );
}

describe("no task IDs in shipped source", () => {
  it("holds across the real workspace", () => {
    expect(checkNoTaskIds(readWorkspaceSources())).toEqual([]);
  });

  it("actually reads a non-trivial number of files", () => {
    // Guards against the check silently going quiet because the directory walk
    // broke and started returning nothing.
    expect(readWorkspaceSources().length).toBeGreaterThanOrEqual(8);
  });
});

describe("no task IDs — the checker actually catches violations", () => {
  // A checker that has never been seen to fail is not known to work.
  const at = (path: string, contents: string): SourceFile[] => [{ path, contents }];

  it("catches a task ID in a line comment", () => {
    const violations = checkNoTaskIds(at("packages/shared/src/events.ts", "// emitted by M2-5"));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.taskId).toBe("M2-5");
    expect(violations[0]?.line).toBe(1);
  });

  it("reports the line number so the message is actionable", () => {
    const violations = checkNoTaskIds(
      at("apps/web/src/pane.ts", "const a = 1;\n\n// see M3-4 for the visual treatment\n"),
    );
    expect(violations[0]?.line).toBe(3);
  });

  it("reports every occurrence, not just the first", () => {
    const violations = checkNoTaskIds(
      at("packages/shared/src/events.ts", "// M2-6/M2-7/M2-8 can produce this"),
    );
    expect(violations.map((v) => v.taskId)).toEqual(["M2-6", "M2-7", "M2-8"]);
  });

  it("explains what to do instead", () => {
    const violations = checkNoTaskIds(at("packages/db/src/schema.ts", "// M0-5"));
    expect(violations[0]?.reason).toContain("docs/PLAN.md");
  });

  it("allows a reference to a plan section, which a reader can open", () => {
    const contents = "// The stack contract lives in docs/PLAN.md §4. See also §5.";
    expect(checkNoTaskIds(at("packages/context/src/engine.ts", contents))).toEqual([]);
  });

  it("does not fire on similar-looking text", () => {
    const contents = "const m = MAX2 - 3;\n// an M3 chip, 4-bit\n// see RFC M12-3\n";
    expect(checkNoTaskIds(at("packages/shared/src/misc.ts", contents))).toEqual([]);
  });

  it("exempts test/ and docs/, which are made of task IDs", () => {
    expect(isCheckedSourcePath("test/docs.ts")).toBe(false);
    expect(isCheckedSourcePath("docs/PLAN.md")).toBe(false);
    expect(isCheckedSourcePath("PROGRESS.md")).toBe(false);
    expect(isCheckedSourcePath("packages/shared/src/events.ts")).toBe(true);
    expect(isCheckedSourcePath("apps/api/src/index.ts")).toBe(true);
  });

  it("ignores a package's config files, which sit outside src", () => {
    expect(checkNoTaskIds(at("packages/shared/vitest.config.ts", "// M0-1"))).toEqual([]);
  });
});
