import { completedTurn, ScriptedAgent } from "@nap/agent/testing/scripted-agent";
import { GatedPageCapture } from "@nap/capture/testing/gated-page-capture";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { StubContextEngine } from "@nap/context/testing/stub-context-engine";
import { enqueueRequest } from "@nap/db/testing/enqueue-request";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import type { PageCapture } from "@nap/shared/ports/page-capture";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SingleAgentRuntime } from "./single-agent-runtime.ts";
import { ThumbnailLane } from "./thumbnail-lane.ts";
import { thumbnailKey } from "./turn-thumbnail.ts";
import { startTurnWorker, type TurnWorker } from "./turn-worker.ts";

/**
 * What a session's lease covers once the agent has finished, driven through a real worker and a
 * real runtime — the two halves of the question are in different files, and neither could answer
 * it alone.
 *
 * **The photograph is outside the lease and the snapshot is inside it.** The first is why a
 * follow-up message no longer waits behind a queue of browsers. The second is what a restore
 * relies on, for the reasons in `docs/scaling-design.md` §17 (B-7).
 */

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const USER_ID = "7b1d9e60-3c2a-4f8b-9a0e-5d6c7b8a9f10";
const FIRST_SHA = "1111111111111111111111111111111111111111";
const SECOND_SHA = "2222222222222222222222222222222222222222";

const workers: TurnWorker[] = [];
const releases: (() => void)[] = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

/** A sandbox whose HEAD moves when a test says so, which is what a following turn does to it. */
function movingSandbox() {
  let head = FIRST_SHA;
  const sandbox = scriptGit(new InMemorySandboxManager({ serves: [TEMPLATE_DEV_PORT] }));
  sandbox.script(/git rev-parse HEAD/, () => ({ exitCode: 0, stdout: `${head}\n` }));
  return {
    sandbox,
    moveTo(sha: string) {
      head = sha;
    },
  };
}

function system(sandbox: InMemorySandboxManager, capture: PageCapture, onTurn?: () => void) {
  const queue = new InMemoryTurnQueue();
  const objects = new InMemoryObjectStore();
  const snapshots = new InMemorySnapshotStore();
  const lane = new ThumbnailLane({ sandbox, capture, objects, concurrency: 1, maxQueued: 8 });
  const runtime = new SingleAgentRuntime({
    sessions: new InMemorySessionStore([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]),
    sandbox,
    context: new StubContextEngine(),
    agent: new ScriptedAgent(() => {
      onTurn?.();
      return completedTurn(FIRST_SHA);
    }),
    events: new InMemoryEventStore(),
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
    objects,
    snapshots,
    thumbnails: lane,
  });
  const worker = startTurnWorker({
    queue,
    runtime,
    concurrency: 4,
    pollIntervalMs: 2,
    renewIntervalMs: 5,
  });
  workers.push(worker);
  return { queue, objects, snapshots, lane, worker };
}

const enqueue = (queue: InMemoryTurnQueue, message: string) =>
  enqueueRequest(queue, {
    sessionId: SESSION_ID,
    userId: USER_ID,
    kind: "turn",
    message,
    model: "openai/gpt-5-mini",
    billsToUser: false,
  });

