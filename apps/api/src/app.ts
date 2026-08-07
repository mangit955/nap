/**
 * The HTTP surface.
 *
 * `createApp` takes its dependencies rather than reaching for module-level singletons, so
 * tests can dispatch requests through `app.request()` with a captured logger and no socket,
 * and so boot wiring stays confined to `index.ts`.
 */

import { VERSION } from "@nap/shared/version";
import { Hono } from "hono";
import { type Logger, withLogContext } from "./logger.ts";

export type AppDeps = {
  logger: Logger;
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
        // Logged after the handler so the line carries the outcome, not just the intent.
        deps.logger.info(
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
