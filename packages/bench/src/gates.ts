/**
 * The gate ladder: rules that constrain a run's outcome regardless of what its checks summed
 * to.
 *
 * Gates exist so that a broken application cannot score well by being good at everything
 * except working. A run whose build failed but whose lint, formatting and structure were
 * immaculate is not a 70; a run whose turn never completed is not a zero, because a zero is a
 * measurement and nothing was measured.
 *
 * **An ordered list of pure functions, each individually tested**, per `CONTEXT.md`. Order is
 * the whole design: the earlier a gate sits, the more fundamental the thing it noticed, and
 * the first one that fires terminally wins. A sandbox that vanished is a better explanation
 * of a run than "the required check failed", and it must not be possible for the second to be
 * reported when the first is true.
 *
 * Nothing here does I/O or reads a clock; every input is already an observation. That is what
 * lets each rung be tested on its own, and what stops the ladder growing a way to change its
 * mind about what happened.
 */

import type { TurnFailureReason } from "@nap/shared/events";
import { z } from "zod";
import { dispositionForTurnFailure, type ErrorKind } from "./error-kind.ts";
import type { PreviewDiagnosis } from "./preview.ts";
import type { CheckResult } from "./report.ts";
import type { RunStatus } from "./status.ts";

/**
 * The gates that can fire, named so a report can say which one decided it.
 *
 * A closed enum rather than free text: reports are diffed across months, and "why did this
 * fail" is exactly the field somebody will want to group by.
 */
export const GATE_IDS = [
  "turn_failed",
  "turn_cancelled",
  "workspace_missing",
  "preview_unreachable",
  "preview_not_started",
  "nothing_measurable",
  "required_check_failed",
  "build_failed",
] as const;

export const GateIdSchema = z.enum(GATE_IDS);
export type GateId = z.infer<typeof GateIdSchema>;

/**
 * What a failing build leaves a run able to score at most.
 *
 * Recorded in the report as a fired gate rather than folded silently into the number, so the
 * headline stays reproducible by hand: compute the weighted mean from the check list, see
 * `build_failed`, apply this cap.
 */
export const BUILD_FAILURE_SCORE_CAP = 40;

export type GateInput = {
  /** How the run's turn ended. */
  turn: { ok: true } | { ok: false; reason: TurnFailureReason };
  /** What was left to run checks in, once the turn was over. */
  workspace: { ok: true } | { ok: false; missing: "session" | "sandbox" };
  /** The preview verdict, or null when the task never asked for one. */
  preview: PreviewDiagnosis | null;
  checks: readonly CheckResult[];
  /** The weighted mean from `scoreRun`, null when nothing produced a result. */
  score: number | null;
};

export type RunVerdict = {
  status: RunStatus;
  score: number | null;
  errorKind: ErrorKind | null;
  /** Which gates fired, in the order they were asked. Empty when the checks decided it. */
  gates: GateId[];
  /**
   * The ceiling a gate imposed, or null when none did.
   *
   * Reported rather than left implicit because it is the one thing standing between the
   * check list and the headline: with it, `score` is `min(weighted mean, scoreCap)` and a
   * reader can still arrive at the number in front of them from the figures beside it.
   */
  scoreCap: number | null;
};

/**
 * What one gate has to say. `null` from a gate means it has nothing to say about this run.
 *
 * `terminal` marks the gates that end the question rather than adjust the answer: no score
 * survives them, and no later gate is consulted, because a run that produced no observation
 * cannot also have a required check to report on.
 */
type GateEffect = {
  gate: GateId;
  status: RunStatus;
  errorKind: ErrorKind | null;
  terminal: boolean;
  /** Caps the score of a run that still carries one. */
  scoreCap: number | null;
};

type Gate = (input: GateInput) => GateEffect | null;

/** A turn that did not complete produced no observation, whoever's fault it was. */
const turnGate: Gate = ({ turn }) => {
  if (turn.ok) return null;

  const disposition = dispositionForTurnFailure(turn.reason);
  return {
    gate: disposition.status === "cancelled" ? "turn_cancelled" : "turn_failed",
    status: disposition.status,
    errorKind: disposition.errorKind,
    terminal: true,
    scoreCap: null,
  };
};

