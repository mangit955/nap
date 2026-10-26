import { existsSync } from "node:fs";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import { afterEach, describe, expect, it } from "vitest";
import { LocalShellSandbox } from "../testing/local-shell-sandbox.ts";
import type { ToolContext } from "./context.ts";
import { PROJECT_ROOT } from "./definitions.ts";
import { executeTool } from "./execute.ts";
import { globMatcher, MAX_GLOB_MATCHES } from "./search.ts";

/**
 * Finding files, against a real shell: `find`'s output is parsed, and the search runs whichever
 * of ripgrep or grep the sandbox has — so both are run here, the second by hiding the first.
 */

const sandboxes: LocalShellSandbox[] = [];

afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.dispose();
});

/** Takes ripgrep away from the shell, the way a template without it looks. */
const WITHOUT_RG = `command() { if [ "$1" = -v ] && [ "$2" = rg ]; then return 1; fi; builtin command "$@"; }`;

async function project(
  files: Record<string, string>,
  options: { prelude?: string } = {},
): Promise<{ sandbox: LocalShellSandbox; ctx: ToolContext }> {
  const sandbox = await LocalShellSandbox.create(options);
  sandboxes.push(sandbox);
  for (const [path, contents] of Object.entries(files))
    await sandbox.writeFile(sandbox.id, `${PROJECT_ROOT}/${path}`, contents);
  const events: PendingEvent[] = [];
  return {
    sandbox,
    ctx: {
      sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
      turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
      sandboxId: sandbox.id,
      sandbox,
      emit: (event) => events.push(event as PendingEvent),
    },
  };
}

const FILES = {
  "src/App.tsx": "import { useState } from 'react';\nexport function App() {}\n",
  "src/components/Button.tsx": "export const Button = () => null;\n",
  "src/components/button.test.tsx": "test('Button', () => {});\n",
  "src/index.css": "@import 'tailwindcss';\n",
  "node_modules/react/index.tsx": "export function useState() {}\n",
  ".github/workflow.yml": "useState: never\n",
};

describe("globMatcher", () => {
  it.each([
    ["**/*.tsx", "src/App.tsx", true],
    ["**/*.tsx", "App.tsx", true],
    ["src/*.tsx", "src/components/Button.tsx", false],
    ["src/**/*.tsx", "src/components/Button.tsx", true],
    ["*.tsx", "src/components/Button.tsx", true],
    ["*.test.{ts,tsx}", "src/components/button.test.tsx", true],
    ["*.test.{ts,tsx}", "src/components/Button.tsx", false],
    ["src/[A-Z]*.tsx", "src/App.tsx", true],
    ["src/[!A-Z]*.tsx", "src/App.tsx", false],
    ["src/?pp.tsx", "src/App.tsx", true],
    ["index.css", "src/index.css", true],
    ["src/index.css", "src/index.css", true],
    ["src/index.css", "lib/src/index.css", false],
    ["*.tsx", "src/App.tsx.bak", false],
    ["file.(x)", "file.(x)", true],
  ])("%s against %s is %s", (pattern, path, expected) => {
    expect(globMatcher(pattern)(path)).toBe(expected);
  });
});

