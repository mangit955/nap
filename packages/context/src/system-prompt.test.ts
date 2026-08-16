import type { ContextRequest } from "@nap/shared/ports/context-engine";
import type { FileNode } from "@nap/shared/ports/sandbox-manager";
import { describe, expect, it } from "vitest";
import { NapContextEngine } from "./context-engine.ts";
import { NoopMemoryProvider } from "./noop-memory-provider.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { type FileTree, stubSandbox } from "./testing/stub-sandbox.ts";
import { estimateTokens } from "./tokens.ts";

const ROOT = "/home/user/app";

/** The template's real layout, so the snapshot shows what a fresh project actually sends. */
function templateTree(): FileTree {
  return {
    [ROOT]: [
      { path: `${ROOT}/src`, type: "directory" } satisfies FileNode,
      { path: `${ROOT}/index.html`, type: "file" },
      { path: `${ROOT}/package.json`, type: "file" },
      { path: `${ROOT}/tsconfig.json`, type: "file" },
      { path: `${ROOT}/vite.config.ts`, type: "file" },
    ],
    [`${ROOT}/src`]: [
      { path: `${ROOT}/src/App.tsx`, type: "file" },
      { path: `${ROOT}/src/index.css`, type: "file" },
      { path: `${ROOT}/src/main.tsx`, type: "file" },
    ],
  };
}

/** Nothing here varies between runs, so the snapshot is stable by construction. */
async function assembled(overrides: Partial<ContextRequest> = {}): Promise<string> {
  const engine = new NapContextEngine({ root: ROOT });
  const context = await engine.build({
    sessionId: "6f1c1d3e-2b7a-4c5e-8f9a-0d1e2f3a4b5c",
    sandboxId: "sbx_1",
    userMessage: "add a dark mode toggle",
    history: [],
    sandbox: stubSandbox(templateTree()),
    memory: new NoopMemoryProvider(),
    ...overrides,
  });
  return context.systemPrompt;
}

describe("the system prompt", () => {
  it("matches the reviewed snapshot", async () => {
    // Snapshots the *assembled* prompt rather than the constant, so a change to how sections
    // are composed is caught alongside a change to their wording. Regenerate deliberately
    // with `vitest -u` and read the diff — this file is the record that a human approved
    // every word the model is told on every turn.
    expect(await assembled()).toMatchSnapshot();
  });

  it("matches the reviewed snapshot on a repair turn", async () => {
    // The second thing a human has to have approved: what a turn prompted by a failed check
    // is told about the job it is repairing. Same rule — read the diff, do not regenerate it.
    const prompt = await assembled({
      userMessage: "The `typecheck` check failed (exited 2). Find the cause and fix it.",
      job: {
        objective: "add a dark mode toggle",
        attempts: [
          {
            check: "typecheck",
            detail: "exited 2",
            output: "src/App.tsx(4,7): error TS2304: Cannot find name 'useTheme'.",
          },
        ],
      },
    });

    expect(prompt).toMatchSnapshot();
  });

  describe("required sections", () => {
    it.each(["<stack>", "<files>", "<scope>", "<response>"])("includes %s", (section) => {
      expect(SYSTEM_PROMPT).toContain(section);
    });

    it("closes every section it opens", () => {
      // An unbalanced tag turns the rest of the prompt into the contents of a section,
      // which reads to the model as something other than what it says.
      for (const section of ["stack", "files", "scope", "response"]) {
        expect(SYSTEM_PROMPT.split(`<${section}>`)).toHaveLength(2);
        expect(SYSTEM_PROMPT.split(`</${section}>`)).toHaveLength(2);
      }
    });
  });

  describe("the stack it must build against", () => {
    it.each(["React 19", "Vite", "Tailwind v4", "TypeScript"])("names %s", (fact) => {
      expect(SYSTEM_PROMPT).toContain(fact);
    });

    it("rules out server code, which the sandbox cannot run", () => {
      expect(SYSTEM_PROMPT).toContain("no backend");
      expect(SYSTEM_PROMPT).toContain("never write API routes or server code");
    });

    it("says where the project lives and what its entry points are", () => {
      expect(SYSTEM_PROMPT).toContain(ROOT);
      expect(SYSTEM_PROMPT).toContain("src/main.tsx");
      expect(SYSTEM_PROMPT).toContain("src/App.tsx");
      expect(SYSTEM_PROMPT).toContain("src/index.css");
    });
  });

  describe("facts that must match the sandbox template", () => {
    // Both of these were wrong in the first draft of this prompt, and neither would have
    // produced a confused agent — they would have produced a confident one, writing files
    // that nothing serves. See packages/sandbox/template/.

    it("does not invent a public/ directory", () => {
      expect(SYSTEM_PROMPT).not.toContain("public/");
    });

    it("says outright that there is no Tailwind config file", () => {
      // Tailwind v4 is configured from CSS. A model carrying v3 habits will otherwise create
      // tailwind.config.js, and get silence rather than an error.
      expect(SYSTEM_PROMPT).toContain("There is no tailwind.config.js");
      expect(SYSTEM_PROMPT).toContain("@theme");
    });
  });

  describe("conciseness and scope discipline", () => {
    it("tells it to write for a chat pane rather than a terminal", () => {
      expect(SYSTEM_PROMPT).toContain("chat pane");
      expect(SYSTEM_PROMPT).toContain("short, plain sentences");
    });

    it("tells it not to widen the task", () => {
      expect(SYSTEM_PROMPT).toContain("Build what was asked for");
      expect(SYSTEM_PROMPT).toContain("nobody asked for");
    });

    it("tells it to finish rather than to report progress it has not made", () => {
      expect(SYSTEM_PROMPT).toContain("Finish the whole task");
    });
  });

  describe("self-verification instructions", () => {
    // The load-bearing absence. This model already checks its own work; telling it to do so
    // again produces redundant tool calls and long reports *about* the checking, not fewer
    // mistakes. The omission looks like an oversight, so it is enforced rather than trusted
    // to survive the next well-meaning edit — see the note in system-prompt.ts.
    it.each([
      "double-check",
      "double check",
      "verify your",
      "re-check",
      "make sure to test",
      "confirm that it works",
      "verification step",
      "check your work",
    ])("does not tell the model to %s", (phrase) => {
      expect(SYSTEM_PROMPT.toLowerCase()).not.toContain(phrase);
    });

    it("contains no verification language at all", () => {
      expect(SYSTEM_PROMPT).not.toMatch(/\bverif/i);
    });
  });

  it("stays small enough to send on every request of every turn", () => {
    // Not arbitrary: this is paid for on every request, and a prompt that grows a paragraph
    // per task is one nobody notices getting expensive. A failure here is a prompt to cut,
    // not a ceiling to raise.
    expect(estimateTokens(SYSTEM_PROMPT)).toBeLessThan(900);
  });
});
