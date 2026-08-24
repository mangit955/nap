/**
 * One scripted user, start to finish.
 *
 * This is the journey `docs/scaling-design.md` §23 says a virtual user runs: sign in through
 * the demo door, create a project, open a socket, wait to be told the replay is over, submit a
 * turn, and read frames until the Job closes. A hundred of these at once is the whole load
 * test, so it is worth being exactly one function.
 *
 * It is written against a client *port* rather than against `fetch` and `WebSocket`, for the
 * reason the rest of this package is pure: the interesting content is the ordering — which step
 * waits on what, which stopwatch starts where, which failure is recorded under which category —
 * and none of that is testable if the only way to run it is to boot a server. The driver
 * implements the port over real HTTP and a real socket; a test implements it in twenty lines.
 *
 * **A step that fails ends the journey.** There is no point measuring a turn that was never
 * admitted, and a harness that carried on would report a `job_duration` for a user who never
 * had one.
 */

import type { Metrics } from "./metrics.ts";
import { checkSequence } from "./sequence.ts";

export type JourneyEvent = {
  seq: number;
  type: string;
  /** When this process saw the frame, which is what every delivery latency is measured from. */
  receivedAt: number;
};

export interface JourneyStream {
  /** Resolves once the server has replayed the log and said so with a `ready` frame. */
  ready(): Promise<void>;
  /** Resolves on the first event of any of `types`; rejects if it does not arrive in time. */
  waitFor(types: readonly string[]): Promise<JourneyEvent>;
  /** Every event delivered so far, in arrival order. */
  received(): readonly JourneyEvent[];
  close(): void;
}

/** Everything the journey does to the system, as narrow as the journey happens to be. */
export interface JourneyClient {
  /** The demo door. Leaves the caller holding whatever credential later calls need. */
  signIn(): Promise<void>;
  createProject(name: string): Promise<{ projectId: string; sessionId: string }>;
  openStream(sessionId: string, afterSeq: number): Promise<JourneyStream>;
  /**
   * Resolves with what the API answered, rather than throwing on a refusal. A 409 for a
   * sandbox quota is an expected outcome of a load test — arguably the point of one — so it is
   * recorded and counted, not raised.
   */
  submitTurn(
    sessionId: string,
    message: string,
  ): Promise<{ status: number; code?: string | undefined }>;
}

export type JourneyStep =
  | "sign_in"
  | "create_project"
  | "open_stream"
  | "submit_turn"
  | "await_turn"
  | "await_job";

export type JourneyResult =
  | {
      ok: true;
      projectId: string;
      sessionId: string;
      /** Every seq this user received, so a caller can print the stream it read. */
      seqs: number[];
    }
  | { ok: false; step: JourneyStep; message: string };

export type JourneyOptions = {
  client: JourneyClient;
  /** What this user asks for. One sentence, as a real first turn is. */
  message: string;
  /** The project's name. Distinct per user, so a run's rows are tellable apart afterwards. */
  projectName: string;
  metrics: Metrics;
  /** Injected so a test can measure without a clock. */
  now?: () => number;
};

/** The counters that must read zero, declared up front so a healthy run prints them as zero. */
export const ZERO_COUNTERS = ["ws_connect_failures", "event_seq_gaps", "event_duplicates"] as const;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runUserJourney(options: JourneyOptions): Promise<JourneyResult> {
  const { client, metrics, message, projectName } = options;
  const now = options.now ?? Date.now;

  for (const counter of ZERO_COUNTERS) metrics.declareCounter(counter);

  const fail = (step: JourneyStep, error: unknown): JourneyResult => {
    metrics.count(`errors_${step}`);
    return { ok: false, step, message: reasonOf(error) };
  };

  // ── Sign in ───────────────────────────────────────────────────────────────
  const signInAt = now();
  try {
    await client.signIn();
  } catch (error) {
    return fail("sign_in", error);
  }
  metrics.trend("sign_in", now() - signInAt);

  // ── Create a project ──────────────────────────────────────────────────────
  const createAt = now();
  let project: { projectId: string; sessionId: string };
  try {
    project = await client.createProject(projectName);
  } catch (error) {
    return fail("create_project", error);
  }
  metrics.trend("create_project", now() - createAt);

  // ── Open the stream ───────────────────────────────────────────────────────
  // From seq 0, as a browser opening a project for the first time does. The cursor is kept
  // because the gap check at the end is only meaningful relative to where the client joined.
  const afterSeq = 0;
  const connectAt = now();
  let stream: JourneyStream;
  try {
    stream = await client.openStream(project.sessionId, afterSeq);
    // Connected is not the same as caught up. A user who submitted a turn before the replay
    // finished would see its events arrive out of order with the backlog, and would be
    // measuring the backlog rather than the turn.
    await stream.ready();
  } catch (error) {
    metrics.count("ws_connect_failures");
    return fail("open_stream", error);
  }
  metrics.trend("ws_connect", now() - connectAt);

  try {
    // ── Submit ──────────────────────────────────────────────────────────────
    const before = stream.received().length;
    const submitAt = now();
    const submitted = await client.submitTurn(project.sessionId, message);
    metrics.trend("admission_latency", now() - submitAt);

    if (submitted.status !== 202) {
      metrics.rate("turn_completion_rate", false);
      metrics.rate("job_completion_rate", false);
      // By category rather than by status: `sandbox_quota_exceeded` and `rate_limited` are both
      // 409 and mean entirely different things about where the ceiling was hit.
      metrics.count(`errors_${submitted.code ?? `http_${submitted.status}`}`);
      return {
        ok: false,
        step: "submit_turn",
        message: `the API answered ${submitted.status}${submitted.code === undefined ? "" : ` (${submitted.code})`}`,
      };
    }

    // ── Watch it run ────────────────────────────────────────────────────────
    const started = await stream.waitFor(["turn.started"]);
    metrics.trend("queue_wait", started.receivedAt - submitAt);

    // The first thing to arrive after the submission — `user.message`, ordinarily. It is what
    // says the system acknowledged this user at all, and it is the number a person watching a
    // chat pane experiences as responsiveness.
    const first = stream.received()[before];
    if (first !== undefined) metrics.trend("time_to_first_event", first.receivedAt - submitAt);

    const settled = await stream.waitFor(["turn.completed", "turn.failed"]);
    metrics.trend("turn_duration", settled.receivedAt - started.receivedAt);
    metrics.rate("turn_completion_rate", settled.type === "turn.completed");

    if (settled.type === "turn.failed") {
      metrics.rate("job_completion_rate", false);
      return { ok: false, step: "await_turn", message: "the turn failed" };
    }

    // A Job outlives its turn: verification and any repairs happen after `turn.completed`, and
    // `job.completed` is the only frame that means the work is really over.
    const job = await stream.waitFor(["job.completed"]);
    metrics.trend("job_duration", job.receivedAt - submitAt);
    metrics.rate("job_completion_rate", true);

    const seqs = stream.received().map((event) => event.seq);
    const { gaps, duplicates } = checkSequence(seqs, afterSeq);
    metrics.count("event_seq_gaps", gaps.length);
    metrics.count("event_duplicates", duplicates.length);

    return { ok: true, projectId: project.projectId, sessionId: project.sessionId, seqs };
  } catch (error) {
    metrics.rate("job_completion_rate", false);
    return fail("await_job", error);
  } finally {
    stream.close();
  }
}
