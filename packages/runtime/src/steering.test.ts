/**
 * Steering through the whole composition: a real agent, a real context engine and the runtime, a
 * scripted model, and a queue holding a real lease (ADR-0027).
 *
 * What is asserted is what the person relies on: a message sent mid-turn is recorded at the step
 * where the agent read it, durably, before the model that reads it is called; a message the turn
 * never read becomes the next turn, or is handed back if the turn was stopped; and none is read
 * twice. Never asserted: anything a model said.
 */

import { NapAgentService } from "@nap/agent/agent-service";
import type { TurnBudgetOptions } from "@nap/agent/safety/budget";
import { ScriptedLLMProvider, type ScriptedTurn } from "@nap/agent/testing/scripted-llm-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { renderSteer } from "@nap/context/steer";
import { expectEventSequence } from "@nap/db/testing/event-assertions";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import { NapEventSchema } from "@nap/shared/events";
import type { LLMMessage, LLMProvider, LLMRequest } from "@nap/shared/ports/llm-provider";
import type { RequestSteering } from "@nap/shared/ports/steer-queue";
import { TurnAbortError } from "@nap/shared/turn-abort";
import { beforeEach, describe, expect, it } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const USER_ID = "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a";
const OWNER = "worker-a";

let sandbox: InMemorySandboxManager;
let events: InMemoryEventStore;
let sessions: InMemorySessionStore;
let queue: InMemoryTurnQueue;

beforeEach(() => {
  sandbox = scriptGit(new InMemorySandboxManager());
  events = new InMemoryEventStore();
  sessions = new InMemorySessionStore([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]);
  queue = new InMemoryTurnQueue();
});

/**
 * The runtime on a scripted model. `beforeCall` runs as each model call begins, with the log as it
 * stands — which is how a test both sends a steer mid-turn and sees what was durable by then.
 */
function subject(
  turns: ScriptedTurn[],
  beforeCall: (call: number) => Promise<void> = async () => {},
  budget?: TurnBudgetOptions,
) {
  const scripted = new ScriptedLLMProvider(turns);
  let calls = 0;
  const provider: LLMProvider = {
    startTurn: (options) => {
      const turn = scripted.startTurn(options);
      return {
        ...turn,
        usage: () => turn.usage(),
        complete: async (request: LLMRequest) => {
          calls += 1;
          await beforeCall(calls);
          return await turn.complete(request);
        },
      };
    },
  };
  const runtime = new SingleAgentRuntime({
    sessions,
    sandbox,
    context: new NapContextEngine(),
    agent: new NapAgentService({ provider, ...(budget === undefined ? {} : { budget }) }),
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
  });
  return { runtime, scripted };
}

/** Each message as its role and its words, which is what the model was told and in what order. */
function said(messages: readonly LLMMessage[]): [string, string][] {
  return messages.map((message) => [
    message.role,
    typeof message.content === "string"
      ? message.content
      : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
  ]);
}

/** A request on the queue, leased the way a worker holds one, and its steering bound to the lease. */
async function leased(
  message = "build a notes app",
): Promise<{ id: string; steering: RequestSteering }> {
  const id = crypto.randomUUID();
  await queue.enqueue({
    id,
    sessionId: SESSION_ID,
    userId: USER_ID,
    kind: "turn",
    message,
    model: "openai/gpt-5-mini",
    billsToUser: false,
  });
  await queue.claim(OWNER);
  return {
    id,
    steering: {
      take: () => queue.take(id, OWNER),
      close: (disposition) => queue.close(id, OWNER, disposition),
    },
  };
}

function send(text: string): Promise<unknown> {
  return queue.steer({
    id: crypto.randomUUID(),
    sessionId: SESSION_ID,
    userId: USER_ID,
    message: text,
    model: "openai/gpt-5-mini",
    billsToUser: false,
  });
}

const reading: ScriptedTurn = [
  { toolCalls: [{ id: "list", name: "list_files", input: { path: "/home/user/app" } }] },
  { text: "Done." },
];

