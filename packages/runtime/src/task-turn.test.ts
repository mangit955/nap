import { NapAgentService } from "@nap/agent/agent-service";
import { ScriptedLLMProvider, type ScriptedTurn } from "@nap/agent/testing/scripted-llm-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { TASK_SYSTEM_PROMPT } from "@nap/context/system-prompt";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { NapEvent } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { LLMProvider } from "@nap/shared/ports/llm-provider";
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

async function run(
  turn: ScriptedTurn,
  box = sandbox(),
  maxSteps = 10,
  extra: { signal?: AbortSignal; onComplete?: () => void } = {},
) {
  const provider = new ScriptedLLMProvider([turn]);
  // What the client below the provider would count: here, one HTTP request per model call plus
  // one retry on the first, so the result is seen to report this number and not the steps.
  let http = 0;
  const counted: LLMProvider = {
    startTurn: (options) => {
      const inner = provider.startTurn(options);
      return {
        ...inner,
        usage: () => inner.usage(),
        complete: (request) => {
          http += http === 0 ? 2 : 1;
          extra.onComplete?.();
          return inner.complete(request);
        },
      };
    },
  };
  const events: NapEvent[] = [];
  let now = 1_000;
  const result = await runTaskTurn({
    sandbox: box,
    context: new NapContextEngine(),
    memory: new NoopMemoryProvider(),
    provider: counted,
    agentFor: (metered) => new NapAgentService({ provider: metered, budget: { maxSteps } }),
    requests: () => http,
    ...(extra.signal === undefined ? {} : { signal: extra.signal }),
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
    // Model calls counted at the provider, HTTP requests from the client's own count, and the
    // usage the provider reported summed.
    expect(result.steps).toBe(2);
    expect(result.requests).toBe(3);
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
    expect(result.steps).toBe(3);
    expect(result.requests).toBe(4);
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
    expect(result.steps).toBe(0);
    expect(provider.requests).toHaveLength(0);
  });

  it("stops when its signal fires, and still reports what it spent", async () => {
    // What the entrypoint does when Harbor closes the channel: a turn nobody can answer for must
    // not keep calling the model.
    const controller = new AbortController();
    const looping: ScriptedTurn = Array.from({ length: 5 }, (_, index) => ({
      toolCalls: [{ id: `ls_${index}`, name: "list_files", input: { path: PROJECT_ROOT_PATH } }],
      usage: { inputTokens: 100, outputTokens: 5 },
    }));
    const { result } = await run(looping, sandbox(), 10, {
      signal: controller.signal,
      onComplete: () => controller.abort(),
    });

    expect(result.status).toBe("failed");
    expect(result.failure?.reason).toBe("cancelled");
    expect(result.steps).toBe(1);
    expect(TaskTurnResultSchema.parse(result)).toEqual(result);
  });
});
