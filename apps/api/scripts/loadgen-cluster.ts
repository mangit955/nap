/**
 * The §23 ramp again, against a Kubernetes cluster instead of against one process.
 *
 * `infra/k8s/load/run.sh` is what drives this, and this is what drives k6 — the *same* k6 script,
 * the same profiles, the same thresholds and the same degradation rules as the single-process
 * baseline in `loadgen-ramp.ts`. That is the entire design: if the two runs differ, the
 * architecture underneath is the only thing that changed.
 *
 * Three things happen here that cannot happen in k6, and one that could not happen in
 * `loadgen-ramp.ts` either:
 *
 *   - **the cluster is sampled while the load runs** — replica counts per component, pod CPU and
 *     memory, the socket gauge as the autoscaler itself reads it, and `turn_requests` depth. The
 *     first and the last are the two numbers the whole ticket turns on: whether the deployment
 *     grew, and what it grew in response to.
 *   - **the report is assembled**, joining k6's per-stage figures to those samples.
 *   - **it is compared against the baseline**, stage by stage and paired on VU count, which is
 *     what makes the run an answer rather than a second set of numbers.
 *   - and the API is *not booted here*: it is already running, as a deployment, and this
 *     process reaches it only over the ingress and over a port-forward to its database.
 *
 * It costs nothing: the pods run `cluster-proof.ts` with `NAP_PROOF_CALIBRATED_LATENCY=true`, so
 * the model and the sandbox are fakes at recorded speeds, and nothing leaves this machine.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import {
  type ClusterSample,
  compareStages,
  rollupClusterSamples,
} from "@nap/loadgen/cluster-samples";
import { firstDegradation } from "@nap/loadgen/degradation";
import { parseK6Summary, rollupOf, type StageRollup, stageRollups } from "@nap/loadgen/k6-summary";
import {
  RAMP_DEGRADATION,
  RAMP_SUBMIT_THRESHOLDS,
  RAMP_THRESHOLDS,
} from "@nap/loadgen/ramp-thresholds";
import { evaluateThresholds } from "@nap/loadgen/report";
import type { SampleWindow } from "@nap/loadgen/server-samples";
import postgres from "postgres";
import { z } from "zod";

/** What the k6 script writes beside its summary: when each plateau began and ended. */
const StageWindowsSchema = z.object({
  profile: z.string(),
  startedAt: z.number(),
  windows: z.array(z.object({ tag: z.string(), from: z.number(), to: z.number() })),
});

const PROFILES = ["smoke", "ramp", "extended", "saturate", "realism"] as const;

function argument(name: string, fallback: string): string {
  return (
    process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
  );
}

/** Parsed rather than cast — see `loadgen-ramp.ts`, which makes the same argument at length. */
const ArgumentsSchema = z.object({
  profile: z.enum(PROFILES),
  base: z.url(),
  namespace: z.string().min(1),
  databaseUrl: z.string().min(1),
  out: z.string().min(1),
  /** A previous run's `report.json`, to compare against. Empty means no comparison. */
  baseline: z.string(),
});

const parsedArguments = ArgumentsSchema.safeParse({
  profile: argument("profile", "ramp"),
  base: argument("base", "http://localhost:8081"),
  namespace: argument("namespace", "nap"),
  databaseUrl: argument("database-url", "postgres://nap:nap@localhost:15432/nap"),
  out: argument("out", "napload-results"),
  baseline: argument("baseline", ""),
});

