/**
 * What a *process* does, for either of the two processes Nap runs.
 *
 * `composeNap` assembles everything above the infrastructure from parts somebody else chose; this
 * is where those parts are made. It reads and validates the environment, builds the real clients —
 * E2B, R2, OpenRouter, Postgres, a browser — hands them over, and returns the pieces along with
 * the shutdown sequence that puts them down again.
 *
 * **One function for the API and the worker, deliberately.** `docs/scaling-design.md` §4 splits
 * the deployment in two: an API pod that serves HTTP and WebSockets and executes nothing, and a
 * worker pod that claims leases and executes turns and serves nothing. The temptation is a second
 * boot file with the half of this that a worker needs — and the copies would have drifted the
 * first time somebody added a store. So both entrypoints call this with a different `role`, and
 * the difference between them is which loops `composeNap` starts and whether anything is served.
 *
 * A worker builds an app it never serves, and an API builds a runtime it never drives. Neither
 * costs anything: nothing here has a side effect until something starts it, and a shared boot that
 * builds one object too many is a much cheaper mistake than two boots that disagree.
 *
 * There are no top-level side effects in this file, unlike the entrypoints that call it — which is
 * what makes it importable, and therefore typechecked, by things that are not a running process.
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
import { PostgresTurnQueue } from "@nap/db/postgres-turn-queue";
import { PostgresTurnRateLimiter } from "@nap/db/postgres-turn-rate-limiter";
import { PostgresUserKeyStore } from "@nap/db/postgres-user-key-store";
import { createProjectSession } from "@nap/db/session-bootstrap";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { NAP_TEMPLATE } from "@nap/sandbox/template";
import { type Logger, setRootLogger } from "@nap/shared/logging";
import { createR2Client, R2ObjectStore } from "@nap/storage/r2-object-store";
import { upgradeWebSocket } from "hono/bun";
import { createKeyVerifier } from "./account/routes.ts";
import { encryptionKeyFrom } from "./account/secret-box.ts";
import { createAuth } from "./auth/auth.ts";
import { type ComposedNap, composeNap, type NapRole } from "./compose.ts";
import { type Env, EnvValidationError, parseEnv } from "./env.ts";
import { createHealthProbe } from "./health.ts";
import { createLogger } from "./logger.ts";

export type NapProcess = {
  env: Env;
  /** Which half of the deployment this is, so the boot line says it. */
  role: NapRole;
  logger: Logger;
  composed: ComposedNap;
  /**
   * Stops everything this process started, in the order that loses the least.
   *
   * Installed on `SIGINT` and `SIGTERM` by `bootNap` itself, and exported so a test or a script
   * can end a process it started without sending it a signal.
   */
  shutdown: () => Promise<void>;
};

/**
 * Before anything else: an unusable environment should kill the process here, with a message
 * naming every problem, rather than surfacing as a confusing failure later.
 *
 * Printed and exited rather than thrown — a stack trace through Zod tells an operator nothing they
 * can act on, and the message already says exactly what to fix.
 */
