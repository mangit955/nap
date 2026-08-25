import { describe, expect, it } from "vitest";
import { DEFAULT_CATEGORY_WEIGHTS } from "./category.ts";
import {
  type BenchReport,
  evaluatorErrorReport,
  parseBenchReport,
  serialiseBenchReport,
} from "./report.ts";
import { VISUAL_NOT_RUN } from "./visual.ts";

const report: BenchReport = {
  runId: "3f2a1c4e-0000-4000-8000-000000000001",
  taskId: "landing-page",
  sessionId: "3f2a1c4e-0000-4000-8000-000000000002",
  turnId: "3f2a1c4e-0000-4000-8000-000000000003",
  status: "passed",
  errorKind: null,
  gates: [],
  scoreCap: null,
  score: 100,
  categories: [{ category: "functional", score: 100, effectiveWeight: 100, checks: 1 }],
  weights: DEFAULT_CATEGORY_WEIGHTS,
  configuration: {
    model: "openai/gpt-5.6-luna",
    budget: { maxSteps: 40, maxTokens: 400_000 },
    harness: {
      commit: "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1",
      dirty: false,
      verification: true,
    },
  },
  screenshots: [],
  visual: VISUAL_NOT_RUN,
  // A v1 report: no scoring model recorded, and neither of the fields the v2 arithmetic
  // writes. Spelled out rather than left to the schema's defaults so that this fixture still
  // round-trips to itself, which is what these tests are for.
  halves: null,
  product: null,
  metrics: {
    toolCalls: 3,
    toolFailures: 0,
    commands: 1,
    filesChanged: 2,
    turns: { started: 1, completed: 1, failed: 0, cancelled: 0 },
    tokens: { inputTokens: 1_000, outputTokens: 200 },
    turnDurationMs: 4_000,
  },
  checks: [
    {
      checkId: "build",
      kind: "command",
      category: "functional",
      weight: 1,
      required: false,
      build: false,
      outcome: "passed",
      detail: "exit 0",
    },
  ],
};

describe("a report", () => {
  it("round-trips through serialisation unchanged", () => {
    const parsed = parseBenchReport(JSON.parse(serialiseBenchReport(report)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(report);
  });

  it("keeps the run id and the session id apart", () => {
    // The word "run" collides: a NapBench run contains a Nap session, which contains
    // turns. A report carrying one id called "id" would make that ambiguous forever.
    // See CONTEXT.md, which calls this out as the collision to guard.
    expect(report.runId).not.toBe(report.sessionId);
    const parsed = parseBenchReport(JSON.parse(serialiseBenchReport(report)));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.value.runId).toBe(report.runId);
    expect(parsed.value.sessionId).toBe(report.sessionId);
  });

  it("round-trips an errored run, which has no score and no turn", () => {
    // Absent rather than zero: a run whose turn never completed produced no observation,
    // and a zero would be indistinguishable from an agent that built something broken.
    const errored: BenchReport = {
      ...report,
      status: "errored",
      score: null,
      errorKind: "sandbox",
      gates: ["turn_failed"],
      turnId: null,
      categories: [],
      checks: [],
    };
    const parsed = parseBenchReport(JSON.parse(serialiseBenchReport(errored)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(errored);
  });

  it("is written as indented JSON, so a committed report diffs line by line", () => {
    expect(serialiseBenchReport(report)).toContain("\n  ");
  });

  it("refuses a report whose score is not a percentage", () => {
    expect(parseBenchReport({ ...report, score: 140 }).ok).toBe(false);
    expect(parseBenchReport({ ...report, score: -1 }).ok).toBe(false);
  });

  it("refuses a passed run with no score", () => {
    // Passed and failed are results and both carry a score; only errored may omit one.
    expect(parseBenchReport({ ...report, score: null }).ok).toBe(false);
  });

  it("refuses an unknown status", () => {
    expect(parseBenchReport({ ...report, status: "exploded" }).ok).toBe(false);
  });

  it("accepts a cancelled run, which has no score and no error kind", () => {
    // Somebody stopped it. Not a result, so no score; not a fault, so no kind.
    const cancelled = {
      ...report,
      status: "cancelled",
      score: null,
      errorKind: null,
      gates: ["turn_cancelled"],
      categories: [],
      checks: [],
    };
    expect(parseBenchReport(cancelled).ok).toBe(true);
  });

  it("refuses a scored cancellation", () => {
    expect(parseBenchReport({ ...report, status: "cancelled" }).ok).toBe(false);
  });

  it("refuses an errored run with no error kind", () => {
    // An error nobody can attribute is an error that cannot be aggregated, which is the only
    // thing an unscored run had left to offer.
    const errored = { ...report, status: "errored", score: null, categories: [], checks: [] };
    expect(parseBenchReport({ ...errored, errorKind: null }).ok).toBe(false);
    expect(parseBenchReport({ ...errored, errorKind: "sandbox" }).ok).toBe(true);
  });

  it("refuses an error kind on a run that produced a result", () => {
    expect(parseBenchReport({ ...report, errorKind: "agent" }).ok).toBe(false);
  });

  it("refuses a score above the cap recorded beside it", () => {
    // The report has to be arithmetically closed: a cap that was recorded and not applied
    // would make the report explain itself incorrectly, which is worse than not explaining.
    expect(parseBenchReport({ ...report, score: 100, scoreCap: 40 }).ok).toBe(false);
    expect(parseBenchReport({ ...report, score: 40, scoreCap: 40 }).ok).toBe(true);
  });

  it("refuses a gate it does not know", () => {
    // Gates are grouped and diffed across months of reports, so the set is closed.
    expect(parseBenchReport({ ...report, gates: ["vibes"] }).ok).toBe(false);
  });
});

describe("what a failed command said", () => {
  const failing = (output?: unknown) => ({
    ...report,
    status: "failed" as const,
    score: 40,
    checks: [
      {
        checkId: "lint",
        kind: "command",
        category: "code",
        weight: 1,
        required: false,
        build: false,
        outcome: "failed",
        detail: "exit 1",
        ...(output === undefined ? {} : { output }),
      },
    ],
  });

  it("round-trips both streams with their own truncation flags", () => {
    const parsed = parseBenchReport(
      failing({
        stdout: { text: "", truncated: false },
        stderr: { text: 'Script not found "lint"', truncated: false },
      }),
    );

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.checks[0]?.output?.stderr.text).toBe('Script not found "lint"');
    }
  });

  it("is absent on a check that recorded none, and stays absent through a round trip", () => {
    // Absent rather than a pair of empty streams, so a passing check adds nothing to the diff.
    const parsed = parseBenchReport(failing());

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.checks[0]?.output).toBeUndefined();
  });

  it("refuses a stream that does not say whether it was truncated", () => {
    // The flag is the whole point: without it a fragment reads as the complete output, which
    // is a more confident wrong answer than recording nothing would have been.
    const parsed = parseBenchReport(
      failing({ stdout: { text: "x" }, stderr: { text: "", truncated: false } }),
    );

    expect(parsed.ok).toBe(false);
  });
});

