/**
 * The baseline run: hold the composed API open, let k6 ramp users at it, and write down what it
 * did — including the things k6 cannot see.
 *
 * `bun run loadgen:ramp` — the §23 ramp to 100. `--profile=smoke` for a ninety-second wiring
 * check, `--profile=extended` to keep climbing past 100 when nothing broke there, and
 * `--profile=realism` for the hundred-connected, twenty-five-active profile.
 *
 * Three things happen in this process and none of them can happen in k6:
 *
 *   - **the server is sampled while the load runs** — CPU, memory, connections, the size of the
 *     event log — so a rising p95 can be told apart from a pool that ran out. k6 measures from
 *     outside and cannot say which.
 *   - **the database is probed afterwards**, against the rows this run really wrote, which is
 *     what `docs/scaling-design.md` §24 items 2 and 4 ask for: the cost of a catch-up poll at a
 *     hundred sessions, and whether `hashtext` maps two of them onto one advisory lock.
 *   - **the report is assembled**, joining k6's per-stage figures to those samples and naming the
 *     first point of material degradation — which §23 calls the headline result, and the reason
 *     a run that passes every threshold without finding one is not finished.
 *
 * It costs nothing: the sandbox and the model are fakes, and nothing leaves this machine.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { type DegradationRule, firstDegradation } from "@nap/loadgen/degradation";
import { parseK6Summary, rollupOf, stageRollups } from "@nap/loadgen/k6-summary";
import { hashCollisions, pollCost } from "@nap/loadgen/probes";
import { evaluateThresholds, type Threshold } from "@nap/loadgen/report";
import { rollupSamples, type SampleWindow, type ServerSample } from "@nap/loadgen/server-samples";
import { recommendWorkerConcurrency } from "@nap/loadgen/worker-concurrency";
import postgres from "postgres";
import { z } from "zod";
import { bootLoadgenApi } from "./loadgen-composition.ts";

/** What the k6 script writes beside its summary: when each plateau began and ended. */
const StageWindowsSchema = z.object({
  profile: z.string(),
  startedAt: z.number(),
  windows: z.array(z.object({ tag: z.string(), from: z.number(), to: z.number() })),
});

type Profile = "ramp" | "extended" | "saturate" | "smoke" | "realism";

const PROFILES: Record<Profile, { users: number }> = {
  smoke: { users: 4 },
  ramp: { users: 100 },
  extended: { users: 400 },
  saturate: { users: 1_200 },
  realism: { users: 100 },
};

function argument(name: string, fallback: string): string {
  return (
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
  );
}

const PROFILE = argument("profile", "ramp") as Profile;
const PORT = Number(argument("port", "3100"));
const RESULTS_ROOT = argument("out", "napload-results");
/** Often enough to see a stage change, rarely enough not to be part of the load. */
const SAMPLE_INTERVAL_MS = 5_000;
/** How the sampler's own connections identify themselves, so it can leave them out. */
const PROBE_APPLICATION_NAME = "nap-loadgen-probe";

if (PROFILES[PROFILE] === undefined) {
  console.error(`--profile must be one of ${Object.keys(PROFILES).join(", ")}`);
  process.exit(1);
}

/**
 * What counts as the system getting materially worse.
 *
 * Each trend rule carries a floor as well as a multiple, because a fourfold rise from two
 * milliseconds is not a finding — see `@nap/loadgen/degradation`. The counters and rates need
 * neither: a dropped event or a turn that never finished is degradation at any scale.
 */
const DEGRADATION: readonly DegradationRule[] = [
  { kind: "counter", metric: "event_seq_gaps", maxValue: 0 },
  { kind: "counter", metric: "event_duplicates", maxValue: 0 },
  { kind: "counter", metric: "ws_connect_failures", maxValue: 0 },
  { kind: "counter", metric: "errors_5xx", maxValue: 0 },
  { kind: "counter", metric: "errors_timeout", maxValue: 0 },
  { kind: "rate", metric: "turn_completion_rate", minValue: 0.99 },
  { kind: "rate", metric: "job_completion_rate", minValue: 0.99 },
  { kind: "rate", metric: "verification_completion_rate", minValue: 0.99 },
  // Admission is the route's own work — the rate-limit and quota queries and the write that
  // accepts the turn — and the one latency a fake-backed run measures honestly.
  {
    kind: "trend",
    metric: "admission_latency",
    statistic: "p95",
    multipleOfBaseline: 3,
    floor: 100,
  },
  // How long a turn waited before anything ran it. The queue's own depth, felt by a person.
  { kind: "trend", metric: "queue_wait", statistic: "p95", multipleOfBaseline: 3, floor: 2_000 },
  {
    kind: "trend",
    metric: "time_to_first_event",
    statistic: "p95",
    multipleOfBaseline: 3,
    floor: 1_000,
  },
  // Append to delivery. This is fanout, and it is the number the whole scaling design is about.
  {
    kind: "trend",
    metric: "event_delivery_latency",
    statistic: "p95",
    multipleOfBaseline: 3,
    floor: 500,
  },
];

