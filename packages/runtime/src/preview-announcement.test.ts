/**
 * A new sandbox's preview is announced without holding the turn up.
 *
 * `preview.ready` waits on the dev server, which takes a couple of seconds from cold and the
 * whole timeout when a restore reinstalls dependencies, and the agent has no use for it. So the
 * turn starts while the wait runs. Three things must still hold, and these tests are what say so:
 * the announcement lands before the ending of the turn it belongs to; nothing is written after the
 * runtime returns, because the lease is released then; and a cancelled turn does not sit out the
 * wait.
 */

import { completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { GatedPageCapture } from "@nap/capture/testing/gated-page-capture";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import type { AgentService } from "@nap/shared/ports/agent-service";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";
import { ThumbnailLane } from "./thumbnail-lane.ts";

const SESSION = "3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b";
const PROJECT = "5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d";
const TURN = "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f";
const URL = `https://${TEMPLATE_DEV_PORT}-sandbox.sandbox.invalid`;

let inner: InMemoryEventStore;
let sandbox: InMemorySandboxManager;
let agent: ScriptedAgent;
/** Every append, in order, and whether the runtime call had already returned when it ran. */
let appends: { type: string; afterReturn: boolean }[];
let returned: boolean;
/** Answers the dev-server wait. Until it is called, nothing is serving. */
let release: (result: Result<string, SandboxError>) => void;

beforeEach(() => {
  inner = new InMemoryEventStore();
  sandbox = scriptGit(new InMemorySandboxManager({ serves: [TEMPLATE_DEV_PORT] }));
  const answered = new Promise<Result<string, SandboxError>>((resolve) => {
    release = resolve;
  });
  sandbox.waitForPreview = () => answered;
  agent = new ScriptedAgent(() => completedTurn(null));
  appends = [];
  returned = false;
});

function runtime(
  overrides: {
    sessions?: InMemorySessionStore;
    thumbnails?: ThumbnailLane;
    agent?: AgentService;
  } = {},
): SingleAgentRuntime {
  const events: EventStore = {
    append: async (event, options) => {
      appends.push({ type: event.type, afterReturn: returned });
      return inner.append(event, options);
    },
    readFrom: (sessionId, afterSeq) => inner.readFrom(sessionId, afterSeq),
  };
  return new SingleAgentRuntime({
    sessions:
      overrides.sessions ?? new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]),
    sandbox,
    context: new StubContextEngine(),
    agent: overrides.agent ?? agent,
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
    // Far longer than any test here may take, so a turn that sat out the wait would time out.
    previewTimeoutMs: 60_000,
    ...(overrides.thumbnails === undefined ? {} : { thumbnails: overrides.thumbnails }),
  });
}

async function types(): Promise<string[]> {
  return (await inner.readFrom(SESSION, 0)).map((event) => event.type);
}

