/**
 * The load harness: the real API, composed with fake infrastructure, driven by scripted users.
 *
 * `bun run loadgen` — one user. `bun run loadgen --users=25` — that many at once.
 *
 * **It costs nothing and it is meant to stay that way.** Nothing here reaches E2B, OpenRouter
 * or R2; the only things outside this process are a throwaway Postgres container and localhost.
 * What the run measures is the layer that was single-process — admission, the turn queue, the
 * event log, fanout to sockets — because that is the part `docs/scaling-design.md` is about.
 * Vendor concurrency is a quota question, not an architecture one, and faking it is what keeps
 * a hundred-user run repeatable.
 *
 * The fakes are slowed to the speeds a funded run really recorded (`@nap/loadgen/calibration`);
 * instant fakes would finish each turn before the next user connected and nothing would ever be
 * concurrent, which is the one thing this exists to produce.
 *
 * Only the composition lives here. The percentile maths, the metric rollup, the threshold
 * verdicts and the order of the journey's steps are all in `@nap/loadgen`, where they are
 * tested — a number a report is read through is not one to leave in an untested script.
 */

import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { createDatabase } from "@nap/db/client";
import { InProcessEventBus } from "@nap/db/in-process-event-bus";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresProjectSandboxStore } from "@nap/db/postgres-project-sandbox-store";
import { PostgresProjectStore } from "@nap/db/postgres-project-store";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { PostgresSnapshotStore } from "@nap/db/postgres-snapshot-store";
import { PostgresUserKeyStore } from "@nap/db/postgres-user-key-store";
import { createProjectSession } from "@nap/db/session-bootstrap";
import { startDockerPostgres } from "@nap/db/testing/docker-postgres";
import { seededRandom } from "@nap/loadgen/calibration";
import type { JourneyClient, JourneyEvent, JourneyStream } from "@nap/loadgen/journey";
import { runUserJourney } from "@nap/loadgen/journey";
import { Metrics } from "@nap/loadgen/metrics";
import { buildReport, formatReport, type Threshold } from "@nap/loadgen/report";
import { slowLLMProvider, slowSandboxManager } from "@nap/loadgen/slow-ports";
import { TEMPLATE_DEV_PORT, TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { ServerFrameSchema } from "@nap/shared/ws-protocol";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { upgradeWebSocket, websocket } from "hono/bun";
import { encryptionKeyFrom } from "../src/account/secret-box.ts";
import { createAuth } from "../src/auth/auth.ts";
import { composeNap, type NapConfig } from "../src/compose.ts";
import { createLogger } from "../src/logger.ts";

const USERS = Number(
  process.argv.find((arg) => arg.startsWith("--users="))?.slice("--users=".length) ?? 1,
);
/** Long enough for the slowest calibrated turn (43s) plus the cold start and the preview wait. */
const JOURNEY_TIMEOUT_MS = 120_000;

if (!Number.isInteger(USERS) || USERS < 1) {
  console.error("--users must be a positive integer");
  process.exit(1);
}

/**
 * What the run is held to.
 *
 * A deliberately small list for the first slice: these are the ones that are *already*
 * meaningful with fake infrastructure behind them, because they are properties of Nap's own
 * plumbing rather than of a vendor. §23's full set — the ramp's latency percentiles, the
 * reconnect assertions — arrives with the k6 profile that can actually exercise them.
 */
const THRESHOLDS: readonly Threshold[] = [
  { metric: "event_seq_gaps", statistic: "count", op: "==", value: 0 },
  { metric: "event_duplicates", statistic: "count", op: "==", value: 0 },
  { metric: "ws_connect_failures", statistic: "count", op: "==", value: 0 },
  { metric: "turn_completion_rate", statistic: "rate", op: ">=", value: 1 },
  { metric: "job_completion_rate", statistic: "rate", op: ">=", value: 1 },
  // Admission is the one latency this composition really measures: the route's own work, the
  // rate-limit and quota queries, and the write that accepts the turn. Everything behind it is
  // a fake sleeping.
  { metric: "admission_latency", statistic: "p95", op: "<", value: 500 },
];

/** What the project template declares, so the verifier finds checks to run. */
const TEMPLATE_MANIFEST = { scripts: { build: "vite build", dev: "vite --host" } };

/**
 * One model turn: think, write a file, answer.
 *
 * Repeated once per user because `ScriptedLLMProvider` hands each `startTurn()` the next entry
 * and throws past the end — which is right for a test and wrong here, so the script is simply
 * made long enough. Doubled, because a Job that needs a repair opens a second turn.
 */
function scriptedTurn() {
  return [
    {
      thinking: ["The project has no toggle yet, ", "so I will add one."],
      streamedText: ["I'll add ", "the component."],
      text: "I'll add the component.",
      toolCalls: [
        {
          id: "call_1",
          name: "write_file",
          input: {
            path: `${TEMPLATE_WORKDIR}/src/DarkModeToggle.tsx`,
            contents:
              "export function DarkModeToggle() {\n  return <button>Toggle theme</button>;\n}\n",
          },
        },
      ],
      usage: { inputTokens: 1_200, outputTokens: 90 },
    },
    {
      text: "Added the toggle component.",
      usage: { inputTokens: 1_400, outputTokens: 20 },
    },
  ];
}

/** An in-memory sandbox answering the commands a turn actually runs, git included. */
function fakeSandbox(): InMemorySandboxManager {
  return (
    new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
      serves: [TEMPLATE_DEV_PORT],
      seed: { [`${PROJECT_ROOT_PATH}/package.json`]: JSON.stringify(TEMPLATE_MANIFEST) },
    })
      // Non-zero means the index differs from HEAD, which is what makes a commit happen.
      .script(/git diff --cached --quiet/, { exitCode: 1 })
      .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${"0".repeat(40)}\n` })
  );
}

/**
 * Ceilings wide enough that the run measures the system rather than its own configuration.
 *
 * Production's numbers are deliberately not used and deliberately not changed: a harness that
 * ran at `NAP_MAX_SANDBOXES_TOTAL=10` would spend a hundred-user run reporting quota refusals,
 * which is a separate assertion (§16) with its own composition.
 */
function config(users: number): NapConfig {
  return {
    NAP_WEB_ORIGIN: "http://localhost:3000",
    NAP_MODEL: "loadgen/fake",
    NAP_FREE_MODEL: "loadgen/fake",
    NAP_ALLOWED_MODELS: ["loadgen/fake"],
    NAP_MAX_STEPS: 8,
    NAP_CONTEXT_BUDGET_TOKENS: 80_000,
    NAP_TURNS_PER_HOUR: users * 4,
    NAP_FREE_TURNS_PER_HOUR: users * 4,
    NAP_MAX_SANDBOXES_PER_USER: 2,
    NAP_FREE_MAX_SANDBOXES_PER_USER: 2,
    NAP_MAX_SANDBOXES_TOTAL: users * 2,
    NAP_SANDBOX_TTL_MINUTES: 30,
    // Far longer than any run, so the reaper never takes a sandbox away mid-journey.
    NAP_REAP_IDLE_MINUTES: 29,
    NAP_REAP_INTERVAL_SECONDS: 600,
  };
}

/** One virtual user's HTTP and WebSocket half of the journey. */
class HttpJourneyClient implements JourneyClient {
  #cookie = "";

  constructor(private readonly base: string) {}

  async signIn(): Promise<void> {
    // The demo door — the only sign-in a load generator can drive without an OAuth browser
    // dance, and a real code path rather than a test-only one.
    const response = await fetch(`${this.base}/api/auth/sign-in/anonymous`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(`sign-in answered ${response.status}`);

    this.#cookie = (response.headers.getSetCookie?.() ?? [])
      .map((cookie) => cookie.split(";")[0])
      .join("; ");
    if (this.#cookie === "") throw new Error("sign-in returned no cookie");
  }

  async createProject(name: string): Promise<{ projectId: string; sessionId: string }> {
    const response = await fetch(`${this.base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.#cookie },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error(`create project answered ${response.status}`);

    const created = (await response.json()) as { projectId: string; sessionId: string };
    return { projectId: created.projectId, sessionId: created.sessionId };
  }

  async openStream(sessionId: string, afterSeq: number): Promise<JourneyStream> {
    return await openStream(
      `${this.base.replace(/^http/, "ws")}/ws?sessionId=${sessionId}&seq=${afterSeq}`,
      this.#cookie,
    );
  }

  async submitTurn(
    sessionId: string,
    message: string,
  ): Promise<{ status: number; code?: string | undefined }> {
    const response = await fetch(`${this.base}/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: this.#cookie },
      body: JSON.stringify({ message }),
    });
    if (response.status === 202) return { status: 202 };

    // The category, not the status: `rate_limited` and `sandbox_quota_exceeded` are both 409
    // and mean entirely different things about which ceiling was reached.
    const body = (await response.json().catch(() => ({}))) as { code?: string };
    return { status: response.status, code: body.code };
  }
}

/** The socket half, as a `JourneyStream`: it records what arrives and answers waits from it. */
async function openStream(url: string, cookie: string): Promise<JourneyStream> {
  const socket = new WebSocket(url, { headers: { cookie } } as unknown as string[]);
  const received: JourneyEvent[] = [];
  const waiters: Array<{ types: readonly string[]; resolve: (event: JourneyEvent) => void }> = [];
  let readyAt: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    readyAt = resolve;
  });

  socket.addEventListener("message", (message) => {
    // Parsed rather than trusted: a frame this client cannot understand is a failed run, not a
    // silently ignored one.
    const frame = ServerFrameSchema.parse(JSON.parse(String(message.data)));
    if (frame.type === "ping") {
      socket.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (frame.type === "ready") {
      readyAt?.();
      return;
    }
    if (frame.type !== "event") return;

    const event: JourneyEvent = {
      seq: frame.event.seq,
      type: frame.event.type,
      receivedAt: Date.now(),
    };
    received.push(event);

    // Drained and refilled rather than spliced in place: resolving a waiter can register
    // another one from the journey's next step, and a loop over an array being appended to
    // while it is read is the kind of thing that works until it does not.
    for (const waiter of waiters.splice(0, waiters.length)) {
      if (waiter.types.includes(event.type)) waiter.resolve(event);
      else waiters.push(waiter);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("the socket refused to open")));
  });

  return {
    ready: () => ready,
    waitFor: (types) =>
      // Resolved from the frames already in hand first: a turn can finish between one `waitFor`
      // and the next, and a waiter registered afterwards would wait forever for an event that
      // has already been and gone.
      new Promise<JourneyEvent>((resolve, reject) => {
        const seen = received.find((event) => types.includes(event.type));
        if (seen !== undefined) {
          resolve(seen);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error(`no ${types.join(" or ")} arrived within ${JOURNEY_TIMEOUT_MS}ms`));
        }, JOURNEY_TIMEOUT_MS);
        waiters.push({
          types,
          resolve: (event) => {
            clearTimeout(timer);
            resolve(event);
          },
        });
      }),
    received: () => received,
    close: () => socket.close(),
  };
}

async function main(): Promise<void> {
  console.log(`Starting Postgres, and composing Nap with a fake sandbox and a fake model.`);
  const postgres = await startDockerPostgres();
  const { db } = createDatabase(postgres.url);

  const logger = createLogger({ level: "silent" }, { write: () => {} });
  // One draw per user's turn duration, from one seeded stream — so two runs of this harness
  // produce the same latencies and a difference between their reports came from the system.
  const random = seededRandom(1);

  const { app, reaper } = composeNap({
    config: config(USERS),
    logger,
    sessions: new PostgresSessionStore(db),
    projects: new PostgresProjectStore(db),
    projectSandboxes: new PostgresProjectSandboxStore(db),
    snapshots: new PostgresSnapshotStore(db),
    userKeys: new PostgresUserKeyStore(db),
    events: new PostgresEventStore(db),
    bus: new InProcessEventBus(),
    sandbox: slowSandboxManager(fakeSandbox()),
    objects: new InMemoryObjectStore(),
    provider: slowLLMProvider(
      new ScriptedLLMProvider(Array.from({ length: USERS * 2 }, scriptedTurn)),
      { random },
    ),
    auth: createAuth(db, {
      secret: "loadgen-secret-loadgen-secret-32b",
      baseUrl: "http://localhost",
      webOrigin: "http://localhost:3000",
      // The door the whole journey goes through.
      allowAnonymous: true,
    }),
    encryptionKey: encryptionKeyFrom(
      Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
    ),
    // Nothing here brings a key, so nothing ever verifies one. A stub rather than the real
    // verifier because the real one calls a vendor, and this run reaches nothing but localhost.
    verifyKey: async () => ({ ok: true }),
    createProject: (options) => createProjectSession(db, options),
    upgradeWebSocket,
  });

  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  const base = `http://localhost:${server.port}`;
  console.log(`API on ${base} — ${USERS} user${USERS === 1 ? "" : "s"}, no network beyond it.\n`);

  const metrics = new Metrics();
  const startedAt = new Date();
  const startedAtMs = Date.now();

  const results = await Promise.all(
    Array.from({ length: USERS }, (_, index) =>
      runUserJourney({
        client: new HttpJourneyClient(base),
        metrics,
        message: "Build a todo list with add, complete, and delete",
        projectName: `loadgen ${index + 1}`,
      }),
    ),
  );

  const failed = results.filter((result) => !result.ok);
  for (const result of failed) {
    if (!result.ok) console.log(`  user failed at ${result.step}: ${result.message}`);
  }

  const report = buildReport({
    startedAt,
    durationMs: Date.now() - startedAtMs,
    users: {
      started: results.length,
      completed: results.length - failed.length,
      failed: failed.length,
    },
    metrics: metrics.rollup(),
    thresholds: THRESHOLDS,
  });

  console.log(formatReport(report));

  reaper.stop();
  server.stop(true);
  await postgres.stop();

  process.exit(report.passed ? 0 : 1);
}

await main();