describe("a photograph still being taken", () => {
  it("does not hold the session's lease", async () => {
    const capture = new GatedPageCapture();
    releases.push(() => capture.releaseAll());
    const { sandbox } = movingSandbox();
    const { queue } = system(sandbox, capture);

    await enqueue(queue, "add a delete button");

    await vi.waitFor(() => expect(capture.waiting).toBe(1));
    await vi.waitFor(async () => expect(await queue.anyLeased([SESSION_ID])).toBe(false));
  });

  it("lets a follow-up message start and finish, and does not overwrite it with the older shot", async () => {
    const capture = new GatedPageCapture();
    releases.push(() => capture.releaseAll());
    const moving = movingSandbox();
    let turns = 0;
    const { queue, objects, lane } = system(moving.sandbox, capture, () => {
      turns += 1;
      if (turns === 2) moving.moveTo(SECOND_SHA);
    });

    await enqueue(queue, "add a delete button");
    await vi.waitFor(() => expect(capture.waiting).toBe(1));

    await enqueue(queue, "now make it red");
    await vi.waitFor(() => expect(turns).toBe(2));
    await vi.waitFor(async () => expect(await queue.anyLeased([SESSION_ID])).toBe(false));
    expect(capture.requests).toHaveLength(1);

    // The first shot comes back holding a picture of an application that has since moved on.
    capture.release(new Uint8Array([1]));
    await vi.waitFor(() => expect(capture.waiting).toBe(1));
    expect(objects.keys()).not.toContain(thumbnailKey(PROJECT_ID));

    capture.release(new Uint8Array([2]));
    await vi.waitFor(() => expect(lane.pending).toBe(0));
    const stored = await objects.get(thumbnailKey(PROJECT_ID));
    expect(stored).toEqual({ ok: true, value: new Uint8Array([2]) });
  });

  it("does not make the session read as busy to the idle sweep", async () => {
    // The sweep asks `anyLeased`. A project whose only activity is its own picture being taken
    // must still be able to be put away, or a wedged browser would keep a sandbox running.
    const capture = new GatedPageCapture();
    releases.push(() => capture.releaseAll());
    const { sandbox } = movingSandbox();
    const { queue, lane } = system(sandbox, capture);

    await enqueue(queue, "add a delete button");
    await vi.waitFor(() => expect(capture.waiting).toBe(1));

    await vi.waitFor(async () => expect(await queue.anyLeased([SESSION_ID])).toBe(false));
    expect(lane.pending).toBe(1);
  });

  it("does not hold up a worker's drain", async () => {
    const capture = new GatedPageCapture();
    releases.push(() => capture.releaseAll());
    const { sandbox } = movingSandbox();
    const { queue, worker, lane } = system(sandbox, capture);

    await enqueue(queue, "add a delete button");
    await vi.waitFor(() => expect(capture.waiting).toBe(1));
    await vi.waitFor(async () => expect(await queue.anyLeased([SESSION_ID])).toBe(false));

    await worker.stop();

    // Still in flight, and the worker has finished draining all the same. What ends it is the
    // lane's own bounded stop, which `bootNap`'s shutdown calls next.
    expect(lane.pending).toBe(1);
  });
});

describe("a snapshot still being taken", () => {
  it("holds the session's lease until the bundle is recorded", async () => {
    // A restore reads the newest row. A next turn that started before this one's row existed
    // would restore from the turn before it and silently fork the project.
    const capture = new GatedPageCapture();
    releases.push(() => capture.releaseAll());
    const { sandbox } = movingSandbox();
    let turns = 0;
    const { queue, objects, snapshots } = system(sandbox, capture, () => {
      turns += 1;
    });

    let uploadAsked = false;
    let releaseUpload: () => void = () => {};
    const upload = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    releases.push(releaseUpload);
    const put = objects.put.bind(objects);
    vi.spyOn(objects, "put").mockImplementation(async (key, bytes) => {
      if (key.endsWith(".bundle")) {
        uploadAsked = true;
        await upload;
      }
      return put(key, bytes);
    });

    await enqueue(queue, "add a delete button");
    await enqueue(queue, "now make it red");

    await vi.waitFor(() => expect(uploadAsked).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(await queue.anyLeased([SESSION_ID])).toBe(true);
    expect(snapshots.all()).toHaveLength(0);
    // The follow-up is still waiting behind it rather than running beside it.
    expect(turns).toBe(1);
    expect(queue.inFlight).toBe(2);

    releaseUpload();
    await vi.waitFor(() => expect(snapshots.all().length).toBeGreaterThan(0));
    await vi.waitFor(() => expect(turns).toBe(2));
  });
});
