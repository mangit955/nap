/**
 * Boot. The only file here with side effects, and deliberately thin — everything it wires
 * together is tested on its own, and what this file adds is exercised by actually starting
 * the process rather than by the suite.
 *
 * What it does is the part that is genuinely about *this process*: read and validate the
 * environment, build the real clients — E2B, R2, OpenRouter, Postgres, a browser — hand them
 * to `composeNap`, and say out loud what it is about to spend money on. The composition
 * itself lives in `compose.ts`, so that a load harness and a worker entrypoint can assemble
 * the same system from different parts rather than growing a second copy of this file.
 *
 * Runs under Bun: the default export's `fetch` and `port` are what `bun run src/index.ts`
 * serves. The test suite runs under Node, so this path is only ever proven by `bun run dev`.
 */

import { createBedrockClient, toBedrockModel } from "@nap/agent/bedrock";
import { ClaudeProvider } from "@nap/agent/claude-provider";
import { createOpenRouterClient, toOpenRouterModel } from "@nap/agent/openrouter";
import { ChromePageCapture } from "@nap/capture/chrome-page-capture";
import { createDatabase, createListenerConnection, pingDatabase } from "@nap/db/client";
import { InProcessEventBus } from "@nap/db/in-process-event-bus";
import { PostgresCapacityReconciler } from "@nap/db/postgres-capacity-reconciler";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresNotifyEventBus } from "@nap/db/postgres-notify-event-bus";
import { PostgresNotifyTransport } from "@nap/db/postgres-notify-transport";
import { PostgresProjectSandboxStore } from "@nap/db/postgres-project-sandbox-store";
import { PostgresProjectStore } from "@nap/db/postgres-project-store";
import { PostgresSandboxCapacity } from "@nap/db/postgres-sandbox-capacity";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { PostgresSnapshotStore } from "@nap/db/postgres-snapshot-store";
import { PostgresUserKeyStore } from "@nap/db/postgres-user-key-store";
import { createProjectSession } from "@nap/db/session-bootstrap";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { NAP_TEMPLATE } from "@nap/sandbox/template";
import { setRootLogger } from "@nap/shared/logging";
import { createR2Client, R2ObjectStore } from "@nap/storage/r2-object-store";
import { upgradeWebSocket, websocket } from "hono/bun";
import { createKeyVerifier } from "./account/routes.ts";
import { encryptionKeyFrom } from "./account/secret-box.ts";
import { createAuth } from "./auth/auth.ts";
import { composeNap } from "./compose.ts";
import { EnvValidationError, parseEnv } from "./env.ts";
import { createHealthProbe } from "./health.ts";
import { createLogger } from "./logger.ts";

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
const { db, client } = createDatabase(env.DATABASE_URL);

const events = new PostgresEventStore(db);

/**
 * How a turn's events reach the sockets watching them.
 *
 * Both implement the same port, so nothing above this line can tell which one it got — the
 * difference is only whether a socket on *another* process hears anything. The Postgres one is
 * behind an environment switch rather than simply replacing the other, because one replica is
 * what is deployed today and a fanout change is not the sort of thing to prove in production.
 *
 * `start()` is awaited at the top level: a process that could not open its `LISTEN` connection
 * has no business answering requests, and the failure should be a boot that dies loudly rather
 * than a server that streams nothing.
 */
const notifyBus =
  env.NAP_EVENT_BUS === "postgres"
    ? new PostgresNotifyEventBus({
        reader: events,
        transport: new PostgresNotifyTransport({
          notifier: client,
          listener: createListenerConnection(env.NAP_LISTEN_DATABASE_URL ?? env.DATABASE_URL),
        }),
      })
    : null;

const bus = notifyBus ?? new InProcessEventBus();

if (notifyBus !== null) await notifyBus.start();

