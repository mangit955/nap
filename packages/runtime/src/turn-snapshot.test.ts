import { type AgentScript, completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";

/**
 * A turn's work reaches storage when the turn ends, not when someone remembers to close the
 * project.
 *
 * Before this, a sandbox was the only copy of everything since the last close or reap — so a
 * process that went away with a live sandbox left the provider's own timer to delete the
 * project. The reaper could not help: it only runs while the process does.
 *
 * The rule these pin is narrow on purpose. A snapshot is taken **only** when a turn completed
 * *and* committed something, and a snapshot that fails **never** fails the turn.
 */

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const COMMIT_SHA = "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1";

/** A turn that ends badly, which is what must leave the snapshot store untouched. */
const failed: AgentScript = () => [
  { type: "turn.started", payload: {} },
  { type: "turn.failed", payload: { reason: "internal", message: "the model fell over" } },
];

let sandbox: InMemorySandboxManager;
let objects: InMemoryObjectStore;
let snapshots: InMemorySnapshotStore;
let events: InMemoryEventStore;
let sessions: InMemorySessionStore;

beforeEach(() => {
  sandbox = scriptGit(new InMemorySandboxManager());
  objects = new InMemoryObjectStore();
  snapshots = new InMemorySnapshotStore();
  events = new InMemoryEventStore();
  sessions = new InMemorySessionStore([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]);
});

function runtime(script: AgentScript | ScriptedAgent, durable = true) {
  return new SingleAgentRuntime({
    sessions,
    sandbox,
    context: new StubContextEngine(),
    agent: script instanceof ScriptedAgent ? script : new ScriptedAgent(script),
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
    ...(durable ? { objects, snapshots } : {}),
  });
}

const run = (
  script: AgentScript | ScriptedAgent = () => completedTurn(COMMIT_SHA),
  durable = true,
  signal?: AbortSignal,
) =>
  runtime(script, durable).runTurn({
    turnId: crypto.randomUUID(),
    sessionId: SESSION_ID,
    message: "add a delete button",
    ...(signal === undefined ? {} : { signal }),
  });

describe("a turn that changed something", () => {
  it("puts its work in storage before it returns", async () => {
    const outcome = await run();

    expect(outcome.ok).toBe(true);
    expect(snapshots.all()).toHaveLength(1);
    expect(objects.keys()).toHaveLength(1);
  });

  it("records the commit the turn produced", async () => {
    // The row is what a restore reads. A snapshot naming the wrong commit would restore the
    // wrong tree without anything noticing.
    await run();

    expect(snapshots.all()[0]).toMatchObject({ projectId: PROJECT_ID, gitSha: COMMIT_SHA });
  });

  it("snapshots without destroying the sandbox the user is still working in", async () => {
    // The whole reason this is not a teardown: the work is safe *and* the project is still
    // there to carry on editing. Destroying here would end the session in order to protect it.
    await run();

    const sandboxId = (await sessions.get(SESSION_ID))?.sandboxId ?? "";
    expect(sandboxId).not.toBe("");
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({ ok: true });
    expect(objects.keys()).toHaveLength(1);
  });

  it("takes one snapshot per turn, not one per event", async () => {
    await run();
    expect(objects.puts).toBe(1);
  });
});

describe("a turn with nothing to store", () => {
  it("writes no snapshot when the turn changed no files", async () => {
    // `commitSha: null` means there was no commit. Bundling again would upload a byte-identical
    // copy of the last one and give the project a second row pointing at the same tree.
    await run(() => completedTurn(null));

    expect(snapshots.all()).toEqual([]);
    expect(objects.puts).toBe(0);
  });

  it("writes no snapshot when the turn failed", async () => {
    // A failed turn never reaches `finalize`, so nothing was committed — and a git bundle holds
    // commits, not the working tree. There is genuinely nothing new to capture.
    const outcome = await run(failed);

    expect(outcome.ok).toBe(false);
    expect(snapshots.all()).toEqual([]);
    expect(objects.puts).toBe(0);
  });

  it("attempts nothing when the runtime was built without somewhere to put it", async () => {
    // `objects`/`snapshots` are optional, and half of the pair is refused at construction. A
    // runtime with neither must still run turns — it just cannot make them durable.
    const outcome = await run(() => completedTurn(COMMIT_SHA), false);

    expect(outcome.ok).toBe(true);
    expect(objects.puts).toBe(0);
    expect(snapshots.all()).toEqual([]);
  });
});

describe("when the snapshot itself fails", () => {
  it("still reports the turn as successful", async () => {
    // The turn did happen and its work is still in the live sandbox. Failing it here would
    // discard a completed turn to report a backup problem, and the reaper is still the backstop.
    objects.failWith({ code: "unavailable", message: "R2 is down" });

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: true, commitSha: COMMIT_SHA });
  });

  it("says nothing to the user about it", async () => {
    // There is no action for them to take, and a warning nobody can act on is what teaches
    // people to ignore the warnings that matter.
    snapshots.failWith(new Error("database is down"));

    await run();

    const log = await events.readFrom(SESSION_ID, 0);
    expect(log.filter((event) => event.type === "system.notice")).toEqual([]);
  });

  it("does not close the turn twice", async () => {
    // The terminal event is already written and published by this point; a failure here that
    // emitted another would leave two endings in one turn's log.
    objects.failWith({ code: "unavailable", message: "R2 is down" });

    await run();

    const log = await events.readFrom(SESSION_ID, 0);
    const terminals = log.filter(
      (event) => event.type === "turn.completed" || event.type === "turn.failed",
    );
    expect(terminals).toHaveLength(1);
  });
});

