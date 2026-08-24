/**
 * The three processes, as a cluster runs them, with nothing behind them that costs money.
 *
 * `bun run apps/api/scripts/cluster-proof.ts <api|worker|reaper>` — the same `composeNap` the real
 * entrypoints call, with the same Postgres queue, the same durable event log and the same
 * `pg_notify` fanout, but a scripted model and an in-memory sandbox in place of OpenRouter and
 * E2B. It is what `infra/k8s/proof/` runs, so that a multi-pod deployment can be *observed*
 * working — a turn submitted to one API pod, executed by a worker pod, streaming to a socket held
 * by a third — without a vendor key or a bill.
 *
 * **What it does not prove, and does not claim to.** The fakes mean nothing here exercises a real
 * sandbox, a real model or R2. What is under test is the layer that used to be single-process:
 * admission, the queue, the leases, the log and the fanout across pods. Vendor behaviour is a
 * quota question and belongs to `bun run acceptance`, which spends money on purpose.
 *
 * It reads `DATABASE_URL` and `PORT` from the environment like the real thing, migrates nothing,
 * and serves only in the `api` role.
 */

import { createDatabase, createListenerConnection } from "@nap/db/client";
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
import { seededRandom } from "@nap/loadgen/calibration";
import { loopingLLMProvider } from "@nap/loadgen/looping-llm-provider";
import { slowLLMProvider, slowSandboxManager } from "@nap/loadgen/slow-ports";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { upgradeWebSocket, websocket } from "hono/bun";
import { encryptionKeyFrom } from "../src/account/secret-box.ts";
import { createAuth } from "../src/auth/auth.ts";
import { composeNap, type NapConfig, type NapRole } from "../src/compose.ts";
import { createLogger } from "../src/logger.ts";
import { createHeartbeatWriter } from "../src/worker-heartbeat.ts";
import { fakeSandbox, scriptedTurn } from "./fake-turn.ts";

const ROLES: NapRole[] = ["api", "worker", "reaper"];

function role(): NapRole {
  const asked = process.argv[2];
  const found = ROLES.find((candidate) => candidate === asked);
  if (found === undefined) {
    console.error(`usage: cluster-proof.ts <${ROLES.join("|")}>`);
    process.exit(1);
  }
  return found;
}

function required(key: string): string {
  const value = process.env[key];
  if (value === undefined || value === "") {
    console.error(`${key} is required`);
    process.exit(1);
  }
  return value;
}

/** A `NAP_*` number from the pod's environment, or the proof's own default. */
function tunable(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`${key} is not a number: ${raw}`);
    process.exit(1);
  }
  return value;
}

/**
 * Ceilings wide enough that the proof measures the deployment rather than its own configuration —
 * and sweeps slow enough that nothing is taken away mid-run.
 *
 * Production's numbers are deliberately not used: at `NAP_MAX_SANDBOXES_TOTAL=10` a proof that
 * happened to run eleven turns would be reporting a quota refusal, which is a different assertion
 * with its own test.
 *
 * The four that a load run has to move are read from the environment. They are the ones the
 * autoscalers are derived from — the sandbox ceiling and a worker's concurrency — plus the drain
 * that scaling in has to wait for, and a run at a hundred users needs all of them larger than a
 * three-pod proof does. Everything else stays fixed here, because a knob nothing turns is a way
 * for two runs to differ for a reason nobody wrote down.
 */
const CONFIG: NapConfig = {
  NAP_WEB_ORIGIN: "http://localhost:3000",
  NAP_MODEL: "proof/fake",
  NAP_FREE_MODEL: "proof/fake",
  NAP_ALLOWED_MODELS: ["proof/fake"],
  NAP_MAX_STEPS: 8,
  NAP_CONTEXT_BUDGET_TOKENS: 80_000,
  NAP_MAX_SANDBOXES_PER_USER: tunable("NAP_MAX_SANDBOXES_PER_USER", 10),
  NAP_FREE_MAX_SANDBOXES_PER_USER: tunable("NAP_FREE_MAX_SANDBOXES_PER_USER", 10),
  NAP_MAX_SANDBOXES_TOTAL: tunable("NAP_MAX_SANDBOXES_TOTAL", 50),
  NAP_SANDBOX_TTL_MINUTES: 30,
  NAP_REAP_IDLE_MINUTES: 29,
  NAP_REAP_INTERVAL_SECONDS: 60,
  // The one sweep that matters here, and it is left fast: a rolling restart of the workers is
  // exactly when a turn's worker disappears, and the janitor is what tells the socket about it.
  NAP_JANITOR_INTERVAL_SECONDS: 15,
  NAP_WORKER_CONCURRENCY: tunable("NAP_WORKER_CONCURRENCY", 5),
  NAP_DRAIN_TIMEOUT_SECONDS: tunable("NAP_DRAIN_TIMEOUT_SECONDS", 30),
  NAP_CAPTURE_CONCURRENCY: 1,
};

