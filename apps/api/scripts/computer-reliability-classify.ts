import type { StoredEvent } from "@nap/shared/ports/event-store";
import type { TurnOutcome } from "@nap/shared/ports/runtime";

/**
 * Why one run of "Test the app" did not pass, against an app known to be correct.
 *
 * Every app this harness tests is correct, so the only right answer is every assertion passed.
 * The kinds split what is Nap's to fix (the machine, the desktop, the ledger, the clock) from
 * what is the model's judgement (`false_failure`, `untested`, `no_assertions`), because the two
 * want different responses and a single pass rate hides which one moved.
 */
export type FailureKind =
  | "sandbox_start"
  | "checks"
  | "dev_server"
  | "desktop_start"
  | "model_provider"
  | "budget"
  | "timeout"
  | "out_of_memory"
  | "ledger_refused"
  | "computer_action"
  | "no_assertions"
  | "untested"
  | "false_failure"
  | "internal";

export type Preparation =
  | { ok: true }
  | {
      ok: false;
      stage: "sandbox_start" | "checks" | "dev_server" | "desktop_start";
      message: string;
    };

export type RunClassification = {
  passed: boolean;
  kind: FailureKind | null;
  detail: string;
  counts: { passed: number; failed: number; untested: number } | null;
  /** Calls the assertion ledger refused. A run can recover from these and still pass. */
  ledgerRefusals: number;
  /** Calls that failed for any other reason after the desktop was ready. */
  actionFailures: number;
  recording: "available" | "unavailable" | "none";
};

/**
 * What `AppTestRun` says when it refuses an annotation or an input. Matched by prefix, and
 * pinned by a test that drives the real ledger into every refusal, so a reworded message fails
 * there rather than silently turning ledger refusals into action failures here.
 */
const LEDGER_REFUSALS = [
  "Setup must precede the first test.",
  "Test IDs must be unique.",
  "State an untested assertion before describing the action.",
  "Start a test before declaring its assertion.",
  "Assertion IDs must be unique",
  "A verdict must match an untested assertion in the current test.",
  "Perform the action and inspect a new screenshot before assigning a verdict.",
  "Record setup or an untested assertion before computer input.",
];

const TURN_FAILURES: Record<string, FailureKind> = {
  budget_exceeded: "budget",
  model_unavailable: "model_provider",
  refusal: "model_provider",
  sandbox_unavailable: "sandbox_start",
};

export function classifyRun(input: {
  preparation: Preparation;
  outcome: TurnOutcome | null;
  events: readonly StoredEvent[];
  timedOut: boolean;
  oomKills: number;
}): RunClassification {
  const { events } = input;
  const ready = new Set<string>();
  const starting = new Set<string>();
  let desktopFailure: string | null = null;
  let ledgerRefusals = 0;
  let actionFailures = 0;
  let firstActionFailure: string | null = null;
  let recording: RunClassification["recording"] = "none";
  let counts: RunClassification["counts"] = null;
  let completedStatus: string | null = null;
  let turnFailure: { reason: string; message: string } | null = null;
  for (const event of events) {
    if (event.type === "computer.status") {
      (event.payload.state === "ready" ? ready : starting).add(event.payload.toolCallId);
    } else if (event.type === "tool.result" && !event.payload.ok) {
      const output = event.payload.output;
      if (LEDGER_REFUSALS.some((message) => output.startsWith(message))) ledgerRefusals += 1;
      else if (starting.has(event.payload.toolCallId) && !ready.has(event.payload.toolCallId))
        desktopFailure ??= output;
      else if (event.payload.toolName === "computer") {
        actionFailures += 1;
        firstActionFailure ??= output;
      }
    } else if (event.type === "test.recording") {
      if (event.payload.recording.state !== "started") recording = event.payload.recording.state;
    } else if (event.type === "test.completed") {
      counts = event.payload.counts;
      completedStatus = event.payload.status;
    } else if (event.type === "turn.failed") {
      turnFailure = event.payload;
    }
  }
  const result = (kind: FailureKind | null, detail: string): RunClassification => ({
    passed: kind === null,
    kind,
    detail,
    counts,
    ledgerRefusals,
    actionFailures,
    recording,
  });

  if (!input.preparation.ok) return result(input.preparation.stage, input.preparation.message);
  if (
    completedStatus === "completed" &&
    counts !== null &&
    counts.passed > 0 &&
    counts.failed === 0 &&
    counts.untested === 0 &&
    input.oomKills === 0
  )
    return result(null, `${counts.passed} assertions passed.`);
  if (input.timedOut) return result("timeout", "The run passed its wall-clock limit.");
  if (input.oomKills > 0)
    return result("out_of_memory", `${input.oomKills} processes killed for memory.`);
  if (desktopFailure !== null) return result("desktop_start", desktopFailure);
  if (turnFailure !== null) {
    const kind = TURN_FAILURES[turnFailure.reason];
    if (kind !== undefined) return result(kind, turnFailure.message);
  }
  if (counts !== null && counts.failed > 0)
    return result("false_failure", `${counts.failed} assertions failed on a correct app.`);
  if (counts !== null && counts.untested > 0) {
    if (ledgerRefusals > 0)
      return result("ledger_refused", `${ledgerRefusals} calls refused by the assertion ledger.`);
    if (firstActionFailure !== null) return result("computer_action", firstActionFailure);
    return result("untested", `${counts.untested} assertions left untested.`);
  }
  if (counts !== null && counts.passed === 0)
    return result("no_assertions", "The test recorded no assertions.");
  return result(
    "internal",
    turnFailure?.message ??
      (input.outcome && !input.outcome.ok ? input.outcome.message : "The test never completed."),
  );
}

export function summarize(runs: readonly { app: string; run: RunClassification }[]): {
  total: { passed: number; runs: number };
  apps: Record<string, { passed: number; runs: number }>;
  failures: Partial<Record<FailureKind, number>>;
} {
  const apps: Record<string, { passed: number; runs: number }> = {};
  const failures: Partial<Record<FailureKind, number>> = {};
  let passed = 0;
  for (const { app, run } of runs) {
    const entry = apps[app] ?? { passed: 0, runs: 0 };
    apps[app] = entry;
    entry.runs += 1;
    if (run.passed) {
      entry.passed += 1;
      passed += 1;
    } else if (run.kind !== null) {
      failures[run.kind] = (failures[run.kind] ?? 0) + 1;
    }
  }
  return { total: { passed, runs: runs.length }, apps, failures };
}

/** The used half of `docker stats`' MemUsage, `"512.3MiB / 2GiB"`, in MiB. Null when unreadable. */
export function dockerMemoryMiB(usage: string): number | null {
  const match = usage.trim().match(/^([\d.]+)\s*([KMG]i?B|B)\s*\//);
  if (!match?.[1] || !match[2]) return null;
  const value = Number(match[1]);
  const scale: Record<string, number> = {
    B: 1 / 1_048_576,
    KiB: 1 / 1024,
    KB: 1 / 1024,
    MiB: 1,
    MB: 1,
    GiB: 1024,
    GB: 1024,
  };
  const factor = scale[match[2]];
  return Number.isFinite(value) && factor !== undefined ? Math.round(value * factor) : null;
}
