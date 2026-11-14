import { describe, expect, it } from "vitest";
import { connectionsHeld, databasePoolSize, WORKER_POOL_HEADROOM } from "./database-pool.ts";

const DEFAULTS = {
  NAP_API_DB_POOL_SIZE: 10,
  NAP_WORKER_DB_POOL_SIZE: undefined,
  NAP_REAPER_DB_POOL_SIZE: 4,
  NAP_WORKER_CONCURRENCY: 25,
  NAP_EVENT_BUS: "postgres" as const,
};

describe("databasePoolSize", () => {
  it("sizes a worker's pool from the turns it runs, plus room for what is not a turn", () => {
    expect(databasePoolSize("worker", DEFAULTS)).toBe(25 + WORKER_POOL_HEADROOM);
    expect(databasePoolSize("worker", { ...DEFAULTS, NAP_WORKER_CONCURRENCY: 5 })).toBe(
      5 + WORKER_POOL_HEADROOM,
    );
  });

  it("takes a worker pool that was set, over the derived one", () => {
    expect(databasePoolSize("worker", { ...DEFAULTS, NAP_WORKER_DB_POOL_SIZE: 40 })).toBe(40);
  });

  it("gives the API and the reaper their own, whatever the worker runs", () => {
    expect(databasePoolSize("api", { ...DEFAULTS, NAP_WORKER_CONCURRENCY: 100 })).toBe(10);
    expect(databasePoolSize("reaper", { ...DEFAULTS, NAP_WORKER_CONCURRENCY: 100 })).toBe(4);
  });

  it("gives a process running every role every role's pool", () => {
    expect(databasePoolSize("all", DEFAULTS)).toBe(10 + 25 + WORKER_POOL_HEADROOM + 4);
  });
});

describe("connectionsHeld", () => {
  it("counts the listener every process holds on the Postgres bus, and the reaper's lock", () => {
    expect(connectionsHeld("api", DEFAULTS)).toBe(10 + 1);
    expect(connectionsHeld("worker", DEFAULTS)).toBe(25 + WORKER_POOL_HEADROOM + 1);
    expect(connectionsHeld("reaper", DEFAULTS)).toBe(4 + 1 + 1);
  });

  it("counts no listener on the in-process bus, which has none", () => {
    expect(connectionsHeld("api", { ...DEFAULTS, NAP_EVENT_BUS: "in-process" })).toBe(10);
  });
});
