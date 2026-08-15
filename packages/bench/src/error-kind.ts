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
 * Six kinds, per `CONTEXT.md`. Three come from a turn's failure reason, one from the preview
 * probe and the run's own setup, one from a browser that would not start, and one — `evaluator`
 * — from NapBench crashing on itself, which the CLI records rather than letting it abort a
 * suite. Each was named before anything raised it, and each now has a producer.
 */

import type { TurnFailureReason } from "@nap/shared/events";
import { z } from "zod";

export const ERROR_KINDS = [
  /** The agent itself: it refused, or it spent its budget without arriving. */
  "agent",
  /** The provider: throttled, overloaded, or briefly down. Says nothing about the model. */
  "model",
  /** The execution plane: no sandbox, a sandbox that went away, a preview nobody can reach. */
  "sandbox",
  /** The browser half of the evaluator: a driver that would not start or could not drive. */
  "browser",
  /** NapBench, or the runtime it drives — the apparatus, rather than what is being measured. */
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
 * A total record rather than a predicate, so a seventh error kind fails this file's typecheck
 * and has to be attributed deliberately — the alternative is a new kind defaulting into
 * "infrastructure" and quietly making every suite look cleaner than it is.
 */
const ERROR_ATTRIBUTION: Record<ErrorKind, ErrorAttribution> = {
  agent: "agent",
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
     * `agent` rather than `evaluator`, and the pull is towards the wrong answer here.
     * `evaluator` is reserved for *NapBench's* own crashes, so that a bug in the benchmark
     * is never attributed to what it is measuring; using it for a Nap fault would file a
     * bug in the system under test as a bug in the instrument, which is the same confusion
     * pointing the other way. Nap's runtime is part of what is being measured, so its
     * failures belong on that side of the ledger — with the imprecision recorded rather
     * than hidden: this is not the *model* misbehaving, and a suite with a lot of it should
     * be read as a deployment to fix rather than a model to rank.
     */
    case "internal":
      return errored("agent");

    // Not an error at all. A run somebody stopped is not an observation, and calling it one
    // would let whoever ran the suite change its numbers by pressing stop.
    case "cancelled":
      return { status: "cancelled", errorKind: null };
  }
}

function errored(errorKind: ErrorKind): TurnFailureDisposition {
  return { status: "errored", errorKind };
}
