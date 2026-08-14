import { describe, expect, it } from "vitest";
import { SessionQueue } from "./session-queue.ts";

/**
 * One thing at a time per session, and nothing left behind.
 *
 * The rule exists because both paths into the runtime create a sandbox when the project has none:
 * a page that resumes on arrival while its user types a message asks for both at once, and run in
 * parallel they would each start one. The project then holds two sandboxes, one of which nobody
 * can find and nobody stops paying for.
 *
 * None of this was reachable from a test before — it lived in a private method, and a queue that
 * silently stopped serializing looks exactly like a queue that works.
 */

const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const OTHER = "9b6f3a5c-0a1d-4e77-8a24-6c1b4e0e2a3f";

/** Lets every already-scheduled continuation run, which a microtask tick alone does not. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A piece of work whose completion the test controls. */
function deferred() {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { done, release };
}

describe("one at a time, per session", () => {
  it("holds the second piece of work until the first has finished", async () => {
    const queue = new SessionQueue();
    const order: string[] = [];
    const first = deferred();

    const one = queue.run(SESSION, async () => {
      order.push("one started");
      await first.done;
      order.push("one finished");
    });
    const two = queue.run(SESSION, async () => {
      order.push("two started");
    });

    // The second has not begun, however long we wait: it is behind a piece of work that has not
    // finished.
    await Promise.resolve();
    expect(order).toEqual(["one started"]);

    first.release();
    await Promise.all([one, two]);
    expect(order).toEqual(["one started", "one finished", "two started"]);
  });

  it("lets different sessions run at the same time", async () => {
    // The lock is per session, not per process. A queue that serialized everything would make one
    // slow turn everybody's problem.
    const queue = new SessionQueue();
    const order: string[] = [];
    const held = deferred();

    const blocked = queue.run(SESSION, async () => {
      await held.done;
      order.push("first session");
    });
    await queue.run(OTHER, async () => {
      order.push("other session");
    });

    expect(order).toEqual(["other session"]);
    held.release();
    await blocked;
  });

  it("gives the caller back whatever the work returned", async () => {
    const queue = new SessionQueue();

    await expect(queue.run(SESSION, async () => "an outcome")).resolves.toBe("an outcome");
  });
});

describe("when a piece of work fails", () => {
  it("still reports the failure to whoever asked for it", async () => {
    const queue = new SessionQueue();

    await expect(
      queue.run(SESSION, async () => {
        throw new Error("the turn blew up");
      }),
    ).rejects.toThrow("the turn blew up");
  });

  it("runs the work queued behind it anyway", async () => {
    // A turn that rejected must not reject the turn queued behind it — that would be one user's
    // failure becoming another's, on a queue they cannot see.
    const queue = new SessionQueue();

    const failed = queue.run(SESSION, async () => {
      throw new Error("the turn blew up");
    });
    const after = queue.run(SESSION, async () => "ran anyway");

    await expect(failed).rejects.toThrow();
    await expect(after).resolves.toBe("ran anyway");
  });
});

describe("what the queue keeps", () => {
  it("holds an entry only while there is work in it", async () => {
    // The map is keyed by session id and the process is long-lived, so an entry that outlived its
    // work would be a slow leak — one key per session anybody ever opened.
    const queue = new SessionQueue();
    const held = deferred();

    const running = queue.run(SESSION, () => held.done);
    expect(queue.size).toBe(1);

    held.release();
    await running;
    await flush();

    expect(queue.size).toBe(0);
  });

  it("keeps the entry while work is still queued behind", async () => {
    // The half the previous test cannot see: the first piece of work finishing must not drop the
    // entry while a second is still waiting on it, or the next caller starts beside work that is
    // still running — which is the double sandbox this queue exists to prevent.
    const queue = new SessionQueue();
    const first = deferred();
    const second = deferred();
    const started: string[] = [];

    const one = queue.run(SESSION, async () => {
      started.push("one");
      await first.done;
    });
    const two = queue.run(SESSION, async () => {
      started.push("two");
      await second.done;
    });

    first.release();
    await flush();

    // The first has finished and the second is running: still exactly one entry, still held.
    expect(started).toEqual(["one", "two"]);
    expect(queue.size).toBe(1);

    second.release();
    await Promise.all([one, two]);
    await flush();
    expect(queue.size).toBe(0);
  });
});
