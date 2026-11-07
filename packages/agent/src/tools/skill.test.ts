import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { ToolName } from "@nap/shared/events";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import { discoverSkills } from "@nap/shared/skills";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolContext } from "./context.ts";
import { PROJECT_ROOT } from "./definitions.ts";
import { executeTool } from "./execute.ts";
import { FileLedger } from "./ledger.ts";
import { SkillSession } from "./skill.ts";

const SKILLS = `${PROJECT_ROOT}/.nap/skills`;

let manager: InMemorySandboxManager;
let sandboxId: string;
let events: PendingEvent[];
let session: SkillSession;
let ledger: FileLedger;

function skillFile(name: string, body: string, extra = ""): string {
  return `---\nname: ${name}\ndescription: When doing ${name} work\n${extra}---\n${body}\n`;
}

async function put(name: string, text: string): Promise<void> {
  const wrote = await manager.writeFile(sandboxId, `${SKILLS}/${name}/SKILL.md`, text);
  if (!wrote.ok) throw new Error(wrote.error.message);
}

/** Discovery as the turn's context build did it, at the start of the turn. */
async function startTurn(): Promise<void> {
  session = new SkillSession(await discoverSkills(manager, sandboxId, PROJECT_ROOT));
}

beforeEach(async () => {
  manager = new InMemorySandboxManager();
  const created = await manager.create("project");
  if (!created.ok) throw new Error(created.error.message);
  sandboxId = created.value.id;
  events = [];
  ledger = new FileLedger();
  await put("migrations", skillFile("migrations", "Run drizzle-kit generate, never edit SQL."));
  await startTurn();
});

function context(offered?: readonly ToolName[]): ToolContext {
  return {
    sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
    turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
    sandboxId,
    sandbox: manager,
    ledger,
    skills: session,
    ...(offered === undefined ? {} : { offered: new Set(offered) }),
    emit: (event) => events.push(event as PendingEvent),
  };
}

let calls = 0;
function run(name: string, input: Record<string, unknown>, offered?: readonly ToolName[]) {
  calls += 1;
  return executeTool({ id: `toolu_${calls}`, name, input }, context(offered));
}

describe("the skill tool", () => {
  it("returns a listed skill's instructions, framed as the project's, with its folder", async () => {
    const outcome = await run("skill", { name: "migrations" });

    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain("Run drizzle-kit generate, never edit SQL.");
    expect(outcome.output).toContain(`${SKILLS}/migrations`);
    // Below the system instructions, never in place of them.
    expect(outcome.output).toMatch(/your system instructions take precedence/i);
  });

  it("records which skill was loaded, between the call and its result", async () => {
    await run("skill", { name: "migrations" });

    expect(events.map((event) => event.type)).toEqual(["tool.call", "skill.loaded", "tool.result"]);
    expect(events[1]).toMatchObject({
      type: "skill.loaded",
      payload: {
        name: "migrations",
        path: `${SKILLS}/migrations/SKILL.md`,
        allowedTools: null,
      },
    });
  });

  it("reads the skill as it is now, not as it was when the turn began", async () => {
    await put("migrations", skillFile("migrations", "Edited: use the migrate script."));

    const outcome = await run("skill", { name: "migrations" });

    expect(outcome.output).toContain("Edited: use the migrate script.");
  });

  it("finds a skill written after the turn began", async () => {
    await put("seeding", skillFile("seeding", "Seed with scripts/seed.ts."));

    const outcome = await run("skill", { name: "seeding" });

    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain("Seed with scripts/seed.ts.");
  });

  it("says which skills exist when asked for one that does not", async () => {
    const outcome = await run("skill", { name: "deploy" });

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("migrations");
    expect(events.some((event) => event.type === "skill.loaded")).toBe(false);
  });

  it("says why a skill that has become malformed cannot be loaded", async () => {
    await put("migrations", "no frontmatter at all");

    const outcome = await run("skill", { name: "migrations" });

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toMatch(/frontmatter/);
  });

  it("refuses a name that could be a path, before it reaches the sandbox", async () => {
    const outcome = await run("skill", { name: "../../etc" });

    expect(outcome.ok).toBe(false);
    expect(outcome.output).toMatch(/Invalid arguments for skill/);
  });

  it("is unavailable where nothing keeps the turn's skills", async () => {
    const outcome = await executeTool(
      { id: "toolu_x", name: "skill", input: { name: "migrations" } },
      { ...context(), skills: undefined },
    );

    expect(outcome.ok).toBe(false);
  });
});

