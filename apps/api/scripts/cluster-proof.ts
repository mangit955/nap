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
import { loopingLLMProvider } from "@nap/loadgen/looping-llm-provider";
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

/**
 * Ceilings wide enough that the proof measures the deployment rather than its own configuration —
 * and sweeps slow enough that nothing is taken away mid-run.
 *
 * Production's numbers are deliberately not used: at `NAP_MAX_SANDBOXES_TOTAL=10` a proof that
 * happened to run eleven turns would be reporting a quota refusal, which is a different assertion
 * with its own test.
 */
const CONFIG: NapConfig = {
  NAP_WEB_ORIGIN: "http://localhost:3000",
  NAP_MODEL: "proof/fake",
  NAP_FREE_MODEL: "proof/fake",
  NAP_ALLOWED_MODELS: ["proof/fake"],
  NAP_MAX_STEPS: 8,
  NAP_CONTEXT_BUDGET_TOKENS: 80_000,
  NAP_MAX_SANDBOXES_PER_USER: 10,
  NAP_FREE_MAX_SANDBOXES_PER_USER: 10,
  NAP_MAX_SANDBOXES_TOTAL: 50,
  NAP_SANDBOX_TTL_MINUTES: 30,
  NAP_REAP_IDLE_MINUTES: 29,
  NAP_REAP_INTERVAL_SECONDS: 60,
  // The one sweep that matters here, and it is left fast: a rolling restart of the workers is
  // exactly when a turn's worker disappears, and the janitor is what tells the socket about it.
  NAP_JANITOR_INTERVAL_SECONDS: 15,
  NAP_WORKER_CONCURRENCY: 5,
  NAP_DRAIN_TIMEOUT_SECONDS: 30,
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
  sandbox: fakeSandbox(),
  objects: new InMemoryObjectStore(),
  provider: model,
  auth: createAuth(db, {
    secret: "GENERATED_AT_RUN_TIME",
    baseUrl: process.env.NAP_API_URL ?? "http://localhost:3001",
    webOrigin: CONFIG.NAP_WEB_ORIGIN,
    // The door the proof's client goes through: it has no account and needs none.
    allowAnonymous: true,
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
