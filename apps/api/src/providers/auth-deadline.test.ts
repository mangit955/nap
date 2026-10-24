import { afterEach, expect, it, vi } from "vitest";
import { withAuthDeadline } from "./auth-deadline.ts";

afterEach(() => vi.useRealTimers());
it("cleans up its deadline after a completed provider operation", async () => {
  vi.useFakeTimers();
  let observed: AbortSignal | undefined;
  await expect(
    withAuthDeadline({
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxDurationMs: 20_000,
      action: async (signal) => {
        observed = signal;
        return "verified";
      },
    }),
  ).resolves.toBe("verified");
  expect(observed?.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds an adapter that ignores abort and aborts its signal without leaking a timer", async () => {
  vi.useFakeTimers();
  let observed: AbortSignal | undefined;
  const pending = withAuthDeadline({
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    maxDurationMs: 20_000,
    action: (signal) => {
      observed = signal;
      return new Promise(() => {});
    },
  });
  const failed = expect(pending).rejects.toThrow("Provider authentication deadline reached");
  await vi.advanceTimersByTimeAsync(20_000);
  await failed;
  expect(observed?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("uses the earlier flow expiry and clears its timer when an adapter fails", async () => {
  vi.useFakeTimers();
  const pending = withAuthDeadline({
    expiresAt: new Date(Date.now() + 50).toISOString(),
    maxDurationMs: 20_000,
    action: () => new Promise(() => {}),
  });
  const failed = expect(pending).rejects.toThrow("Provider authentication deadline reached");
  await vi.advanceTimersByTimeAsync(50);
  await failed;
  await expect(
    withAuthDeadline({
      expiresAt: new Date(Date.now() + 100).toISOString(),
      maxDurationMs: 20,
      action: async () => {
        throw new Error("provider error");
      },
    }),
  ).rejects.toThrow("provider error");
  expect(vi.getTimerCount()).toBe(0);
});
