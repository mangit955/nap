/**
 * The HTTP surface.
 *
 * `createApp` takes its dependencies rather than reaching for module-level singletons, so
 * tests can dispatch requests through `app.request()` with a captured logger and no socket,
 * and so boot wiring stays confined to `index.ts`.
 */

import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore } from "@nap/shared/ports/event-store";
import { VERSION } from "@nap/shared/version";
import { type Context, Hono } from "hono";
import type { WSEvents } from "hono/ws";
import { getLogger, type Logger, withLogContext } from "./logger.ts";
import { type HeartbeatOptions, openEventStream } from "./ws/event-stream.ts";
import { parseStreamQuery } from "./ws/query.ts";

/**
 * Turning a request into a WebSocket is the one thing that cannot happen here: it needs a
 * running `Bun.serve`, and the test suite runs under Node. Injecting it keeps this module
 * importable and its routing testable, and confines the runtime-specific half to boot.
 */
export type UpgradeWebSocket = (c: Context, events: WSEvents) => Promise<Response>;

export type AppDeps = {
  logger: Logger;
  /** Everything `/ws` needs. The store supplies the replay, the bus the live tail. */
  stream: {
    store: EventStore;
    bus: EventBus;
    upgradeWebSocket: UpgradeWebSocket;
    /** Overridden only by the smoke script, which cannot wait 30 seconds for a ping. */
    heartbeat?: HeartbeatOptions;
  };
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // Opens a log context for the request so anything downstream — including code that never
  // receives a logger — reports under the same ids. `sessionId` is picked up from the path
  // or query when present; routes that know more add to the context themselves.
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    const sessionId = c.req.param("sessionId") ?? url.searchParams.get("sessionId") ?? undefined;

    await withLogContext(
      deps.logger,
      { requestId: crypto.randomUUID(), ...(sessionId === undefined ? {} : { sessionId }) },
      async () => {
        const startedAt = performance.now();
        await next();
        // Logged after the handler so the line carries the outcome, not just the intent, and
        // through the context logger so the line itself carries the ids everything below it
        // is reporting under — otherwise the request is the one line you cannot grep for.
        getLogger().info(
          {
            method: c.req.method,
            path: url.pathname,
            status: c.res.status,
            durationMs: Math.round(performance.now() - startedAt),
          },
          "request",
        );
      },
    );
  });

  /**
   * Liveness. Deliberately does no dependency checks yet — the observability task adds
   * database and sandbox reachability behind a `checks` field and a `degraded` status,
   * which it can do without changing the two keys already here.
   */
  app.get("/health", (c) => c.json({ status: "ok", version: VERSION }));

  /**
   * The session's event stream: everything after `seq`, then the live tail.
   *
   * A bad query is refused *before* the upgrade, while an ordinary HTTP response can still
   * carry the reason — a socket that opens and immediately closes tells a client nothing.
   */
  app.get("/ws", async (c) => {
    const query = parseStreamQuery(new URL(c.req.url));
    if (!query.ok) return c.json({ error: query.error.message }, 400);

    const { sessionId, afterSeq } = query.value;
    let stream: ReturnType<typeof openEventStream> | undefined;

    const events: WSEvents = {
      onOpen: (_event, ws) => {
        stream = openEventStream({
          store: deps.stream.store,
          bus: deps.stream.bus,
          sessionId,
          afterSeq,
          socket: ws,
          ...(deps.stream.heartbeat === undefined ? {} : { heartbeat: deps.stream.heartbeat }),
        });
      },
      onMessage: (event) => stream?.onMessage(event.data),
      onClose: () => stream?.onClose(),
      // A socket error is a closed socket as far as this end is concerned; without this the
      // subscription and the heartbeat would outlive the connection.
      onError: () => stream?.onClose(),
    };

    return await deps.stream.upgradeWebSocket(c, events);
  });

  // Hono's default 404 is text/plain; every client of this API speaks JSON, and an HTML or
  // bare-text body on the error path turns a typo'd URL into an unreadable parse failure.
  app.notFound((c) =>
    c.json({ error: `No route for ${c.req.method} ${new URL(c.req.url).pathname}` }, 404),
  );

  app.onError((error, c) => {
    deps.logger.error({ err: error }, "unhandled error");
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return app;
}
