/**
 * The ramp to 100 concurrent turns, and the profile that holds them there.
 *
 * `docs/scaling-design.md` §23 specifies this run: one VU is one user, with their own project,
 * their own session and their own WebSocket, submitting turns in a burst so that a hundred turns
 * are genuinely in flight at once. It drives the composed API over real HTTP and real sockets
 * against a real Postgres; the sandbox and the model behind it are fakes slowed to the speeds a
 * funded run recorded, so the run costs nothing and measures Nap's own plumbing — admission, the
 * turn queue, the event log, fanout — which is the part the scaling work is about.
 *
 * Driven by `bun run loadgen:ramp`, which boots that API, spawns this, samples the server while
 * it runs and writes the report. Running this file by hand needs `NAP_LOADGEN_BASE` pointed at
 * something already serving.
 *
 * **The async WebSocket module, not `k6/ws`.** The legacy one blocks the VU for the socket's
 * lifetime, so a VU could not hold a stream open *and* POST the turn that fills it — which is the
 * whole journey. The module's name is version-dependent and worth checking rather than
 * recalling: on the k6 in this checkout (v2.0.0) it is `k6/websockets`;
 * `k6/experimental/websockets` still resolves but warns that it is going away, and
 * `k6/net/websockets` — the name much of the documentation uses — fails dependency resolution
 * outright and takes the whole run with it.
 *
 * **Every measurement is tagged with the stage it was taken in**, and each of those sub-metrics
 * is named in `thresholds` — declaring a threshold is the only thing that makes k6 report a
 * sub-metric at all, and per-stage figures are how the first point of material degradation gets
 * found. Only the *plateaus* are tagged with a VU count; samples taken while the ramp is still
 * climbing are tagged `ramp` and read by nothing, because a stage's numbers should describe a
 * steady load rather than the moment it changed.
 */

import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Rate, Trend } from "k6/metrics";
import { clearTimeout, setTimeout } from "k6/timers";
import { WebSocket } from "k6/websockets";

const BASE = __ENV.NAP_LOADGEN_BASE || "http://localhost:3100";
const PROFILE = __ENV.NAP_LOADGEN_PROFILE || "ramp";
const SUMMARY_PATH = __ENV.NAP_LOADGEN_SUMMARY || "k6-summary.json";

/**
 * Long enough for the slowest calibrated turn (43s) plus a cold start, a preview render and
 * whatever queue it waited in. A turn that has not finished by now is a failed turn, and saying
 * so is the point — but the number has to be well clear of the honest worst case or the run
 * reports the harness's impatience as the system's ceiling.
 */
const TURN_TIMEOUT_MS = Number(__ENV.NAP_LOADGEN_TURN_TIMEOUT_MS || 240_000);

/** How much of a realism VU's cycle is spent not asking for anything. See §23. */
const THINK_TIME_MS = Number(__ENV.NAP_LOADGEN_THINK_MS || 75_000);

/** One in this many VUs drops its socket mid-turn and rejoins at the highest seq it saw. */
const RECONNECT_EVERY = 10;

// ── The profiles ────────────────────────────────────────────────────────────────────────────

/** `ramp` is §23's headline profile verbatim: 10 → 25 → 50 → 75 → 100, held at each. */
const RAMP = [
  { target: 10, rampSeconds: 30, holdSeconds: 120 },
  { target: 25, rampSeconds: 30, holdSeconds: 120 },
  { target: 50, rampSeconds: 30, holdSeconds: 180 },
  { target: 75, rampSeconds: 30, holdSeconds: 180 },
  { target: 100, rampSeconds: 30, holdSeconds: 300 },
];

/**
 * What to run when the headline profile finds nothing.
 *
 * §23 is explicit that the run is not a success unless the first point of material degradation
 * is found, so a clean 100 is a reason to keep climbing rather than a result.
 */