describe("a turn on a sandbox it just created", () => {
  it("reaches the model before the dev server answers", async () => {
    const outcome = runtime()
      .runTurn({ turnId: TURN, sessionId: SESSION, message: "build me a todo list" })
      .finally(() => {
        returned = true;
      });

    await vi.waitFor(() => expect(agent.calls).toBe(1));
    expect(await types()).not.toContain("preview.ready");

    release({ ok: true, value: URL });
    expect((await outcome).ok).toBe(true);

    const log = await inner.readFrom(SESSION, 0);
    const order = log.map((event) => event.type);
    const ready = order.indexOf("preview.ready");
    expect(ready).toBeGreaterThan(order.indexOf("turn.started"));
    // Before the endings of the turn and the job it belongs to, and under that turn.
    expect(ready).toBeLessThan(order.indexOf("turn.completed"));
    expect(ready).toBeLessThan(order.indexOf("job.completed"));
    expect(log[ready]?.turnId).toBe(TURN);
    expect(log[ready]?.payload).toEqual({ url: URL, port: TEMPLATE_DEV_PORT });
  });

  it("holds a plan proposal's ending for it too, though the proposal opens no job", async () => {
    const outcome = runtime().runTurn({
      turnId: TURN,
      sessionId: SESSION,
      message: "add a dark theme",
      plan: { intent: "propose" },
    });

    await vi.waitFor(() => expect(agent.calls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await types()).not.toContain("turn.completed");

    release({ ok: true, value: URL });
    expect((await outcome).ok).toBe(true);

    const log = await inner.readFrom(SESSION, 0);
    const order = log.map((event) => event.type);
    expect(order).not.toContain("job.started");
    const ready = order.indexOf("preview.ready");
    expect(ready).toBeGreaterThan(order.indexOf("user.message"));
    expect(ready).toBeLessThan(order.indexOf("turn.completed"));
    expect(log[ready]?.turnId).toBe(TURN);
  });

  it("does not return while the announcement is outstanding, and writes nothing after", async () => {
    let done = false;
    const outcome = runtime()
      .runTurn({ turnId: TURN, sessionId: SESSION, message: "build me a todo list" })
      .finally(() => {
        returned = true;
        done = true;
      });

    await vi.waitFor(() => expect(agent.calls).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);

    release({ ok: true, value: URL });
    await outcome;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(appends.filter((append) => append.afterReturn)).toEqual([]);
    expect(await types()).toContain("preview.ready");
  });

  it("stops waiting the moment the turn is cancelled, and the next turn announces it", async () => {
    const controller = new AbortController();
    agent.before = (request) =>
      new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const nap = runtime();

    const outcome = nap
      .runTurn({
        turnId: TURN,
        sessionId: SESSION,
        message: "build me a todo list",
        signal: controller.signal,
      })
      .finally(() => {
        returned = true;
      });

    await vi.waitFor(() => expect(agent.calls).toBe(1));
    controller.abort();

    // The dev server has not answered; the turn must end on the cancel, not on the timeout.
    const ended = await Promise.race([
      outcome,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
    ]);
    expect(ended).toMatchObject({ ok: false, reason: "cancelled" });
    expect(await types()).not.toContain("preview.ready");
    expect(appends.filter((append) => append.afterReturn)).toEqual([]);

    // It comes up a moment later. The sandbox is still running and is never created again, so
    // unless the next turn announces it, nothing ever will and the pane says "starting" forever.
    release({ ok: true, value: URL });
    delete agent.before;
    const next = crypto.randomUUID();
    expect((await nap.runTurn({ turnId: next, sessionId: SESSION, message: "carry on" })).ok).toBe(
      true,
    );

    const log = await inner.readFrom(SESSION, 0);
    const ready = log.filter((event) => event.type === "preview.ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]?.turnId).toBe(next);

    // And once it is announced, it stays announced: a third turn must not remount the frame.
    expect(
      (await nap.runTurn({ turnId: crypto.randomUUID(), sessionId: SESSION, message: "more" })).ok,
    ).toBe(true);
    expect((await types()).filter((type) => type === "preview.ready")).toHaveLength(1);
  });

  it("announces on a resume a sandbox whose creating turn was cancelled first", async () => {
    const controller = new AbortController();
    agent.before = (request) =>
      new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const nap = runtime();

    const outcome = nap.runTurn({
      turnId: TURN,
      sessionId: SESSION,
      message: "build me a todo list",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(agent.calls).toBe(1));
    controller.abort();
    expect(await outcome).toMatchObject({ ok: false, reason: "cancelled" });

    release({ ok: true, value: URL });
    expect(await nap.resumeSession(SESSION, { turnId: crypto.randomUUID() })).toMatchObject({
      ok: true,
      created: false,
    });
    expect((await types()).filter((type) => type === "preview.ready")).toHaveLength(1);
  });

  it("does not start the wait at all for a turn cancelled before it got there", async () => {
    let asked = 0;
    sandbox.waitForPreview = async () => {
      asked += 1;
      return { ok: true, value: URL };
    };
    const controller = new AbortController();
    // Cancelled in the last moment of the acquire, after its own check for one: the sandbox is
    // in hand, and the turn has been told to stop before it asked about the preview.
    const sessions = new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]);
    const record = sessions.setSandboxId.bind(sessions);
    sessions.setSandboxId = async (sessionId, sandboxId) => {
      await record(sessionId, sandboxId);
      controller.abort();
    };

    const outcome = await runtime({ sessions }).runTurn({
      turnId: TURN,
      sessionId: SESSION,
      message: "build me a todo list",
      signal: controller.signal,
    });
    expect(outcome).toMatchObject({ ok: false, reason: "cancelled" });
    expect(asked).toBe(0);
  });

  it("announces on the next turn a sandbox whose dev server outlived the first turn's wait", async () => {
    // The first wait times out; by the next turn the dev server is up. Nothing creates the
    // sandbox again, so the next turn is the only chance there is to say so.
    let asked = 0;
    sandbox.waitForPreview = async () => {
      asked += 1;
      return asked === 1
        ? { ok: false, error: { code: "timeout", message: "nothing is serving yet" } }
        : { ok: true, value: URL };
    };
    const nap = runtime();

    expect(
      (await nap.runTurn({ turnId: TURN, sessionId: SESSION, message: "build me a todo list" })).ok,
    ).toBe(true);
    expect(await types()).not.toContain("preview.ready");

    expect(
      (await nap.runTurn({ turnId: crypto.randomUUID(), sessionId: SESSION, message: "again" })).ok,
    ).toBe(true);
    expect((await types()).filter((type) => type === "preview.ready")).toHaveLength(1);
  });

  it("closes a turn once when something throws after its ending, held for the preview", async () => {
    // The ending is held until the dev server answers, so for that long it is not yet the sink's
    // `terminal` — and a catch that read it without draining first would add a `turn.failed`.
    let ended = false;
    const throwsAfterEnding: AgentService = {
      runTurn: async (request) => {
        await agent.runTurn(request);
        ended = true;
        throw new Error("thrown after the turn had ended");
      },
    };
    const outcome = runtime({ agent: throwsAfterEnding }).runTurn({
      turnId: TURN,
      sessionId: SESSION,
      message: "build me a todo list",
    });

    await vi.waitFor(() => expect(ended).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    release({ ok: true, value: URL });
    await outcome;

    const endings = (await types()).filter(
      (type) => type === "turn.completed" || type === "turn.failed",
    );
    expect(endings).toEqual(["turn.completed"]);
  });

  it("announces nothing when the dev server never comes up, and the turn still completes", async () => {
    const outcome = runtime().runTurn({
      turnId: TURN,
      sessionId: SESSION,
      message: "build me a todo list",
    });

    await vi.waitFor(() => expect(agent.calls).toBe(1));
    release({ ok: false, error: { code: "timeout", message: "nothing is serving" } });

    expect((await outcome).ok).toBe(true);
    expect(await types()).not.toContain("preview.ready");
  });
});

describe("resuming a project", () => {
  it("settles the announcement before it returns", async () => {
    let done = false;
    const outcome = runtime()
      .resumeSession(SESSION, { turnId: TURN })
      .finally(() => {
        returned = true;
        done = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);

    release({ ok: true, value: URL });
    expect((await outcome).ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await types()).toEqual(["preview.ready"]);
    expect(appends.filter((append) => append.afterReturn)).toEqual([]);
  });

  it("gives the card's picture as long to come up as the announcement had", async () => {
    // Nothing on a resume waits for the dev server any more, so the thumbnail is asked for while
    // it may still be starting; on the lane's short default it would miss a slow one.
    const waits: (number | undefined)[] = [];
    sandbox.waitForPreview = async (_sandboxId, _port, opts) => {
      waits.push(opts?.timeoutMs);
      return { ok: true, value: URL };
    };
    const capture = new GatedPageCapture();
    const thumbnails = new ThumbnailLane({
      sandbox,
      capture,
      objects: new InMemoryObjectStore(),
      concurrency: 1,
      maxQueued: 1,
    });

    expect((await runtime({ thumbnails }).resumeSession(SESSION, { turnId: TURN })).ok).toBe(true);
    await vi.waitFor(() => expect(capture.waiting).toBe(1));
    capture.releaseAll();

    // The announcement's wait, then the picture's: both on the runtime's deadline.
    expect(waits).toEqual([60_000, 60_000]);
  });
});
