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
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

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

function runtime(): SingleAgentRuntime {
  const events: EventStore = {
    append: async (event, options) => {
      appends.push({ type: event.type, afterReturn: returned });
      return inner.append(event, options);
    },
    readFrom: (sessionId, afterSeq) => inner.readFrom(sessionId, afterSeq),
  };
  return new SingleAgentRuntime({
    sessions: new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]),
    sandbox,
    context: new StubContextEngine(),
    agent,
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
    // Far longer than any test here may take, so a turn that sat out the wait would time out.
    previewTimeoutMs: 60_000,
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

  it("stops waiting the moment the turn is cancelled", async () => {
    const controller = new AbortController();
    agent.before = (request) =>
      new Promise((_, reject) => {
        request.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const outcome = runtime()
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

    // The dev server never answers; the turn must end on the cancel, not on the timeout.
    const ended = await Promise.race([
      outcome,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_000)),
    ]);
    expect(ended).toMatchObject({ ok: false, reason: "cancelled" });
    expect(await types()).not.toContain("preview.ready");
    expect(appends.filter((append) => append.afterReturn)).toEqual([]);
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
});