/** §23's thresholds, restated here so the report says whether they held as well as k6 does. */
const THRESHOLDS: readonly Threshold[] = [
  { metric: "ws_connect_failures", statistic: "count", op: "==", value: 0 },
  { metric: "event_seq_gaps", statistic: "count", op: "==", value: 0 },
  { metric: "event_duplicates", statistic: "count", op: "==", value: 0 },
  { metric: "reconnect_seq_gaps", statistic: "count", op: "==", value: 0 },
  { metric: "reconnect_duplicates", statistic: "count", op: "==", value: 0 },
  { metric: "turn_completion_rate", statistic: "rate", op: ">", value: 0.99 },
  { metric: "verification_completion_rate", statistic: "rate", op: ">", value: 0.99 },
  { metric: "admission_latency", statistic: "p95", op: "<", value: 300 },
  { metric: "queue_wait", statistic: "p95", op: "<", value: 5_000 },
  { metric: "time_to_first_event", statistic: "p95", op: "<", value: 2_000 },
  { metric: "event_delivery_latency", statistic: "p95", op: "<", value: 1_000 },
  { metric: "dropped_iterations", statistic: "count", op: "==", value: 0 },
];

/** Samples the process and its database on a timer, and hands back everything it took. */
function startSampling(sql: postgres.Sql): { samples: ServerSample[]; stop: () => void } {
  const samples: ServerSample[] = [];
  let previousCpu = process.cpuUsage();
  let previousAt = Date.now();

  const timer = setInterval(() => {
    void (async () => {
      const now = Date.now();
      const cpu = process.cpuUsage();
      const elapsedMs = now - previousAt;
      // Microseconds of CPU over milliseconds of wall clock, as a percentage of one core. A
      // figure above 100 means the runtime's own threads, not a broken calculation.
      const usedMs = (cpu.user - previousCpu.user + (cpu.system - previousCpu.system)) / 1_000;
      previousCpu = cpu;
      previousAt = now;

      const memory = process.memoryUsage();
      // The observer's own connections are excluded by name. Counting them would report the
      // API's pool as two connections wider than it is, at exactly the moment — saturation —
      // when the number is being read to decide whether the pool is the ceiling.
      const [activity] = await sql<{ total: number; active: number }[]>`
        select count(*)::int as total,
               count(*) filter (where state = 'active')::int as active
        from pg_stat_activity
        where datname = current_database() and application_name <> ${PROBE_APPLICATION_NAME}`;
      const [events] = await sql<{ rows: number }[]>`select count(*)::int as rows from events`;

      // A bare round trip on a connection nothing else is using: it says whether the database
      // itself is answering slowly, which is the reading that separates a slow query from a
      // process too busy to read its sockets.
      const pingAt = performance.now();
      await sql`select 1`;
      const dbPingMs = performance.now() - pingAt;

      samples.push({
        at: now,
        cpuPercent: elapsedMs === 0 ? 0 : (usedMs / elapsedMs) * 100,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        dbConnections: activity?.total ?? 0,
        dbActiveQueries: activity?.active ?? 0,
        dbPingMs,
        // The whole machine, because k6 is on it too — see `ServerSample`.
        systemLoad1m: loadavg()[0] ?? 0,
        eventRows: events?.rows ?? 0,
      });
    })().catch(() => {
      // A sample that could not be taken is not worth failing a twenty-minute run over; the
      // gap shows up in the report as a window with fewer samples than its neighbours.
    });
  }, SAMPLE_INTERVAL_MS);

  return { samples, stop: () => clearInterval(timer) };
}

