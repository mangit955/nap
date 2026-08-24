/**
 * The system under load: the real API, composed with fake infrastructure, on a real Postgres.
 *
 * Shared by the two things that drive it — `loadgen.ts`, which runs scripted users inside this
 * process, and `loadgen-ramp.ts`, which holds it open for k6 — because the *composition* is the
 * thing being measured and two copies of it would eventually become two different systems. What
 * a caller chooses is how many users to size the ceilings for and which port to serve on.
 *
 * **It costs nothing and it is meant to stay that way.** Nothing here reaches E2B, OpenRouter or
 * R2; the only things outside this process are a throwaway Postgres container and localhost. What
 * the run measures is the layer that is single-process — admission, the turn queue, the event
 * log, fanout to sockets — because that is the part `docs/scaling-design.md` is about. Vendor
 * concurrency is a quota question, not an architecture one, and faking it is what keeps a
 * hundred-user run repeatable.
 *
 * The fakes are slowed to the speeds a funded run really recorded (`@nap/loadgen/calibration`);
 * instant fakes would finish each turn before the next user connected and nothing would ever be
 * concurrent, which is the one thing this exists to produce.
 */

import { createDatabase } from "@nap/db/client";
import { InProcessEventBus } from "@nap/db/in-process-event-bus";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresProjectSandboxStore } from "@nap/db/postgres-project-sandbox-store";
import { PostgresProjectStore } from "@nap/db/postgres-project-store";
import { PostgresSandboxCapacity } from "@nap/db/postgres-sandbox-capacity";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { PostgresSnapshotStore } from "@nap/db/postgres-snapshot-store";
import { PostgresTurnQueue } from "@nap/db/postgres-turn-queue";
import { PostgresTurnRateLimiter } from "@nap/db/postgres-turn-rate-limiter";
import { PostgresUserKeyStore } from "@nap/db/postgres-user-key-store";
import { createProjectSession } from "@nap/db/session-bootstrap";
import { startDockerPostgres } from "@nap/db/testing/docker-postgres";
import { seededRandom } from "@nap/loadgen/calibration";
import { loopingLLMProvider, type ProviderTotals } from "@nap/loadgen/looping-llm-provider";
import { sharedSandboxManager } from "@nap/loadgen/shared-sandbox-manager";
import { slowLLMProvider, slowSandboxManager } from "@nap/loadgen/slow-ports";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { upgradeWebSocket, websocket } from "hono/bun";
import { encryptionKeyFrom } from "../src/account/secret-box.ts";
import { createAuth } from "../src/auth/auth.ts";
import { composeNap, type NapConfig } from "../src/compose.ts";
import { createLogger } from "../src/logger.ts";
import { fakeSandbox, scriptedTurn } from "./fake-turn.ts";
import { createSharedSandboxTable, PostgresSharedSandboxStore } from "./loadgen-sandbox-store.ts";

/**
 * Ceilings wide enough that the run measures the system rather than its own configuration.
 *
 * Production's numbers are deliberately not used and deliberately not changed: a harness that ran
 * at `NAP_MAX_SANDBOXES_TOTAL=10` would spend a hundred-user run reporting quota refusals, which
 * is a separate assertion (§16) with its own composition. The turn allowance is sized the same
 * way and is no longer here — it is a limiter rather than a number now, built in `bootLoadgenApi`
 * against the same Postgres.
 */
export function loadgenConfig(users: number): NapConfig {
  return {
    NAP_WEB_ORIGIN: "http://localhost:3000",
    NAP_MODEL: "loadgen/fake",
    NAP_FREE_MODEL: "loadgen/fake",
    NAP_ALLOWED_MODELS: ["loadgen/fake"],
    NAP_MAX_STEPS: 8,
    NAP_CONTEXT_BUDGET_TOKENS: 80_000,
    NAP_MAX_SANDBOXES_PER_USER: 2,
    NAP_FREE_MAX_SANDBOXES_PER_USER: 2,
    NAP_MAX_SANDBOXES_TOTAL: users * 2,
    NAP_SANDBOX_TTL_MINUTES: 30,
    // Far longer than any run, so the reaper never takes a sandbox away mid-journey.
    NAP_REAP_IDLE_MINUTES: 29,
    NAP_REAP_INTERVAL_SECONDS: 600,
    // Nothing here kills a worker, so the janitor has nothing to find; long enough that a ramp
    // never pays for the query.
    NAP_JANITOR_INTERVAL_SECONDS: 600,
    // Sized like the ceilings above rather than like production's: a worker that could only run
    // ten turns at once would make every ramp above ten a measurement of this number.
    NAP_WORKER_CONCURRENCY: users * 2,
    // A run ends by killing the harness, so nothing here ever drains; short enough that a
    // teardown which does reach it does not hold the process open.
    NAP_DRAIN_TIMEOUT_SECONDS: 5,
    // Nothing in a run photographs anything — the composition holds no browser — so this is the
    // bound on a semaphore in front of nothing.
    NAP_CAPTURE_CONCURRENCY: 1,
  };
}

/** One tier's allowance, sized like the ceilings above: far past what a run can reach. */
function turnRateLimiter(db: PostgresJsDatabase, users: number, tier: "free" | "paid") {
  return new PostgresTurnRateLimiter(db, {
    limit: users * 200,
    windowMs: 60 * 60 * 1000,
    tier,
  });
}