const EXTENDED = RAMP.concat([
  { target: 150, rampSeconds: 30, holdSeconds: 180 },
  { target: 200, rampSeconds: 30, holdSeconds: 180 },
  { target: 300, rampSeconds: 30, holdSeconds: 180 },
  { target: 400, rampSeconds: 30, holdSeconds: 300 },
]);

/** Two plateaus and eighty seconds, for proving the wiring without waiting twenty minutes. */
const SMOKE = [
  { target: 2, rampSeconds: 5, holdSeconds: 45 },
  { target: 4, rampSeconds: 5, holdSeconds: 45 },
];

/**
 * Where the ceiling is, when 400 was not it.
 *
 * It starts at 400 rather than repeating the climb: the baseline every stage is compared
 * against is the *first* one, and by this point 400 is the load already known to be dull.
 * Above this the load generator is a real suspect, which is why the harness records the whole
 * machine's load average and not only the server's CPU.
 */
const SATURATE = [
  { target: 400, rampSeconds: 60, holdSeconds: 120 },
  { target: 600, rampSeconds: 60, holdSeconds: 180 },
  { target: 800, rampSeconds: 60, holdSeconds: 180 },
  { target: 1000, rampSeconds: 60, holdSeconds: 180 },
  { target: 1200, rampSeconds: 60, holdSeconds: 300 },
];

const PLATEAUS = {
  ramp: RAMP,
  extended: EXTENDED,
  saturate: SATURATE,
  smoke: SMOKE,
  realism: [{ target: 100 }],
};
const TABLE = PLATEAUS[PROFILE];
if (TABLE === undefined) throw new Error(`unknown profile ${PROFILE}`);

/** k6's own stage list: climb to each target, then hold it, then come back down. */
function k6Stages(table) {
  const stages = [];
  for (const plateau of table) {
    stages.push({ duration: `${plateau.rampSeconds}s`, target: plateau.target });
    stages.push({ duration: `${plateau.holdSeconds}s`, target: plateau.target });
  }
  stages.push({ duration: "60s", target: 0 });
  return stages;
}

/** When each plateau starts and ends, in milliseconds since the run began. */
function windows(table) {
  const result = [];
  let at = 0;
  for (const plateau of table) {
    at += plateau.rampSeconds * 1_000;
    result.push({ tag: String(plateau.target), from: at, to: at + plateau.holdSeconds * 1_000 });
    at += plateau.holdSeconds * 1_000;
  }
  return result;
}

const WINDOWS = PROFILE === "realism" ? null : windows(TABLE);

/**
 * Which stage a sample belongs to, from the clock rather than from the live VU count.
 *
 * `vusActive` is the obvious source and the wrong one: during a ramp it sits between two
 * targets, so samples taken while the load is changing would be filed under a stage that was
 * never held. The clock says exactly which plateau the run is in, and `ramp` for everything in
 * between — which the analysis ignores.
 */
function stageTag() {
  if (WINDOWS === null) return "100";
  const at = exec.instance.currentTestRunDuration;
  for (const window of WINDOWS) {
    if (at >= window.from && at < window.to) return window.tag;
  }
  return "ramp";
}

// ── Metrics ─────────────────────────────────────────────────────────────────────────────────
// Declared here because k6 refuses a metric created inside a VU, which is also why the error
// categories are a fixed list rather than a counter per code seen.

const wsConnect = new Trend("ws_connect", true);
const wsConnectFailures = new Counter("ws_connect_failures");
const admissionLatency = new Trend("admission_latency", true);
const queueWait = new Trend("queue_wait", true);
const timeToFirstEvent = new Trend("time_to_first_event", true);
const eventDeliveryLatency = new Trend("event_delivery_latency", true);
const eventInterArrival = new Trend("event_inter_arrival", true);
const turnDuration = new Trend("turn_duration", true);
const verificationDuration = new Trend("verification_duration", true);
const jobDuration = new Trend("job_duration", true);
const sandboxAcquisition = new Trend("sandbox_acquisition", true);

const seqGaps = new Counter("event_seq_gaps");
const duplicates = new Counter("event_duplicates");
const reconnects = new Counter("reconnects");
const reconnectGaps = new Counter("reconnect_seq_gaps");
const reconnectDuplicates = new Counter("reconnect_duplicates");