const sandbox = new E2BSandboxManager({
  template: NAP_TEMPLATE,
  // E2B's own default is five minutes from creation, whatever is happening inside. Every
  // turn pushes this back; the reaper is what ends a sandbox nobody is using, and it takes a
  // snapshot first.
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

const { app, reaper } = composeNap({
  config: env,
  logger,
  sessions: new PostgresSessionStore(db),
  projects: new PostgresProjectStore(db),
  projectSandboxes: new PostgresProjectSandboxStore(db),
  // The ceiling that bounds this deployment's E2B bill, held in rows rather than in this
  // process: the count and the creation it guards happen in one transaction, so a burst of
  // turns across every replica cannot all find themselves under the cap at once.
  capacity: new PostgresSandboxCapacity(db, {
    perUser: env.NAP_MAX_SANDBOXES_PER_USER,
    total: env.NAP_MAX_SANDBOXES_TOTAL,
  }),
  // What makes that ceiling self-healing rather than a number that only ever shrinks. The
  // inventory is the E2B manager itself: `list` is on `SandboxInventory` rather than on
  // `SandboxManager`, for the reason `ping` is — it is a question about the deployment rather
  // than about one project's workspace.
  reconcile: { reconciler: new PostgresCapacityReconciler(db), inventory: sandbox },
  snapshots: new PostgresSnapshotStore(db),
  userKeys: new PostgresUserKeyStore(db),
  // One store and one bus for the process, shared by the runtime that publishes and the socket
  // that subscribes. Two instances would compile, boot, and stream nothing: the runtime would
  // be announcing to a bus with no listeners while every open tab waited on an empty one.
  events,
  bus,
  sandbox,
  objects,
  provider: buildProvider(),
  ...(capture === undefined ? {} : { capture }),
  auth,
  authenticate: auth.getUser,
  // The secret that seals the keys people brought with them, and the vendor call that refuses a
  // typo before it is stored.
  encryptionKey: encryptionKeyFrom(env.NAP_KEY_ENCRYPTION_SECRET),
  verifyKey: createKeyVerifier(),
  createProject: (options) => createProjectSession(db, options),
  upgradeWebSocket,
  // The two things a turn cannot happen without: the database holds every project and every
  // event, and the sandbox is where the user's app actually runs. An API that answers while
  // either is unreachable will accept a message and then fail the turn, which is exactly the
  // state worth being able to see from outside. Built here rather than in the composition
  // because `ping()` is deliberately not on the `SandboxManager` port.
  health: createHealthProbe({
    checks: [
      { name: "database", probe: () => pingDatabase(db) },
      { name: "sandbox", probe: () => sandbox.ping() },
    ],
  }),
  // Readiness is only the database, and its own probe rather than a reading of the one above:
  // a slow sandbox provider must not delay the answer to "may this pod have traffic", and an
  // unreachable one must not change it — every replica shares that provider, so de-registering
  // on it would empty the load balancer instead of shifting work to a pod that can serve.
  //
  // A much shorter cache than `/health`'s, because the two are polled for different reasons.
  // That 5s exists to stop a public endpoint billing an E2B call per request; here the only
  // check is a local `select 1`, and the cost of staleness is real — a probe on a 5s period
  // would spend an extra failed interval both leaving the rotation and rejoining it.
  //
  // **Readiness fails on a lost LISTEN connection**, which is design §24 item 5 decided rather
  // than left open. The argument for merely warning is that such a pod can still serve HTTP and
  // can still replay from the log, since the catch-up poll covers fanout — but "covers" here
  // means every event arrives up to a poll interval late, and a chat that answers two seconds
  // behind is the thing this whole endpoint exists to route around. Another pod is streaming
  // properly; send the traffic there. It is not a *liveness* failure: the connection comes back
  // on its own, and restarting the process would only throw away the sockets it still had.
  //
  // Absent from the in-process arrangement entirely, because there is nothing to be down.
  readiness: createHealthProbe({
    checks: [
      { name: "database", probe: () => pingDatabase(db) },
      ...(notifyBus === null
        ? []
        : [
            {
              name: "listener",
              probe: async () => {
                if (!notifyBus.listening) {
                  throw new Error("the event listener has stopped delivering");
                }
              },
            },
          ]),
    ],
    ttlMs: 1000,
  }),
});

// A signal means the platform is taking the process away; stopping the timer means an
// in-flight sweep is not joined by another one on the way out.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    reaper.stop();

    // Closing the listener too, so a rolling restart does not leave a `LISTEN` connection
    // holding a backend open until the database notices the socket is gone. Exiting is inside
    // the `finally` because it has to happen either way: a close that hangs must not turn a
    // graceful shutdown into a process the platform has to kill, and an unclosed connection is
    // reclaimed on its own once the socket drops.
    void (async () => {
      try {
        await notifyBus?.stop();
      } finally {
        process.exit(0);
      }
    })();
  });
}

// Said out loud at startup, because every message a user sends spends money on whatever is
// named here — that is not something anyone should first learn from an invoice.
logger.info(
  {
    port: env.PORT,
    nodeEnv: env.NODE_ENV,
    platform: env.NAP_PLATFORM,
    // Whether this process can share a session with another one. `in-process` and two replicas
    // is a chat that stops moving, and that is worth being able to read off a boot line.
    eventBus: env.NAP_EVENT_BUS,
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