function loadEnv(): Env {
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

/** Fixed by the names of the two settings that fill it: `NAP_…_TURNS_PER_HOUR`. */
const TURN_RATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * The one combination that runs perfectly and does nothing anybody can see.
 *
 * A worker publishing to a bus inside itself announces a turn to nobody: every socket watching that
 * session is on an API pod. Nothing fails — the turn runs, commits, and lands in the durable log —
 * so the symptom is a chat pane that sits still while both processes log clean, and the only hint
 * is that a reconnect suddenly delivers the whole turn at once, because replay reads the log rather
 * than the bus.
 *
 * Refused at boot rather than warned about, because a warning here is one line in a healthy-looking
 * log and the thing it warns about looks exactly like a bug in the browser.
 *
 * **On the worker only, and that is enough.** Both processes read the same variable, so the worker
 * refusing is what makes an operator fix it for the pair. An API started alone on the in-process
 * bus is a perfectly ordinary thing to want — it is what somebody working on the front end runs,
 * and with no worker anywhere there is nothing to stream regardless.
 */
function refuseSilentFanout(role: NapRole, eventBus: Env["NAP_EVENT_BUS"]): void {
  if (role !== "worker" || eventBus === "postgres") return;

  console.error(
    `NAP_EVENT_BUS=${eventBus} cannot serve a worker process.\n` +
      "  The sockets watching a turn are on the API, so a bus inside this process reaches none\n" +
      "  of them: every turn would run correctly and no browser would see anything happen.\n" +
      "  Set NAP_EVENT_BUS=postgres. See docs/DEPLOY.md.",
  );
  process.exit(1);
}

export async function bootNap(role: NapRole): Promise<NapProcess> {
  const env = loadEnv();
  refuseSilentFanout(role, env.NAP_EVENT_BUS);

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
   * **A split deployment cannot run on the in-process one**, and this is where that becomes
   * physical rather than theoretical: a worker publishing to a bus inside itself announces a turn
   * to nobody, because every socket watching it is on an API pod. The in-process bus is the
   * single-container arrangement's, and `role: "all"` is the only role it is honest under.
   *
   * `start()` is awaited: a process that could not open its `LISTEN` connection has no business
   * answering requests, and the failure should be a boot that dies loudly rather than a server
   * that streams nothing.
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
   *
   * Constructed but not launched: `ChromePageCapture` starts a browser on its first capture, so an
   * API pod that never photographs anything never pays for the binary it was configured with. How
   * many of them may be open at once is the composition's, not this file's.
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

  const composed = composeNap({
    config: env,
    role,
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
    // The other ceiling that bounds the bill, and in rows for the same reason: a limiter held in
    // this process would give each replica its own allowance, so "5 free turns an hour" would
    // quietly become five times the replica count. Two instances rather than two numbers on one —
    // sharing a window would let somebody's paid turns eat their free allowance.
    rateLimits: {
      rate: new PostgresTurnRateLimiter(db, {
        limit: env.NAP_TURNS_PER_HOUR,
        windowMs: TURN_RATE_WINDOW_MS,
        tier: "paid",
      }),
      freeRate: new PostgresTurnRateLimiter(db, {
        limit: env.NAP_FREE_TURNS_PER_HOUR,
        windowMs: TURN_RATE_WINDOW_MS,
        tier: "free",
      }),
    },
    // The distributed `SessionQueue`: one in-flight request per session, enforced by a partial
    // unique index rather than by a `Map` each replica keeps its own copy of. Every API pod writes
    // to it at admission and every worker claims from it — it is the only thing the two halves of
    // the deployment share.
    queue: new PostgresTurnQueue(db),
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

  /**
   * Everything this process started, put down in the order that loses the least.
   *
   * The sweeps go first and synchronously: a tick that has not started must not start while the
   * process is leaving, and anything it would have closed out is still expired when the next pod
   * looks. Then the drain, which is the long part — a worker waits for the turns it is running so
   * a rolling restart finishes them rather than leaving their leases to expire and their jobs open
   * for somebody to continue by hand. The listener goes last, so a restart does not leave a
   * `LISTEN` connection holding a backend open until the database notices the socket is gone.
   *
   * On an API composition every one of these is a no-op except the listener, which is the point of
   * the composition returning stubs rather than `undefined`: the sequence does not have to know
   * which half it is.
   */
  let shuttingDown: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    // Once, however many times it is asked. A second SIGTERM — or the same one delivered to a
    // process group — would otherwise start a second drain beside the first, and the two would
    // race to `process.exit` while the turns they were both waiting for were still running.
    shuttingDown ??= (async () => {
      composed.reaper.stop();
      composed.janitor.stop();
      await composed.worker.stop();
      await notifyBus?.stop();
    })();

    return shuttingDown;
  }

  // A signal means the platform is taking the process away. Exiting is inside the `finally`
  // because it has to happen either way: a shutdown that hangs must not turn a graceful stop into
  // a process the platform has to kill, and an unclosed connection is reclaimed on its own once
  // the socket drops.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      logger.info({ signal }, "shutting down");
      void (async () => {
        try {
          await shutdown();
        } finally {
          process.exit(0);
        }
      })();
    });
  }

  return { env, role, logger, composed, shutdown };
}
