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
import { createOpenRouterClient, toOpenRouterModel } from "@nap/agent/openrouter";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { createDatabase, pingDatabase } from "@nap/db/client";
import { InProcessEventBus } from "@nap/db/in-process-event-bus";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresProjectSandboxStore } from "@nap/db/postgres-project-sandbox-store";
import { PostgresProjectStore } from "@nap/db/postgres-project-store";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { PostgresSnapshotStore } from "@nap/db/postgres-snapshot-store";
import { createProjectSession } from "@nap/db/session-bootstrap";
import { startReaper, sweepIdleProjects } from "@nap/runtime/reaper";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { NAP_TEMPLATE } from "@nap/sandbox/template";
import { setRootLogger } from "@nap/shared/logging";
import { createR2Client, R2ObjectStore } from "@nap/storage/r2-object-store";
import { upgradeWebSocket, websocket } from "hono/bun";
import { createApp } from "./app.ts";
import { createAuth } from "./auth/auth.ts";
import { EnvValidationError, parseEnv } from "./env.ts";
import { createHealthProbe } from "./health.ts";
import { createLogger } from "./logger.ts";
import { TurnRateLimiter } from "./turns/rate-limiter.ts";
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
// So that anything logging outside a request — the reaper's sweep, a component reporting from
// deep in a turn — reaches this stream rather than the discarding default.
setRootLogger(logger);

// One pool for the process; the stores are handed a database rather than opening their own.
const { db } = createDatabase(env.DATABASE_URL);

const sessions = new PostgresSessionStore(db);
const sandbox = new E2BSandboxManager({
  template: NAP_TEMPLATE,
  // E2B's own default is five minutes from creation, whatever is happening inside. Every
  // turn pushes this back; the reaper below is what ends a sandbox nobody is using, and it
  // takes a snapshot first.
  timeoutMs: env.NAP_SANDBOX_TTL_MINUTES * 60 * 1000,
});

// A project's bytes while nothing is running, and the rows that say where they are.
const objects = new R2ObjectStore(
  createR2Client({
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
  }),
);
const snapshots = new PostgresSnapshotStore(db);
const projectSandboxes = new PostgresProjectSandboxStore(db);
const projects = new PostgresProjectStore(db);

/**
 * The same Messages API either way — only the client and the shape of the model id differ, and
 * nothing above `LLMProvider` can tell which one answered. The env check has already refused
 * to boot without whichever credentials the chosen route needs.
 */
