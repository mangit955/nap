import { NapAgentService } from "@nap/agent/agent-service";
import { ScriptedLLMProvider, type ScriptedTurn } from "@nap/agent/testing/scripted-llm-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { TASK_SYSTEM_PROMPT } from "@nap/context/system-prompt";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { NapEvent } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { describe, expect, it } from "vitest";
import { linkWorkspaceCommand, runTaskTurn, TaskTurnResultSchema } from "./task-turn.ts";

const MODEL = "vendor/model:free";

function sandbox(): InMemorySandboxManager {
  return new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0, stdout: "" }) }).script(
    linkWorkspaceCommand(),
    { exitCode: 0, stdout: "/app" },
  );
}

/** A model that writes the answer file and stops. */
const SOLVES: ScriptedTurn = [
  {
    toolCalls: [
      {
        id: "write_1",
        name: "write_file",
        input: { path: `${PROJECT_ROOT_PATH}/regex.txt`, contents: "\\d{4}\n" },
      },
    ],
    usage: { inputTokens: 1_000, outputTokens: 50, cacheReadTokens: 400 },
  },
  { text: "Wrote the regex.", usage: { inputTokens: 1_200, outputTokens: 10 } },
];

async function run(turn: ScriptedTurn, box = sandbox(), maxSteps = 10) {
  const provider = new ScriptedLLMProvider([turn]);
  const events: NapEvent[] = [];
  let now = 1_000;
  const result = await runTaskTurn({
    sandbox: box,
    context: new NapContextEngine(),
    memory: new NoopMemoryProvider(),
    provider,
    agentFor: (counted) => new NapAgentService({ provider: counted, budget: { maxSteps } }),
    instruction: "Save your regex in /app/regex.txt",
    model: MODEL,
    onEvent: (event) => events.push(event),
    clock: () => (now += 500),
  });
  return { result, events, provider, box };
}

describe("runTaskTurn", () => {
  it("runs the agent's tools in the task's machine and reports Nap's own count", async () => {
    const { result, events, provider, box } = await run(SOLVES);

    expect(result.status).toBe("completed");
    expect(result.failure).toBeNull();
    expect(result.workdir).toBe("/app");
    // One request per model call, counted at the provider, and the usage it reported summed.
    expect(result.requests).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 2_200, outputTokens: 60, cacheReadTokens: 400 });
    expect(TaskTurnResultSchema.parse(result)).toEqual(result);

    const listed = await box.list();
    const id = listed.ok ? (listed.value[0]?.id ?? "") : "";
    expect((await box.readFile(id, `${PROJECT_ROOT_PATH}/regex.txt`)).ok).toBe(true);
    expect(box.commands(id)[0]).toBe(linkWorkspaceCommand());

    // The task's prompt, and nothing a Nap project turn would add.
    expect(provider.requests[0]?.systemPrompt).toContain(TASK_SYSTEM_PROMPT);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["user.message", "turn.started", "tool.call", "turn.completed"]),
    );
    expect(events[0]?.type).toBe("user.message");
    expect(events.at(-1)?.type).toBe("turn.completed");
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.some((event) => event.type.startsWith("verification."))).toBe(false);
    expect(events.some((event) => event.type.startsWith("preview."))).toBe(false);
  });

  it("counts every request of a turn that runs out of steps, and says why it stopped", async () => {
    const looping: ScriptedTurn = Array.from({ length: 4 }, (_, index) => ({
      toolCalls: [{ id: `ls_${index}`, name: "list_files", input: { path: PROJECT_ROOT_PATH } }],
      usage: { inputTokens: 100, outputTokens: 5 },
    }));
    const { result } = await run(looping, sandbox(), 3);

    expect(result.status).toBe("failed");
    expect(result.failure?.reason).toBe("budget_exceeded");
    expect(result.requests).toBe(3);
    // A failed turn carries no usage on its event; the count at the provider still has it.
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 15 });
  });

  it("refuses a machine whose working directory is the filesystem root, before any request", async () => {
    const box = new InMemorySandboxManager().script(linkWorkspaceCommand(), {
      exitCode: 1,
      stderr: "the task's working directory is /, which is not a project",
    });
    const { result, provider } = await run(SOLVES, box);

    expect(result.status).toBe("failed");
    expect(result.failure).toEqual({
      reason: "sandbox_unavailable",
      message: "the task's working directory is /, which is not a project",
    });
    expect(result.requests).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });
});
