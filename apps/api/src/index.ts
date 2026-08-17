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
import { ChromePageCapture } from "@nap/capture/chrome-page-capture";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { createDatabase, pingDatabase } from "@nap/db/client";
import { InProcessEventBus } from "@nap/db/in-process-event-bus";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresProjectSandboxStore } from "@nap/db/postgres-project-sandbox-store";
import { PostgresProjectStore } from "@nap/db/postgres-project-store";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { PostgresSnapshotStore } from "@nap/db/postgres-snapshot-store";
import { PostgresUserKeyStore } from "@nap/db/postgres-user-key-store";
import { createProjectSession } from "@nap/db/session-bootstrap";
import { startReaper, sweepIdleProjects } from "@nap/runtime/reaper";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { NAP_TEMPLATE } from "@nap/sandbox/template";
import { setRootLogger } from "@nap/shared/logging";
import { createR2Client, R2ObjectStore } from "@nap/storage/r2-object-store";
import { upgradeWebSocket, websocket } from "hono/bun";
import { createKeyVerifier } from "./account/routes.ts";
import { encryptionKeyFrom, open } from "./account/secret-box.ts";
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
/**
 * The browser that photographs projects for the dashboard's cards, if this machine has one.
 *
 * One instance, shared by everything that can catch a project while it is running: the end of a
 * turn, and a project coming back up. Closing is deliberately not one of them — the picture it
 * would take is the one the last turn already took, and waiting for a page load would hold the
 * close request open before teardown even started. Undefined is an ordinary state — both call
 * sites skip the picture and the cards fall back to a colour.
 */
const capture =
  env.NAP_CHROME_PATH === undefined
    ? undefined
    : new ChromePageCapture({ executablePath: env.NAP_CHROME_PATH });

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
  // A picture of each finished turn, and of each project coming back up.
  ...(capture === undefined ? {} : { capture }),
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
  ...(env.GOOGLE_CLIENT_ID === undefined || env.GOOGLE_CLIENT_SECRET === undefined
    ? {}
    : {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
        },
      }),
  allowAnonymous: env.NAP_ALLOW_DEMO,
});

/**
 * The keys people brought with them, and the secret that seals them.
 *
 * `openCallerKey` is the one place ciphertext becomes a credential. It answers `null` for
 * anything it cannot open — a key sealed under a secret that has since been rotated — which
 * puts that person back on the free tier rather than failing their turn with something they
 * cannot act on. Their next save fixes it, and the log line is what says why it happened.
 */
const userKeys = new PostgresUserKeyStore(db);
const encryptionKey = encryptionKeyFrom(env.NAP_KEY_ENCRYPTION_SECRET);

const openCallerKey = async (userId: string) => {
  const stored = await userKeys.get(userId);
  if (stored === null) return null;

  const opened = open({ ciphertext: stored.ciphertext, iv: stored.iv }, encryptionKey);
  if (!opened.ok) {
    logger.warn({ userId, reason: opened.reason }, "stored API key could not be opened");
    return null;
  }

  return { platform: stored.platform, apiKey: opened.value };
};

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
  account: {
    keys: userKeys,
    encryptionKey,
    verify: createKeyVerifier(),
  },
  models: {
    allowed: env.NAP_ALLOWED_MODELS,
    fallback: env.NAP_MODEL,
    freeModel: env.NAP_FREE_MODEL,
    // The stored record, not the opened key: the picker needs the platform and the hint, and
    // nothing on that route spends anything.
    keys: (userId) => userKeys.get(userId),
  },
  turns: {
    runtime,
    registry,
    sessions,
    // Who pays for each turn, which is also what decides the models they may name.
    keys: openCallerKey,
    freeModel: env.NAP_FREE_MODEL,
    defaultModel: env.NAP_MODEL,
    // The same store the project routes list from, so a project named on its first turn and one
    // renamed by hand are written through one code path.
    projects,
    allowedModels: env.NAP_ALLOWED_MODELS,
    // What one person, and this whole process, may have running at once. This endpoint is the
    // only way to start a turn, so it is the only place either ceiling has to be applied.
    limits: {
      rate: new TurnRateLimiter({ limit: env.NAP_TURNS_PER_HOUR, windowMs: 60 * 60 * 1000 }),
      // The tighter one, for turns this deployment is paying for. Its own limiter rather than
      // its own number, so a person's paid turns cannot eat their free allowance.
      freeRate: new TurnRateLimiter({
        limit: env.NAP_FREE_TURNS_PER_HOUR,
        windowMs: 60 * 60 * 1000,
      }),
      projects,
      sandboxes: {
        perUser: env.NAP_MAX_SANDBOXES_PER_USER,
        total: env.NAP_MAX_SANDBOXES_TOTAL,
      },
      freeSandboxes: {
        perUser: env.NAP_FREE_MAX_SANDBOXES_PER_USER,
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
    // Opening a project can continue a job a restart left open, which spends tokens — so it is
    // billed exactly as a turn is, to whoever is standing in front of it.
    models: {
      keys: openCallerKey,
      allowedModels: env.NAP_ALLOWED_MODELS,
      freeModel: env.NAP_FREE_MODEL,
      defaultModel: env.NAP_MODEL,
    },
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
    // Whether the dashboard's cards will get pictures. Off is a perfectly good state to run in,
    // but it is indistinguishable from a capture that keeps failing unless the boot says which.
    screenshots: env.NAP_CHROME_PATH === undefined ? "off" : "on",
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
