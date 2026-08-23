/**
 * The HTTP surface.
 *
 * `createApp` takes its dependencies rather than reaching for module-level singletons, so
 * tests can dispatch requests through `app.request()` with a captured logger and no socket,
 * and so boot wiring stays confined to `index.ts`.
 */

import { getLogger, type Logger, withLogContext } from "@nap/shared/logging";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { SessionStore } from "@nap/shared/ports/session-store";
import { VERSION } from "@nap/shared/version";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { WSEvents } from "hono/ws";
import { type AccountRouteDeps, registerAccountRoutes } from "./account/routes.ts";
import type { Authenticate, AuthInstance } from "./auth/auth.ts";
import { findOwnedSession } from "./auth/owned-session.ts";
import { type AuthVariables, requireUser } from "./auth/require-user.ts";
import { type FileRouteDeps, registerFileRoutes } from "./files/routes.ts";
import type { HealthProbe, HealthReport } from "./health.ts";
import { idsFromRequest } from "./log-ids.ts";
import { METRICS_CONTENT_TYPE, type Metrics } from "./metrics.ts";
import { type ModelRouteDeps, registerModelRoutes } from "./models/routes.ts";
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
  /**
   * How a request is turned into a caller. Boot passes `auth.getUser`; tests pass a stub, which
   * is what keeps every route test free of a database and a real cookie.
   *
   * **Absent means refuse, not allow.** See `requireUser` — an app assembled without a way to
   * identify anyone should reach nobody's data.
   */
  authenticate?: Authenticate;
  /**
   * Whether the dependencies a turn needs are reachable, for `/health` to report.
   *
   * Optional, and its absence means the endpoint reports `ok` with nothing named — which is
   * what it said before any of this existed, and the right answer for an app assembled with no
   * database and no sandbox provider to ask about.
   */
  health?: HealthProbe;
  /**
   * Whether this process should be *sent traffic*, for `/readyz` to answer with a status code.
   *
   * Deliberately a second probe rather than a reading of `health`, and narrower: readiness is
   * about the things only this pod can be wrong about, so an unreachable database belongs here
   * and an unreachable sandbox provider does not — every replica shares that one, and taking
   * them all out of the load balancer over it turns a partial outage into a total one.
   *
   * Optional, and absent means ready: an app assembled with no database has nothing to be
   * unready for, and answering 503 forever would be a lie about a working process.
   */
  readiness?: HealthProbe;
  /**
   * What this pod is holding, for `/metrics` to expose and the API's autoscaler to read.
   *
   * Optional, and absent means the route does not exist rather than answering an empty body: a
   * scrape target that returns nothing is indistinguishable from a pod with no sockets, and an
   * autoscaler reading a spurious zero from every replica scales the deployment to its floor.
   * A 404 is a scrape failure, which is visible.
   */
  metrics?: Metrics;
  /** Everything `/ws` needs. The store supplies the replay, the bus the live tail. */
  stream: {
    store: EventStore;
    bus: EventBus;
    /**
     * Looking up the session behind `?sessionId=` so the socket can be refused before it is
     * upgraded. Optional only because most stream tests have no store of sessions; without it
     * `/ws` refuses every connection, for the same reason `authenticate` does.
     */
    sessions?: SessionStore;
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
  /** Which models a turn may name. The picker reads this list; the turn route enforces it. */
  models?: ModelRouteDeps;
  /**
   * Saving and removing the API key somebody brought with them. Optional for the same reason
   * the rest are: an app assembled without a key store should have no route that pretends to
   * save one.
   */
  account?: AccountRouteDeps;
  /**
   * Listing, creating, closing and deleting projects — the front door. Optional for the same
   * reason as above: most route tests have no database behind them, and an app built without
   * one should have no project routes rather than routes that fail once they are called.
   */
  projects?: ProjectRouteDeps;
};

/**
 * What all three probe endpoints say, so that the *status code* is the only thing that differs
 * between them — which is the one difference a reader has to notice.
 *
 * No report means nothing was wired to ask, which is reported as `ok`: an app assembled without
 * a database has nothing to be degraded or unready about.
 */
function probeBody(report?: HealthReport) {
  if (report === undefined) return { status: "ok", version: VERSION };
  return { status: report.status, version: VERSION, checks: report.checks };
}

