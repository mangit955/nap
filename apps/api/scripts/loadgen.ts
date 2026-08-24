/**
 * The load harness: scripted users, in this process, against the composed API.
 *
 * `bun run loadgen` — one user. `bun run loadgen --users=25` — that many at once. The system they
 * drive is assembled by `loadgen-composition.ts` and shared with `bun run loadgen:ramp`, so the
 * two halves of the load story measure one system rather than two similar ones.
 *
 * This is the free inner loop: it needs no k6, prints a report in one command, and is what to
 * reach for while changing the journey itself. The ramp is what answers §23.
 *
 * Only the driving lives here. The percentile maths, the metric rollup, the threshold verdicts
 * and the order of the journey's steps are all in `@nap/loadgen`, where they are tested — a
 * number a report is read through is not one to leave in an untested script.
 */

import type { JourneyClient, JourneyEvent, JourneyStream } from "@nap/loadgen/journey";
import { runUserJourney } from "@nap/loadgen/journey";
import { Metrics } from "@nap/loadgen/metrics";
import { buildReport, formatReport, type Threshold } from "@nap/loadgen/report";
import { ServerFrameSchema } from "@nap/shared/ws-protocol";
import { bootLoadgenApi } from "./loadgen-composition.ts";

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
  const api = await bootLoadgenApi({ users: USERS });
  const base = api.base;
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

  await api.stop();

  process.exit(report.passed ? 0 : 1);
}

await main();