/**
 * §24 item 4: does `hashtext(session_id)` put two of this run's sessions on one advisory lock,
 * and does sharing one cost anything measurable?
 *
 * The collision count alone says nothing — the birthday expectation beside it is what makes it
 * readable — so the second half times the lock itself: the same number of acquisitions from the
 * same number of connections, once on distinct keys and once on a single shared one. The
 * difference is what contention would cost if two sessions really did collide.
 */
async function probeAdvisoryLocks(sql: postgres.Sql) {
  const hashed = await sql<{ hash: number }[]>`select hashtext(id::text) as hash from sessions`;
  const collisions = hashCollisions(hashed.map((row) => row.hash));

  const CLIENTS = 10;
  const PER_CLIENT = 50;
  const time = async (key: (client: number, n: number) => number) => {
    const startedAt = Date.now();
    await Promise.all(
      Array.from({ length: CLIENTS }, async (_, client) => {
        for (let n = 0; n < PER_CLIENT; n += 1) {
          await sql.begin(async (tx) => {
            await tx`select pg_advisory_xact_lock(${key(client, n)})`;
          });
        }
      }),
    );
    return (Date.now() - startedAt) / (CLIENTS * PER_CLIENT);
  };

  const distinctMs = await time((client, n) => client * 1_000 + n);
  const sharedMs = await time(() => 1);

  return { collisions, lock: { clients: CLIENTS, perClient: PER_CLIENT, distinctMs, sharedMs } };
}

/**
 * §24 item 2: what a catch-up poll would cost at this run's session count.
 *
 * Both queries are timed against the log this run actually wrote, because the answer depends
 * entirely on how many rows are in it: the per-session form asks one session for anything past
 * its cursor, the batched form asks for every session's high-water mark in one round trip.
 */
async function probePollCost(sql: postgres.Sql) {
  const sessions = await sql<{ id: string }[]>`select id from sessions`;
  const ids = sessions.map((row) => row.id);
  if (ids.length === 0) return null;

  const median = async (run: (index: number) => Promise<unknown>, times: number) => {
    const samples: number[] = [];
    for (let i = 0; i < times; i += 1) {
      const startedAt = performance.now();
      await run(i);
      samples.push(performance.now() - startedAt);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)] ?? 0;
  };

  const perSessionMs = await median(
    (index) =>
      sql`select seq, type from events where session_id = ${ids[index % ids.length] as string}
          and seq > 0 order by seq limit 100`,
    100,
  );
  const batchedMs = await median(
    () =>
      sql`select session_id, max(seq) as seq from events where session_id = any(${ids})
          group by session_id`,
    20,
  );

  const TICK_MS = 2_000;
  return {
    sessions: ids.length,
    tickIntervalMs: TICK_MS,
    perSession: {
      queryMs: perSessionMs,
      ...pollCost({
        queriesPerTick: ids.length,
        tickIntervalMs: TICK_MS,
        perQueryMs: perSessionMs,
      }),
    },
    batched: {
      queryMs: batchedMs,
      ...pollCost({ queriesPerTick: 1, tickIntervalMs: TICK_MS, perQueryMs: batchedMs }),
    },
  };
}

