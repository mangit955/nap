/**
 * Whose fault an errored run was.
 *
 * An errored run has no score, so the only thing it can contribute to a benchmark is an
 * attribution — and getting that attribution from the *reason* rather than from the fact of
 * failure is the whole point. The runtime's failure reasons already span agent causes and
 * infrastructure ones: a sandbox that could not be started is E2B having a bad afternoon, and
 * a model that could not be reached is a provider outage. Neither is evidence about the
 * agent's quality, and a benchmark that counted them as such would rank models by how lucky
 * they were.
 *
 * **What is measured is the model, with Nap held fixed** — see docs/adr/0004. Everything else
 * is apparatus: Nap's runtime, the sandbox provider, the browser driver and NapBench itself.
 * That is the rule the seven kinds below are grouped by, and the rule that decides which of
 * the two columns each of them counts in.
 *
 * Seven kinds, per `CONTEXT.md`, in four groups: the system under test's own two halves, the
 * two providers it depends on, the two halves of the instrument, and the operator. Each was
 * named before anything raised it, and each now has a producer.
 */

import type { TurnFailureReason } from "@nap/shared/events";
import { z } from "zod";

export const ERROR_KINDS = [
  // The system under test. `agent` is the only kind that is evidence about a model; `runtime`
  // is the same deployment failing underneath it, which is not.
  /** The agent itself: it refused, or it spent its budget without arriving. */
  "agent",
  /** Nap's own machinery: a store that could not be read, a bug in the runtime. */
  "runtime",

  // What the system under test depends on, and neither of them is ours.
  /** The provider: throttled, overloaded, or briefly down. Says nothing about the model. */
  "model",
  /** The execution plane: no sandbox, a sandbox that went away, a preview nobody can reach. */
  "sandbox",

  // The instrument.
  /** The browser half of the evaluator: a driver that would not start or could not drive. */
  "browser",
  /** NapBench crashing on itself — the instrument, rather than anything it was measuring. */
  "evaluator",

  /** The run was set up wrong: no such session, an unmeasurable task, a missing credential. */
  "configuration",
] as const;

export const ErrorKindSchema = z.enum(ERROR_KINDS);
export type ErrorKind = z.infer<typeof ErrorKindSchema>;

/**
 * The two sides of the ledger a suite reports separately.
 *
 * *Agent* is evidence about what is being measured. *Infrastructure* is everything else that
 * stopped a run producing a number — a provider outage, an execution plane having a bad
 * afternoon, a browser that would not start, a bug in the benchmark, a run set up wrong. None
 * of it says anything about a model, and a suite carrying much of it is not comparable data.
 */
export type ErrorAttribution = "agent" | "infrastructure";

/**
 * Whose column an error kind counts in.
 *
 * A total record rather than a predicate, so an eighth error kind fails this file's typecheck
 * and has to be attributed deliberately — the alternative is a new kind defaulting into
 * "infrastructure" and quietly making every suite look cleaner than it is. This is not
 * hypothetical: `runtime` was added by adding it here and following the type error.
 */
const ERROR_ATTRIBUTION: Record<ErrorKind, ErrorAttribution> = {
  agent: "agent",
  /**
   * Infrastructure, because Nap is the thing held fixed rather than the thing measured.
   *
   * It reads oddly at first — Nap is under test, so surely its faults count? — but the column
   * is not "was this our fault", it is "is this evidence about the model". A runtime that
   * fell over tells you nothing about the agent whose work it was carrying, and every model
   * compared under that deployment suffers it equally.
   */
  runtime: "infrastructure",
  model: "infrastructure",
  sandbox: "infrastructure",
  browser: "infrastructure",
  evaluator: "infrastructure",
  configuration: "infrastructure",
};

export function attributionOf(kind: ErrorKind): ErrorAttribution {
  return ERROR_ATTRIBUTION[kind];
}

/**
 * How a run ended, given that its turn did not complete.
 *
 * Not every failed turn is an error: a cancelled one is a *cancelled* run, which is not an
 * observation and is excluded from the aggregates entirely.
 */
export type TurnFailureDisposition =
  | { status: "cancelled"; errorKind: null }
  | { status: "errored"; errorKind: ErrorKind };

/**
 * Maps a turn's failure reason to how the run is recorded.
 *
 * An exhaustive `switch` with no `default`, deliberately: a seventh `TurnFailureReason` added
 * to the event contract fails this file's typecheck rather than falling into a catch-all and
 * being attributed to whichever kind happened to be the default. Silent misattribution is the
 * one failure mode this module exists to prevent.
 */
export function dispositionForTurnFailure(reason: TurnFailureReason): TurnFailureDisposition {
  switch (reason) {
    // The two things the agent does wrong on its own: declining the work, and never
    // finishing it. Both are evidence about the agent, which is why they are the only two
    // that count against it.
    case "refusal":
      return errored("agent");
    case "budget_exceeded":
      return errored("agent");

    case "model_unavailable":
      return errored("model");
    case "sandbox_unavailable":
      return errored("sandbox");

    /**
     * Nap's own machinery broke — a store that could not be read, a bug in the runtime.
     *
     * Its own kind, because both of the kinds that already existed were wrong for it, in
     * opposite directions. `evaluator` is reserved for *NapBench's* own crashes, so using it
     * here would file a bug in the system under test as a bug in the instrument. `agent` —
     * what this was until docs/adr/0004 — is the more damaging error: the agent may have
     * written perfectly good code and had the runtime fall over underneath it, and counting
     * that against the model is exactly the misattribution this module exists to prevent.
     *
     * So: infrastructure, like the other two, but nameable apart from them. A suite carrying
     * a lot of `runtime` is a deployment to fix; one carrying a lot of `evaluator` is a
     * benchmark to fix; and a reader can tell which source tree to open.
     */
    case "internal":
      return errored("runtime");

    // Not an error at all. A run somebody stopped is not an observation, and calling it one
    // would let whoever ran the suite change its numbers by pressing stop.
    case "cancelled":
      return { status: "cancelled", errorKind: null };
  }
}

function errored(errorKind: ErrorKind): TurnFailureDisposition {
  return { status: "errored", errorKind };
}
