import { GatedPageCapture } from "@nap/capture/testing/gated-page-capture";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThumbnailLane, type ThumbnailLaneOptions } from "./thumbnail-lane.ts";
import { thumbnailKey } from "./turn-thumbnail.ts";

/**
 * The lane on its own: what it runs, what it refuses and what it leaves behind.
 *
 * Nothing holds a sandbox still for it, so these are written against a workspace that a test moves
 * underneath a shot in flight. That a turn really does hand the lease back without it is
 * `after-turn-lease.test.ts`'s claim.
 */

const CLEAN = "1111111111111111111111111111111111111111\n";
const MOVED = "2222222222222222222222222222222222222222\n";
const EDITING = `${CLEAN} M src/App.tsx\n`;

const captures: GatedPageCapture[] = [];
afterEach(() => {
  for (const capture of captures.splice(0)) capture.releaseAll();
});

async function fixture(options: Partial<ThumbnailLaneOptions> = {}) {
  let workspace = CLEAN;
  const sandbox = new InMemorySandboxManager({ serves: [TEMPLATE_DEV_PORT] });
  sandbox.script(/git rev-parse HEAD/, () => ({ stdout: workspace }));
  const objects = new InMemoryObjectStore();
  const capture = new GatedPageCapture();
  captures.push(capture);
  const lane = new ThumbnailLane({
    sandbox,
    capture,
    objects,
    concurrency: 1,
    maxQueued: 8,
    ...options,
  });

  async function project() {
    const projectId = crypto.randomUUID();
    const created = await sandbox.create(projectId);
    if (!created.ok) throw new Error(created.error.message);
    return { projectId, sandboxId: created.value.id, port: TEMPLATE_DEV_PORT };
  }

  return {
    sandbox,
    objects,
    capture,
    lane,
    project,
    setWorkspace(state: string) {
      workspace = state;
    },
  };
}

describe("taking a picture", () => {
  it("stores what the browser saw under the project's key", async () => {
    const f = await fixture();
    const target = await f.project();

    await f.lane.request(target);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    f.capture.release(new Uint8Array([9]));
    await vi.waitFor(() => expect(f.lane.pending).toBe(0));

    expect(await f.objects.get(thumbnailKey(target.projectId))).toEqual({
      ok: true,
      value: new Uint8Array([9]),
    });
  });

  it("waits for the preview as long as the asker says, when it says", async () => {
    // A resume asks before the dev server has answered, so its shot may need the runtime's
    // whole preview deadline rather than the lane's short one.
    const f = await fixture();
    const waits: (number | undefined)[] = [];
    const wait = f.sandbox.waitForPreview.bind(f.sandbox);
    f.sandbox.waitForPreview = (sandboxId, port, opts) => {
      waits.push(opts?.timeoutMs);
      return wait(sandboxId, port, opts);
    };

    await f.lane.request({ ...(await f.project()), previewTimeoutMs: 20_000 });
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    await f.lane.request(await f.project());
    f.capture.release(new Uint8Array([1]));
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));

    expect(waits).toEqual([20_000, 15_000]);
  });

  it("answers the request without waiting for the browser", async () => {
    // Under the caller's lease. This resolving while the capture is open is the whole change.
    const f = await fixture();

    await f.lane.request(await f.project());

    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    expect(f.lane.pending).toBe(1);
  });

  it("keeps going after a capture fails or a store throws", async () => {
    // One lost slot at a bound of one is a worker that never photographs anything again.
    const f = await fixture();
    const [first, second, third] = [await f.project(), await f.project(), await f.project()];
    await f.lane.request(first);
    await f.lane.request(second);
    await f.lane.request(third);

    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    f.capture.fail({ code: "unavailable", message: "no browser at that path" });

    await vi.waitFor(() => expect(f.capture.requests).toHaveLength(2));
    vi.spyOn(f.objects, "put").mockRejectedValueOnce(new Error("the bucket fell over"));
    f.capture.release();

    await vi.waitFor(() => expect(f.capture.requests).toHaveLength(3));
    f.capture.release();
    await vi.waitFor(() => expect(f.lane.pending).toBe(0));
    expect(f.objects.keys()).toEqual([thumbnailKey(third.projectId)]);
  });
});

