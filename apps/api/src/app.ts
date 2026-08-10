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
import { cors } from "hono/cors";
import type { WSEvents } from "hono/ws";
import type { AuthInstance } from "./auth/auth.ts";
import { type FileRouteDeps, registerFileRoutes } from "./files/routes.ts";
import { getLogger, type Logger, withLogContext } from "./logger.ts";
import { type ProjectRouteDeps, registerProjectRoutes } from "./projects/routes.ts";
import { registerTurnRoutes, type TurnRouteDeps } from "./turns/routes.ts";
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
  /**
   * The origin the browser app is served from, allowed through CORS with credentials.
   *
   * A concrete origin rather than `*`, and not because it is tidier: a browser refuses to
   * send cookies to a wildcard origin, so the two settings are a package. Omitting this
   * leaves CORS off entirely, which is right for a same-origin deployment and for the tests
   * that dispatch straight into the router.
   */
  webOrigin?: string;
  /**
   * Sign-in, sign-out and the OAuth callback, mounted under `/api/auth`. Optional like the
   * three below: an app built without it has no auth routes at all, rather than routes that
   * fail on the first request for want of a database.
   */
  auth?: AuthInstance;
  /** Everything `/ws` needs. The store supplies the replay, the bus the live tail. */
  stream: {
    store: EventStore;
    bus: EventBus;
    upgradeWebSocket: UpgradeWebSocket;
    /** Overridden only by the smoke script, which cannot wait 30 seconds for a ping. */
    heartbeat?: HeartbeatOptions;
  };
  /**
   * Reading a project's files needs a session's sandbox, which means a `SessionStore` — and
   * boot has none yet. Optional rather than required, so an app built without one has no file
   * routes at all: registering them regardless would answer a real request with an internal
   * error from a missing dependency, which is a worse answer than "no such route".
   */
  files?: FileRouteDeps;
  /**
   * Everything needed to run a turn. Optional for the same reason `files` is — most of the
   * route tests have no runtime, and an app without one should have no way to start a turn
   * rather than a route that fails once it is called.
   */
  turns?: TurnRouteDeps;
  /**
   * Listing, creating, closing and deleting projects — the front door. Optional for the same
   * reason as above: most route tests have no database behind them, and an app built without
   * one should have no project routes rather than routes that fail once they are called.
   */
  projects?: ProjectRouteDeps;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  // First, and before the logger: a preflight is answered by this middleware without ever
  // reaching a handler, and a rejected one must still carry the headers that say why.
  //
  // `credentials` is the whole point. The web app is on another origin in development, the
  // session lives in a cookie, and a browser sends that cookie cross-origin only when the
  // response both names the origin exactly and allows credentials.
  if (deps.webOrigin !== undefined) {
    app.use("*", cors({ origin: deps.webOrigin, credentials: true }));
  }

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

  // Every method, because the library owns this whole prefix: sign-in posts, the OAuth
  // callback arrives as a GET redirect from GitHub, and which paths exist under it is its
  // business rather than this file's.
  if (deps.auth !== undefined) {
    const { auth } = deps;
    app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

    // What the sign-in page needs before anybody has signed in, so it offers a GitHub button
    // only when there is a GitHub app behind it. Necessarily unauthenticated, and says
    // nothing a stranger could not learn by pressing the button.
    app.get("/auth/providers", (c) => c.json({ socialProviders: auth.socialProviders }));
  }

  if (deps.files !== undefined) registerFileRoutes(app, deps.files);
  if (deps.turns !== undefined) registerTurnRoutes(app, deps.turns);
  if (deps.projects !== undefined) registerProjectRoutes(app, deps.projects);

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
