import { type AgentScript, completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { FakePageCapture } from "@nap/capture/testing/fake-page-capture";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";
import { thumbnailKey } from "./turn-thumbnail.ts";

/**
 * The dashboard's card shows the app, and this is where the picture is taken.
 *
 * The rules are the snapshot's, one notch weaker: only after a turn that committed, and **a
 * failure is never allowed near the turn's outcome**. A missing thumbnail costs a card its
 * picture; a turn failed over one would cost somebody their work.
 */

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const COMMIT_SHA = "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1";

let sandbox: InMemorySandboxManager;
let objects: InMemoryObjectStore;
let capture: FakePageCapture;
let sessions: InMemorySessionStore;

beforeEach(() => {
  // Every sandbox this test's runtime creates is serving, so `waitForPreview` resolves the way
  // it would against a project whose dev server came up during the turn.
  sandbox = scriptGit(new InMemorySandboxManager({ serves: [TEMPLATE_DEV_PORT] }));
  objects = new InMemoryObjectStore();
  capture = new FakePageCapture();
  sessions = new InMemorySessionStore([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]);
});

function run(script: AgentScript = () => completedTurn(COMMIT_SHA), withCapture = true) {
  const runtime = new SingleAgentRuntime({
    sessions,
    sandbox,
    context: new StubContextEngine(),
    agent: new ScriptedAgent(script),
    events: new InMemoryEventStore(),
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
    objects,
    snapshots: new InMemorySnapshotStore(),
    ...(withCapture ? { capture } : {}),
  });

  return runtime.runTurn({
    turnId: crypto.randomUUID(),
    sessionId: SESSION_ID,
    message: "add a delete button",
  });
}

describe("a turn that changed something", () => {
  it("stores a picture of the project under its own key", async () => {
    await run();

    expect(objects.keys()).toContain(thumbnailKey(PROJECT_ID));
  });

  it("photographs the preview rather than any other address", async () => {
    await run();

    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0]?.url).toMatch(new RegExp(`^https://${TEMPLATE_DEV_PORT}-`));
  });
});

describe("a turn with nothing new to show", () => {
  it("takes no picture when the turn changed no files", async () => {
    // The app on screen is the one already photographed, so a second identical capture would
    // be a browser launch and an upload for a byte-for-byte repeat.
    await run(() => completedTurn(null));

    expect(capture.requests).toEqual([]);
    expect(objects.keys()).not.toContain(thumbnailKey(PROJECT_ID));
  });

  it("takes no picture when the runtime was built without a browser", async () => {
    // The ordinary state of a deployment that has no Chrome to drive: turns still run and the
    // work is still preserved, and the dashboard falls back to a colour.
    const outcome = await run(() => completedTurn(COMMIT_SHA), false);

    expect(outcome.ok).toBe(true);
    expect(objects.keys()).not.toContain(thumbnailKey(PROJECT_ID));
  });
});

describe("when the capture fails", () => {
  it("still reports the turn as successful", async () => {
    capture.failWith({ code: "unavailable", message: "no browser at that path" });

    expect(await run()).toMatchObject({ ok: true, commitSha: COMMIT_SHA });
  });

  it("leaves the turn's snapshot alone", async () => {
    // The two run off the same beat, and the picture is the expendable half. A capture failure
    // that took the bundle with it would trade the work for a thumbnail.
    capture.failWith({ code: "unavailable", message: "no browser at that path" });

    await run();

    expect(objects.keys().some((key) => key.endsWith(".bundle"))).toBe(true);
  });
});

describe("a project coming back up", () => {
  /** A resume against a session whose sandbox has to be created, as an old project's would. */
  function resume(withCapture = true) {
    const runtime = new SingleAgentRuntime({
      sessions,
      sandbox,
      context: new StubContextEngine(),
      agent: new ScriptedAgent(() => completedTurn(COMMIT_SHA)),
      events: new InMemoryEventStore(),
      bus: new InMemoryEventBus(),
      memory: new NoopMemoryProvider(),
      objects,
      snapshots: new InMemorySnapshotStore(),
      ...(withCapture ? { capture } : {}),
    });

    return runtime.resumeSession(SESSION_ID);
  }

  it("photographs it, without any turn having run", async () => {
    // Every project made before there was a browser has no picture at all, and a turn is the
    // only other thing that would take one — so opening a project is the cheapest way for its
    // card to catch up, and it costs no model call.
    const outcome = await resume();

    expect(outcome.ok).toBe(true);
    expect(objects.keys()).toContain(thumbnailKey(PROJECT_ID));
  });

  it("takes no picture when the sandbox was already serving", async () => {
    // Nothing has changed since whatever last photographed it, so a second shot is a browser
    // launch for a byte-identical picture — the same reason the preview is not re-announced.
    await resume();
    capture.requests.length = 0;

    await resume();

    expect(capture.requests).toEqual([]);
  });

  it("still resumes when the picture fails", async () => {
    capture.failWith({ code: "unavailable", message: "no browser at that path" });

    expect(await resume()).toMatchObject({ ok: true });
  });
});
