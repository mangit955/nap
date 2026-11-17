import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { describe, expect, it } from "vitest";
import { judge, NapReviewer } from "./reviewer.ts";
import { ScriptedLLMProvider, type ScriptedTurn } from "./testing/scripted-llm-provider.ts";
import { PROJECT_ROOT } from "./tools/definitions.ts";

async function review(turns: ScriptedTurn[], maxSteps?: number) {
  const sandbox = new InMemorySandboxManager({
    defaultExec: () => ({
      exitCode: 1,
      stdout: "FAILED test_parse - expected 3, got 2\n",
      stderr: "",
    }),
  });
  const created = await sandbox.create("p");
  if (!created.ok) throw new Error(created.error.message);
  await sandbox.writeFile(created.value.id, `${PROJECT_ROOT}/a.py`, "x = 2\n");
  const provider = new ScriptedLLMProvider(turns);
  const reviewer = new NapReviewer({
    provider,
    prompts: { system: "review", task: (request) => `Review: ${request.objective}` },
    ...(maxSteps === undefined ? {} : { maxSteps }),
  });
  const result = await reviewer.review({
    sandbox,
    sandboxId: created.value.id,
    objective: "Make parse return 3.",
    changedFiles: ["a.py"],
  });
  return { result, sandbox, sandboxId: created.value.id, provider };
}

const RUN = { id: "c1", name: "run_command", input: { command: "pytest -q" } };
const report = (body: unknown) => ({ text: `\`\`\`json\n${JSON.stringify(body)}\n\`\`\`` });

describe("NapReviewer", () => {
  it("blocks on a problem shown by a command it ran, quoting what that command printed", async () => {
    const { result } = await review([
      [
        { toolCalls: [RUN], usage: { inputTokens: 100, outputTokens: 10 } },
        {
          ...report({
            problems: [
              { summary: "parse returns 2", command: "pytest -q", observed: "expected 3, got 2" },
            ],
            notes: ["naming is fine"],
          }),
          usage: { inputTokens: 200, outputTokens: 20 },
        },
      ],
    ]);
    expect(result.status).toBe("completed");
    expect(result.blocking).toEqual([
      { summary: "parse returns 2", command: "pytest -q", observed: "expected 3, got 2" },
    ]);
    expect(result.notes.map((note) => note.summary)).toEqual(["naming is fine"]);
    expect(result.steps).toBe(2);
    expect(result.usage).toMatchObject({ inputTokens: 300, outputTokens: 30 });
  });

  it("does not block on a problem citing a command it never ran", async () => {
    const { result } = await review([
      [
        report({
          problems: [
            { summary: "tests fail", command: "pytest -q", observed: "expected 3, got 2" },
          ],
        }),
      ],
    ]);
    expect(result.blocking).toEqual([]);
    expect(result.notes.map((note) => note.summary)).toEqual(["tests fail"]);
  });

  it("does not block on a quote its command did not print", async () => {
    const { result } = await review([
      [
        { toolCalls: [RUN] },
        report({
          problems: [{ summary: "crashes", command: "pytest -q", observed: "Segmentation fault" }],
        }),
      ],
    ]);
    expect(result.blocking).toEqual([]);
  });

  it("does not block on a command the guard refused, whatever it quotes", async () => {
    const refused = { id: "c1", name: "run_command", input: { command: "apt-get install foo" } };
    const { result, sandbox, sandboxId } = await review([
      [
        { toolCalls: [refused] },
        report({
          problems: [{ summary: "x", command: "apt-get install foo", observed: "apt-get" }],
        }),
      ],
    ]);
    expect(sandbox.commands(sandboxId)).toEqual([]);
    expect(result.blocking).toEqual([]);
  });

  it("is not offered a tool that writes, and a write it asks for changes nothing", async () => {
    const write = {
      id: "w1",
      name: "write_file",
      input: { path: `${PROJECT_ROOT}/a.py`, contents: "x = 3\n" },
    };
    const { result, sandbox, sandboxId, provider } = await review([
      [{ toolCalls: [write] }, report({ problems: [], notes: [] })],
    ]);
    const offered = provider.requests[0]?.tools.map((tool) => tool.name).sort();
    expect(offered).toEqual(["glob", "list_files", "read_file", "run_command", "search_files"]);
    const file = await sandbox.readFile(sandboxId, `${PROJECT_ROOT}/a.py`);
    expect(file.ok && file.value).toBe("x = 2\n");
    expect(result).toMatchObject({ status: "completed", blocking: [], notes: [] });
  });

  it("blocks nothing when it runs out of steps, and says so", async () => {
    const { result, provider } = await review(
      [[{ toolCalls: [RUN] }, { toolCalls: [{ ...RUN, id: "c2" }] }]],
      2,
    );
    expect(result).toMatchObject({ status: "failed", blocking: [], steps: 2 });
    expect(result.failure).toMatch(/steps/);
    const last = provider.requests[1]?.messages.at(-1);
    expect(JSON.stringify(last)).toContain("last request");
  });

  it("blocks nothing when the model errors", async () => {
    const { result } = await review([[{ error: { message: "upstream", retryable: false } }]]);
    expect(result).toMatchObject({ status: "failed", blocking: [], failure: "upstream" });
  });
});

describe("judge", () => {
  const ran = new Map([["make test", ["exit code 2\nError: missing /app/out.txt\n"]]]);

  it("accepts a quote whose whitespace differs from the output", () => {
    const verdict = judge(
      JSON.stringify({
        problems: [
          { summary: "s", command: "make test", observed: "Error:   missing\n/app/out.txt" },
        ],
      }),
      ran,
    );
    expect(verdict.blocking).toHaveLength(1);
  });

  it("rejects a quote too short to prove anything", () => {
    const verdict = judge(
      JSON.stringify({ problems: [{ summary: "s", command: "make test", observed: "2" }] }),
      ran,
    );
    expect(verdict.blocking).toEqual([]);
  });

  it("keeps an unreadable report as a note that blocks nothing", () => {
    const verdict = judge("Looks broken to me.", ran);
    expect(verdict).toMatchObject({ status: "completed", blocking: [] });
    expect(verdict.notes[0]?.summary).toBe("Looks broken to me.");
    expect(verdict.failure).toMatch(/could not be read/);
  });

  it("reads a bare JSON object after prose", () => {
    const verdict = judge(
      `Done.\n{"problems":[{"summary":"s","command":"make test","observed":"missing /app/out.txt"}]}`,
      ran,
    );
    expect(verdict.blocking).toHaveLength(1);
  });
});
