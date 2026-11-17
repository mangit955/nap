import { NapAgentService } from "@nap/agent/agent-service";
import { NapReviewer } from "@nap/agent/reviewer";
import { ScriptedLLMProvider, type ScriptedTurn } from "@nap/agent/testing/scripted-llm-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { REVIEW_PROMPT } from "@nap/context/review-prompt";
import { TASK_SYSTEM_PROMPT } from "@nap/context/system-prompt";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { NapEvent } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { LLMProvider } from "@nap/shared/ports/llm-provider";
import { MAX_REVIEW_ROUNDS } from "@nap/shared/ports/reviewer";
import { describe, expect, it } from "vitest";
import { linkWorkspaceCommand, runTaskTurn, TaskTurnResultSchema } from "./task-turn.ts";

const MODEL = "vendor/model:free";

function isTurns(turn: ScriptedTurn | ScriptedTurn[]): turn is ScriptedTurn[] {
  return Array.isArray(turn[0]);
}

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
  turn: ScriptedTurn | ScriptedTurn[],
  box = sandbox(),
  maxSteps = 10,
  extra: { signal?: AbortSignal; onComplete?: () => void; review?: boolean } = {},
) {
  // One script per `startTurn`: the agent's round, then the review's, then the next round's.
  const provider = new ScriptedLLMProvider(isTurns(turn) ? turn : [turn]);
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
    agentFor: (metered, steps) =>
      new NapAgentService({ provider: metered, budget: { maxSteps: steps } }),
    maxSteps,
    ...(extra.review === true
      ? {
          reviewerFor: (metered: LLMProvider) =>
            new NapReviewer({ provider: metered, systemPrompt: REVIEW_PROMPT }),
        }
      : {}),
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

/** A review that runs the test and reports what it proved, or nothing. */
function reviewing(problem: boolean): ScriptedTurn {
  return [
    {
      toolCalls: [{ id: "rc_1", name: "run_command", input: { command: "cat regex.txt" } }],
      usage: { inputTokens: 500, outputTokens: 20 },
    },
    {
      text: JSON.stringify({
        problems: problem
          ? [{ summary: "matches years only", command: "cat regex.txt", observed: "exit code 0" }]
          : [],
        notes: [],
      }),
      usage: { inputTokens: 600, outputTokens: 30 },
    },
  ];
}

const FIXES: ScriptedTurn = [{ text: "Fixed it.", usage: { inputTokens: 1_500, outputTokens: 5 } }];

describe("runTaskTurn with the reviewer", () => {
  it("writes no reviews without one, so a baseline result reads as it did", async () => {
    const { result } = await run(SOLVES);
    expect(result).not.toHaveProperty("reviews");
  });

  it("reviews a claim of done, and keeps the reviewer's steps out of the agent's", async () => {
    const { result } = await run([SOLVES, reviewing(false)], sandbox(), 10, { review: true });
    expect(result.status).toBe("completed");
    expect(result.steps).toBe(2);
    expect(result.reviews).toEqual([
      expect.objectContaining({ status: "completed", blocking: 0, steps: 2, sentBack: false }),
    ]);
    // Every token is counted: the agent's 2,200 input and the review's 1,100.
    expect(result.usage.inputTokens).toBe(3_300);
  });

  it("sends the agent back on a proved problem, with the steps the first round left", async () => {
    const { result, events, provider } = await run([SOLVES, reviewing(true), FIXES], sandbox(), 3, {
      review: true,
    });
    expect(result.status).toBe("completed");
    // Two steps in the first round, one in the fix: never more than the task's three.
    expect(result.steps).toBe(3);
    expect(result.reviews?.map((review) => review.sentBack)).toEqual([true]);
    const prompts = events.filter((event) => event.type === "user.message");
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1])).toContain("A reviewer checked your work");
    // The fix round carries the first round's conversation, as a repair turn does. It is the
    // last request: with the task's steps spent, nothing is left for a second review to send back.
    const fix = provider.requests.at(-1);
    expect(JSON.stringify(fix?.messages)).toContain("Wrote the regex.");
  });

  it("never lets a fix round take the task past the steps it was given", async () => {
    const read = { id: "r", name: "read_file", input: { path: `${PROJECT_ROOT_PATH}/regex.txt` } };
    const slowFix: ScriptedTurn = [
      { toolCalls: [{ ...read, id: "r1" }] },
      { toolCalls: [{ ...read, id: "r2" }] },
      { text: "Fixed it." },
    ];
    const { result } = await run([SOLVES, reviewing(true), slowFix], sandbox(), 3, {
      review: true,
    });
    expect(result.steps).toBe(3);
    expect(result).toMatchObject({ status: "failed", failure: { reason: "budget_exceeded" } });
  });

  it("does not review a turn that ran out of steps, which claimed nothing", async () => {
    const { result } = await run([SOLVES, reviewing(true)], sandbox(), 1, { review: true });
    expect(result.status).toBe("failed");
    expect(result.reviews).toEqual([]);
  });

  it("does not review a claim no step is left to fix", async () => {
    const { result } = await run([SOLVES, reviewing(true)], sandbox(), 2, { review: true });
    expect(result.status).toBe("completed");
    expect(result.reviews).toEqual([]);
  });

  it(`reviews at most ${MAX_REVIEW_ROUNDS} times`, async () => {
    const { result } = await run(
      [SOLVES, reviewing(true), FIXES, reviewing(true), FIXES, reviewing(true)],
      sandbox(),
      10,
      { review: true },
    );
    expect(result.reviews).toHaveLength(MAX_REVIEW_ROUNDS);
    expect(result.steps).toBe(2 + MAX_REVIEW_ROUNDS);
    expect(TaskTurnResultSchema.parse(result)).toEqual(result);
  });
});
