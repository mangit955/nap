import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComputerControl } from "./use-computer-control.ts";

const options = {
  sessionId: "session-a",
  sourceKey: "live-a",
  active: true,
  connected: true,
  busy: false,
};
function deferred() {
  let resolve: (response: Response) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<Response>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function setup() {
  const requests: {
    url: string;
    init?: RequestInit | undefined;
    gate: ReturnType<typeof deferred>;
  }[] = [];
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    const gate = deferred();
    requests.push({ url, init, gate });
    return gate.promise;
  });
  const hook = renderHook((props) => useComputerControl({ ...props, fetch: fetcher }), {
    initialProps: options,
  });
  async function reply(index: number, body: unknown, status = 200) {
    await act(async () => {
      requests[index]?.gate.resolve(json(body, status));
    });
  }
  async function drive() {
    await reply(requests.length - 1, { available: true });
    act(() => {
      void hook.result.current.takeControl();
    });
    await reply(requests.length - 1, { grant: "private-grant", expiresAt: Date.now() + 60_000 });
    expect(hook.result.current.driving).toBe(true);
  }
  return { ...hook, requests, reply, drive, fetcher };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useComputerControl", () => {
  it("uses authoritative availability, private JSON writes and the actual applied count", async () => {
    const h = setup();
    expect(h.result.current.available).toBe(false);
    await h.drive();
    expect(h.requests[0]?.url).toMatch(/\/sessions\/session-a\/computer\/control$/);
    expect(h.requests[0]?.init).toMatchObject({
      credentials: "include",
      cache: "no-store",
      method: "GET",
    });
    expect(h.requests[1]?.init).toMatchObject({
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });
    let sent: Promise<boolean> = Promise.resolve(false);
    act(() => {
      sent = h.result.current.sendActions([{ action: "key", text: "Escape" }]);
    });
    expect(h.requests[2]?.url).toMatch(/\/computer\/input$/);
    expect(JSON.parse(String(h.requests[2]?.init?.body))).toStrictEqual({
      grant: "private-grant",
      actions: [{ action: "key", text: "Escape" }],
    });
    await h.reply(2, { applied: 1 });
    expect(await sent).toBe(true);
    expect(JSON.stringify(h.result.current)).not.toContain("private-grant");
  });

  it.each([409, 503, 403])(
    "denies availability on HTTP %s without exposing server text",
    async (status) => {
      const h = setup();
      await h.reply(0, { error: "private-grant password typed-value" }, status);
      expect(h.result.current.available).toBe(false);
      expect(h.result.current.disabledReason).toBeTruthy();
      expect(JSON.stringify(h.result.current)).not.toContain("password");
      act(() => {
        void h.result.current.takeControl();
      });
      expect(h.requests).toHaveLength(1);
    },
  );

  it.each([
    { active: false },
    { connected: false },
    { busy: true },
    { sessionId: "session-b" },
    { sourceKey: "live-b" },
  ])("discards a late grant and never resurrects control after %j", async (change) => {
    const h = setup();
    await h.reply(0, { available: true });
    act(() => {
      void h.result.current.takeControl();
    });
    h.rerender({ ...options, ...change });
    await h.reply(1, { grant: "late", expiresAt: Date.now() + 60_000 });
    expect(h.result.current.driving).toBe(false);
    expect(h.requests[1]?.init?.signal?.aborted).toBe(true);
  });

  it("a project lease during a pending grant invalidates its late success", async () => {
    const h = setup();
    await h.reply(0, { available: true });
    act(() => {
      void h.result.current.takeControl();
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await h.reply(2, { code: "busy" }, 409);
    await h.reply(1, { grant: "stale", expiresAt: Date.now() + 60_000 });
    expect(h.result.current.driving).toBe(false);
    expect(h.result.current.disabledReason).toMatch(/turn.*running/i);
  });

  it("serializes requests and coalesces only adjacent queued mouse moves", async () => {
    const h = setup();
    await h.drive();
    act(() => {
      void h.result.current.sendActions([{ action: "type", text: "a" }]);
      void h.result.current.sendActions([{ action: "mouse_move", coordinate: [1, 1] }]);
      void h.result.current.sendActions([{ action: "mouse_move", coordinate: [9, 9] }]);
      void h.result.current.sendActions([{ action: "key", text: "Return" }]);
    });
    expect(h.requests).toHaveLength(3);
    await h.reply(2, { applied: 1 });
    expect(JSON.parse(String(h.requests[3]?.init?.body)).actions).toStrictEqual([
      { action: "mouse_move", coordinate: [9, 9] },
    ]);
    await h.reply(3, { applied: 1 });
    expect(JSON.parse(String(h.requests[4]?.init?.body)).actions).toStrictEqual([
      { action: "key", text: "Return" },
    ]);
    await h.reply(4, { applied: 1 });
  });

  it.each([409, 503, 200])(
    "never replays ambiguous or partial input after status %s",
    async (status) => {
      const h = setup();
      await h.drive();
      let queued = Promise.resolve(true);
      act(() => {
        void h.result.current.sendActions([{ action: "type", text: "secret" }]);
        queued = h.result.current.sendActions([{ action: "key", text: "Return" }]);
      });
      await h.reply(2, { applied: 0 }, status);
      expect(h.result.current.driving).toBe(false);
      expect(await queued).toBe(false);
      expect(h.result.current.error).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(h.requests.filter((r) => r.url.endsWith("/input"))).toHaveLength(1);
    },
  );

  it("a lease during an inflight action drops queued actions and ignores late callbacks", async () => {
    const h = setup();
    await h.drive();
    let first = Promise.resolve(true);
    let queued = Promise.resolve(true);
    act(() => {
      first = h.result.current.sendActions([{ action: "type", text: "once" }]);
      queued = h.result.current.sendActions([{ action: "type", text: "never" }]);
    });
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    await h.reply(3, {}, 409);
    expect(await first).toBe(false);
    expect(await queued).toBe(false);
    await h.reply(2, { applied: 1 });
    expect(h.result.current.driving).toBe(false);
    expect(h.requests.filter((r) => r.url.endsWith("/input"))).toHaveLength(1);
  });

  it.each([
    { active: false },
    { connected: false },
    { busy: true },
    { sessionId: "session-b" },
    { sourceKey: "live-b" },
  ])("cancels inflight and queued input on %j", async (change) => {
    const h = setup();
    await h.drive();
    let pending = Promise.resolve(true);
    act(() => {
      void h.result.current.sendActions([{ action: "type", text: "first" }]);
      pending = h.result.current.sendActions([{ action: "type", text: "queued" }]);
    });
    h.rerender({ ...options, ...change });
    expect(await pending).toBe(false);
    await h.reply(2, { applied: 1 });
    expect(h.requests.filter((r) => r.url.endsWith("/input"))).toHaveLength(1);
  });

  it("release, expiry and unmount clear pending work and all timers", async () => {
    const h = setup();
    await h.drive();
    act(() => h.result.current.release());
    expect(h.result.current.driving).toBe(false);
    act(() => {
      void h.result.current.takeControl();
    });
    await h.reply(2, { grant: "new", expiresAt: Date.now() + 1000 });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(h.result.current.driving).toBe(false);
    expect(h.result.current.status).toMatch(/expired/i);
    h.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmount aborts a pending grant and old status cannot enable a new session", async () => {
    const h = setup();
    h.rerender({ ...options, sessionId: "session-b" });
    await h.reply(0, { available: true });
    expect(h.result.current.available).toBe(false);
    await h.reply(1, { available: true });
    act(() => {
      void h.result.current.takeControl();
    });
    h.unmount();
    await h.reply(2, { grant: "late", expiresAt: Date.now() + 60_000 });
    expect(h.requests[2]?.init?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("validates the human wire boundary before any dispatch", async () => {
    const h = setup();
    await h.drive();
    await act(async () => {
      expect(await h.result.current.sendActions([])).toBe(false);
      expect(await h.result.current.sendActions([{ action: "type", text: "x".repeat(2001) }])).toBe(
        false,
      );
      expect(
        await h.result.current.sendActions(
          Array.from({ length: 17 }, () => ({ action: "key", text: "a" })),
        ),
      ).toBe(false);
    });
    expect(h.requests).toHaveLength(2);
  });
});

it("a rejected input ends control without leaking error text or resending queued text", async () => {
  const h = setup();
  await h.drive();
  let pending = Promise.resolve(true);
  act(() => {
    void h.result.current.sendActions([{ action: "type", text: "once" }]);
    pending = h.result.current.sendActions([{ action: "type", text: "never" }]);
  });
  await act(async () => {
    h.requests[2]?.gate.reject(new Error("private-grant typed-value password"));
  });
  expect(await pending).toBe(false);
  expect(h.result.current.driving).toBe(false);
  expect(h.result.current.error).not.toMatch(/private-grant|typed-value|password/);
  expect(h.requests.filter((r) => r.url.endsWith("/input"))).toHaveLength(1);
});
it("release invalidates a pending grant without waiting for a fetch that ignores abort", async () => {
  const h = setup();
  await h.reply(0, { available: true });
  act(() => {
    void h.result.current.takeControl();
    h.result.current.release();
  });
  await h.reply(1, { grant: "stale", expiresAt: Date.now() + 60_000 });
  expect(h.result.current.driving).toBe(false);
  expect(h.result.current.status).toBe("Control released.");
});
it("a late retired input cannot cancel or drain the next takeover's input", async () => {
  const h = setup();
  await h.drive();
  act(() => {
    void h.result.current.sendActions([{ action: "type", text: "retired" }]);
    h.result.current.release();
  });
  act(() => {
    void h.result.current.takeControl();
  });
  await h.reply(3, { grant: "fresh", expiresAt: Date.now() + 60_000 });
  act(() => {
    void h.result.current.sendActions([{ action: "key", text: "a" }]);
  });
  await h.reply(2, { applied: 0 }, 503);
  expect(h.result.current.driving).toBe(true);
  await h.reply(4, { applied: 1 });
  expect(h.result.current.driving).toBe(true);
});
it("rejects forbidden held/observation actions from untyped callers", async () => {
  const h = setup();
  await h.drive();
  await act(async () => {
    // @ts-expect-error Deliberately bypass types to verify the external input boundary.
    expect(await h.result.current.sendActions([{ action: "left_mouse_down" }])).toBe(false);
    // @ts-expect-error Deliberately bypass types to verify the external input boundary.
    expect(await h.result.current.sendActions([{ action: "left_mouse_up" }])).toBe(false);
    // @ts-expect-error Deliberately bypass types to verify the external input boundary.
    expect(await h.result.current.sendActions([{ action: "wait", duration: 1 }])).toBe(false);
    // @ts-expect-error Deliberately bypass types to verify the external input boundary.
    expect(await h.result.current.sendActions([{ action: "read_dom" }])).toBe(false);
    // @ts-expect-error Deliberately bypass types to verify the external input boundary.
    expect(await h.result.current.sendActions([{ action: "screenshot" }])).toBe(false);
    expect(await h.result.current.sendActions([{ action: "key", text: "a;b" }])).toBe(false);
  });
  expect(h.requests).toHaveLength(2);
});
it.each([{ available: false }, { available: true, grant: "must-not-be-accepted" }])(
  "rejects malformed authoritative status %j",
  async (body) => {
    const h = setup();
    await h.reply(0, body);
    expect(h.result.current.available).toBe(false);
  },
);
it("does not dispatch input after clock expiry even before the timer callback runs", async () => {
  const h = setup();
  await h.drive();
  vi.setSystemTime(Date.now() + 60_001);
  await act(async () => {
    expect(await h.result.current.sendActions([{ action: "key", text: "a" }])).toBe(false);
  });
  expect(h.requests).toHaveLength(2);
  expect(h.result.current.driving).toBe(false);
});
