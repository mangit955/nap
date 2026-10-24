import type { DistributiveOmit, PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import type { Runtime, TurnOutcome } from "@nap/shared/ports/runtime";
import { describe, expect, it, vi } from "vitest";
import { APP_TEST_TASKS, evaluateAppTest, parseAppTestArgs, runAppTest } from "./app-test.ts";

const task = APP_TEST_TASKS[0]!;
const sessionId = "00000000-0000-4000-8000-000000000001";
const turnId = "00000000-0000-4000-8000-000000000002";
const jobId = "00000000-0000-4000-8000-000000000003";
const commitSha = "a".repeat(40);
const outcome: TurnOutcome = { ok: true, turnId, commitSha: null };
function log(result: "passed" | "failed" | "untested" = "passed"): StoredEvent[] {
  const entry = <T extends DistributiveOmit<PendingEvent, "sessionId" | "turnId" | "createdAt">>(
    event: T,
  ) => ({
    sessionId,
    turnId,
    createdAt: "2026-10-24T00:00:00Z",
    ...event,
  });
  const assertion = {
    type: "assertion",
    id: task.assertionId,
    expectation: "A saved note survives reload",
  } as const;
  const events: PendingEvent[] = [
    entry({ type: "test.started", payload: { jobId, commitSha, objective: task.objective } }),
    entry({ type: "turn.started", payload: { source: "test" } }),
    entry({
      type: "test.annotation",
      payload: {
        timeMs: 0,
        annotation: { type: "test_start", id: task.flowId, description: "Save a note" },
      },
    }),
    entry({
      type: "test.annotation",
      payload: { timeMs: 1, annotation: { ...assertion, result: "untested" } },
    }),
    entry({
      type: "computer.screenshot",
      payload: { toolCallId: "input", key: "frame.jpg", width: 1024, height: 768 },
    }),
    ...(result === "untested"
      ? []
      : [
          entry({
            type: "test.annotation",
            payload: { timeMs: 2, annotation: { ...assertion, result } },
          }),
        ]),
    entry({
      type: "turn.completed",
      payload: { commitSha: null, durationMs: 1, usage: { inputTokens: 0, outputTokens: 0 } },
    }),
    entry({
      type: "test.completed",
      payload: {
        jobId,
        status: "completed",
        counts: {
          passed: result === "passed" ? 1 : 0,
          failed: result === "failed" ? 1 : 0,
          untested: result === "untested" ? 1 : 0,
        },
      },
    }),
  ];
  return events.map((event, index) => ({ ...event, seq: index + 1 }));
}
const assess = (events = log(), turnOutcome: TurnOutcome = outcome) =>
  evaluateAppTest({ task, events, outcome: turnOutcome, sessionId, turnId, jobId, commitSha });

it("keeps two independent app flows balanced, with the same neutral objective in each pair", () => {
  expect(APP_TEST_TASKS.map((t) => t.id)).toEqual([
    "notes-correct",
    "notes-buggy",
    "cart-correct",
    "cart-buggy",
  ]);
  for (const fixture of ["notes", "cart"]) {
    const pair = APP_TEST_TASKS.filter((t) => t.fixture === fixture);
    expect(pair.map((t) => t.expected)).toEqual(["passed", "failed"]);
    expect(pair[0]?.objective).toBe(pair[1]?.objective);
    expect(pair[0]?.objective).not.toMatch(/buggy|correct|ground.truth|planted/i);
  }
});

it.each(["passed", "failed"] as const)(
  "scores the designated structured %s assertion against evaluator-only truth",
  (result) => {
    for (const task of APP_TEST_TASKS) {
      const events = log(result).map((event) =>
        event.type === "test.annotation"
          ? {
              ...event,
              payload: {
                ...event.payload,
                annotation:
                  event.payload.annotation.type === "test_start"
                    ? { ...event.payload.annotation, id: task.flowId }
                    : event.payload.annotation.type === "assertion"
                      ? { ...event.payload.annotation, id: task.assertionId }
                      : event.payload.annotation,
              },
            }
          : event,
      );
      expect(
        evaluateAppTest({ task, events, outcome, sessionId, turnId, jobId, commitSha }),
      ).toMatchObject({
        status: "measured",
        observed: result,
        score: result === task.expected ? 1 : 0,
      });
    }
  },
);

describe("unmeasured guards", () => {
  it.each([
    "test.started",
    "turn.started",
    "turn.completed",
    "test.completed",
    "computer.screenshot",
  ] as const)("requires %s evidence", (type) => {
    expect(assess(log().filter((e) => e.type !== type))).toMatchObject({
      status: "unmeasured",
      score: null,
    });
  });
  it("never uses prose or unrelated/history assertions, including empty reports", () => {
    const annotations = log().filter((e) => e.type === "test.annotation");
    for (const events of [
      [],
      log("untested"),
      log().filter((e) => e.type !== "test.annotation"),
      log().map((e) => (e.type === "test.annotation" ? { ...e, turnId: jobId } : e)),
      log().map((e) =>
        e.type === "test.annotation" && e.payload.annotation.type === "test_start"
          ? {
              ...e,
              payload: { ...e.payload, annotation: { ...e.payload.annotation, id: "unrelated" } },
            }
          : e,
      ),
      log().map((e) =>
        e.type === "test.annotation" && e.payload.annotation.type === "assertion"
          ? {
              ...e,
              payload: { ...e.payload, annotation: { ...e.payload.annotation, expectation: "  " } },
            }
          : e,
      ),
    ]) {
      expect(assess(events)).toMatchObject({ status: "unmeasured", score: null });
    }
    expect(annotations).not.toHaveLength(0);
  });
  it("refuses runtime interruption, capture/tool failure, count disagreement, wrong checkpoint and wrong job", () => {
    expect(
      assess(log(), { ok: false, turnId, reason: "internal", message: "failure" }),
    ).toMatchObject({ status: "unmeasured" });
    for (const events of [
      [
        ...log(),
        {
          ...log()[0]!,
          type: "tool.result" as const,
          payload: {
            toolName: "computer" as const,
            toolCallId: "capture",
            ok: false,
            output: "capture failed",
          },
        },
      ],
      log().map((e) =>
        e.type === "test.completed"
          ? { ...e, payload: { ...e.payload, status: "interrupted" as const } }
          : e,
      ),
      log().map((e) =>
        e.type === "test.completed"
          ? { ...e, payload: { ...e.payload, counts: { passed: 0, failed: 0, untested: 0 } } }
          : e,
      ),
      log().map((e) =>
        e.type === "test.started" ? { ...e, payload: { ...e.payload, commitSha: "wrong" } } : e,
      ),
      log().map((e) =>
        e.type === "test.completed" ? { ...e, payload: { ...e.payload, jobId: turnId } } : e,
      ),
    ])
      expect(assess(events)).toMatchObject({ status: "unmeasured", score: null });
  });
  it("requires the designated assertion ID and isolates sessions as well as turns", () => {
    for (const events of [
      log().map((e) => ({ ...e, sessionId: jobId })),
      log().map((e) =>
        e.type === "test.annotation" && e.payload.annotation.type === "assertion"
          ? {
              ...e,
              payload: { ...e.payload, annotation: { ...e.payload.annotation, id: "unrelated" } },
            }
          : e,
      ),
      log().map((e) =>
        e.type === "turn.started" ? { ...e, payload: { source: "user" as const } } : e,
      ),
      log().map((e) =>
        e.type === "turn.completed" ? { ...e, payload: { ...e.payload, commitSha } } : e,
      ),
    ])
      expect(assess(events)).toMatchObject({ status: "unmeasured", score: null });
  });
  it("does not turn an untested extra assertion into success on the designated flow", () => {
    const events = log();
    const extra: StoredEvent = {
      ...events[0]!,
      type: "test.annotation",
      payload: {
        timeMs: 3,
        annotation: {
          type: "assertion",
          id: "other",
          expectation: "Another flow",
          result: "untested",
        },
      },
    };
    events.splice(6, 0, extra);
    expect(
      assess(
        events.map((e) =>
          e.type === "test.completed"
            ? { ...e, payload: { ...e.payload, counts: { passed: 1, failed: 0, untested: 1 } } }
            : e,
        ),
      ),
    ).toMatchObject({ status: "unmeasured", score: null });
  });
});

it("runs exactly one test turn without a message, then grades its scoped log", async () => {
  const runTurn = vi.fn<Runtime["runTurn"]>().mockResolvedValue(outcome);
  const runtime: Runtime = { runTurn, resumeSession: vi.fn() };
  const result = await runAppTest({
    task,
    runtime,
    events: { append: vi.fn(), readFrom: vi.fn().mockResolvedValue(log()) },
    sessionId,
    turnId,
    jobId,
    commitSha,
    model: "anthropic/claude-sonnet-5",
  });
  expect(runTurn.mock.calls).toEqual([
    [{ kind: "test", sessionId, turnId, jobId, model: "anthropic/claude-sonnet-5" }],
  ]);
  expect(result.assessment).toMatchObject({ status: "measured", score: 1 });
});

it("makes a thrown runtime failure unmeasured", async () => {
  const result = await runAppTest({
    task,
    runtime: {
      runTurn: vi.fn().mockRejectedValue(new Error("runtime down")),
      resumeSession: vi.fn(),
    },
    events: { append: vi.fn(), readFrom: vi.fn().mockResolvedValue(log()) },
    sessionId,
    turnId,
    jobId,
    commitSha,
    model: "anthropic/claude-sonnet-5",
  });
  expect(result.assessment).toMatchObject({ status: "unmeasured", score: null });
});

it("parses a free default, explicit real intent and rejects typos before composition", () => {
  expect(parseAppTestArgs([])).toEqual({
    real: false,
    taskId: null,
    out: "napbench-results/app-test.json",
  });
  expect(
    parseAppTestArgs([
      "--real",
      "--task=notes-buggy",
      "--out=/tmp/result.json",
      "--model=anthropic/claude-sonnet-5",
      "--max-steps=8",
      "--max-tokens=40000",
      "--budget-tokens=20000",
      "--max-output-tokens=2000",
    ]),
  ).toEqual({
    real: true,
    taskId: "notes-buggy",
    out: "/tmp/result.json",
    model: "anthropic/claude-sonnet-5",
    maxSteps: 8,
    maxTokens: 40000,
    budgetTokens: 20000,
    maxOutputTokens: 2000,
    effort: "medium",
    template: undefined,
  });
  for (const args of [
    ["--rael"],
    ["--task=unknown"],
    ["--out="],
    ["--real=false"],
    ["--real", "--real"],
    ["--real"],
    ["--model=anthropic/claude-sonnet-5"],
  ])
    expect(() => parseAppTestArgs(args)).toThrow();
});

it("requires every real limit, canonical image model and strict positive safe integers", () => {
  const flags = [
    "--real",
    "--model=anthropic/claude-sonnet-5",
    "--max-steps=8",
    "--max-tokens=40000",
    "--budget-tokens=20000",
    "--max-output-tokens=2000",
  ];
  for (const flag of flags.slice(1))
    expect(() => parseAppTestArgs(flags.filter((f) => f !== flag))).toThrow();
  for (const value of ["0", "-1", "1.5", "NaN", "1e3", "9007199254740992", "1x", "", " 8"]) {
    expect(() =>
      parseAppTestArgs(
        flags.map((flag) => (flag.startsWith("--max-steps=") ? `--max-steps=${value}` : flag)),
      ),
    ).toThrow();
  }
  for (const flag of [
    "--model=unknown",
    "--model=openai/gpt-oss-20b:free",
    "--model=claude-sonnet-5",
    "--effort=wat",
    "--template=",
    "--keep",
    "--max-tokens=1",
    "--max-output-tokens=50000",
  ]) {
    const key = flag.split("=")[0];
    expect(() =>
      parseAppTestArgs([...flags.filter((f) => f.split("=")[0] !== key), flag]),
    ).toThrow();
  }
  expect(parseAppTestArgs([...flags, "--effort=low", "--template=approved-desktop"])).toMatchObject(
    { effort: "low", template: "approved-desktop" },
  );
});
