/**
 * Boot. The only file here with side effects, and deliberately thin — everything it wires
 * together is tested on its own, and what this file adds is exercised by actually starting
 * the process rather than by the suite.
 *
 * Runs under Bun: the default export's `fetch` and `port` are what `bun run src/index.ts`
 * serves. The test suite runs under Node, so this path is only ever proven by `bun run dev`.
 */

import { createDatabase } from "@nap/db/client";
import { InProcessEventBus } from "@nap/db/in-process-event-bus";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { upgradeWebSocket, websocket } from "hono/bun";
import { createApp } from "./app.ts";
import { EnvValidationError, parseEnv } from "./env.ts";
import { createLogger, setRootLogger } from "./logger.ts";

// Before anything else: an unusable environment should kill the process here, with a
// message naming every problem, rather than surfacing as a confusing failure later.
// Printed and exited rather than thrown — a stack trace through Zod tells an operator
// nothing they can act on, and the message already says exactly what to fix.
function loadEnv() {
  try {
    return parseEnv(process.env);
  } catch (error) {
    if (error instanceof EnvValidationError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const env = loadEnv();

const logger = createLogger({ level: env.LOG_LEVEL });
setRootLogger(logger);

// One pool for the process; the stores are handed a database rather than opening their own.
const { db } = createDatabase(env.DATABASE_URL);

const app = createApp({
  logger,
  stream: {
    store: new PostgresEventStore(db),
    // In-process fanout: one API process, and the port is what keeps a cross-process
    // transport additive later.
    bus: new InProcessEventBus(),
    upgradeWebSocket,
  },
});

logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, "api listening");

export default {
  port: env.PORT,
  fetch: app.fetch,
  // Bun dispatches socket lifecycle here; without it an upgraded connection is never read.
  websocket,
};