if (!parsedArguments.success) {
  for (const issue of parsedArguments.error.issues) {
    console.error(`--${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const {
  profile: PROFILE,
  base: BASE,
  namespace: NAMESPACE,
  databaseUrl: DATABASE_URL,
  out: RESULTS_ROOT,
  baseline: BASELINE,
} = parsedArguments.data;

/** Often enough to see a scaling decision, rarely enough not to be part of the load. */
const SAMPLE_INTERVAL_MS = 5_000;
/** How the sampler's own connections identify themselves, so it can leave them out. */
const PROBE_APPLICATION_NAME = "nap-loadgen-probe";

/** What the two runs are lined up on, stage by stage. §23's headline numbers, and no others. */
const COMPARED = [
  { metric: "admission_latency", statistic: "p95" },
  { metric: "queue_wait", statistic: "p95" },
  { metric: "time_to_first_event", statistic: "p95" },
  { metric: "event_delivery_latency", statistic: "p95" },
  { metric: "turn_duration", statistic: "p95" },
  { metric: "event_seq_gaps", statistic: "count" },
  { metric: "event_duplicates", statistic: "count" },
] as const;

/**
 * A `kubectl` call, answered as parsed JSON.
 *
 * Failure is `null` rather than a throw: a sample that could not be taken is not worth failing a
 * twenty-minute run over, and the gap shows up in the report as a window with fewer samples than
 * its neighbours. The same argument `loadgen-ramp.ts`'s sampler makes.
 */
async function kubectlJson(args: string[]): Promise<unknown> {
  try {
    const proc = Bun.spawn(["kubectl", ...args], { stdout: "pipe", stderr: "pipe" });
    const [text, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (exit !== 0) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Enough of `kubectl get pods -o json` to count ready pods per component. */
const PodListSchema = z.object({
  items: z.array(
    z.object({
      metadata: z.object({ labels: z.record(z.string(), z.string()).optional() }).optional(),
      status: z
        .object({
          conditions: z.array(z.object({ type: z.string(), status: z.string() })).optional(),
        })
        .optional(),
    }),
  ),
});

/** Enough of `kubectl top pods -o json`, whose figures are strings with units. */
const PodMetricsSchema = z.object({
  items: z.array(
    z.object({
      containers: z.array(z.object({ usage: z.object({ cpu: z.string(), memory: z.string() }) })),
    }),
  ),
});

/** Enough of the custom-metrics API's answer to sum one gauge across pods. */
const CustomMetricsSchema = z.object({
  items: z.array(z.object({ value: z.string() })),
});

/** `123n`, `45u`, `600m` or a bare core count — what the metrics API reports CPU in. */
function millicores(raw: string): number {
  if (raw.endsWith("n")) return Number(raw.slice(0, -1)) / 1_000_000;
  if (raw.endsWith("u")) return Number(raw.slice(0, -1)) / 1_000;
  if (raw.endsWith("m")) return Number(raw.slice(0, -1));
  return Number(raw) * 1_000;
}

/** `123Ki`, `45Mi`, `2Gi` or bytes. */
function bytes(raw: string): number {
  const units: Record<string, number> = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 };
  for (const [suffix, factor] of Object.entries(units)) {
    if (raw.endsWith(suffix)) return Number(raw.slice(0, -suffix.length)) * factor;
  }
  return Number(raw);
}

/** Quantities in the custom-metrics API carry a unit too, and a socket count is always plain. */
function quantity(raw: string): number {
  return raw.endsWith("m") ? Number(raw.slice(0, -1)) / 1_000 : Number(raw);
}

async function readReplicas(): Promise<Record<string, number>> {
  const raw = await kubectlJson(["-n", NAMESPACE, "get", "pods", "-o", "json"]);
  const parsed = PodListSchema.safeParse(raw);
  if (!parsed.success) return {};

  const counts: Record<string, number> = {};
  for (const pod of parsed.data.items) {
    const component = pod.metadata?.labels?.["app.kubernetes.io/component"];
    if (component === undefined) continue;
    // Ready, not merely scheduled: a pod that is still starting cannot claim or serve, and
    // counting it would report the deployment as having grown before it had.
    const ready = pod.status?.conditions?.some(
      (condition) => condition.type === "Ready" && condition.status === "True",
    );
    if (ready !== true) continue;
    counts[component] = (counts[component] ?? 0) + 1;
  }
  return counts;
}

async function readPodUsage(): Promise<{ cpuMillicores: number; memoryBytes: number }> {
  const raw = await kubectlJson([
    "get",
    "--raw",
    `/apis/metrics.k8s.io/v1beta1/namespaces/${NAMESPACE}/pods`,
  ]);
  const parsed = PodMetricsSchema.safeParse(raw);
  if (!parsed.success) return { cpuMillicores: 0, memoryBytes: 0 };

  let cpuMillicores = 0;
  let memoryBytes = 0;
  for (const pod of parsed.data.items) {
    for (const container of pod.containers) {
      cpuMillicores += millicores(container.usage.cpu);
      memoryBytes += bytes(container.usage.memory);
    }
  }
  return { cpuMillicores, memoryBytes };
}

/**
 * The socket gauge, read the way the autoscaler reads it.
 *
 * Deliberately through the custom-metrics API rather than by scraping the pods: what matters is
 * not that the number exists but that it reaches an HPA, and this is the whole path — the pod's
 * `/metrics`, Prometheus, the adapter, the aggregation layer. A cluster without the adapter
 * answers nothing here, which is exactly what its HPA sees.
 */
async function readSocketGauge(): Promise<number | null> {
  const raw = await kubectlJson([
    "get",
    "--raw",
    `/apis/custom.metrics.k8s.io/v1beta1/namespaces/${NAMESPACE}/pods/*/nap_ws_connections`,
  ]);
  const parsed = CustomMetricsSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.items.reduce((total, item) => total + quantity(item.value), 0);
}

function startSampling(sql: postgres.Sql): { samples: ClusterSample[]; stop: () => void } {
  const samples: ClusterSample[] = [];

  const timer = setInterval(() => {
    void (async () => {
      const [replicas, usage, sockets] = await Promise.all([
        readReplicas(),
        readPodUsage(),
        readSocketGauge(),
      ]);

      const [activity] = await sql<{ total: number; active: number }[]>`
        select count(*)::int as total,
               count(*) filter (where state = 'active')::int as active
        from pg_stat_activity
        where datname = current_database() and application_name <> ${PROBE_APPLICATION_NAME}`;
      const [depth] = await sql<{ queued: number; leased: number }[]>`
        select count(*) filter (where state = 'queued')::int as queued,
               count(*) filter (where state = 'leased')::int as leased
        from turn_requests`;
      const [events] = await sql<{ rows: number }[]>`select count(*)::int as rows from events`;

      const pingAt = performance.now();
      await sql`select 1`;
      const dbPingMs = performance.now() - pingAt;

      samples.push({
        at: Date.now(),
        replicas,
        podCpuMillicores: usage.cpuMillicores,
        podMemoryBytes: usage.memoryBytes,
        // Kept as `null` when the custom-metrics API answered nothing, rather than collapsed to
        // zero: a cluster with no adapter and a cluster with nobody connected are different
        // findings, and the whole claim about the API's autoscaler rests on telling them apart.
        wsConnections: sockets,
        queueDepth: { queued: depth?.queued ?? 0, leased: depth?.leased ?? 0 },
        dbConnections: activity?.total ?? 0,
        dbActiveQueries: activity?.active ?? 0,
        dbPingMs,
        systemLoad1m: loadavg()[0] ?? 0,
        eventRows: events?.rows ?? 0,
      });
    })().catch(() => {
      // See `kubectlJson`: a missed sample is a gap in the report, not a failed run.
    });
  }, SAMPLE_INTERVAL_MS);

  return { samples, stop: () => clearInterval(timer) };
}

/**
 * A previous run's `report.json`, validated down to the numbers the comparison reads.
 *
 * Parsed rather than cast, and not as ceremony: the file is on disk, was written by an older
 * version of a script, and is named on a command line — three ways for its shape to be wrong. A
 * cast would turn any of them into `undefined` arriving inside `statisticOf` and a comparison
 * table of `NaN`, twenty minutes after the run that produced it.
 *
 * `passthrough` on the metric summaries, because a future run may record statistics this one does
 * not and a baseline should not be refused for carrying more than is asked of it.
 */
const SummaryStatisticsSchema = z
  .object({
    count: z.number(),
    min: z.number(),
    max: z.number(),
    mean: z.number(),
    p50: z.number(),
    p95: z.number(),
    p99: z.number(),
  })
  .loose();

const BaselineReportSchema = z.object({
  stages: z.array(
    z.object({
      label: z.string(),
      vus: z.number(),
      metrics: z.object({
        trends: z.record(z.string(), SummaryStatisticsSchema),
        counters: z.record(z.string(), z.number()),
        rates: z.record(
          z.string(),
          z.object({ passed: z.number(), total: z.number(), rate: z.number() }),
        ),
      }),
    }),
  ),
});

function readBaselineStages(path: string): StageRollup[] {
  const parsed = BaselineReportSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) {
    console.error(`the baseline at ${path} is not a load report: ${parsed.error.message}`);
    process.exit(1);
  }
  return parsed.data.stages;
}

async function main(): Promise<void> {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-cluster-${PROFILE}`;
  const outDir = join(RESULTS_ROOT, runId);
  await mkdir(outDir, { recursive: true });

  // Before twenty minutes of load, not after: an ingress that is not routing yet produces a run
  // of nothing but connection failures, and the shape of that report is indistinguishable from a
  // deployment that fell over.
  const live = await fetch(`${BASE}/livez`).catch(() => null);
  if (live === null || !live.ok) {
    console.error(`${BASE}/livez did not answer — is the cluster up? See infra/k8s/load/run.sh`);
    process.exit(1);
  }

  console.log(`Ramping ${PROFILE} at ${BASE}; results in ${outDir}\n`);

  const sql = postgres(DATABASE_URL, {
    max: 2,
    onnotice: () => {},
    connection: { application_name: PROBE_APPLICATION_NAME },
  });
  const sampler = startSampling(sql);

  const summaryPath = resolve(outDir, "k6-summary.json");
  const startedAt = Date.now();
  const k6 = Bun.spawn(["k6", "run", join(import.meta.dir, "..", "k6", "ramp.js")], {
    env: {
      ...process.env,
      NAP_LOADGEN_BASE: BASE,
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
    join(outDir, "cluster-samples.jsonl"),
    sampler.samples.map((sample) => JSON.stringify(sample)).join("\n"),
  );
  await sql.end();

  const parsed = parseK6Summary(JSON.parse(readFileSync(summaryPath, "utf8")));
  if (!parsed.ok) {
    console.error(`k6's summary could not be read: ${parsed.error.message}`);
    process.exit(1);
  }

  const overall = rollupOf(parsed.value);
  const stages = stageRollups(parsed.value, "stage").filter((stage) => Number.isFinite(stage.vus));
  const degradation = firstDegradation(stages, RAMP_DEGRADATION);
  const thresholds = [
    ...evaluateThresholds(overall, RAMP_THRESHOLDS),
    ...evaluateThresholds(
      rollupOf(parsed.value, { name: "submit_turn" }),
      RAMP_SUBMIT_THRESHOLDS,
    ).map((result) => ({ ...result, metric: "http_req_duration{name:submit_turn}" })),
  ];

  // `safeParse`, like every other boundary here: a missing or truncated `-stages.json` is an
  // expected failure of a twenty-minute run, and a thrown Zod error at this point loses the k6
  // summary that has already been written beside it.
  const stagesPath = summaryPath.replace(/\.json$/, "-stages.json");
  const parsedSpans = StageWindowsSchema.safeParse(JSON.parse(readFileSync(stagesPath, "utf8")));
  if (!parsedSpans.success) {
    console.error(`${stagesPath} is not a stage-window file: ${parsedSpans.error.message}`);
    process.exit(1);
  }
  const spans = parsedSpans.data;
  const windows: SampleWindow[] = spans.windows.map((span) => ({
    label: span.tag,
    vus: Number(span.tag),
    from: span.from,
    to: span.to,
  }));
  const cluster = rollupClusterSamples(sampler.samples, windows);

  const comparison =
    BASELINE === "" ? null : compareStages(readBaselineStages(BASELINE), stages, [...COMPARED]);

  const report = {
    runId,
    profile: PROFILE,
    target: "cluster",
    base: BASE,
    startedAt: new Date(startedAt).toISOString(),
    durationMs,
    k6Exit,
    overall,
    stages,
    degradation,
    thresholds,
    cluster,
    ...(comparison === null ? {} : { baseline: BASELINE, comparison }),
  };
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n${"─".repeat(96)}`);
  for (const stage of stages) {
    const window = cluster.find((entry) => entry.label === stage.label);
    const admission = stage.metrics.trends.admission_latency;
    const delivery = stage.metrics.trends.event_delivery_latency;
    const jobs = stage.metrics.rates.job_completion_rate;
    const api = window?.replicas.api;
    const worker = window?.replicas.worker;
    console.log(
      `  ${stage.label.padStart(4)} VUs  admission p95 ${Math.round(admission?.p95 ?? 0)
        .toString()
        .padStart(6)}ms   delivery p95 ${Math.round(delivery?.p95 ?? 0)
        .toString()
        .padStart(6)}ms   jobs ${jobs?.passed ?? 0}/${jobs?.total ?? 0}` +
        `   api ${api === undefined ? "?" : `${api.min}-${api.max}`}` +
        `   workers ${worker === undefined ? "?" : `${worker.min}-${worker.max}`}`,
    );
  }
  console.log(`${"─".repeat(96)}`);

  if (comparison !== null) {
    console.log("\nAgainst the baseline (candidate ÷ baseline; below 1 is better):");
    for (const row of comparison) {
      if (row.ratio === null) continue;
      console.log(
        `  ${String(row.vus).padStart(4)} VUs  ${row.metric}.${row.statistic}` +
          `  ${Math.round(row.baseline ?? 0)} → ${Math.round(row.candidate ?? 0)}` +
          `  (×${row.ratio.toFixed(2)})`,
      );
    }
  }

  for (const result of thresholds) {
    if (result.passed) continue;
    console.log(
      `  THRESHOLD  ${result.metric}.${result.statistic} ${result.op} ${result.value} — ${result.actual ?? "never recorded"}`,
    );
  }

  console.log(`\nReport written to ${join(outDir, "report.json")}`);

  /**
   * The exit code is about *thresholds*, not about finding degradation — which is where this
   * parts company with `loadgen-ramp.ts`.
   *
   * The baseline existed to find the first point of material degradation, so a flat ramp meant
   * it had not finished. This run has a different question: does the cluster hold every §23
   * threshold at a hundred? A flat ramp is the answer rather than a missing one.
   */
  const failed = thresholds.filter((result) => !result.passed);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
