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
 * Six kinds, per `CONTEXT.md`. Three come from a turn's failure reason and one more from the
 * preview probe and the run's own setup. The remaining two — `browser` and `evaluator` — are
 * declared with nothing that raises them yet, on purpose: the first belongs to the browser
 * driver and the second to NapBench crashing on itself, neither of which exists. Naming them
 * now costs nothing and keeps the vocabulary whole; inventing producers for them would mean
 * writing the code that fails before the code that can fail.
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