describe("a job that repairs itself", () => {
  const REPAIRED_SHA = "2222222222222222222222222222222222222222";

  /**
   * A project whose typecheck says no `reds` times and then yes, and whose HEAD moves on with each
   * turn the agent runs — which is what a repair that commits does to it.
   */
  function repairingProject(reds: number) {
    let remaining = reds;
    let head = COMMIT_SHA;
    sandbox = scriptGit(
      new InMemorySandboxManager({
        serves: [TEMPLATE_DEV_PORT],
        seed: {
          [`${PROJECT_ROOT_PATH}/package.json`]: JSON.stringify({
            scripts: { typecheck: "tsc --noEmit" },
          }),
        },
      }),
    )
      .script(/git rev-parse HEAD/, () => ({ exitCode: 0, stdout: `${head}\n` }))
      .script(/bun run typecheck/, () => {
        if (remaining === 0) return { exitCode: 0 };
        remaining -= 1;
        return { exitCode: 1, stderr: "type error" };
      });
    const agent = new ScriptedAgent(() => {
      const sha = agent.calls === 1 ? COMMIT_SHA : REPAIRED_SHA;
      head = sha;
      return completedTurn(sha);
    });
    return agent;
  }

  /** Bundle uploads that finish when the test says, counted so an overlap would show. */
  function gatedUploads() {
    const waiting: (() => void)[] = [];
    let inFlight = 0;
    const gate = { asked: 0, peak: 0, release: () => waiting.shift()?.() };
    const put = objects.put.bind(objects);
    vi.spyOn(objects, "put").mockImplementation(async (key, bytes) => {
      if (key.endsWith(".bundle")) {
        gate.asked += 1;
        inFlight += 1;
        gate.peak = Math.max(gate.peak, inFlight);
        await new Promise<void>((resolve) => waiting.push(resolve));
        inFlight -= 1;
      }
      return put(key, bytes);
    });
    return gate;
  }

  it("starts the repair without waiting for the round before it to reach storage", async () => {
    // The person is watching a repair, not a backup: holding the next turn for an upload only
    // makes the job, and so everything queued behind its lease, take longer.
    const agent = repairingProject(1);
    const uploads = gatedUploads();

    const outcome = run(agent);

    await vi.waitFor(() => expect(agent.calls).toBe(2));
    expect(snapshots.all()).toEqual([]);

    uploads.release();
    await vi.waitFor(() => expect(uploads.asked).toBe(2));
    uploads.release();
    expect((await outcome).ok).toBe(true);
  });

  it("records every round's snapshot before it returns, one at a time, the newest last", async () => {
    // Before it returns is before the lease goes back, which is what orders this job's snapshots
    // against the next turn's and keeps the idle sweep away from the sandbox mid-bundle.
    const agent = repairingProject(1);
    const uploads = gatedUploads();
    let returned = false;

    const outcome = run(agent).finally(() => {
      returned = true;
    });

    await vi.waitFor(() => expect(uploads.asked).toBe(1));
    await vi.waitFor(() => expect(agent.calls).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The repair's own round has been checked and wants its snapshot, and waits for the first.
    expect(uploads.asked).toBe(1);
    expect(returned).toBe(false);

    uploads.release();
    await vi.waitFor(() => expect(uploads.asked).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(returned).toBe(false);

    uploads.release();
    await outcome;

    expect(uploads.peak).toBe(1);
    expect(snapshots.all()).toHaveLength(2);
    expect(snapshots.all().at(-1)).toMatchObject({ gitSha: REPAIRED_SHA });
  });

  it.each([
    ["crashes", "throw"],
    ["is cancelled", "abort"],
  ] as const)("still records the round before it when the repair %s", async (_name, how) => {
    // The boundary a worker's own failure lands on: the round before has committed, its upload
    // is in flight, and the turn that was meant to fix it is gone. That commit must still reach
    // storage before anything can hand the lease back.
    const agent = repairingProject(Number.POSITIVE_INFINITY);
    const controller = new AbortController();
    agent.before = async () => {
      if (agent.calls < 2) return;
      if (how === "throw") throw new Error("provider exploded");
      controller.abort();
    };
    const uploads = gatedUploads();
    let returned = false;

    const outcome = run(agent, true, controller.signal).finally(() => {
      returned = true;
    });

    await vi.waitFor(() => expect(agent.calls).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(uploads.asked).toBe(1);
    expect(returned).toBe(false);

    // A scripted agent does not hear the cancel, so the repair may still commit — and then its
    // commit is preserved too, after this one. Every upload is let through until the job returns.
    const releasing = setInterval(uploads.release, 2);
    await outcome.finally(() => clearInterval(releasing));

    expect(snapshots.all()[0]).toMatchObject({ gitSha: COMMIT_SHA });
    expect(uploads.peak).toBe(1);
  });
});