describe("allowed-tools", () => {
  const OFFERED: readonly ToolName[] = [
    "read_file",
    "write_file",
    "search_files",
    "run_command",
    "todo_write",
    "ask_user",
    "skill",
  ];

  it("narrows the rest of the turn to what the skill lists", async () => {
    await put("review", skillFile("review", "Only look.", "allowed-tools: Read, Grep\n"));
    await manager.writeFile(sandboxId, `${PROJECT_ROOT}/a.ts`, "a");

    await run("skill", { name: "review" }, OFFERED);
    const write = await run("write_file", { path: `${PROJECT_ROOT}/b.ts`, contents: "b" }, OFFERED);
    const read = await run("read_file", { path: `${PROJECT_ROOT}/a.ts` }, OFFERED);

    expect(write.output).toMatch(/outside what the review skill allows/);
    expect(read.ok).toBe(true);
    expect(events.find((event) => event.type === "skill.loaded")?.payload).toMatchObject({
      allowedTools: ["read_file", "search_files"],
    });
  });

  it("never widens: a tool the turn was not offered stays refused, whatever the skill lists", async () => {
    // A plan mode turn, say: nothing that writes. The skill asks for writing and commands.
    const looking: ToolName[] = ["read_file", "search_files", "skill"];
    await put("builder", skillFile("builder", "Build it.", "allowed-tools: Read Write Bash\n"));

    await run("skill", { name: "builder" }, looking);
    const write = await run("write_file", { path: `${PROJECT_ROOT}/b.ts`, contents: "b" }, looking);
    const command = await run("run_command", { command: "rm -rf /" }, looking);

    expect(write.output).toMatch(/not available in this turn/);
    expect(command.output).toMatch(/not available in this turn/);
    expect(events.find((event) => event.type === "skill.loaded")?.payload).toMatchObject({
      allowedTools: ["read_file"],
    });
  });

  it("only narrows further when a second skill is loaded", async () => {
    await put("one", skillFile("one", "First.", "allowed-tools: Read Write\n"));
    await put("two", skillFile("two", "Second.", "allowed-tools: Read Bash\n"));

    await run("skill", { name: "one" }, OFFERED);
    await run("skill", { name: "two" }, OFFERED);
    const command = await run("run_command", { command: "ls" }, OFFERED);
    const write = await run("write_file", { path: `${PROJECT_ROOT}/b.ts`, contents: "b" }, OFFERED);

    expect(command.output).toMatch(/outside what the one and two skills allow/);
    expect(write.output).toMatch(/outside what the one and two skills allow/);
    const loaded = events.filter((event) => event.type === "skill.loaded");
    expect(loaded.at(-1)?.payload).toMatchObject({ allowedTools: ["read_file"] });
  });

  it("grants nothing for an entry it cannot enforce, and says so", async () => {
    await put("git", skillFile("git", "Use git.", "allowed-tools: Read, Bash(git status:*)\n"));

    const outcome = await run("skill", { name: "git" }, OFFERED);
    const command = await run("run_command", { command: "git status" }, OFFERED);

    expect(outcome.output).toContain("Bash(git status:*)");
    expect(command.output).toMatch(/outside what the git skill allows/);
  });

  it("leaves the turn able to talk to the person and to load another skill", async () => {
    await put("review", skillFile("review", "Only look.", "allowed-tools: Read\n"));

    await run("skill", { name: "review" }, OFFERED);
    const todo = await run(
      "todo_write",
      { todos: [{ content: "Look", status: "in_progress" }] },
      OFFERED,
    );
    const again = await run("skill", { name: "migrations" }, OFFERED);

    expect(todo.ok).toBe(true);
    expect(again.ok).toBe(true);
  });

  it("narrows nothing when the skill does not say", async () => {
    await manager.writeFile(sandboxId, `${PROJECT_ROOT}/a.ts`, "a");

    await run("skill", { name: "migrations" }, OFFERED);
    const read = await run("read_file", { path: `${PROJECT_ROOT}/a.ts` }, OFFERED);
    const write = await run("write_file", { path: `${PROJECT_ROOT}/a.ts`, contents: "b" }, OFFERED);

    expect(read.ok).toBe(true);
    expect(write.ok).toBe(true);
    expect(session.allows("run_command")).toBe(true);
  });
});