describe("the bound on how many", () => {
  it("never has more browsers open than the composition allows", async () => {
    const f = await fixture({ concurrency: 2 });
    for (let i = 0; i < 6; i += 1) await f.lane.request(await f.project());

    await vi.waitFor(() => expect(f.capture.waiting).toBe(2));
    for (let i = 0; i < 6; i += 1) {
      f.capture.release();
      await vi.waitFor(() => expect(f.lane.pending).toBeLessThanOrEqual(5 - i));
    }

    expect(f.capture.peak).toBe(2);
    expect(f.capture.requests).toHaveLength(6);
  });

  it("refuses a project past the queue's bound, and photographs the ones it kept", async () => {
    const f = await fixture({ maxQueued: 2 });
    const first = await f.project();
    const kept = [await f.project(), await f.project()];
    const refused = [await f.project(), await f.project()];
    // One in flight and two waiting is everything this will hold, however many ask.
    await f.lane.request(first);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    for (const target of [...kept, ...refused]) await f.lane.request(target);

    expect(f.lane.pending).toBe(3);
    while (f.lane.pending > 0) {
      f.capture.release();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(f.capture.requests).toHaveLength(3);
    for (const target of refused) {
      expect(f.objects.keys()).not.toContain(thumbnailKey(target.projectId));
    }
  });

  it("holds one place per project, however many times it is asked", async () => {
    const f = await fixture();
    const busy = await f.project();
    const target = await f.project();
    await f.lane.request(busy);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));

    await f.lane.request(target);
    await f.lane.request(target);
    await f.lane.request(target);

    expect(f.lane.pending).toBe(2);
  });

  it("does not let the newest request for a project lose its place in the line", async () => {
    const f = await fixture();
    const [busy, first, second] = [await f.project(), await f.project(), await f.project()];
    await f.lane.request(busy);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    await f.lane.request(first);
    await f.lane.request(second);
    await f.lane.request(first);

    f.capture.release();
    await vi.waitFor(() => expect(f.capture.requests).toHaveLength(2));
    expect(f.capture.requests[1]?.url).toContain(first.sandboxId);
  });

  it("never photographs one project twice at once, or lets the older shot land last", async () => {
    const f = await fixture({ concurrency: 2 });
    const target = await f.project();
    await f.lane.request(target);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));

    f.setWorkspace(MOVED);
    await f.lane.request(target);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.capture.waiting).toBe(1);

    f.capture.release(new Uint8Array([1]));
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    f.capture.release(new Uint8Array([2]));
    await vi.waitFor(() => expect(f.lane.pending).toBe(0));

    expect(await f.objects.get(thumbnailKey(target.projectId))).toEqual({
      ok: true,
      value: new Uint8Array([2]),
    });
  });

  it("photographs a project asked for twice while it waited once, as the newer request left it", async () => {
    // Two jobs closing in quick succession behind a busy browser. Keeping the older request would
    // spend a browser on a workspace that has already moved, and then store nothing at all.
    const f = await fixture();
    const [busy, target] = [await f.project(), await f.project()];
    await f.lane.request(busy);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));

    await f.lane.request(target);
    f.setWorkspace(MOVED);
    await f.lane.request(target);

    f.capture.release();
    await vi.waitFor(() => expect(f.capture.requests).toHaveLength(2));
    f.capture.release(new Uint8Array([2]));
    await vi.waitFor(() => expect(f.lane.pending).toBe(0));

    expect(f.capture.requests).toHaveLength(2);
    expect(await f.objects.get(thumbnailKey(target.projectId))).toEqual({
      ok: true,
      value: new Uint8Array([2]),
    });
  });

  it.each([0, -1, 1.5])("refuses a capture bound of %s rather than never photographing", (n) => {
    const sandbox = new InMemorySandboxManager();
    expect(
      () =>
        new ThumbnailLane({
          sandbox,
          capture: new GatedPageCapture(),
          objects: new InMemoryObjectStore(),
          concurrency: n,
          maxQueued: 1,
        }),
    ).toThrow(RangeError);
  });

  it.each([0, -1, 1.5])("refuses a queue bound of %s rather than never photographing", (n) => {
    // Every request waits in the queue first, even with a browser free, so a queue of nought
    // refuses all of them.
    const sandbox = new InMemorySandboxManager();
    expect(
      () =>
        new ThumbnailLane({
          sandbox,
          capture: new GatedPageCapture(),
          objects: new InMemoryObjectStore(),
          concurrency: 1,
          maxQueued: n,
        }),
    ).toThrow(RangeError);
  });
});

describe("a workspace that moves while a shot is in the lane", () => {
  it.each([
    ["a following turn has committed", MOVED],
    ["a following turn is halfway through an edit", EDITING],
  ])("launches no browser when %s", async (_, state) => {
    const f = await fixture();
    const busy = await f.project();
    const target = await f.project();
    await f.lane.request(busy);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    await f.lane.request(target);

    // Only the waiting one can be told apart here: `busy` is already past its first look.
    f.setWorkspace(state);
    f.capture.release();
    await vi.waitFor(() => expect(f.lane.pending).toBe(0));

    expect(f.capture.requests).toHaveLength(1);
  });

  it.each([
    ["a following turn has committed", MOVED],
    ["a following turn is halfway through an edit", EDITING],
  ])("keeps the picture it had when %s during the capture", async (_, state) => {
    const f = await fixture();
    const target = await f.project();
    await f.objects.put(thumbnailKey(target.projectId), new Uint8Array([7]));

    await f.lane.request(target);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    f.setWorkspace(state);
    f.capture.release(new Uint8Array([1]));
    await vi.waitFor(() => expect(f.lane.pending).toBe(0));

    expect(await f.objects.get(thumbnailKey(target.projectId))).toEqual({
      ok: true,
      value: new Uint8Array([7]),
    });
  });

  it("does not store what it saw once the sandbox has been destroyed", async () => {
    // A preview whose sandbox has gone answers with the provider's own error page, and storing
    // that would put "not found" on the card of a project that is perfectly fine.
    const f = await fixture();
    const target = await f.project();
    await f.objects.put(thumbnailKey(target.projectId), new Uint8Array([7]));

    await f.lane.request(target);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    await f.sandbox.destroy(target.sandboxId);
    f.capture.release(new Uint8Array([1]));
    await vi.waitFor(() => expect(f.lane.pending).toBe(0));

    expect(await f.objects.get(thumbnailKey(target.projectId))).toEqual({
      ok: true,
      value: new Uint8Array([7]),
    });
  });

  it("takes nothing, and throws nothing, for a sandbox that is already gone", async () => {
    const f = await fixture();
    const target = await f.project();
    await f.sandbox.destroy(target.sandboxId);

    await expect(f.lane.request(target)).resolves.toBeUndefined();

    expect(f.lane.pending).toBe(0);
    expect(f.capture.requests).toEqual([]);
  });
});