/**
 * A completed turn with nothing left to look at.
 *
 * The two are different faults. No session is a run pointed at something that does not exist,
 * which is somebody's configuration; no sandbox behind a completed turn is the workspace
 * having gone away underneath the run, which is the execution plane's.
 */
const workspaceGate: Gate = ({ workspace }) => {
  if (workspace.ok) return null;

  return {
    gate: "workspace_missing",
    status: "errored",
    errorKind: workspace.missing === "session" ? "configuration" : "sandbox",
    terminal: true,
    scoreCap: null,
  };
};

/**
 * The disambiguation, once `diagnosePreview` has done the work of telling the two apart.
 *
 * Unreachable is terminal and infrastructure; not started is a *failure*, which is the whole
 * point — the checks that ran still stand, and the run is recorded as an application that did
 * not come up rather than as a run nobody could measure.
 */
const previewGate: Gate = ({ preview }) => {
  if (preview === null || preview.state === "serving") return null;

  if (preview.state === "unreachable") {
    return {
      gate: "preview_unreachable",
      status: "errored",
      errorKind: "sandbox",
      terminal: true,
      scoreCap: null,
    };
  }

  return {
    gate: "preview_not_started",
    status: "failed",
    errorKind: null,
    terminal: false,
    scoreCap: null,
  };
};

/**
 * A run where nothing produced a result at all.
 *
 * Not a zero: zero means every check was asked and none passed, and this means none were
 * asked. A task with no answerable checks is a task written wrong, so it is configuration.
 */
const measurableGate: Gate = ({ score }) =>
  score !== null
    ? null
    : {
        gate: "nothing_measurable",
        status: "errored",
        errorKind: "configuration",
        terminal: true,
        scoreCap: null,
      };

/** A check the task declared non-negotiable. Fails the run whatever the rest came to. */
const requiredGate: Gate = ({ checks }) =>
  checks.some((check) => check.required && check.outcome === "failed")
    ? {
        gate: "required_check_failed",
        status: "failed",
        errorKind: null,
        terminal: false,
        scoreCap: null,
      }
    : null;

/** An application that does not compile. Fails, and cannot score above the cap. */
const buildGate: Gate = ({ checks }) =>
  checks.some((check) => check.build && check.outcome === "failed")
    ? {
        gate: "build_failed",
        status: "failed",
        errorKind: null,
        terminal: false,
        scoreCap: BUILD_FAILURE_SCORE_CAP,
      }
    : null;

/**
 * The ladder, in order. Terminal rungs first, from the most fundamental failure outwards.
 *
 * The order is a decision, not an accident of how the file was typed, and `gates.test.ts`
 * pins it with cases where two rungs are true at once and only one may be reported.
 */
const GATE_LADDER: readonly Gate[] = [
  turnGate,
  workspaceGate,
  previewGate,
  measurableGate,
  requiredGate,
  buildGate,
];

/**
 * Runs the ladder over one run's observations.
 *
 * The baseline — before any gate speaks — is what the checks themselves say: every check that
 * produced a result had to pass. Gates only ever make that verdict worse, which is the
 * property that makes them safe to add.
 */
export function applyGates(input: GateInput): RunVerdict {
  const verdict: RunVerdict = {
    status: input.checks.some((check) => check.outcome === "failed") ? "failed" : "passed",
    score: input.score,
    errorKind: null,
    gates: [],
    scoreCap: null,
  };

  for (const gate of GATE_LADDER) {
    const effect = gate(input);
    if (effect === null) continue;

    verdict.gates.push(effect.gate);

    if (effect.terminal) {
      // No score survives a run that produced no observation, and nothing later has anything
      // to add: there is no check list to have opinions about. No cap either — a ceiling on
      // a number that does not exist would be one more thing to explain.
      return {
        ...verdict,
        status: effect.status,
        score: null,
        errorKind: effect.errorKind,
        scoreCap: null,
      };
    }

    verdict.status = effect.status;
    if (effect.scoreCap !== null) {
      // The lowest ceiling wins, so two capping gates cannot raise each other's limit.
      verdict.scoreCap = Math.min(verdict.scoreCap ?? effect.scoreCap, effect.scoreCap);
      if (verdict.score !== null) verdict.score = Math.min(verdict.score, verdict.scoreCap);
    }
  }

  return verdict;
}