const turnCompletion = new Rate("turn_completion_rate");
const jobCompletion = new Rate("job_completion_rate");
const verificationCompletion = new Rate("verification_completion_rate");

const ERRORS = {
  rate_limited: new Counter("errors_rate_limited"),
  sandbox_quota_exceeded: new Counter("errors_sandbox_quota_exceeded"),
  byok_required: new Counter("errors_byok_required"),
  model_not_allowed: new Counter("errors_model_not_allowed"),
  no_session: new Counter("errors_no_session"),
  unauthorized: new Counter("errors_unauthorized"),
  server_error: new Counter("errors_5xx"),
  timeout: new Counter("errors_timeout"),
  socket: new Counter("errors_socket"),
  other: new Counter("errors_other"),
};

function countError(category, tags) {
  (ERRORS[category] || ERRORS.other).add(1, tags);
}

// ── Options ─────────────────────────────────────────────────────────────────────────────────

/**
 * A threshold per stage for every metric worth reading per stage — generous on purpose.
 *
 * These are not judgements. k6 only reports a tagged sub-metric if some threshold names it, so
 * this is how the per-stage numbers reach the summary at all; the bounds are wide enough never
 * to be the thing that fails a run. §23's real thresholds are the untagged ones below.
 */
function perStageThresholds() {
  const thresholds = {};
  const tags = (WINDOWS === null ? [{ tag: "100" }] : WINDOWS).map((window) => window.tag);

  for (const tag of tags) {
    for (const metric of [
      "admission_latency",
      "queue_wait",
      "time_to_first_event",
      "event_delivery_latency",
      "event_inter_arrival",
      "turn_duration",
      "job_duration",
      "verification_duration",
      "sandbox_acquisition",
      "ws_connect",
      "http_req_duration",
    ]) {
      thresholds[`${metric}{stage:${tag}}`] = ["p(95)>=0"];
    }
    for (const metric of [
      "event_seq_gaps",
      "event_duplicates",
      "ws_connect_failures",
      "reconnects",
      "reconnect_seq_gaps",
      "reconnect_duplicates",
      ...Object.values(ERRORS).map((counter) => counter.name),
    ]) {
      thresholds[`${metric}{stage:${tag}}`] = ["count>=0"];
    }
    for (const metric of [
      "turn_completion_rate",
      "job_completion_rate",
      "verification_completion_rate",
      // A rate, not a counter — k6 refuses `count` on one, and refuses the whole run with it.
      "http_req_failed",
    ]) {
      thresholds[`${metric}{stage:${tag}}`] = ["rate>=0"];
    }
  }

  return thresholds;
}

export const options = {
  scenarios:
    PROFILE === "realism"
      ? {
          // §23's secondary profile: a hundred people with the tab open, about a quarter of them
          // waiting on a turn at any moment. The duty cycle does the arithmetic — a ~25s turn
          // followed by 75s of reading is one active user in four.
          realism: {
            executor: "constant-vus",
            vus: 100,
            duration: __ENV.NAP_LOADGEN_DURATION || "8m",
            exec: "realism",
            gracefulStop: "120s",
          },
        }
      : {
          ramp: {
            executor: "ramping-vus",
            gracefulRampDown: "120s",
            gracefulStop: "120s",
            stages: k6Stages(TABLE),
          },
        },
  // p(99) and count are not in k6's default set, and half of §23's thresholds are stated in p99.
  /**
   * Keep the cookie jar across iterations.
   *
   * k6 clears it at the start of every iteration by default, which is right for a VU that is a
   * fresh visitor each time and exactly wrong here: one VU is one *person*, signed in once, with
   * one project they keep coming back to. Without this the first turn of each VU succeeds and
   * every turn after it is a 401 — which reads, from the metrics alone, like the API refusing
   * load rather than the load generator forgetting who it was.
   */
  noCookiesReset: true,
  summaryTrendStats: ["avg", "min", "med", "p(95)", "p(99)", "max", "count"],
  thresholds: Object.assign(
    {
      // §23's list. The two counters are the ones that decide whether fanout is correct.
      ws_connect_failures: ["count==0"],
      event_seq_gaps: ["count==0"],
      event_duplicates: ["count==0"],
      turn_completion_rate: ["rate>0.99"],
      verification_completion_rate: ["rate>0.99"],
      "http_req_duration{name:submit_turn}": ["p(95)<500", "p(99)<1500"],
      http_req_failed: ["rate<0.01"],
      admission_latency: ["p(95)<300"],
      queue_wait: ["p(95)<5000"],
      time_to_first_event: ["p(95)<2000"],
      event_delivery_latency: ["p(95)<1000"],
      // Not a property of the system: it is how the run proves the load generator was not
      // itself the bottleneck, which is what makes every number above it worth reading.
      dropped_iterations: ["count==0"],
    },
    perStageThresholds(),
  ),
};

