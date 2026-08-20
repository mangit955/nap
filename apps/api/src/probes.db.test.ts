import { setTimeout as sleep } from "node:timers/promises";
import { createDatabase, pingDatabase } from "@nap/db/client";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { describe, expect, inject, it } from "vitest";
import { createApp } from "./app.ts";
import { createHealthProbe, type HealthCheck } from "./health.ts";
import { createLogger } from "./logger.ts";

/**
 * The probe split against a database that is genuinely there and genuinely not.
 *
 * The route tests upstairs hand `/readyz` a function that says "degraded", which proves the
 * status code and nothing about the chain that produces it. This one runs the whole thing —
 * `pingDatabase` over a real pool, through `createHealthProbe`, into the route — because the
 * claim being made to a kubelet is about Postgres rather than about a stub, and the only way
 * to be wrong about it is at one of the joins.
 *
 * Closing the pool is how a real outage arrives here: not a query that errors, but a pool that
 * has nothing behind it.
 */

const silent = () => createLogger({ level: "silent" }, { write: () => {} });

function appWithReadiness(probe: () => Promise<unknown>, extra: HealthCheck[] = []) {
  return createApp({
    logger: silent(),
    // The same 1s boot gives readiness, so a recovery becomes visible here on the same
    // schedule a load balancer would see it on.
    readiness: createHealthProbe({ checks: [{ name: "database", probe }, ...extra], ttlMs: 1000 }),
    stream: {
      store: new InMemoryEventStore(),
      bus: new InMemoryEventBus(),
      upgradeWebSocket: async () => new Response(null),
    },
  });
}

describe("the probe endpoints against a real database", () => {
  it("answers readiness 200 while Postgres is reachable", async () => {
    const { db, close } = createDatabase(inject("postgresUrl"), { max: 1 });
    try {
      const app = appWithReadiness(() => pingDatabase(db));

      const res = await app.request("/readyz");
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ checks: { database: "ok" } });
    } finally {
      await close();
    }
  });

  it("answers readiness 503 and liveness 200 once Postgres is gone", async () => {
    const { db, close } = createDatabase(inject("postgresUrl"), { max: 1 });
    await close();

    const app = appWithReadiness(() => pingDatabase(db));

    // Out of the load balancer — another replica can serve this request.
    expect((await app.request("/readyz")).status).toBe(503);
    // But not restarted. Killing the container would not bring Postgres back; it would only
    // remove the process that was still able to say so, and during a shared outage it would
    // do that to every replica at once.
    expect((await app.request("/livez")).status).toBe(200);
  });

  it("answers readiness 503 when the event listener has stopped delivering", async () => {
    const { db, close } = createDatabase(inject("postgresUrl"), { max: 1 });
    try {
      let listening = false;
      const app = appWithReadiness(
        () => pingDatabase(db),
        [
          {
            name: "listener",
            probe: async () => {
              if (!listening) throw new Error("the event listener has stopped delivering");
            },
          },
        ],
      );

      // Design §24 item 5, decided: **fail rather than warn.** This pod can still serve HTTP
      // and can still replay from the log — the catch-up poll covers fanout — but "covers"
      // means every event arrives up to a poll interval late, and another pod is streaming
      // properly. Postgres being reachable is not enough to be ready.
      const down = await app.request("/readyz");
      expect(down.status).toBe(503);
      await expect(down.json()).resolves.toMatchObject({
        checks: { database: "ok", listener: "down" },
      });

      // And it rejoins on its own once the connection comes back, which is why this is not a
      // liveness failure: restarting the process would only throw away the sockets it still had.
      listening = true;
      // Past the readiness probe's own cache, which is what makes recovery visible at all.
      await sleep(1100);

      expect((await app.request("/readyz")).status).toBe(200);
    } finally {
      await close();
    }
  });
});
