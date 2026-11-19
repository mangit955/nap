import type { SessionListHandler } from "@nap/shared/ports/session-list-channel";
import { describe, expect, it, vi } from "vitest";
import { createSessionListHub } from "./session-list-hub.ts";

const ALICE = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const BOB = "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a";

/** A channel whose notices the test sends by hand, counting how often it was listened to. */
function channel() {
  let handler: SessionListHandler | undefined;
  let deaf = false;
  const listen = vi.fn(async (next: SessionListHandler) => {
    handler = next;
    return async () => {};
  });
  return {
    listen,
    hearing: () => !deaf,
    deafen: (value: boolean) => {
      deaf = value;
    },
    notice: (userId: string) => handler?.(userId),
  };
}

describe("createSessionListHub", () => {
  it("hands a notice to that user's sockets on this pod, and nobody else's", async () => {
    const source = channel();
    const hub = createSessionListHub(source);
    const heard: string[] = [];
    await hub.subscribe(ALICE, () => heard.push("alice tab 1"));
    await hub.subscribe(ALICE, () => heard.push("alice tab 2"));
    await hub.subscribe(BOB, () => heard.push("bob"));

    source.notice(ALICE);

    expect(heard).toEqual(["alice tab 1", "alice tab 2"]);
  });

  it("listens once for every socket, and only once something subscribes", async () => {
    // A worker composed with the same channel serves no sockets, and must not `LISTEN` to it.
    const source = channel();
    const hub = createSessionListHub(source);
    expect(source.listen).not.toHaveBeenCalled();

    await hub.subscribe(ALICE, () => {});
    await hub.subscribe(BOB, () => {});

    expect(source.listen).toHaveBeenCalledTimes(1);
  });

  it("stops handing notices to a socket that unsubscribed", async () => {
    const source = channel();
    const hub = createSessionListHub(source);
    let heard = 0;
    const unsubscribe = await hub.subscribe(ALICE, () => heard++);

    unsubscribe();
    unsubscribe();
    source.notice(ALICE);

    expect(heard).toBe(0);
  });

  it("refuses a socket while it cannot listen, and tries again for the next one", async () => {
    const source = channel();
    const failing = vi
      .fn<typeof source.listen>()
      .mockRejectedValueOnce(new Error("listener down"))
      .mockImplementation(source.listen);
    const hub = createSessionListHub({ listen: failing, hearing: () => true });
    let heard = 0;

    await expect(hub.subscribe(ALICE, () => heard++)).rejects.toThrow("listener down");
    source.notice(ALICE);
    expect(heard).toBe(0);

    await hub.subscribe(ALICE, () => heard++);
    source.notice(ALICE);
    expect(heard).toBe(1);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("refuses a socket while the pod cannot hear notices, and says so to the ones it has", async () => {
    const source = channel();
    const hub = createSessionListHub(source);
    await hub.subscribe(ALICE, () => {});
    expect(hub.hearing()).toBe(true);

    source.deafen(true);

    expect(hub.hearing()).toBe(false);
    await expect(hub.subscribe(BOB, () => {})).rejects.toThrow("not reaching this pod");
    source.deafen(false);
    await expect(hub.subscribe(BOB, () => {})).resolves.toBeTypeOf("function");
  });
});
