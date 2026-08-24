import { describe, expect, it } from "vitest";
import { rollupSamples, type ServerSample } from "./server-samples.ts";

function sample(at: number, cpuPercent: number, rssBytes: number): ServerSample {
  return {
    at,
    cpuPercent,
    rssBytes,
    heapUsedBytes: rssBytes / 2,
    dbConnections: 5,
    dbActiveQueries: 1,
    dbPingMs: 0.5,
    systemLoad1m: 2,
    eventRows: 0,
  };
}

describe("rollupSamples", () => {
  const samples = [sample(0, 10, 100), sample(1_000, 20, 200), sample(5_000, 90, 900)];

  it("summarises each numeric series inside a window", () => {
    const [window] = rollupSamples(samples, [{ label: "10", vus: 10, from: 0, to: 2_000 }]);
    expect(window?.series.cpuPercent).toMatchObject({ count: 2, min: 10, max: 20, mean: 15 });
    expect(window?.series.rssBytes?.max).toBe(200);
    // Round-trip time to the database, which is what tells a slow query apart from a busy
    // event loop when both show up as one rising latency at the client.
    expect(window?.series.dbPingMs?.mean).toBe(0.5);
    // The whole machine, not just this process: at high VU counts the load generator is on it
    // too, and a report that cannot say so cannot claim the system under test was the limit.
    expect(window?.series.systemLoad1m?.mean).toBe(2);
  });

  it("puts each sample in the window that contains it, right edge exclusive", () => {
    const windows = rollupSamples(samples, [
      { label: "a", vus: 10, from: 0, to: 1_000 },
      { label: "b", vus: 25, from: 1_000, to: 6_000 },
    ]);
    expect(windows[0]?.series.cpuPercent?.count).toBe(1);
    expect(windows[1]?.series.cpuPercent?.count).toBe(2);
  });

  it("keeps a window nothing landed in, so a gap in sampling is visible", () => {
    const [window] = rollupSamples(samples, [{ label: "quiet", vus: 50, from: 9e9, to: 9e9 + 1 }]);
    expect(window?.label).toBe("quiet");
    expect(window?.series).toEqual({});
  });
});