// ── One user ────────────────────────────────────────────────────────────────────────────────
// Module scope in k6 is per-VU, so this is one user's state and it survives their iterations —
// which is what makes a VU one person with one project rather than a new signup every turn.

let user = null;
/** The highest seq this user has seen, so a reconnect asks for the gap rather than the log. */
let lastSeq = 0;

function cookieHeader() {
  const jar = http.cookieJar().cookiesForURL(BASE);
  return Object.keys(jar)
    .map((name) => `${name}=${jar[name][0]}`)
    .join("; ");
}

/**
 * Signs in through the demo door and creates this VU's project, once.
 *
 * The demo door is the only sign-in a load generator can drive without an OAuth browser dance,
 * and it is a real code path rather than a test-only one — see §23.
 */
function ensureUser(tags) {
  if (user !== null) return true;

  const signIn = http.post(`${BASE}/api/auth/sign-in/anonymous`, "{}", {
    headers: { "content-type": "application/json" },
    tags: Object.assign({ name: "sign_in" }, tags),
  });
  if (!check(signIn, { "signed in": (r) => r.status === 200 })) {
    countError(signIn.status >= 500 ? "server_error" : "other", tags);
    return false;
  }

  const created = http.post(
    `${BASE}/projects`,
    JSON.stringify({ name: `loadgen vu ${exec.vu.idInTest}` }),
    {
      headers: { "content-type": "application/json" },
      tags: Object.assign({ name: "create_project" }, tags),
    },
  );
  if (!check(created, { "project created": (r) => r.status === 201 })) {
    countError(created.status >= 500 ? "server_error" : "other", tags);
    return false;
  }

  const body = created.json();
  user = { projectId: body.projectId, sessionId: body.sessionId, cookie: cookieHeader() };
  return true;
}

function streamUrl(afterSeq) {
  return `${BASE.replace(/^http/, "ws")}/ws?sessionId=${user.sessionId}&seq=${afterSeq}`;
}

/**
 * One turn, watched from a socket that may be dropped and rejoined halfway through.
 *
 * Resolves when the Job closes, or when nothing has arrived for `TURN_TIMEOUT_MS`. It is written
 * as one promise around the socket's callbacks because that is the only shape in which a VU can
 * be *inside* a stream and still make the HTTP request that fills it.
 */
