import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionsSchema, ruleMatches, runsWithoutPrompt } from "./permissions.ts";

const repoRoot = join(import.meta.dirname, "..");
const settings = JSON.parse(readFileSync(join(repoRoot, ".claude/settings.json"), "utf8"));
const permissions = PermissionsSchema.parse(settings.permissions);

describe("matching a Bash rule against a command", () => {
  it("treats * as any run of characters", () => {
    expect(ruleMatches("Bash(bun run harness *)", 'bun run harness "fix it"')).toBe(true);
    expect(ruleMatches("Bash(bun run harness *--real*)", 'bun run harness --real "x"')).toBe(true);
  });

  it("keeps the space before * as a word boundary", () => {
    expect(ruleMatches("Bash(bun run test *)", "bun run test:integration")).toBe(false);
  });

  it("reads \\* as a literal asterisk", () => {
    expect(ruleMatches("Bash(ls \\*)", "ls *")).toBe(true);
    expect(ruleMatches("Bash(ls \\*)", "ls a")).toBe(false);
  });

  it("ignores rules for other tools", () => {
    expect(ruleMatches("Read(**)", "bun run test")).toBe(false);
  });
});

describe("runsWithoutPrompt", () => {
  it("lets ask override allow, as Claude Code does", () => {
    const rules = { allow: ["Bash(go *)"], ask: ["Bash(go *--real*)"] };
    expect(runsWithoutPrompt(rules, "go x")).toBe(true);
    expect(runsWithoutPrompt(rules, "go --real x")).toBe(false);
    expect(runsWithoutPrompt(rules, "other")).toBe(false);
  });
});

// The project allowlist exists so free commands stop prompting. These hit real E2B or a real
// model (docs/commands.md), so each must still ask, however an agent spells it. Vitest takes
// positional arguments as substring filters across every project, so a "file-shaped" allow rule
// such as `bunx vitest run *.test.ts*` let `bunx vitest run .test.ts` collect the integration suite.
const PAID = [
  "bun run test:integration",
  "bun run test --project integration",
  'bun run harness --real "fix the bug"',
  "bun run harness --plan --real x",
  "bunx vitest run .test.ts",
  "bunx vitest run packages/sandbox",
  "bunx vitest run packages/sandbox/src/git.test.ts packages/sandbox",
  "bunx vitest run --project integration",
  "bunx vitest run --project unit --project integration x",
  "bunx vitest run packages/sandbox/src/git.integration.test.ts",
];

const FREE = [
  "bun run test",
  "bun run test:fast",
  'bun run harness "fix the bug"',
  "bun run ws:smoke",
  'bunx vitest run --project unit test/comments.test.ts -t "explains"',
  "bunx vitest run --project web apps/web/src/chat/chat-input.test.tsx",
  "gh pr view 12",
];

describe(".claude/settings.json", () => {
  it.each(PAID)("asks before a paid run: %s", (command) => {
    expect(runsWithoutPrompt(permissions, command)).toBe(false);
  });

  it.each(FREE)("lets a free command run: %s", (command) => {
    expect(runsWithoutPrompt(permissions, command)).toBe(true);
  });
});