async function main(): Promise<void> {
  const { users } = PROFILES[PROFILE];
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${PROFILE}`;
  const outDir = join(RESULTS_ROOT, runId);
  await mkdir(outDir, { recursive: true });

  console.log(`Starting Postgres, and composing Nap with a fake sandbox and a fake model.`);
  const api = await bootLoadgenApi({ users, port: PORT });
  console.log(`API on ${api.base} — profile ${PROFILE}, results in ${outDir}\n`);

  // Its own connection, deliberately: the sampler must not compete for the pool it is measuring.
  const sql = postgres(api.postgresUrl, {
    max: 2,
    onnotice: () => {},
    connection: { application_name: PROBE_APPLICATION_NAME },
  });
  const sampler = startSampling(sql);

  // Absolute, and the script is found relative to this file: k6 writes its summary relative to
  // its own working directory, and neither of these should depend on where the command was run.
  const summaryPath = resolve(outDir, "k6-summary.json");
  const startedAt = Date.now();
  const k6 = Bun.spawn(["k6", "run", join(import.meta.dir, "..", "k6", "ramp.js")], {
    env: {
      ...process.env,
      NAP_LOADGEN_BASE: api.base,
      NAP_LOADGEN_PROFILE: PROFILE,
      NAP_LOADGEN_SUMMARY: summaryPath,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const k6Exit = await k6.exited;
  const durationMs = Date.now() - startedAt;

  sampler.stop();
  writeFileSync(
    join(outDir, "server-samples.jsonl"),
    sampler.samples.map((sample) => JSON.stringify(sample)).join("\n"),
  );

  console.log("\nProbing the database this run just filled…");
  const locks = await probeAdvisoryLocks(sql);
  const poll = await probePollCost(sql);
  await sql.end();
  await api.stop();

  const parsed = parseK6Summary(JSON.parse(readFileSync(summaryPath, "utf8")));
  if (!parsed.ok) {
    console.error(`k6's summary could not be read: ${parsed.error.message}`);
    process.exit(1);
  }

  const overall = rollupOf(parsed.value);
  // `ramp` is what the script tags samples taken while the load was still changing. A stage's
  // numbers should describe a steady load, so it is dropped rather than ranked among them.
  const stages = stageRollups(parsed.value, "stage").filter((stage) => Number.isFinite(stage.vus));
  const degradation = firstDegradation(stages, DEGRADATION);
  const thresholds = evaluateThresholds(overall, THRESHOLDS);

  // The samples, cut at the same boundaries k6 tagged its own by — so a stage's CPU and its
  // latency describe the same minutes. The boundaries come from k6 rather than from a second
  // copy of the stage table here, which could only ever drift out of step with the first.
  const spans = StageWindowsSchema.parse(
    JSON.parse(readFileSync(summaryPath.replace(/\.json$/, "-stages.json"), "utf8")),
  );
  const windows: SampleWindow[] = spans.windows.map((span) => ({
    label: span.tag,
    vus: Number(span.tag),
    from: span.from,
    to: span.to,
  }));
  const server = rollupSamples(sampler.samples, windows);

  // Sized from the *heaviest* plateau, not from the whole run: averaging a twenty-minute ramp
  // in includes the minutes spent at ten users, and a worker ceiling derived from that would be
  // set for a load the deployment has already left behind. §24 item 1.
  const heaviest = stages.at(-1);
  const heaviestSpan = spans.windows.find((span) => span.tag === heaviest?.label);
  const heaviestSeconds =
    heaviestSpan === undefined ? 0 : (heaviestSpan.to - heaviestSpan.from) / 1_000;
  const advice = recommendWorkerConcurrency({
    turnsPerSecond:
      heaviestSeconds === 0
        ? 0
        : (heaviest?.metrics.rates.job_completion_rate?.total ?? 0) / heaviestSeconds,
    meanTurnMs: heaviest?.metrics.trends.turn_duration?.mean ?? 0,
    // What one process holds today, which is the number this baseline exists to replace.
    workers: 1,
  });

  const report = {
    runId,
    profile: PROFILE,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    k6Exit,
    overall,
    stages,
    degradation,
    thresholds,
    server,
    probes: { locks, poll },
    workerConcurrency: advice,
  };
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n${"─".repeat(78)}`);
  for (const stage of stages) {
    const admission = stage.metrics.trends.admission_latency;
    const delivery = stage.metrics.trends.event_delivery_latency;
    const jobs = stage.metrics.rates.job_completion_rate;
    console.log(
      `  ${stage.label.padStart(4)} VUs  admission p95 ${Math.round(admission?.p95 ?? 0)
        .toString()
        .padStart(6)}ms   delivery p95 ${Math.round(delivery?.p95 ?? 0)
        .toString()
        .padStart(6)}ms   jobs ${jobs?.passed ?? 0}/${jobs?.total ?? 0}`,
    );
  }
  console.log(`${"─".repeat(78)}`);

  if (degradation === null) {
    console.log(
      `\nNothing degraded through ${stages.at(-1)?.label ?? "?"} VUs. §23 says the run is not` +
        ` finished until something does — rerun with --profile=extended.`,
    );
  } else {
    console.log(`\nFirst material degradation at ${degradation.vus} VUs:`);
    for (const reason of degradation.reasons) console.log(`  · ${reason}`);
  }

  for (const result of thresholds) {
    if (result.passed) continue;
    console.log(
      `  THRESHOLD  ${result.metric}.${result.statistic} ${result.op} ${result.value} — ${result.actual ?? "never recorded"}`,
    );
  }

  console.log(`\nReport written to ${join(outDir, "report.json")}`);
  process.exit(k6Exit === 0 && degradation !== null ? 0 : 1);
}

await main();