describe("what the lane does to the sandbox", () => {
  it("never creates, resumes, extends or destroys one", async () => {
    // A leaked slot of the ceiling and a sandbox kept alive by its own picture are the two failures
    // that would make this worse than the lock it replaced.
    const f = await fixture();
    const target = await f.project();
    const create = vi.spyOn(f.sandbox, "create");
    const resume = vi.spyOn(f.sandbox, "resume");
    const extend = vi.spyOn(f.sandbox, "extendTimeout");
    const destroy = vi.spyOn(f.sandbox, "destroy");

    await f.lane.request(target);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    f.capture.release();
    await vi.waitFor(() => expect(f.lane.pending).toBe(0));

    expect(create).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(extend).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(f.sandbox.timeoutOf(target.sandboxId)).toBeUndefined();
  });
});

describe("stopping", () => {
  it("drops what is waiting, launches nothing more, and waits for what is running", async () => {
    const f = await fixture();
    await f.lane.request(await f.project());
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    await f.lane.request(await f.project());
    await f.lane.request(await f.project());

    const stopping = f.lane.stop();
    f.capture.release();
    await stopping;

    expect(f.lane.pending).toBe(0);
    expect(f.capture.requests).toHaveLength(1);
    expect(f.objects.keys()).toHaveLength(1);
  });

  it("does not wait past its grace for a browser that never answers, and tells it to stop", async () => {
    const f = await fixture({ stopGraceMs: 5 });
    await f.lane.request(await f.project());
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));

    await expect(f.lane.stop()).resolves.toBeUndefined();

    // Aborted rather than abandoned: the browser is closed by its own adapter, not by the
    // process's exit, and nothing is left counted as running.
    expect(f.capture.requests[0]?.options.signal?.aborted).toBe(true);
    expect(f.lane.pending).toBe(0);
  });

  it("stores nothing from a shot that answers after it was told to stop", async () => {
    const f = await fixture({ stopGraceMs: 5 });
    const target = await f.project();
    await f.lane.request(target);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));

    await f.lane.stop();
    f.capture.release();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(f.objects.keys()).not.toContain(thumbnailKey(target.projectId));
  });

  it("refuses anything asked for afterwards", async () => {
    const f = await fixture();
    await f.lane.stop();

    await f.lane.request(await f.project());
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(f.lane.pending).toBe(0);
    expect(f.capture.requests).toEqual([]);
  });
});

describe("a shot that never finishes", () => {
  it("is given up on at its deadline, and its place goes to the next project", async () => {
    // At a bound of one, a browser that hangs would otherwise be the last picture this worker
    // ever takes: every later request waits behind it until the queue fills and drops them all.
    const f = await fixture({ shotTimeoutMs: 20 });
    const [stuck, next] = [await f.project(), await f.project()];
    await f.lane.request(stuck);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    await f.lane.request(next);

    await vi.waitFor(() => expect(f.capture.requests).toHaveLength(2));
    expect(f.capture.requests[1]?.url).toContain(next.sandboxId);
    expect(f.capture.requests[0]?.options.signal?.aborted).toBe(true);
  });

  it("stores nothing if the browser answers after the deadline", async () => {
    const f = await fixture({ shotTimeoutMs: 20 });
    const target = await f.project();
    await f.lane.request(target);
    await vi.waitFor(() => expect(f.capture.waiting).toBe(1));
    await vi.waitFor(() => expect(f.lane.pending).toBe(0));

    f.capture.release();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(f.objects.keys()).not.toContain(thumbnailKey(target.projectId));
  });

  it("rejects nothing when the late answer is a throw", async () => {
    // Nobody is awaiting a shot that was given up on, so a rejection from it would be unhandled.
    const f = await fixture({ shotTimeoutMs: 20 });
    let explode: (error: Error) => void = () => {};
    vi.spyOn(f.capture, "capture").mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          explode = reject;
        }),
    );
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await f.lane.request(await f.project());
      await vi.waitFor(() => expect(f.lane.pending).toBe(0));
      explode(new Error("the browser fell over"));
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", unhandled);
    }

    expect(unhandled).not.toHaveBeenCalled();
  });
});
