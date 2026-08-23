import { type AgentScript, completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
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

function runtime(script: AgentScript, durable = true) {
  return new SingleAgentRuntime({
    sessions,
    sandbox,
    context: new StubContextEngine(),
    agent: new ScriptedAgent(script),
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
    ...(durable ? { objects, snapshots } : {}),
  });
}

const run = (script: AgentScript = () => completedTurn(COMMIT_SHA), durable = true) =>
  runtime(script, durable).runTurn({
    turnId: crypto.randomUUID(),
    sessionId: SESSION_ID,
    message: "add a delete button",
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