describe("the configuration a run was held at", () => {
  it("reads a report written before the field existed as having recorded nothing", () => {
    // The three funded runs predate this field. Refusing them would make the archive
    // unreadable to the tool that produced it, so the field defaults instead of being
    // required — and it defaults to *unrecorded* rather than to a plausible-looking budget,
    // because inventing one would put a ceiling in an archived artefact that no run was held at.
    const { configuration: _omitted, ...archived } = report;

    const parsed = parseBenchReport(archived);
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.value.configuration).toEqual({ model: null, budget: null, harness: null });
  });

  it("keeps what it was given when the run did record it", () => {
    const parsed = parseBenchReport(report);
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.value.configuration.budget).toEqual({
        maxSteps: 40,
        maxTokens: 400_000,
      });
  });

  it("refuses a configuration that could not describe any real run", () => {
    expect(
      parseBenchReport({
        ...report,
        configuration: { model: "m", budget: { maxSteps: 0, maxTokens: 1 }, harness: null },
      }).ok,
    ).toBe(false);
  });

  it("gives two parses their own object rather than one they share", () => {
    // The default is a getter for this reason. A shared literal would hand every archived
    // report the same object, so anything that later wrote to one would silently edit them all.
    const { configuration: _omitted, ...archived } = report;
    const first = parseBenchReport(archived);
    const second = parseBenchReport(archived);

    expect(first.ok && second.ok && first.value.configuration).not.toBe(
      second.ok ? second.value.configuration : null,
    );
  });
});

describe("a report for a crash in the benchmark itself", () => {
  const crashed = evaluatorErrorReport({
    runId: "3f2a1c4e-0000-4000-8000-000000000004",
    taskId: "todo-crud",
    sessionId: "3f2a1c4e-0000-4000-8000-000000000005",
    weights: DEFAULT_CATEGORY_WEIGHTS,
    metrics: {
      toolCalls: 2,
      toolFailures: 0,
      commands: 0,
      filesChanged: 1,
      turns: { started: 1, completed: 1, failed: 0, cancelled: 0 },
    },
  });

  it("errors with no score, blaming the instrument rather than what it measures", () => {
    expect(crashed.status).toBe("errored");
    expect(crashed.errorKind).toBe("evaluator");
    expect(crashed.score).toBeNull();
  });

  it("keeps whatever the run had already done, rather than reporting zeroes", () => {
    // The metrics come from the events the turn really wrote, so a crash after the work
    // still records the work.
    expect(crashed.metrics.toolCalls).toBe(2);
  });

  it("is a valid report, so a crashed run is still archived like any other", () => {
    expect(parseBenchReport(JSON.parse(serialiseBenchReport(crashed))).ok).toBe(true);
  });
});
