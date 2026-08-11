import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealthProbe } from "./health.ts";

/**
 * `/health` is unauthenticated and polled by things with no session, so these tests are as
 * much about what the endpoint must *not* do — hang, throw, or make an API call per poll — as
 * about what it reports.
 */

afterEach(() => {
  vi.useRealTimers();
});

const resolves = () => Promise.resolve();
const rejects = () => Promise.reject(new Error("connection refused"));

describe("createHealthProbe", () => {
  it("reports ok when every dependency answers", async () => {
    const probe = createHealthProbe({
      checks: [
        { name: "database", probe: resolves },
        { name: "sandbox", probe: resolves },
      ],
    });

    await expect(probe()).resolves.toEqual({
      status: "ok",
      checks: { database: "ok", sandbox: "ok" },
    });
  });

  it("reports degraded, and names which dependency, when one is down", async () => {
    // Which one is the whole value of the endpoint: "degraded" alone sends an operator
    // looking, and this tells them where.
    const probe = createHealthProbe({
      checks: [
        { name: "database", probe: resolves },
        { name: "sandbox", probe: rejects },
      ],
    });

    await expect(probe()).resolves.toEqual({
      status: "degraded",
      checks: { database: "ok", sandbox: "down" },
    });
  });

  it("does not reject when a probe throws synchronously", async () => {
    // A health endpoint that 500s because a dependency is down reports nothing about the
    // dependencies that are still up.
    const probe = createHealthProbe({
      checks: [
        {
          name: "database",
          probe: () => {
            throw new Error("no pool");
          },
        },
      ],
    });

    await expect(probe()).resolves.toEqual({ status: "degraded", checks: { database: "down" } });
  });

  it("tolerates a slow first connection by default, rather than crying outage", async () => {
    vi.useFakeTimers();
    // Measured, not guessed: a Neon instance that has scaled to zero answers its first query in
    // ~1.8s, and with the original 2s deadline the first poll after a cold boot reported
    // `degraded` on a healthy system. A false outage is the reading that teaches people to
    // ignore the endpoint, so the default has to clear a real cold start with margin.
    const probe = createHealthProbe({
      checks: [
        {
          name: "database",
          probe: () => new Promise((resolve) => setTimeout(resolve, 3000)),
        },
      ],
    });

    const report = probe();
    await vi.advanceTimersByTimeAsync(3000);

    await expect(report).resolves.toEqual({ status: "ok", checks: { database: "ok" } });
  });

  it("gives up on a probe that hangs rather than hanging with it", async () => {
    vi.useFakeTimers();
    // The failure this is for: a database that accepts the connection and never answers. With
    // no deadline, /health stops responding at exactly the moment somebody needs it to.
    const probe = createHealthProbe({
      checks: [{ name: "database", probe: () => new Promise(() => {}) }],
      timeoutMs: 2000,
    });

    const report = probe();
    await vi.advanceTimersByTimeAsync(2000);

    await expect(report).resolves.toEqual({ status: "degraded", checks: { database: "down" } });
  });

  it("swallows a probe that fails after its deadline has already passed", async () => {
    vi.useFakeTimers();
    // The race is settled by then, so nothing is listening to the probe any more — and an
    // unhandled rejection under Bun ends the process. A health check that takes the server
    // down when a dependency is slow *and* then fails is worse than having no check.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);

    try {
      const probe = createHealthProbe({
        checks: [
          {
            name: "database",
            probe: () =>
              new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error("too late")), 5000);
              }),
          },
        ],
        timeoutMs: 2000,
      });

      const report = probe();
      await vi.advanceTimersByTimeAsync(2000);
      await expect(report).resolves.toMatchObject({ checks: { database: "down" } });

      // Now let the probe fail, long after anybody cared.
      await vi.advanceTimersByTimeAsync(3000);
      await vi.advanceTimersByTimeAsync(0);

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("leaves no timer running once a probe has answered", async () => {
    vi.useFakeTimers();
    const probe = createHealthProbe({
      checks: [{ name: "database", probe: resolves }],
      timeoutMs: 2000,
    });

    await probe();

    // A deadline that is never cleared keeps the event loop alive per poll, which on a health
    // endpoint is once every few seconds forever.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caches the report, so polling does not bill an API call per request", async () => {
    let calls = 0;
    const probe = createHealthProbe({
      checks: [
        {
          name: "sandbox",
          probe: async () => {
            calls += 1;
          },
        },
      ],
      ttlMs: 5000,
      now: () => 1000,
    });

    await probe();
    await probe();
    await probe();

    // The endpoint is public. Without this, anyone who can reach it can drive load against
    // the sandbox provider's API for free.
    expect(calls).toBe(1);
  });

  it("re-checks once the cached report is stale", async () => {
    let calls = 0;
    let clock = 1000;
    const probe = createHealthProbe({
      checks: [
        {
          name: "sandbox",
          probe: async () => {
            calls += 1;
          },
        },
      ],
      ttlMs: 5000,
      now: () => clock,
    });

    await probe();
    clock += 5000;
    await probe();

    // Or a dependency that recovered would be reported down until the process restarted.
    expect(calls).toBe(2);
  });

  it("collapses concurrent polls into one round of checks", async () => {
    let calls = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const probe = createHealthProbe({
      checks: [
        {
          name: "sandbox",
          probe: async () => {
            calls += 1;
            await gate;
          },
        },
      ],
    });

    const [first, second] = [probe(), probe()];
    release();
    await Promise.all([first, second]);

    // Two load balancers polling at once must not double the work; without this the cache
    // only helps requests that arrive after a round has finished.
    expect(calls).toBe(1);
  });

  it("reports ok with no checks at all", async () => {
    // An app assembled without dependency probes still answers liveness, which is what
    // `/health` meant before any of this existed.
    await expect(createHealthProbe({ checks: [] })()).resolves.toEqual({
      status: "ok",
      checks: {},
    });
  });
});