describe("glob", () => {
  it("lists matching files by absolute path, sorted, skipping node_modules", async () => {
    const { ctx } = await project(FILES);

    const result = await executeTool(
      { id: "g", name: "glob", input: { pattern: "**/*.tsx" } },
      ctx,
    );

    expect(result.output.split("\n")).toEqual([
      `${PROJECT_ROOT}/src/App.tsx`,
      `${PROJECT_ROOT}/src/components/Button.tsx`,
      `${PROJECT_ROOT}/src/components/button.test.tsx`,
    ]);
  });

  it("matches under another directory when given one", async () => {
    const { ctx } = await project(FILES);

    const result = await executeTool(
      {
        id: "g",
        name: "glob",
        input: { pattern: "*.tsx", path: `${PROJECT_ROOT}/src/components` },
      },
      ctx,
    );

    expect(result.output).toBe(
      `${PROJECT_ROOT}/src/components/Button.tsx\n${PROJECT_ROOT}/src/components/button.test.tsx`,
    );
  });

  it("says when nothing matches", async () => {
    const { ctx } = await project(FILES);
    const result = await executeTool({ id: "g", name: "glob", input: { pattern: "*.vue" } }, ctx);
    expect(result).toEqual({ ok: true, output: `No files match *.vue under ${PROJECT_ROOT}.` });
  });

  it("cuts a pattern that matches too much and says how much was left out", async () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_GLOB_MATCHES + 7 }, (_, i) => [`gen/f${i}.ts`, ""]),
    );
    const { ctx } = await project(many);
    const result = await executeTool({ id: "g", name: "glob", input: { pattern: "*.ts" } }, ctx);
    expect(result.output).toMatch(/… 7 more\. Narrow the pattern\.$/);
  });
});

describe.each([
  ["ripgrep", ""],
  ["grep", WITHOUT_RG],
])("search_files with %s", (program, prelude) => {
  it.skipIf(program === "ripgrep" && !hasRipgrep())(
    "finds matching lines with their numbers, outside node_modules but in hidden directories",
    async () => {
      const { ctx } = await project(FILES, { prelude });
      const result = await executeTool(
        { id: "s", name: "search_files", input: { pattern: "useState" } },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(result.output).toContain(`${PROJECT_ROOT}/src/App.tsx:1:`);
      expect(result.output).toContain(`${PROJECT_ROOT}/.github/workflow.yml:1:`);
      expect(result.output).not.toContain("node_modules");
    },
  );

  it.skipIf(program === "ripgrep" && !hasRipgrep())(
    "reads extended regular expressions, filters by file name, and ignores case on request",
    async () => {
      const { ctx } = await project(FILES, { prelude });
      const result = await executeTool(
        {
          id: "s",
          name: "search_files",
          input: { pattern: "button|App\\(", glob: "*.tsx", ignore_case: true, files_only: true },
        },
        ctx,
      );
      expect(result.output.trim().split("\n").toSorted()).toEqual([
        `${PROJECT_ROOT}/src/App.tsx`,
        `${PROJECT_ROOT}/src/components/Button.tsx`,
        `${PROJECT_ROOT}/src/components/button.test.tsx`,
      ]);
    },
  );

  it.skipIf(program === "ripgrep" && !hasRipgrep())(
    "keeps a hostile pattern a pattern",
    async () => {
      // The pattern comes from a model repeating what a user typed into a chat box. Only a real
      // shell can settle whether it survives as text or runs as code.
      const { sandbox, ctx } = await project(
        { "notes.txt": "a; touch pwned; echo b\n" },
        { prelude },
      );
      const hostile = "; touch pwned; echo ";
      const result = await executeTool(
        { id: "s", name: "search_files", input: { pattern: `'${hostile}'`, path: PROJECT_ROOT } },
        ctx,
      );
      expect(result.ok).toBe(true);
      expect(existsSync(sandbox.host(`${PROJECT_ROOT}/pwned`))).toBe(false);
      const found = await executeTool(
        { id: "s2", name: "search_files", input: { pattern: hostile } },
        ctx,
      );
      expect(found.output).toContain("notes.txt:1:");
      expect(existsSync(sandbox.host(`${PROJECT_ROOT}/pwned`))).toBe(false);
    },
  );

  it.skipIf(program === "ripgrep" && !hasRipgrep())("answers no match as a result", async () => {
    const { ctx } = await project(FILES, { prelude });
    const result = await executeTool(
      { id: "s", name: "search_files", input: { pattern: "nowhere-to-be-found" } },
      ctx,
    );
    expect(result).toEqual({
      ok: true,
      output: `No matches for nowhere-to-be-found in ${PROJECT_ROOT}.`,
    });
  });
});

function hasRipgrep(): boolean {
  return (process.env.PATH ?? "").split(":").some((dir) => existsSync(`${dir}/rg`));
}
