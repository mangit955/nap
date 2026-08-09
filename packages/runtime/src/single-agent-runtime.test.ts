/**
 * What a turn did to the world, asserted through the log it left and the commands it ran.
 *
 * Two of these are the assertions docs/PLAN.md §4 calls the most valuable in the codebase.
 * **Append before publish**: a client handed an event that was never written is shown
 * history that does not exist, and once both calls have finished the order between them is
 * invisible — so it is recorded as it happens, by a spy wrapping both. **Zero commits on a
 * failed turn**: a failed turn must leave the workspace at the last good commit, and the
 * only honest way to check that is to count the commit commands that reached the sandbox.
 *
 * Nothing here asserts on model prose (docs/PLAN.md §3).
 */

import { NapAgentService } from "@nap/agent/agent-service";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { expectEventSequence } from "@nap/db/testing/event-assertions";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { NapEventSchema, type NapEventType } from "@nap/shared/events";
import type { AgentService, AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { ContextEngine, ContextRequest } from "@nap/shared/ports/context-engine";
import type { EventStore, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { commitMessage, SingleAgentRuntime } from "./single-agent-runtime.ts";

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const COMMIT_SHA = "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1";

/** Every command `commitAll` issues, answered so a turn can commit without a real git. */
function scriptGit(manager: InMemorySandboxManager, dirty = true): InMemorySandboxManager {
  return (
    manager
      .script(/git add -A/, { exitCode: 0 })
      // Non-zero means the index differs from HEAD, which is what makes a commit happen.
      .script(/git diff --cached --quiet/, { exitCode: dirty ? 1 : 0 })
      .script(/git .*commit -m/, { exitCode: 0 })
      .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${COMMIT_SHA}\n` })
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function commitCommands(manager: InMemorySandboxManager, sandboxId: string): string[] {
  return manager.commands(sandboxId).filter((command) => /git .*commit -m/.test(command));
}

/**
 * An `AgentService` that emits a scripted list of events instead of driving a model.
 *
 * The runtime's job is what happens *around* the agent — acquiring a sandbox, persisting,
 * publishing, committing — so the agent is scripted here for the same reason the model is
 * scripted a layer below: a test that also has to make a model behave is asserting on two
 * things at once.
 */
class ScriptedAgent implements AgentService {
  calls = 0;
  requests: AgentTurnRequest[] = [];
  /** Runs before the scripted events, so a test can drive concurrency or throw. */
  before?: (request: AgentTurnRequest) => Promise<void>;

  constructor(
    private readonly script: (
      request: AgentTurnRequest,
    ) => { type: NapEventType; payload: unknown }[] = () => [{ type: "turn.started", payload: {} }],
    private readonly finalizes = false,
  ) {}

  async runTurn(request: AgentTurnRequest): Promise<void> {
    this.calls += 1;
    this.requests.push(request);
    await this.before?.(request);

    for (const event of this.script(request)) {
      if (event.type === "turn.completed" && this.finalizes) {
        const finalized = await request.finalize?.();
        request.onEvent({
          type: "turn.completed",
          sessionId: request.sessionId,
          turnId: request.turnId,
          createdAt: "2026-01-01T00:00:00.000Z",
          payload: {
            usage: { inputTokens: 1, outputTokens: 2 },
            durationMs: 5,
            commitSha: finalized?.commitSha ?? null,
          },
        });
        continue;
      }
      request.onEvent({
        ...event,
        sessionId: request.sessionId,
        turnId: request.turnId,
        createdAt: "2026-01-01T00:00:00.000Z",
      } as PendingEvent);
    }
  }
}

/** A sandbox manager that cannot hand out sandboxes, for the acquisition-failure path. */
class UncreatableSandboxManager extends InMemorySandboxManager {
  override async create(): Promise<{ ok: false; error: { code: "unavailable"; message: string } }> {
    return { ok: false, error: { code: "unavailable", message: "no capacity" } };
  }
}

/** A well-behaved turn: opens, says something, completes with whatever `finalize` returned. */
const HAPPY_SCRIPT = () => [
  { type: "turn.started" as const, payload: {} },
  { type: "agent.message" as const, payload: { text: "done" } },
  { type: "turn.completed" as const, payload: {} },
];

class StubContextEngine implements ContextEngine {
  requests: ContextRequest[] = [];

  async build(request: ContextRequest) {
    this.requests.push(request);
    return {
      systemPrompt: "system",
      messages: [{ role: "user" as const, content: request.userMessage }],
      estimatedTokens: 3,
    };
  }
}

/** Records `("append"|"publish", type)` as it happens, because order is invisible after. */
class OrderRecorder {
  readonly calls: [string, NapEventType][] = [];

  wrap(store: EventStore, bus: InMemoryEventBus): { store: EventStore; bus: InMemoryEventBus } {
    const recorder = this;
    const wrappedStore: EventStore = {
      async append(event: PendingEvent) {
        const stored = await store.append(event);
        recorder.calls.push(["append", stored.type]);
        return stored;
      },
      readFrom: (sessionId, afterSeq) => store.readFrom(sessionId, afterSeq),
    };

    bus.subscribe(SESSION_ID, (event) => recorder.calls.push(["publish", event.type]));
    return { store: wrappedStore, bus };
  }
}

let sandbox: InMemorySandboxManager;
let events: InMemoryEventStore;
let bus: InMemoryEventBus;
let sessions: InMemorySessionStore;
let context: StubContextEngine;

beforeEach(() => {
  sandbox = scriptGit(new InMemorySandboxManager());
  events = new InMemoryEventStore();
  bus = new InMemoryEventBus();
  sessions = new InMemorySessionStore([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]);
  context = new StubContextEngine();
});

function runtime(
  agent: AgentService,
  overrides: Partial<{
    events: EventStore;
    sandbox: SandboxManager;
    sessions: InMemorySessionStore;
    objects: ObjectStore;
    snapshots: SnapshotStore;
  }> = {},
): SingleAgentRuntime {
  return new SingleAgentRuntime({
    sessions: overrides.sessions ?? sessions,
    sandbox: overrides.sandbox ?? sandbox,
    context,
    agent,
    events: overrides.events ?? events,
    bus,
    memory: new NoopMemoryProvider(),
    ...(overrides.objects === undefined ? {} : { objects: overrides.objects }),
    ...(overrides.snapshots === undefined ? {} : { snapshots: overrides.snapshots }),
  });
}

async function loggedTypes(): Promise<NapEventType[]> {
  const stored = await events.readFrom(SESSION_ID, 0);
  return stored.map((event) => event.type);
}

async function onlySandboxId(): Promise<string> {
  const record = await sessions.get(SESSION_ID);
  if (record?.sandboxId == null) throw new Error("expected a sandbox to have been recorded");
  return record.sandboxId;
}

describe("SingleAgentRuntime", () => {
  it("appends every event before it publishes it", async () => {
    const recorder = new OrderRecorder();
    const wrapped = recorder.wrap(events, bus);
    const agent = new ScriptedAgent(HAPPY_SCRIPT, true);

    await new SingleAgentRuntime({
      sessions,
      sandbox,
      context,
      agent,
      events: wrapped.store,
      bus: wrapped.bus,
      memory: new NoopMemoryProvider(),
    }).runTurn({ sessionId: SESSION_ID, message: "add a dark mode toggle" });

    // Alternating, one pair per event, append first — anything else is a client seeing
    // history that was not written.
    expect(recorder.calls.length).toBeGreaterThan(0);
    expect(recorder.calls.length % 2).toBe(0);
    for (let i = 0; i < recorder.calls.length; i += 2) {
      expect(recorder.calls[i]?.[0]).toBe("append");
      expect(recorder.calls[i + 1]?.[0]).toBe("publish");
      expect(recorder.calls[i]?.[1]).toBe(recorder.calls[i + 1]?.[1]);
    }
  });

  it("assigns seq monotonically with no gaps", async () => {
    await runtime(new ScriptedAgent(HAPPY_SCRIPT, true)).runTurn({
      sessionId: SESSION_ID,
      message: "first",
    });
    await runtime(new ScriptedAgent(HAPPY_SCRIPT, true)).runTurn({
      sessionId: SESSION_ID,
      message: "second",
    });

    const stored = await events.readFrom(SESSION_ID, 0);
    expect(stored.map((event) => event.seq)).toEqual(
      Array.from({ length: stored.length }, (_, i) => i + 1),
    );
  });

  it("logs the user's message before the turn opens", async () => {
    await runtime(new ScriptedAgent(HAPPY_SCRIPT, true)).runTurn({
      sessionId: SESSION_ID,
      message: "add a dark mode toggle",
    });

    expectEventSequence(await events.readFrom(SESSION_ID, 0), [
      "user.message",
      "turn.started",
      "agent.message",
      "turn.completed",
    ]);
  });

  it("writes a log every consumer can parse", async () => {
    await runtime(new ScriptedAgent(HAPPY_SCRIPT, true)).runTurn({
      sessionId: SESSION_ID,
      message: "hello",
    });

    for (const event of await events.readFrom(SESSION_ID, 0)) {
      expect(() => NapEventSchema.parse(event)).not.toThrow();
    }
  });

  it("produces exactly one commit on a successful turn", async () => {
    const outcome = await runtime(new ScriptedAgent(HAPPY_SCRIPT, true)).runTurn({
      sessionId: SESSION_ID,
      message: "add a dark mode toggle",
    });

    const sandboxId = await onlySandboxId();
    expect(commitCommands(sandbox, sandboxId)).toHaveLength(1);
    expect(outcome).toStrictEqual({ ok: true, turnId: expect.any(String), commitSha: COMMIT_SHA });
  });

  it("produces zero commits on a failed turn", async () => {
    const failing = new ScriptedAgent(
      () => [
        { type: "turn.started", payload: {} },
        { type: "turn.failed", payload: { reason: "refusal", message: "declined" } },
      ],
      true,
    );

    const outcome = await runtime(failing).runTurn({ sessionId: SESSION_ID, message: "no" });

    const sandboxId = await onlySandboxId();
    expect(commitCommands(sandbox, sandboxId)).toEqual([]);
    expect(outcome).toStrictEqual({
      ok: false,
      turnId: expect.any(String),
      reason: "refusal",
      message: "declined",
    });
  });

  it("reports no commit when the turn changed no files", async () => {
    sandbox = scriptGit(new InMemorySandboxManager(), false);

    const outcome = await runtime(new ScriptedAgent(HAPPY_SCRIPT, true), { sandbox }).runTurn({
      sessionId: SESSION_ID,
      message: "what does App.tsx render?",
    });

    expect(outcome).toStrictEqual({ ok: true, turnId: expect.any(String), commitSha: null });
  });

  it("fails the turn without invoking the agent when the sandbox cannot be created", async () => {
    const agent = new ScriptedAgent();

    const outcome = await runtime(agent, { sandbox: new UncreatableSandboxManager() }).runTurn({
      sessionId: SESSION_ID,
      message: "build me an app",
    });

    expect(agent.calls).toBe(0);
    expect(await loggedTypes()).toEqual(["turn.failed"]);
    expect(outcome).toMatchObject({ ok: false, reason: "sandbox_unavailable" });
  });

  it("fails the turn when a recorded sandbox can no longer be resumed and nothing can be restored", async () => {
    // No object store and no snapshot store, so there is nothing to restore *from*: starting
    // over would silently hand the user an empty template in place of their project. The
    // configured case is covered below, where a fresh sandbox is filled from a snapshot.
    sessions = new InMemorySessionStore([
      { sessionId: SESSION_ID, projectId: PROJECT_ID, sandboxId: "gone" },
    ]);
    const agent = new ScriptedAgent();

    const outcome = await runtime(agent, { sessions }).runTurn({
      sessionId: SESSION_ID,
      message: "carry on",
    });

    expect(agent.calls).toBe(0);
    expect(outcome).toMatchObject({ ok: false, reason: "sandbox_unavailable" });
  });

  it("serializes concurrent turns on one session instead of interleaving them", async () => {
    const order: string[] = [];

    const agent = new ScriptedAgent(HAPPY_SCRIPT, true);
    agent.before = async (request) => {
      order.push(`enter:${request.turnId}`);
      // A real delay, not a microtask: an unserialized second turn has ample room to start
      // inside it, so the interleaved ordering would actually be observed rather than
      // narrowly missed. Only the first turn waits, so the test does not deadlock.
      if (order.length === 1) await delay(25);
      order.push(`exit:${request.turnId}`);
    };

    const subject = runtime(agent);
    await Promise.all([
      subject.runTurn({ sessionId: SESSION_ID, message: "one" }),
      subject.runTurn({ sessionId: SESSION_ID, message: "two" }),
    ]);

    expect(order.map((entry) => entry.split(":")[0])).toEqual(["enter", "exit", "enter", "exit"]);
    expect(order[0]?.slice(6)).toBe(order[1]?.slice(5));
    expect(order[0]).not.toBe(order[2]);
    // And the log shows two whole turns, not two interleaved ones.
    expectEventSequence(await events.readFrom(SESSION_ID, 0), [
      "user.message",
      "turn.started",
      "agent.message",
      "turn.completed",
      "user.message",
      "turn.started",
      "agent.message",
      "turn.completed",
    ]);
  });

  it("runs turns for different sessions without one waiting on the other", async () => {
    const other = "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e";
    sessions = new InMemorySessionStore([
      { sessionId: SESSION_ID, projectId: PROJECT_ID },
      { sessionId: other, projectId: PROJECT_ID },
    ]);

    const agent = new ScriptedAgent(HAPPY_SCRIPT, true);
    let entered = 0;
    agent.before = async () => {
      entered += 1;
      if (entered === 1) await delay(25);
    };

    const subject = runtime(agent, { sessions });
    const finished: string[] = [];
    const slow = subject
      .runTurn({ sessionId: SESSION_ID, message: "one" })
      .then(() => finished.push("slow"));
    const otherTurn = subject
      .runTurn({ sessionId: other, message: "two" })
      .then(() => finished.push("other"));

    await Promise.all([slow, otherTurn]);

    // The lock is per session: a slow turn in one chat must not hold up another.
    expect(finished).toEqual(["other", "slow"]);
  });

  it("hands the context engine the history so far, without the current message", async () => {
    const subject = runtime(new ScriptedAgent(HAPPY_SCRIPT, true));
    await subject.runTurn({ sessionId: SESSION_ID, message: "first" });
    await subject.runTurn({ sessionId: SESSION_ID, message: "second" });

    const [, latest] = context.requests;
    expect(latest?.userMessage).toBe("second");
    // The engine appends the turn's own message itself; finding it in the history too
    // would send it twice.
    const texts = (latest?.history ?? [])
      .filter((event): event is Extract<StoredEvent, { type: "user.message" }> => {
        return event.type === "user.message";
      })
      .map((event) => event.payload.text);
    expect(texts).toEqual(["first"]);
  });

  it("resumes the sandbox it created rather than creating a second one", async () => {
    const subject = runtime(new ScriptedAgent(HAPPY_SCRIPT, true));
    await subject.runTurn({ sessionId: SESSION_ID, message: "one" });
    const sandboxId = await onlySandboxId();

    await subject.runTurn({ sessionId: SESSION_ID, message: "two" });

    expect(await onlySandboxId()).toBe(sandboxId);
  });

  it("fails the turn when the commit itself fails, and never reports completion", async () => {
    sandbox = new InMemorySandboxManager()
      .script(/git add -A/, { exitCode: 0 })
      .script(/git diff --cached --quiet/, { exitCode: 1 })
      .script(/git .*commit -m/, { exitCode: 128, stderr: "fatal: unable to write" });

    const outcome = await runtime(new ScriptedAgent(HAPPY_SCRIPT, true), { sandbox }).runTurn({
      sessionId: SESSION_ID,
      message: "change something",
    });

    expect(await loggedTypes()).toEqual([
      "user.message",
      "turn.started",
      "agent.message",
      "turn.failed",
    ]);
    expect(outcome).toMatchObject({ ok: false, reason: "internal" });
  });

  it("closes the turn when the agent throws, so the log never shows it still open", async () => {
    const throwing = new ScriptedAgent();
    throwing.before = async () => {
      throw new Error("provider exploded");
    };

    const outcome = await runtime(throwing).runTurn({ sessionId: SESSION_ID, message: "hi" });

    expect(await loggedTypes()).toEqual(["user.message", "turn.failed"]);
    expect(outcome).toMatchObject({ ok: false, reason: "internal" });
  });

  it("closes the turn when the agent ends without reporting an outcome", async () => {
    const silent = new ScriptedAgent(() => [{ type: "turn.started", payload: {} }]);

    const outcome = await runtime(silent).runTurn({ sessionId: SESSION_ID, message: "hi" });

    expect(await loggedTypes()).toEqual(["user.message", "turn.started", "turn.failed"]);
    expect(outcome).toMatchObject({ ok: false, reason: "internal" });
  });

  it("fails without writing anything when the session does not exist", async () => {
    const unknown = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
    const agent = new ScriptedAgent();

    const outcome = await runtime(agent).runTurn({ sessionId: unknown, message: "hi" });

    expect(agent.calls).toBe(0);
    // No event: a row referencing a session that does not exist is a foreign key violation
    // waiting to happen, and there is nobody subscribed to a session nobody opened.
    expect(await events.readFrom(unknown, 0)).toEqual([]);
    expect(outcome).toMatchObject({ ok: false, reason: "internal" });
  });

  it("passes the caller's cancellation signal through to the agent", async () => {
    const controller = new AbortController();
    const agent = new ScriptedAgent(HAPPY_SCRIPT, true);

    await runtime(agent).runTurn({
      sessionId: SESSION_ID,
      message: "hi",
      signal: controller.signal,
    });

    expect(agent.requests[0]?.signal).toBe(controller.signal);
  });

  it("drives a real agent, context engine and provider end to end", async () => {
    // The composition the CLI harness assembles against real E2B and a real model, with
    // both ends scripted so it stays in the free suite.
    const provider = new ScriptedLLMProvider([[{ text: "I have read it." }]]);
    const agent = new NapAgentService({ provider });
    const subject = new SingleAgentRuntime({
      sessions,
      sandbox,
      context: new NapContextEngine(),
      agent,
      events,
      bus,
      memory: new NoopMemoryProvider(),
    });

    const outcome = await subject.runTurn({ sessionId: SESSION_ID, message: "what is in App?" });

    expect(outcome).toMatchObject({ ok: true, commitSha: COMMIT_SHA });
    expectEventSequence(await events.readFrom(SESSION_ID, 0), [
      "user.message",
      "turn.started",
      "agent.message",
      "turn.completed",
    ]);
  });
});

describe("commitMessage", () => {
  it("uses the user's request, so the history reads as what was asked for", () => {
    expect(commitMessage("add a dark mode toggle")).toBe("add a dark mode toggle");
  });

  it("takes the first line only", () => {
    expect(commitMessage("add a toggle\n\nand make it persist")).toBe("add a toggle");
  });

  it("truncates a long request rather than writing a paragraph into the subject line", () => {
    const long = "a".repeat(200);
    const message = commitMessage(long);

    expect(message.length).toBeLessThanOrEqual(72);
    expect(message.endsWith("…")).toBe(true);
  });

  it("falls back to something rather than committing with an empty message", () => {
    expect(commitMessage("   \n  ")).not.toBe("");
  });
});

describe("telling the client where the preview is", () => {
  const PORT = 5173;

  it("reports the preview once the new sandbox is serving", async () => {
    // Nothing else in the system emits this, and without it the preview pane has no address
    // to point an iframe at — the user watches files change and never sees the app.
    const serving = scriptGit(new InMemorySandboxManager({ serves: [PORT] }));
    const agent = new ScriptedAgent(HAPPY_SCRIPT);

    await runtime(agent, { sandbox: serving }).runTurn({
      sessionId: SESSION_ID,
      message: "build a todo list",
    });

    const stored = await events.readFrom(SESSION_ID, 0);
    expectEventSequence(stored, [
      "user.message",
      "preview.ready",
      "turn.started",
      "agent.message",
      "turn.completed",
    ]);

    const ready = stored.find((event) => event.type === "preview.ready");
    if (ready === undefined) throw new Error("no preview.ready was logged");
    expect(ready.payload).toMatchObject({ port: PORT });
    expect((ready.payload as { url: string }).url).toMatch(/^https:\/\//);
  });

  it("says nothing about the preview when the sandbox was resumed", async () => {
    // A resumed sandbox is already serving, and its `preview.ready` is in the log from the
    // turn that created it — the client replays it. Re-announcing would hard-reload the app
    // the user is in the middle of using, every single turn.
    const serving = scriptGit(new InMemorySandboxManager({ serves: [PORT] }));
    const created = await serving.create(PROJECT_ID);
    if (!created.ok) throw new Error("could not seed a sandbox");

    const agent = new ScriptedAgent(HAPPY_SCRIPT);
    await runtime(agent, {
      sandbox: serving,
      sessions: new InMemorySessionStore([
        { sessionId: SESSION_ID, projectId: PROJECT_ID, sandboxId: created.value.id },
      ]),
    }).runTurn({ sessionId: SESSION_ID, message: "add a delete button" });

    expect(await loggedTypes()).not.toContain("preview.ready");
  });

  it("still runs the turn when the dev server never comes up", async () => {
    // A slow or broken dev server is not a reason to refuse to edit the project. The pane
    // shows that it is still starting; the agent gets on with the work.
    const agent = new ScriptedAgent(HAPPY_SCRIPT);

    const outcome = await runtime(agent).runTurn({
      sessionId: SESSION_ID,
      message: "build a todo list",
    });

    expect(outcome.ok).toBe(true);
    expect(await loggedTypes()).toEqual([
      "user.message",
      "turn.started",
      "agent.message",
      "turn.completed",
    ]);
  });

  it("uses the port it was configured with", async () => {
    const port = 4321;
    const serving = scriptGit(new InMemorySandboxManager({ serves: [port] }));
    const agent = new ScriptedAgent(HAPPY_SCRIPT);

    await new SingleAgentRuntime({
      sessions,
      sandbox: serving,
      context,
      agent,
      events,
      bus,
      memory: new NoopMemoryProvider(),
      previewPort: port,
    }).runTurn({ sessionId: SESSION_ID, message: "build a todo list" });

    const stored = await events.readFrom(SESSION_ID, 0);
    expect(stored.find((event) => event.type === "preview.ready")?.payload).toMatchObject({ port });
  });
});

describe("opening a project that has been put away", () => {
  const SNAPSHOT_KEY = `projects/${PROJECT_ID}/1735689600000-${COMMIT_SHA}.bundle`;
  const PORT = 5173;

  let objects: InMemoryObjectStore;
  let snapshots: InMemorySnapshotStore;

  /** Everything a restore runs, answered the way a real project would answer it. */
  function scriptRestore(manager: InMemorySandboxManager): InMemorySandboxManager {
    return manager
      .script(/base64 -d/, { exitCode: 0 })
      .script(/git fetch/, { exitCode: 0 })
      .script(/git reset --hard/, { exitCode: 0 })
      .script(/git clean/, { exitCode: 0 })
      .script(/bun install/, { exitCode: 0 });
  }

  beforeEach(async () => {
    sandbox = scriptRestore(scriptGit(new InMemorySandboxManager({ serves: [PORT] })));
    objects = new InMemoryObjectStore();
    snapshots = new InMemorySnapshotStore();

    await objects.put(SNAPSHOT_KEY, new TextEncoder().encode("PACK-bundle-bytes"));
    await snapshots.record({ projectId: PROJECT_ID, key: SNAPSHOT_KEY, gitSha: COMMIT_SHA });
  });

  function restoringRuntime(
    agent: AgentService,
    overrides: Partial<{ sessions: InMemorySessionStore }> = {},
  ): SingleAgentRuntime {
    return runtime(agent, {
      objects,
      snapshots,
      ...(overrides.sessions === undefined ? {} : { sessions: overrides.sessions }),
    });
  }

  it("restores the snapshot into the sandbox it creates", async () => {
    const agent = new ScriptedAgent(HAPPY_SCRIPT, true);

    const outcome = await restoringRuntime(agent).runTurn({
      sessionId: SESSION_ID,
      message: "carry on where we left off",
    });

    expect(outcome.ok).toBe(true);
    const sandboxId = await onlySandboxId();
    expect(sandbox.commands(sandboxId).join("\n")).toMatch(/git fetch/);
  });

  it("says nothing when the restore went cleanly", async () => {
    // A notice on every open is a notice nobody reads. This one is reserved for the cases
    // where the project is not what the user left behind.
    await restoringRuntime(new ScriptedAgent(HAPPY_SCRIPT, true)).runTurn({
      sessionId: SESSION_ID,
      message: "carry on",
    });

    expect(await loggedTypes()).not.toContain("system.notice");
  });

  it("carries on with a fresh template, and says so, when the snapshot is unusable", async () => {
    sandbox.script(/git fetch/, { exitCode: 128, stderr: "fatal: not a valid object name" });
    const agent = new ScriptedAgent(HAPPY_SCRIPT, true);

    const outcome = await restoringRuntime(agent).runTurn({
      sessionId: SESSION_ID,
      message: "carry on",
    });

    // The turn runs: an unusable snapshot is a project the user has lost, not a reason to
    // refuse them the project they still have. The notice comes before the preview, because
    // it explains the empty app the preview is about to show.
    expect(outcome.ok).toBe(true);
    expectEventSequence(await events.readFrom(SESSION_ID, 0), [
      "user.message",
      "system.notice",
      "preview.ready",
      "turn.started",
      "agent.message",
      "turn.completed",
    ]);
  });

  it("restores into a new sandbox when the recorded one is gone", async () => {
    // The payoff for the whole task: before snapshots, this failed the turn, because the
    // only alternative was handing back an empty template and calling it success.
    const withDeadSandbox = new InMemorySessionStore([
      { sessionId: SESSION_ID, projectId: PROJECT_ID, sandboxId: "gone" },
    ]);
    const agent = new ScriptedAgent(HAPPY_SCRIPT, true);

    const outcome = await restoringRuntime(agent, { sessions: withDeadSandbox }).runTurn({
      sessionId: SESSION_ID,
      message: "carry on",
    });

    expect(outcome.ok).toBe(true);
    expect(agent.calls).toBe(1);
    const record = await withDeadSandbox.get(SESSION_ID);
    expect(record?.sandboxId).not.toBe("gone");
  });

  it("warns that a lost sandbox has cost the user everything since the last snapshot", async () => {
    // The snapshot is from the last time the project was put away, so anything after it is
    // genuinely gone. Restoring silently would look like the project had rolled itself back.
    const withDeadSandbox = new InMemorySessionStore([
      { sessionId: SESSION_ID, projectId: PROJECT_ID, sandboxId: "gone" },
    ]);

    await restoringRuntime(new ScriptedAgent(HAPPY_SCRIPT, true), {
      sessions: withDeadSandbox,
    }).runTurn({ sessionId: SESSION_ID, message: "carry on" });

    const stored = await events.readFrom(SESSION_ID, 0);
    const notice = stored.find((event) => event.type === "system.notice");
    expect(notice?.payload).toMatchObject({
      level: "warning",
      text: expect.stringMatching(/snapshot/i),
    });
  });

  it("refuses to be constructed with only half of what a restore needs", () => {
    // A store of bytes nothing can name, or names with nothing behind them. Neither opens
    // a project, and both type-check.
    expect(
      () =>
        new SingleAgentRuntime({
          sessions,
          sandbox,
          context,
          agent: new ScriptedAgent(),
          events,
          bus,
          memory: new NoopMemoryProvider(),
          objects,
        }),
    ).toThrow(/both/i);
  });
});

describe("keeping a resumed sandbox alive", () => {
  it("pushes the sandbox's deadline back when a turn resumes it", async () => {
    // Providers kill a sandbox on a timer that starts at creation, not at the last thing
    // anyone did. Without this, a long conversation loses its workspace mid-sentence.
    const created = await sandbox.create(PROJECT_ID);
    if (!created.ok) throw new Error("could not seed a sandbox");

    await runtime(new ScriptedAgent(HAPPY_SCRIPT, true), {
      sessions: new InMemorySessionStore([
        { sessionId: SESSION_ID, projectId: PROJECT_ID, sandboxId: created.value.id },
      ]),
    }).runTurn({ sessionId: SESSION_ID, message: "carry on" });

    expect(sandbox.timeoutOf(created.value.id)).toBe(30 * 60 * 1000);
  });

  it("uses the lifetime it was configured with", async () => {
    const created = await sandbox.create(PROJECT_ID);
    if (!created.ok) throw new Error("could not seed a sandbox");

    await new SingleAgentRuntime({
      sessions: new InMemorySessionStore([
        { sessionId: SESSION_ID, projectId: PROJECT_ID, sandboxId: created.value.id },
      ]),
      sandbox,
      context,
      agent: new ScriptedAgent(HAPPY_SCRIPT, true),
      events,
      bus,
      memory: new NoopMemoryProvider(),
      sandboxTtlMs: 90_000,
    }).runTurn({ sessionId: SESSION_ID, message: "carry on" });

    expect(sandbox.timeoutOf(created.value.id)).toBe(90_000);
  });
});