function runTurn(tags, options) {
  const willReconnect = options.reconnect;

  return new Promise((resolve) => {
    let socket = null;
    /** The live socket's own retirement flag — see `attach`. */
    let current = { retired: false };
    let settled = false;
    let timer = null;
    let submittedAt = 0;
    let turnStartedAt = 0;
    let verificationStartedAt = 0;
    let sawVerification = false;
    let firstEventSeen = false;
    let previousEventAt = 0;
    let reconnected = false;

    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (socket !== null) {
        try {
          socket.close();
        } catch (_error) {
          // A socket the server already closed is not an error worth failing a turn over.
        }
      }
      resolve(outcome);
    };

    const arm = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        countError("timeout", tags);
        turnCompletion.add(false, tags);
        jobCompletion.add(false, tags);
        finish("timeout");
      }, TURN_TIMEOUT_MS);
    };

    const submit = () => {
      submittedAt = Date.now();
      const response = http.post(
        `${BASE}/sessions/${user.sessionId}/turns`,
        JSON.stringify({ message: "Build a todo list with add, complete, and delete" }),
        {
          headers: { "content-type": "application/json" },
          tags: Object.assign({ name: "submit_turn" }, tags),
        },
      );
      admissionLatency.add(Date.now() - submittedAt, tags);

      if (response.status === 202) return true;

      // By category rather than by status: `rate_limited` and `sandbox_quota_exceeded` are both
      // 409 and mean entirely different things about which ceiling was reached.
      let code = "other";
      if (response.status >= 500) code = "server_error";
      else if (response.status === 401 || response.status === 403) code = "unauthorized";
      else {
        const body = response.json();
        if (body !== null && typeof body === "object" && body.code) code = body.code;
      }
      countError(code, tags);
      turnCompletion.add(false, tags);
      jobCompletion.add(false, tags);
      return false;
    };

    /** Every seq check lives here, so a reconnect is held to exactly the same rule. */
    const account = (event) => {
      if (event.seq <= lastSeq) {
        duplicates.add(1, tags);
        if (reconnected) reconnectDuplicates.add(1, tags);
        return;
      }
      if (event.seq > lastSeq + 1) {
        const missing = event.seq - lastSeq - 1;
        seqGaps.add(missing, tags);
        if (reconnected) reconnectGaps.add(missing, tags);
      }
      lastSeq = event.seq;
    };

    const onEvent = (event) => {
      const now = Date.now();
      account(event);

      // The row's own timestamp against this clock: the load generator and the API share a
      // machine, so this really is append-to-delivery rather than a round trip.
      const createdAt = Date.parse(event.createdAt);
      if (!Number.isNaN(createdAt)) eventDeliveryLatency.add(now - createdAt, tags);
      if (previousEventAt !== 0) eventInterArrival.add(now - previousEventAt, tags);
      previousEventAt = now;

      if (!firstEventSeen && submittedAt !== 0) {
        firstEventSeen = true;
        timeToFirstEvent.add(now - submittedAt, tags);
      }

      switch (event.type) {
        case "turn.started":
          turnStartedAt = now;
          queueWait.add(now - submittedAt, tags);
          // Halfway through is the point of the exercise: a socket dropped before the turn is
          // running has nothing to catch up on.
          if (willReconnect && !reconnected) reconnect();
          break;
        case "preview.ready":
          // The closest thing to sandbox acquisition a client can time: the address it was
          // given is now serving. Only a turn that had to make a sandbox records one.
          sandboxAcquisition.add(now - submittedAt, tags);
          break;
        case "verification.started":
          verificationStartedAt = now;
          break;
        case "verification.completed":
          sawVerification = true;
          if (verificationStartedAt !== 0) {
            verificationDuration.add(now - verificationStartedAt, tags);
          }
          break;
        case "turn.completed":
          turnDuration.add(now - turnStartedAt, tags);
          turnCompletion.add(true, tags);
          break;
        case "turn.failed":
          turnDuration.add(now - turnStartedAt, tags);
          turnCompletion.add(false, tags);
          break;
        case "job.completed":
          jobDuration.add(now - submittedAt, tags);
          jobCompletion.add(true, tags);
          verificationCompletion.add(sawVerification, tags);
          finish("completed");
          break;
        default:
          break;
      }
    };

    /**
     * Opens a stream at `afterSeq` and wires it up.
     *
     * The `retired` flag is per socket rather than per turn, and that is load-bearing: a socket
     * closed on purpose reports its close *later*, through the event loop, by which time a
     * reconnect has already succeeded. A flag on the turn would have been cleared by then, and
     * the old socket's farewell would fail a turn that is running perfectly well.
     */
    const attach = (afterSeq, onReady) => {
      const connectAt = Date.now();
      const self = { retired: false };
      const stream = new WebSocket(streamUrl(afterSeq), null, {
        headers: { Cookie: user.cookie },
        tags: tags,
      });
      socket = stream;

      stream.onmessage = (message) => {
        if (self.retired) return;
        arm();
        const frame = JSON.parse(message.data);
        if (frame.type === "ping") {
          stream.send(JSON.stringify({ type: "pong" }));
          return;
        }
        if (frame.type === "ready") {
          wsConnect.add(Date.now() - connectAt, tags);
          onReady();
          return;
        }
        if (frame.type === "event") onEvent(frame.event);
      };

      stream.onerror = () => {
        if (self.retired || settled) return;
        wsConnectFailures.add(1, tags);
        countError("socket", tags);
        turnCompletion.add(false, tags);
        jobCompletion.add(false, tags);
        finish("socket_error");
      };

      stream.onclose = () => {
        if (self.retired || settled) return;
        countError("socket", tags);
        // Both, like every other way a turn can end badly. A client that lost its socket cannot
        // claim the turn finished — it stopped watching — and recording only the job would make
        // turn completion read better than reality at exactly the load where sockets start
        // dropping, which is the reading the whole run exists to produce.
        turnCompletion.add(false, tags);
        jobCompletion.add(false, tags);
        finish("closed");
      };

      return self;
    };

    /**
     * Drops the socket mid-turn and rejoins at the highest seq seen.
     *
     * The catch-up path, and the one most likely to break under fanout changes — so the gap and
     * duplicate accounting deliberately carries across the break rather than restarting. A gap
     * here is a client that lost part of its transcript for good.
     */
    const reconnect = () => {
      reconnects.add(1, tags);
      const dropped = socket;
      current.retired = true;
      try {
        dropped.close();
      } catch (_error) {
        // Already gone; the reconnect below is what matters.
      }
      reconnected = true;
      current = attach(lastSeq, () => {});
    };

    arm();
    current = attach(lastSeq, () => {
      // Connected is not caught up. A turn submitted before the replay finished would measure
      // the backlog rather than the turn.
      if (submittedAt !== 0) return;
      if (!submit()) finish("refused");
    });
  });
}

