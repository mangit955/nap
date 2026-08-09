/**
 * Boot. The only file here with side effects, and deliberately thin — everything it wires
 * together is tested on its own, and what this file adds is exercised by actually starting
 * the process rather than by the suite.
 *
 * This is where the whole composition finally exists in one place: a sandbox manager, a
 * context engine, an agent over the model, a runtime to sequence them, and the store and bus
 * that make what they emit durable and then visible. `packages/runtime/scripts/harness.ts`
 * assembles the same thing for the command line; the difference is that this one is driven
 * by HTTP and pays for real sandboxes and real model calls.
 *
 * Runs under Bun: the default export's `fetch` and `port` are what `bun run src/index.ts`
 * serves. The test suite runs under Node, so this path is only ever proven by `bun run dev`.
 */

import { NapAgentService } from "@nap/agent/agent-service";
import { createBedrockClient, toBedrockModel } from "@nap/agent/bedrock";
import { ClaudeProvider } from "@nap/agent/claude-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { createDatabase } from "@nap/db/client";
import { InProcessEventBus } from "@nap/db/in-process-event-bus";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { createProjectSession } from "@nap/db/session-bootstrap";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { NAP_TEMPLATE } from "@nap/sandbox/template";
import { upgradeWebSocket, websocket } from "hono/bun";
import { createApp } from "./app.ts";
import { EnvValidationError, parseEnv } from "./env.ts";
import { createLogger, setRootLogger } from "./logger.ts";
import { TurnRegistry } from "./turns/registry.ts";

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

const sessions = new PostgresSessionStore(db);
const sandbox = new E2BSandboxManager({ template: NAP_TEMPLATE });

/**
 * The same models either way — only the client and the shape of the model id differ, and
 * nothing above `LLMProvider` can tell which one answered. The env check has already refused
 * to boot without whichever credentials the chosen route needs.
 */
function buildProvider(): ClaudeProvider {
  if (env.NAP_PLATFORM === "bedrock") {
    return new ClaudeProvider({
      model: toBedrockModel(env.NAP_MODEL),
      effort: env.NAP_EFFORT,
      client: createBedrockClient(),
    });
  }

  return new ClaudeProvider({ model: env.NAP_MODEL, effort: env.NAP_EFFORT });
}

// One store and one bus for the process, shared by the runtime that publishes and the socket
// that subscribes. Two instances would compile, boot, and stream nothing: the runtime would
// be announcing to a bus with no listeners while every open tab waited on an empty one.
const store = new PostgresEventStore(db);
const bus = new InProcessEventBus();

const runtime = new SingleAgentRuntime({
  sessions,
  sandbox,
  context: new NapContextEngine({ budgetTokens: env.NAP_CONTEXT_BUDGET_TOKENS }),
  agent: new NapAgentService({
    provider: buildProvider(),
    budget: { maxSteps: env.NAP_MAX_STEPS },
  }),
  events: store,
  bus,
  memory: new NoopMemoryProvider(),
});

const app = createApp({
  logger,
  stream: { store, bus, upgradeWebSocket },
  files: { sessions, sandbox },
  turns: { runtime, registry: new TurnRegistry(), sessions },
  sessions: { createSession: (options) => createProjectSession(db, options) },
});

// Said out loud at startup, because every message a user sends spends money on whatever is
// named here — that is not something anyone should first learn from an invoice.
logger.info(
  {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    platform: env.NAP_PLATFORM,
    model: env.NAP_MODEL,
    effort: env.NAP_EFFORT,
  },
  "api listening",
);

export default {
  port: env.PORT,
  fetch: app.fetch,
  // Bun dispatches socket lifecycle here; without it an upgraded connection is never read.
  websocket,
};