const which = role();
const databaseUrl = required("DATABASE_URL");
const logger = createLogger({ level: "info" });
const { db, client } = createDatabase(databaseUrl);

const events = new PostgresEventStore(db);

/**
 * The whole point of the exercise: a bus that crosses processes.
 *
 * The in-process one would make every pod look healthy and stream nothing — the worker publishes
 * to subscribers inside itself, and every socket is on an API pod.
 */
const bus = new PostgresNotifyEventBus({
  reader: events,
  transport: new PostgresNotifyTransport({
    notifier: client,
    listener: createListenerConnection(process.env.NAP_LISTEN_DATABASE_URL ?? databaseUrl),
  }),
});
await bus.start();

const model = loopingLLMProvider(scriptedTurn());
const heartbeatFile = process.env.NAP_WORKER_HEARTBEAT_FILE;

/**
 * Whether the fakes answer instantly or at the speeds a funded run recorded.
 *
 * Instant is right for the proof: it asks whether a turn crosses pods, and waiting 43 seconds to
 * find out wastes a minute per check. It is wrong for a load run, and by more than a factor —
 * instant fakes finish each turn before the next user has connected, so nothing is ever
 * concurrent and a ramp to a hundred measures a system that never had two turns at once. Same
 * argument as `loadgen-composition.ts`, and the same `@nap/loadgen` calibration behind it, so
 * that a cluster run and the single-process baseline are comparable.
 */
const calibrated = process.env.NAP_PROOF_CALIBRATED_LATENCY === "true";
// One seeded stream, so two runs of this pod draw the same turn durations. Per pod rather than
// per deployment: nothing can share a stream across processes, and what matters is that a
// rerun of the same shape sees the same dice.
const random = seededRandom(tunable("NAP_PROOF_SEED", 1));

const { app, worker, reaper, janitor } = composeNap({
  config: CONFIG,
  role: which,
  logger,
  sessions: new PostgresSessionStore(db),
  projects: new PostgresProjectStore(db),
  projectSandboxes: new PostgresProjectSandboxStore(db),
  capacity: new PostgresSandboxCapacity(db, {
    perUser: CONFIG.NAP_MAX_SANDBOXES_PER_USER,
    total: CONFIG.NAP_MAX_SANDBOXES_TOTAL,
  }),
  rateLimits: {
    rate: new PostgresTurnRateLimiter(db, { limit: 1_000, windowMs: 3_600_000, tier: "paid" }),
    freeRate: new PostgresTurnRateLimiter(db, { limit: 1_000, windowMs: 3_600_000, tier: "free" }),
  },
  queue: new PostgresTurnQueue(db),
  snapshots: new PostgresSnapshotStore(db),
  userKeys: new PostgresUserKeyStore(db),
  events,
  bus,
  sandbox: calibrated ? slowSandboxManager(fakeSandbox()) : fakeSandbox(),
  objects: new InMemoryObjectStore(),
  provider: calibrated ? slowLLMProvider(model, { random }) : model,
  auth: createAuth(db, {
    /*
     * The pod already mounts one — `run.sh` generates it into the overlay's Secret — so read it
     * rather than carrying a second, hardcoded copy that would have to be kept in step. The
     * fallback is for running this script outside a cluster, where the sessions it signs live as
     * long as the process does and nothing else can be reached with them.
     */
    secret: process.env.BETTER_AUTH_SECRET ?? "cluster-proof-outside-a-cluster",
    baseUrl: process.env.NAP_API_URL ?? "http://localhost:3001",
    webOrigin: CONFIG.NAP_WEB_ORIGIN,
    // The door the proof's client goes through: it has no account and needs none.
    allowAnonymous: true,
    // Wide, because every simulated user arrives from one address — the k6 process behind the
    // ingress — and the library's per-IP allowance would refuse ninety of a hundred sign-ins
    // before the run had started. §24 item 6: this is the tenancy question, and the answer for
    // a deployed run is the same shape but a decision somebody has to make on purpose.
    authRequestsPerWindow: 100_000,
  }),
  encryptionKey: encryptionKeyFrom(
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
  ),
  // Nothing here brings a key, so nothing ever verifies one — and the real verifier calls a vendor.
  verifyKey: async () => ({ ok: true }),
  createProject: (options) => createProjectSession(db, options),
  upgradeWebSocket,
  ...(heartbeatFile === undefined ? {} : { onClaimTick: createHeartbeatWriter(heartbeatFile) }),
});

if (which === "api") {
  const port = Number(process.env.PORT ?? 3001);
  Bun.serve({ port, fetch: app.fetch, websocket });
  logger.info({ port, role: which }, "cluster proof serving");
} else {
  logger.info({ role: which }, "cluster proof running");
}

/**
 * The same shutdown shape `boot.ts` installs, and the reason the worker's is worth having here: a
 * rolling restart of the workers is one of the two things this proof exists to watch.
 */
async function shutdown(): Promise<void> {
  reaper.stop();
  janitor.stop();
  await worker.stop();
  await bus.stop?.();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