// ── The scenarios' entrypoints ──────────────────────────────────────────────────────────────

async function oneTurn() {
  const tags = { stage: stageTag() };
  if (!ensureUser(tags)) return;
  await runTurn(tags, { reconnect: exec.vu.idInTest % RECONNECT_EVERY === 0 });
}

export default async function () {
  await oneTurn();
}

/** The secondary profile: connected throughout, active about a quarter of the time. */
export async function realism() {
  await oneTurn();
  await new Promise((resolve) => setTimeout(resolve, THINK_TIME_MS));
}

/**
 * The summary, and beside it the wall-clock boundaries of each plateau.
 *
 * The stage table lives here because it *is* k6's `options.stages`; writing the windows out is
 * what lets the harness cut its own server samples at the same boundaries without a second copy
 * of the table to keep in step. Absolute epoch milliseconds rather than offsets, because only
 * this process knows when k6 considered the run to have started.
 */
export function handleSummary(data) {
  const endedAt = Date.now();
  const startedAt = endedAt - data.state.testRunDurationMs;
  const spans =
    WINDOWS === null
      ? [{ tag: "100", from: 0, to: data.state.testRunDurationMs }]
      : WINDOWS.map((window) => ({ tag: window.tag, from: window.from, to: window.to }));

  const summary = {};
  summary[SUMMARY_PATH] = JSON.stringify(data, null, 2);
  summary[SUMMARY_PATH.replace(/\.json$/, "-stages.json")] = JSON.stringify(
    {
      profile: PROFILE,
      startedAt,
      windows: spans.map((span) => ({
        tag: span.tag,
        from: startedAt + span.from,
        to: startedAt + span.to,
      })),
    },
    null,
    2,
  );
  return summary;
}