export function createApp(deps: AppDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

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
  // receives a logger — reports under the same ids. `sessionId` and `projectId` are picked up
  // from the path or query when present; `userId` is added by the authentication middleware
  // below, and code that learns more (the runtime, once it knows a turn id) adds it there.
  //
  // This runs before authentication on purpose: a 401 is exactly the kind of line worth being
  // able to grep, and it has no user to attribute.
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);

    await withLogContext(
      deps.logger,
      { requestId: crypto.randomUUID(), ...idsFromRequest(url) },
      async () => {
        const startedAt = performance.now();
        await next();
        // Logged after the handler so the line carries the outcome, not just the intent, and
        // through the context logger so the line itself carries the ids everything below it
        // is reporting under — otherwise the request is the one line you cannot grep for.
        // That is also why authentication enriches this context rather than nesting inside it.
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
   * Nobody reaches a route without being somebody.
   *
   * Registered here — after CORS and the logger, before every route — so a route added below is
   * guarded by existing. Making one public is an edit to the allow-list inside `requireUser`,
   * which is a decision someone has to write down rather than one they can forget to make.
   */
  app.use("*", requireUser(deps.authenticate));

  /**
   * What is reachable from here, for a person to read. The endpoint the other two are not.
   *
   * **Always 200, even when degraded.** A non-2xx here is how an orchestrator decides to
   * restart or de-register the process, and neither helps: the database being unreachable is
   * not something this process can fix by dying, and taking every instance out of rotation
   * during a shared-dependency outage turns a partial failure into a total one. The body is
   * what carries the verdict, and it is machine-readable so an alert can read it.
   *
   * Answering an automated probe is `/livez` and `/readyz` below — a status code is the only
   * thing either of those callers reads, and this one deliberately never varies it.
   */
  app.get("/health", async (c) => c.json(probeBody(await deps.health?.())));

  /**
   * Liveness: is this process still a process?
   *
   * **Never touches a dependency, and that is the entire design.** Whatever a liveness probe
   * consults becomes a reason for an orchestrator to kill the container, so pointing one at a
   * check that includes the database means a database blip restarts every replica at once —
   * the pods that were fine included. Answering at all is the whole signal.
   */
  app.get("/livez", (c) => c.json(probeBody()));

  /**
   * Readiness: should this process be sent traffic?
   *
   * The one endpoint here that answers with a **status code**, because that is the only thing
   * a load balancer reads. A pod that cannot reach Postgres cannot serve a request, and should
   * leave the rotation so that one which can takes it — the opposite of the liveness call
   * above, and the reason the two cannot be one endpoint.
   *
   * The body still names what is unready, for whoever is reading rather than probing.
   */
  app.get("/readyz", async (c) => {
    const report = await deps.readiness?.();
    return c.json(probeBody(report), report === undefined || report.status === "ok" ? 200 : 503);
  });

  /**
   * What this pod is holding, for whatever is scraping it.
   *
   * Public for the same reason the probes are — the scraper is a sidecar or a Prometheus in
   * another namespace, and neither has a session — and safe to be: the body is a count of open
   * sockets, which names no user, no project and no session. The NetworkPolicy is what keeps it
   * inside the cluster.
   */
  if (deps.metrics !== undefined) {
    const { metrics } = deps;
    app.get("/metrics", (c) =>
      c.text(metrics.render(), 200, { "content-type": METRICS_CONTENT_TYPE }),
    );
  }

  /**
   * The session's event stream: everything after `seq`, then the live tail.
   *
   * A bad query is refused *before* the upgrade, while an ordinary HTTP response can still
   * carry the reason — a socket that opens and immediately closes tells a client nothing. The
   * same goes for a session that is not the caller's: this is a stream of everything that
   * happens in somebody's project, so it is authorized like any other route reading one, and
   * refused here rather than by a socket that opens and then goes quiet.
   */
  app.get("/ws", async (c) => {
    const query = parseStreamQuery(new URL(c.req.url));
    if (!query.ok) return c.json({ error: query.error.message }, 400);

    const owned = await findOwnedSession(
      // No session store means nothing can establish whose session this is, and a stream that
      // cannot be authorized is not one to open.
      deps.stream.sessions ?? { get: async () => null, setSandboxId: async () => undefined },
      query.value.sessionId,
      c.get("userId"),
    );
    if (!owned.ok) return c.json({ error: owned.error.message }, owned.error.status);

    const { sessionId, afterSeq } = query.value;
    let stream: ReturnType<typeof openEventStream> | undefined;
    // Counted here rather than inside `openEventStream`, because the gauge is about the socket
    // rather than about the replay: a stream that fails to start still holds a connection, and
    // that is exactly the pod-level cost the autoscaler is reading.
    let released: (() => void) | undefined;
    const close = () => {
      released?.();
      stream?.onClose();
    };

    const events: WSEvents = {
      onOpen: (_event, ws) => {
        released = deps.metrics?.connectionOpened();
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
      onClose: close,
      // A socket error is a closed socket as far as this end is concerned; without this the
      // subscription and the heartbeat would outlive the connection. Both paths run for an
      // errored socket, which is why the release above is idempotent.
      onError: close,
    };

    return await deps.stream.upgradeWebSocket(c, events);
  });

  // Every method, because the library owns this whole prefix: sign-in posts, the OAuth
  // callback arrives as a GET redirect from GitHub, and which paths exist under it is its
  // business rather than this file's.
  if (deps.auth !== undefined) {
    const { auth } = deps;
    app.all("/api/auth/*", (c) => auth.handler(c.req.raw));

    // What the sign-in page needs before anybody has signed in, so it offers a button only
    // when there is something behind it — a Google or GitHub app, or the demo plugin.
    // Necessarily unauthenticated, and says nothing a stranger could not learn by pressing.
    app.get("/auth/providers", (c) =>
      c.json({ socialProviders: auth.socialProviders, demo: auth.demo }),
    );
  }

  if (deps.account !== undefined) registerAccountRoutes(app, deps.account);
  if (deps.files !== undefined) registerFileRoutes(app, deps.files);
  if (deps.turns !== undefined) registerTurnRoutes(app, deps.turns);
  if (deps.models !== undefined) registerModelRoutes(app, deps.models);
  if (deps.projects !== undefined) registerProjectRoutes(app, deps.projects);

  // Hono's default 404 is text/plain; every client of this API speaks JSON, and an HTML or
  // bare-text body on the error path turns a typo'd URL into an unreadable parse failure.
  app.notFound((c) =>
    c.json({ error: `No route for ${c.req.method} ${new URL(c.req.url).pathname}` }, 404),
  );

  app.onError((error, c) => {
    // Through the ambient logger, not `deps.logger`. A 500 is the line most worth grepping and
    // the one with least to go on — the body deliberately says nothing, so the ids are all a
    // reader gets to connect it to the request that caused it. `onError` runs inside the
    // middleware that opened the context, so they are still there to be picked up.
    getLogger().error({ err: error }, "unhandled error");
    return c.json({ error: "Internal Server Error" }, 500);
  });

  return app;
}