function buildProvider(): ClaudeProvider {
  if (env.NAP_PLATFORM === "openrouter") {
    return new ClaudeProvider({
      model: toOpenRouterModel(env.NAP_MODEL),
      effort: env.NAP_EFFORT,
      client: createOpenRouterClient(),
    });
  }

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

const registry = new TurnRegistry();

const runtime = new SingleAgentRuntime({
  sessions,
  sandbox,
  // With these, a project outlives its sandbox: a session whose sandbox is gone is restored
  // from its last snapshot rather than starting again from an empty template.
  objects,
  snapshots,
  sandboxTtlMs: env.NAP_SANDBOX_TTL_MINUTES * 60 * 1000,
  context: new NapContextEngine({ budgetTokens: env.NAP_CONTEXT_BUDGET_TOKENS }),
  agent: new NapAgentService({
    provider: buildProvider(),
    budget: { maxSteps: env.NAP_MAX_STEPS },
  }),
  events: store,
  bus,
  memory: new NoopMemoryProvider(),
});

const auth = createAuth(db, {
  secret: env.BETTER_AUTH_SECRET,
  baseUrl: env.NAP_API_URL,
  webOrigin: env.NAP_WEB_ORIGIN,
  // Both or neither — the env check has already refused to boot on one of the two.
  ...(env.GITHUB_CLIENT_ID === undefined || env.GITHUB_CLIENT_SECRET === undefined
    ? {}
    : {
        github: {
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
        },
      }),
});

const app = createApp({
  logger,
  // The two things a turn cannot happen without: the database holds every project and every
  // event, and the sandbox is where the user's app actually runs. An API that answers while
  // either is unreachable will accept a message and then fail the turn, which is exactly the
  // state worth being able to see from outside.
  health: createHealthProbe({
    checks: [
      { name: "database", probe: () => pingDatabase(db) },
      { name: "sandbox", probe: () => sandbox.ping() },
    ],
  }),
  // The browser app is on another port, so every request it makes is cross-origin and every
  // session cookie depends on this being right.
  webOrigin: env.NAP_WEB_ORIGIN,
  auth,
  // The same instance answers "who is this?" for every guarded route. Passing it here rather
  // than letting `createApp` reach into `auth` keeps the app's dependency a plain function.
  authenticate: auth.getUser,
  stream: { store, bus, sessions, upgradeWebSocket },
  files: { sessions, sandbox },
  models: { allowed: env.NAP_ALLOWED_MODELS, fallback: env.NAP_MODEL },
  turns: {
    runtime,
    registry,
    sessions,
    // The same store the project routes list from, so a project named on its first turn and one
    // renamed by hand are written through one code path.
    projects,
    allowedModels: env.NAP_ALLOWED_MODELS,
    // What one person, and this whole process, may have running at once. This endpoint is the
    // only way to start a turn, so it is the only place either ceiling has to be applied.
    limits: {
      rate: new TurnRateLimiter({ limit: env.NAP_TURNS_PER_HOUR, windowMs: 60 * 60 * 1000 }),
      projects,
      sandboxes: {
        perUser: env.NAP_MAX_SANDBOXES_PER_USER,
        total: env.NAP_MAX_SANDBOXES_TOTAL,
      },
    },
  },
  projects: {
    projects,
    projectSandboxes,
    snapshots,
    objects,
    sandbox,
    createProject: (options) => createProjectSession(db, options),
    // The same runtime the turn routes drive: resuming a project and running a turn in it are
    // serialized per session there, which is what stops the two starting two sandboxes.
    runtime,
    // The same store and bus the socket subscribes to, or a close would append `preview.stopped`
    // to a log nobody is listening on.
    events: { events: store, bus },
    // Resuming makes a sandbox, so it answers to the same ceiling a turn does.
    limits: {
      projects,
      sandboxes: {
        perUser: env.NAP_MAX_SANDBOXES_PER_USER,
        total: env.NAP_MAX_SANDBOXES_TOTAL,
      },
    },
    // The same registry the turn routes write to and the reaper reads, so "busy" means one
    // thing everywhere: closing or deleting a project mid-turn is refused for the same reason
    // the reaper skips it.
    isBusy: (sessionIds) => sessionIds.some((id) => registry.isRunning(id)),
  },
});

/**
 * Sweeps up sandboxes nobody is using, snapshotting each one before destroying it.
 *
 * The busy check reuses the registry the turn routes already write to, which is the only
 * thing in this process that knows a turn is running. It reads across a project's sessions
 * because a sandbox belongs to the project they share.
 */
const reaper = startReaper({
  intervalMs: env.NAP_REAP_INTERVAL_SECONDS * 1000,
  sweep: () =>
    sweepIdleProjects({
      projects: projectSandboxes,
      sandbox,
      objects,
      snapshots,
      idleMs: env.NAP_REAP_IDLE_MINUTES * 60 * 1000,
      isBusy: (project) => project.sessionIds.some((id) => registry.isRunning(id)),
      // A swept project's tabs are still open on it, showing an address that is about to stop
      // answering. Same store and bus as everything else, for the same reason.
      announce: { events: store, bus },
    }).then((result) => {
      if (result.reaped.length > 0) logger.info({ reaped: result.reaped }, "projects put away");
      // Their sandboxes were reclaimed by something else before we could snapshot them. Worth
      // a line each: a steady stream of these means the lifetimes above are wrong.
      for (const projectId of result.abandoned) {
        logger.warn({ projectId }, "sandbox was already gone; released without a snapshot");
      }
      for (const failure of result.failed)
        logger.error({ failure }, "could not put a project away");
    }),
  onError: (error) => logger.error({ err: error }, "reaper sweep threw"),
});

// A signal means the platform is taking the process away; stopping the timer means an
// in-flight sweep is not joined by another one on the way out.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    reaper.stop();
    process.exit(0);
  });
}

// Said out loud at startup, because every message a user sends spends money on whatever is
// named here — that is not something anyone should first learn from an invoice.
logger.info(
  {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    platform: env.NAP_PLATFORM,
    model: env.NAP_MODEL,
    effort: env.NAP_EFFORT,
    reapIdleMinutes: env.NAP_REAP_IDLE_MINUTES,
    sandboxTtlMinutes: env.NAP_SANDBOX_TTL_MINUTES,
    turnsPerHour: env.NAP_TURNS_PER_HOUR,
    maxSandboxesPerUser: env.NAP_MAX_SANDBOXES_PER_USER,
    maxSandboxesTotal: env.NAP_MAX_SANDBOXES_TOTAL,
  },
  "api listening",
);

export default {
  port: env.PORT,
  fetch: app.fetch,
  // Bun dispatches socket lifecycle here; without it an upgraded connection is never read.
  websocket,
};
