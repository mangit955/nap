/**
 * The API process: HTTP, WebSockets, auth, admission. It executes no turns.
 *
 * A turn that arrives here is validated, charged against the caller's allowance and written to
 * `turn_requests` as a row; a worker somewhere else claims it and runs it, and its events come
 * back to the sockets held here through the log and the bus. `docs/scaling-design.md` §4 is the
 * responsibility split, and `worker.ts` is the other half.
 *
 * Everything this file used to do is in `boot.ts`, which both entrypoints share. What is left is
 * the part that is genuinely about *serving*: saying what is about to be served, and exporting the
 * fetch handler Bun needs.
 *
 * Runs under Bun: the default export's `fetch` and `port` are what `bun run src/index.ts` serves.
 * The test suite runs under Node, so this path is only ever proven by actually starting it.
 */

import { websocket } from "hono/bun";
import { bootNap } from "./boot.ts";
import { announce } from "./boot-line.ts";

const nap = await bootNap("api");

announce(nap, "api listening", {
  port: nap.env.PORT,
  // Whether the dashboard's cards will get pictures. Off is a perfectly good state to run in, but
  // it is indistinguishable from a capture that keeps failing unless the boot says which.
  screenshots: nap.env.NAP_CHROME_PATH === undefined ? "off" : "on",
  turnsPerHour: nap.env.NAP_TURNS_PER_HOUR,
  maxSandboxesPerUser: nap.env.NAP_MAX_SANDBOXES_PER_USER,
  maxSandboxesTotal: nap.env.NAP_MAX_SANDBOXES_TOTAL,
});

export default {
  port: nap.env.PORT,
  fetch: nap.composed.app.fetch,
  // Bun closes an HTTP connection that has sent nothing for 10s by default, including one still
  // waiting on its handler. A request slowed by an upstream — GitHub listing a large installation —
  // then reaches the browser as a dropped connection, which the web app can only report as "could
  // not reach the server". A slow upstream should surface as a slow response. Sockets have their
  // own timeout on `websocket`, so this does not change how long an idle chat stream lives.
  idleTimeout: 30,
  // Bun dispatches socket lifecycle here; without it an upgraded connection is never read.
  websocket,
};