export type BootOptions = {
  /** How many users the ceilings are sized for. */
  users: number;
  /** 0 lets the operating system choose, which is what an in-process run wants. */
  port?: number;
  /** Seeds the turn-duration draws, so two runs of one harness produce the same latencies. */
  seed?: number;
};

export type BootedLoadgenApi = {
  base: string;
  port: number;
  /** The throwaway container's URL, so a probe can open its own connection to it. */
  postgresUrl: string;
  /**
   * The synthetic tokens every turn of this run "spent".
   *
   * Real in the sense that it is what the model was really asked for and really answered with;
   * imaginary in that no vendor saw any of it. §23 wants the column regardless.
   */
  modelTotals: () => ProviderTotals;
  /** Stops the server, the two sweeps, the pool and the container, in that order. */
  stop: () => Promise<void>;
};

/**
 * Starts Postgres, composes Nap against it with fakes, and serves.
 *
 * The pool is left at `createDatabase`'s default because that is what `index.ts` boots with: a
 * harness that widened it would be measuring a deployment nobody runs, and pool exhaustion under
 * a hundred concurrent turns is a finding rather than a nuisance.
 */
export async function bootLoadgenApi(options: BootOptions): Promise<BootedLoadgenApi> {
  const postgres = await startDockerPostgres();
  const { db, close } = createDatabase(postgres.url);
  // The fake sandboxes' own table, which no migration creates because nothing that ships reads
  // it. One process here, so nothing has to be found across one — but the store is the same one
  // the cluster run uses, and a harness that composed it differently would be a second system.
  await createSharedSandboxTable(db);

  // Held rather than inlined, because it is the only thing that can say afterwards how many
  // turns ran through it and what they notionally cost.
  const model = loopingLLMProvider(scriptedTurn());

  const logger = createLogger({ level: "silent" }, { write: () => {} });
  // One draw per turn's duration from one seeded stream, so a difference between two reports
  // came from the system rather than from the dice.
  const random = seededRandom(options.seed ?? 1);

  const config = loadgenConfig(options.users);

  const { app, reaper, worker, janitor } = composeNap({
    config,
    logger,
    sessions: new PostgresSessionStore(db),
    projects: new PostgresProjectStore(db),
    projectSandboxes: new PostgresProjectSandboxStore(db),
    // The real one, against the ramp's own Postgres: admission under load is exactly what the
    // ramp is measuring, so a fake here would measure the wrong system.
    capacity: new PostgresSandboxCapacity(db, {
      perUser: config.NAP_MAX_SANDBOXES_PER_USER,
      total: config.NAP_MAX_SANDBOXES_TOTAL,
    }),
    // The real limiter too, and against the same Postgres: it is on the admission hot path of
    // every turn the ramp sends, so a fake would be measuring a system nobody deploys. The
    // allowance is per hour and a ramp runs for twenty minutes, so it is set far past what any
    // user can reach in one — the run measures the system rather than its own configuration.
    rateLimits: {
      rate: turnRateLimiter(db, options.users, "paid"),
      freeRate: turnRateLimiter(db, options.users, "free"),
    },
    // The real queue, against the ramp's own Postgres. Every turn the ramp sends is admitted
    // through it and claimed off it, which is precisely the hot path the ramp exists to measure.
    queue: new PostgresTurnQueue(db),
    snapshots: new PostgresSnapshotStore(db),
    userKeys: new PostgresUserKeyStore(db),
    events: new PostgresEventStore(db),
    bus: new InProcessEventBus(),
    // Slow *outside* shared, and that order is the point: the calibrated cold start belongs to
    // `create`, so a reattach through the store never pays one.
    sandbox: slowSandboxManager(
      sharedSandboxManager(fakeSandbox(), new PostgresSharedSandboxStore(db)),
    ),
    objects: new InMemoryObjectStore(),
    provider: slowLLMProvider(model, { random }),
    auth: createAuth(db, {
      secret: "loadgen-secret-loadgen-secret-32b",
      baseUrl: "http://localhost",
      webOrigin: "http://localhost:3000",
      // The door the whole journey goes through.
      allowAnonymous: true,
      // Every simulated user arrives from one address, so the library's per-IP allowance would
      // refuse most of the sign-ins. It happens to be off here anyway — better-auth enables it
      // only under `NODE_ENV=production` — and relying on that would make this harness's result
      // depend on an environment variable nobody set on purpose.
      authRequestsPerWindow: 100_000,
    }),
    encryptionKey: encryptionKeyFrom(
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    ),
    // Nothing here brings a key, so nothing ever verifies one. A stub rather than the real
    // verifier because the real one calls a vendor, and this run reaches nothing but localhost.
    verifyKey: async () => ({ ok: true }),
    createProject: (createOptions) => createProjectSession(db, createOptions),
    upgradeWebSocket,
  });

  const server = Bun.serve({ port: options.port ?? 0, fetch: app.fetch, websocket });
  // `port` is optional on Bun's server because a unix-socket server has none. This one always
  // listens on a port, and a load run with nothing to point k6 at should say so here.
  const port = server.port;
  if (port === undefined) throw new Error("the load harness's server came up without a port");

  return {
    base: `http://localhost:${port}`,
    port,
    modelTotals: () => model.totals(),
    postgresUrl: postgres.url,
    stop: async () => {
      reaper.stop();
      janitor.stop();
      // Before the server, so a run that ended with turns in flight settles them rather than
      // leaving leases to expire against a database that is about to be torn down.
      await worker.stop();
      server.stop(true);
      await close();
      await postgres.stop();
    },
  };
}