describe("a steer sent while a turn runs", () => {
  it("is recorded where the agent read it, durably, before the model that reads it is called", async () => {
    let durableAtSecondCall: string[] = [];
    const { runtime, scripted } = subject([reading], async (call) => {
      if (call === 1) await send("Use Postgres instead");
      if (call === 2)
        durableAtSecondCall = (await events.readFrom(SESSION_ID, 0)).map((event) => event.type);
    });
    const { id, steering } = await leased();
    // A store slower than the turn, so "durable before the call" is only true if it was waited for.
    const append = events.append.bind(events);
    events.append = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await append(...args);
    };

    const outcome = await runtime.runTurn({
      turnId: id,
      sessionId: SESSION_ID,
      message: "build a notes app",
      steering,
    });

    expect(outcome.ok).toBe(true);
    expect(durableAtSecondCall).toContain("steer.applied");
    const log = await events.readFrom(SESSION_ID, 0);
    const turn = log.filter((event) => event.type !== "context.usage" && event.turnId === id);
    expectEventSequence(turn, [
      "user.message",
      "job.started",
      "turn.started",
      "tool.call",
      "tool.result",
      "steer.applied",
      "agent.message",
      "turn.completed",
      "verification.started",
      "job.completed",
    ]);
    const applied = log.find((event) => event.type === "steer.applied");
    expect(applied?.payload).toMatchObject({ text: "Use Postgres instead" });
    // Read once: nothing left waiting, and the model saw it once.
    expect(await queue.take(id, OWNER)).toEqual([]);
    const second = scripted.requests[1]?.messages ?? [];
    const said = JSON.stringify(second).split(
      JSON.stringify(renderSteer("Use Postgres instead")).slice(1, -1),
    );
    expect(said).toHaveLength(2);
    for (const event of log) expect(NapEventSchema.safeParse(event).success).toBe(true);
  });

  it("becomes the next turn when the turn ends without reading it, and is not dropped", async () => {
    // One step, spent on the one call: whatever arrives during it has no step left to be read in.
    const { runtime } = subject([[{ text: "Done." }]], async () => {}, { maxSteps: 1 });
    const { id, steering } = await leased();
    await send("and add tags");

    const outcome = await runtime.runTurn({
      turnId: id,
      sessionId: SESSION_ID,
      message: "build a notes app",
      steering: {
        // Read at the first step; the next is sent while the only model call runs.
        take: async () => {
          const taken = await steering.take();
          await send("and a footer");
          return taken;
        },
        close: steering.close,
      },
    });

    expect(outcome.ok).toBe(true);
    const log = await events.readFrom(SESSION_ID, 0);
    expect(log.filter((event) => event.type === "steer.dropped")).toEqual([]);
    const states = await queue.steersOf(id);
    expect(states.map((steer) => [steer.text, steer.state])).toEqual([
      ["and add tags", "applied"],
      ["and a footer", "deferred"],
    ]);
    // Queued under its own id, waiting for this request's lease to go back.
    const deferred = states[1];
    expect(
      await queue.getStatus({ id: deferred?.id ?? "", sessionId: SESSION_ID, userId: USER_ID }),
    ).toEqual({ id: deferred?.id, state: "queued" });
  });

  it("is handed back, and queues nothing, when the turn is stopped before reading it", async () => {
    const controller = new AbortController();
    const { runtime } = subject([reading], async (call) => {
      if (call === 1) {
        await send("never mind, use SQLite");
        controller.abort();
      }
    });
    const { id, steering } = await leased();

    const outcome = await runtime.runTurn({
      turnId: id,
      sessionId: SESSION_ID,
      message: "build a notes app",
      steering,
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({ ok: false, reason: "cancelled" });
    const log = await events.readFrom(SESSION_ID, 0);
    const dropped = log.filter((event) => event.type === "steer.dropped");
    expect(dropped.map((event) => event.payload)).toEqual([
      expect.objectContaining({ text: "never mind, use SQLite", reason: "stopped" }),
    ]);
    // After the turn's own end, under the request it was sent to.
    expect(dropped[0]?.turnId).toBe(id);
    expect(log.findIndex((event) => event.type === "turn.failed")).toBeLessThan(
      log.findIndex((event) => event.type === "steer.dropped"),
    );
    expect(queue.inFlight).toBe(1);
  });

  it("says the turn was interrupted, not stopped, when its worker gave it up", async () => {
    // A drain that ran out of time, or a lease that went away: nobody pressed Stop, and the pane
    // must not say they did.
    for (const code of ["shutdown", "lease_lost"] as const) {
      events = new InMemoryEventStore();
      const controller = new AbortController();
      const { runtime } = subject([reading], async (call) => {
        if (call === 1) {
          await send("use SQLite");
          controller.abort(new TurnAbortError(code));
        }
      });
      const { id, steering } = await leased();

      await runtime.runTurn({
        turnId: id,
        sessionId: SESSION_ID,
        message: "build a notes app",
        steering,
        signal: controller.signal,
      });

      const log = await events.readFrom(SESSION_ID, 0);
      expect(
        log.filter((event) => event.type === "steer.dropped").map((event) => event.payload),
      ).toEqual([expect.objectContaining({ text: "use SQLite", reason: "interrupted" })]);
      await queue.settle(id, OWNER, "failed");
    }
  });

  it("hands a steer back when the Stop reached the queue before it reached the worker", async () => {
    // The worker has not yet heard of the Stop, so the turn runs to its end and asks to defer. The
    // queue knows better, and the words must not run as a turn the person already stopped.
    const { runtime } = subject([reading], async (call) => {
      if (call === 1) {
        await send("never mind");
        await queue.requestCancel(SESSION_ID);
      }
    });
    const { id, steering } = await leased();

    await runtime.runTurn({ turnId: id, sessionId: SESSION_ID, message: "hi", steering });

    const log = await events.readFrom(SESSION_ID, 0);
    expect(log.filter((event) => event.type === "steer.applied")).toEqual([]);
    expect(
      log.filter((event) => event.type === "steer.dropped").map((event) => event.payload),
    ).toEqual([expect.objectContaining({ text: "never mind", reason: "stopped" })]);
    expect(queue.inFlight).toBe(1);
  });

  it("keeps a turn going when it arrives as the model finishes, and replays it where it was read", async () => {
    // The model replies with nothing left to do; the steer was sent while it wrote that. The
    // turn answers it rather than ending, and the next turn's context — rebuilt from the log —
    // has to hold it where this turn's model saw it: after that reply, before the answer to it.
    const first = subject(
      [[{ text: "Done." }, { text: "Switched to Postgres." }]],
      async (call) => {
        if (call === 1) await send("Use Postgres instead");
      },
    );
    const { id, steering } = await leased();

    const outcome = await first.runtime.runTurn({
      turnId: id,
      sessionId: SESSION_ID,
      message: "build a notes app",
      steering,
    });

    expect(outcome.ok).toBe(true);
    const steer = renderSteer("Use Postgres instead");
    const seen = said(first.scripted.requests[1]?.messages ?? []);
    expect(seen.slice(-2)).toEqual([
      ["assistant", "Done."],
      ["user", steer],
    ]);
    const log = await events.readFrom(SESSION_ID, 0);
    expect(log.filter((event) => event.turnId === id).map((event) => event.type)).not.toContain(
      "steer.dropped",
    );

    await queue.settle(id, OWNER, "done");
    const next = subject([[{ text: "Added." }]]);
    const later = await leased("add tags");
    await next.runtime.runTurn({
      turnId: later.id,
      sessionId: SESSION_ID,
      message: "add tags",
      steering: later.steering,
    });

    const replayed = said(next.scripted.requests[0]?.messages ?? []);
    const at = replayed.findIndex(([, text]) => text === steer);
    expect(replayed.slice(at - 1, at + 2)).toEqual([
      ["assistant", "Done."],
      ["user", steer],
      ["assistant", "Switched to Postgres."],
    ]);
  });

  it("closes a finished request to steers, so a later message is the next turn", async () => {
    const { runtime } = subject([[{ text: "Done." }]]);
    const { id, steering } = await leased();

    await runtime.runTurn({ turnId: id, sessionId: SESSION_ID, message: "hi", steering });

    await expect(send("after it ended")).resolves.toEqual({ as: "turn" });
  });
});
