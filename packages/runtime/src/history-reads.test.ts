/**
 * How often a turn reads the session's log, and that reading it less changed nothing it saw.
 *
 * The log is the largest thing a turn touches — streamed text lands in it every few hundred
 * milliseconds and a file write carries the file — and a job used to read all of it again at
 * every step: before the prompt, before each repair, when it compacted. The runtime now holds
 * one `SessionHistory` per call and asks the store only for what was appended since. These tests
 * are what stop a call site drifting back to `readFrom(sessionId, 0)`, and what prove the
 * incremental reads hand every consumer exactly the events a full read would have.
 */

import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import type { NapEvent } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { AgentService, AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { ContextEngine, ContextRequest } from "@nap/shared/ports/context-engine";
import type { EventStore, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import { expect, it } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

const SESSION = "7d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a";
const PROJECT = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const EARLIER_TURN = "0f1e2d3c-4b5a-4968-8776-655443322110";

/**
 * An agent that does just enough to need the log: it says something, compacts on the first
 * repair, and commits. Written here rather than scripted because compaction is a call *into* the
 * runtime mid-turn, which a list of events cannot make.
 */
class CompactingAgent implements AgentService {
  turns = 0;
  compactions: boolean[] = [];

  async runTurn(request: AgentTurnRequest): Promise<void> {
    const turn = this.turns++;
    const emit = (type: NapEvent["type"], payload: unknown) =>
      request.onEvent({
        type,
        payload,
        sessionId: request.sessionId,
        turnId: request.turnId,
        createdAt: "2026-01-01T00:00:00.000Z",
      } as PendingEvent);

    emit("turn.started", { source: request.promptSource ?? "user" });
    emit("agent.message", { text: `reply ${turn}` });

    if (turn === 1 && request.compactContext !== undefined) {
      const compacted = await request.compactContext({
        messages: [{ role: "user", content: "x".repeat(20_000) }],
        tools: [],
        systemPrompt: "system",
        trigger: "automatic",
        complete: async () => ({
          type: "message",
          text: "the summary",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      });
      this.compactions.push(compacted.ok);
    }

    const finalized = await request.finalize?.();
    emit("turn.completed", {
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
      commitSha: finalized?.commitSha ?? null,
    });
  }
}

it("reads the log from the start once per turn, however many repairs and compactions it runs", async () => {
  const inner = new InMemoryEventStore();

  // A session with something in it already, so "the history" is not trivially empty.
  for (const [type, payload] of [
    ["user.message", { text: "an earlier request" }],
    ["agent.message", { text: "an earlier answer" }],
  ] as const) {
    await inner.append({
      type,
      payload,
      sessionId: SESSION,
      turnId: EARLIER_TURN,
      createdAt: "2026-01-01T00:00:00.000Z",
    } as PendingEvent);
  }

  const reads: number[] = [];
  const events: EventStore = {
    append: (event, options) => inner.append(event, options),
    readFrom: (sessionId, afterSeq) => {
      reads.push(afterSeq);
      return inner.readFrom(sessionId, afterSeq);
    },
  };

  // Each build is recorded next to the whole log as it stood at that moment, read past the
  // counter, so the test can say what a full read would have handed over.
  const stub = new StubContextEngine();
  const builds: { request: ContextRequest; log: StoredEvent[] }[] = [];
  const context: ContextEngine = {
    build: async (request) => {
      builds.push({ request, log: await inner.readFrom(SESSION, 0) });
      return stub.build(request);
    },
  };

  const sandbox = scriptGit(
    new InMemorySandboxManager({
      serves: [TEMPLATE_DEV_PORT],
      seed: {
        [`${PROJECT_ROOT_PATH}/package.json`]: JSON.stringify({
          scripts: { typecheck: "tsc --noEmit" },
        }),
      },
    }),
  );
  // Red twice, then green: the prompt's turn and the first repair fail their check, the
  // second repair passes it.
  let checked = 0;
  sandbox.script(/bun run typecheck/, () => {
    checked += 1;
    return checked >= 3
      ? { exitCode: 0, stdout: "", stderr: "" }
      : { exitCode: 2, stdout: "", stderr: "src/App.tsx: error TS2304" };
  });

  const agent = new CompactingAgent();
  const outcome = await new SingleAgentRuntime({
    sessions: new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]),
    sandbox,
    context,
    agent,
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
  }).runTurn({ turnId: crypto.randomUUID(), sessionId: SESSION, message: "add a delete button" });

  expect(outcome.ok).toBe(true);
  // The shape the rest of the test depends on: three turns, and a compaction that ran.
  expect(agent.turns).toBe(3);
  expect(agent.compactions).toEqual([true]);

  // The guard. One read of the whole log; every other read starts where the last one ended.
  expect(reads.filter((afterSeq) => afterSeq === 0)).toHaveLength(1);
  // The prompt, two repairs and the compaction each needed the log.
  expect(reads.length).toBeGreaterThanOrEqual(4);
  expect(reads).toEqual([...reads].sort((a, b) => a - b));

  // And what each consumer was handed is what a full read would have produced at that moment.
  const initial = builds.filter((build) => build.request.continuation !== true);
  const rebuilt = builds.filter((build) => build.request.continuation === true);
  expect(initial).toHaveLength(3);
  expect(rebuilt).toHaveLength(1);

  for (const { request, log } of initial) {
    // The log *before* this turn's prompt was logged — the context engine appends the prompt
    // itself, so a history that already held it would send it to the model twice.
    const prompt = log.findLastIndex(
      (event) => event.type === "user.message" && event.payload.text === request.userMessage,
    );
    expect(prompt).toBeGreaterThan(0);
    expect(request.history).toStrictEqual(log.slice(0, prompt));
  }

  for (const { request, log } of rebuilt) {
    // Compaction rebuilds from the whole log as it stood, plus the checkpoint it is about to
    // write — which is not in the log yet, so it is the one element a full read lacks.
    expect(request.history.slice(0, -1)).toStrictEqual(log);
    expect(request.history.at(-1)?.type).toBe("compaction.completed");
  }
});
