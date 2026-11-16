import { AppTestRun } from "@nap/runtime/app-test-run";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import type { TurnOutcome } from "@nap/shared/ports/runtime";
import type { DesktopAction } from "@nap/shared/ports/sandbox-desktop";
import { describe, expect, it } from "vitest";
import { classifyRun, dockerMemoryMiB, summarize } from "./computer-reliability-classify.ts";

const sessionId = "00000000-0000-4000-8000-000000000001";
const turnId = "00000000-0000-4000-8000-000000000002";
const jobId = "00000000-0000-4000-8000-000000000003";
let seq = 0;
function event(type: string, payload: Record<string, unknown>): StoredEvent {
  seq += 1;
  return {
    sessionId,
    turnId,
    seq,
    createdAt: "2026-11-15T00:00:00.000Z",
    type,
    payload,
  } as StoredEvent;
}
const completed = (counts: { passed: number; failed: number; untested: number }) =>
  event("test.completed", { jobId, status: "completed", counts });
const ok: TurnOutcome = { ok: true, turnId, commitSha: null } as TurnOutcome;
const refused = (output: string) =>
  event("tool.result", { toolCallId: "c1", toolName: "computer", ok: false, output });
const base = { preparation: { ok: true as const }, outcome: ok, timedOut: false, oomKills: 0 };

describe("classifyRun", () => {
  it("passes a completed test whose every assertion passed", () => {
    const run = classifyRun({
      ...base,
      events: [completed({ passed: 2, failed: 0, untested: 0 })],
    });
    expect(run).toMatchObject({ passed: true, kind: null });
  });

  it("does not pass a test with no assertions", () => {
    const run = classifyRun({
      ...base,
      events: [completed({ passed: 0, failed: 0, untested: 0 })],
    });
    expect(run).toMatchObject({ passed: false, kind: "no_assertions" });
  });

  it("calls a failed assertion on a correct app a false failure", () => {
    const run = classifyRun({
      ...base,
      events: [completed({ passed: 1, failed: 1, untested: 0 })],
    });
    expect(run).toMatchObject({ passed: false, kind: "false_failure" });
  });

  it("calls an assertion left untested untested", () => {
    const run = classifyRun({
      ...base,
      events: [completed({ passed: 1, failed: 0, untested: 1 })],
    });
    expect(run).toMatchObject({ passed: false, kind: "untested" });
  });

  it("puts a failed preparation stage ahead of everything else", () => {
    const run = classifyRun({
      ...base,
      preparation: { ok: false, stage: "dev_server", message: "no preview" },
      outcome: null,
      events: [],
    });
    expect(run).toMatchObject({ passed: false, kind: "dev_server", detail: "no preview" });
  });

  it("names a timeout and an out-of-memory kill before the turn's own reason", () => {
    const failed = event("turn.failed", {
      reason: "cancelled",
      message: "The app test was cancelled.",
    });
    expect(classifyRun({ ...base, timedOut: true, events: [failed] }).kind).toBe("timeout");
    expect(classifyRun({ ...base, oomKills: 1, events: [failed] }).kind).toBe("out_of_memory");
  });

  it("maps turn failure reasons", () => {
    const failedWith = (reason: string) =>
      classifyRun({ ...base, events: [event("turn.failed", { reason, message: "m" })] }).kind;
    expect(failedWith("budget_exceeded")).toBe("budget");
    expect(failedWith("model_unavailable")).toBe("model_provider");
    expect(failedWith("refusal")).toBe("model_provider");
    expect(failedWith("sandbox_unavailable")).toBe("sandbox_start");
    expect(failedWith("internal")).toBe("internal");
  });

  it("tells a desktop that never started from the model's own failure", () => {
    const events = [
      event("computer.status", { toolCallId: "c1", state: "starting" }),
      refused("Desktop startup timed out."),
      completed({ passed: 0, failed: 0, untested: 1 }),
    ];
    expect(classifyRun({ ...base, events })).toMatchObject({
      kind: "desktop_start",
      detail: "Desktop startup timed out.",
    });
  });

  it("recognises every refusal the real assertion ledger gives", async () => {
    const run = new AppTestRun({ emit: () => {} });
    const outputs: string[] = [];
    const refuse = async (result: Promise<{ ok: boolean; error?: { message: string } }>) => {
      const value = await result;
      if (!value.ok && value.error) outputs.push(value.error.message);
    };
    const click: DesktopAction = { action: "left_click", coordinate: [1, 1] };
    const beforeAction = run.beforeAction(click);
    if (!beforeAction.ok) outputs.push(beforeAction.error.message);
    await refuse(run.annotate({ type: "action", description: "Click" }));
    await refuse(
      run.annotate({ type: "assertion", id: "a", expectation: "x", result: "untested" }),
    );
    await run.annotate({ type: "test_start", id: "t", description: "T" });
    await refuse(run.annotate({ type: "test_start", id: "t", description: "T" }));
    await run.annotate({ type: "assertion", id: "a", expectation: "x", result: "untested" });
    await refuse(
      run.annotate({ type: "assertion", id: "a", expectation: "x", result: "untested" }),
    );
    await refuse(run.annotate({ type: "assertion", id: "a", expectation: "y", result: "passed" }));
    await refuse(run.annotate({ type: "assertion", id: "a", expectation: "x", result: "passed" }));
    await refuse(run.annotate({ type: "setup", description: "late" }));
    expect(outputs).toHaveLength(8);
    for (const output of outputs)
      expect(classifyRun({ ...base, events: [refused(output)] }).ledgerRefusals, output).toBe(1);
  });

  it("names a run the ledger blocked, and counts its refusals even when it passed", () => {
    const refusal = refused(
      "Perform the action and inspect a new screenshot before assigning a verdict.",
    );
    const blocked = classifyRun({
      ...base,
      events: [refusal, completed({ passed: 0, failed: 0, untested: 1 })],
    });
    expect(blocked.kind).toBe("ledger_refused");
    const recovered = classifyRun({
      ...base,
      events: [refusal, completed({ passed: 1, failed: 0, untested: 0 })],
    });
    expect(recovered).toMatchObject({ passed: true, ledgerRefusals: 1 });
  });

  it("reports a recording that did not survive without failing the test", () => {
    const events = [
      event("test.recording", { recording: { state: "unavailable", reason: "capture_failed" } }),
      completed({ passed: 1, failed: 0, untested: 0 }),
    ];
    expect(classifyRun({ ...base, events })).toMatchObject({
      passed: true,
      recording: "unavailable",
    });
  });

  it("calls a turn that ended without a test terminal internal", () => {
    expect(classifyRun({ ...base, events: [] }).kind).toBe("internal");
  });
});

describe("summarize", () => {
  it("counts passes and failure kinds per app and overall", () => {
    const pass = classifyRun({
      ...base,
      events: [completed({ passed: 1, failed: 0, untested: 0 })],
    });
    const fail = classifyRun({
      ...base,
      events: [completed({ passed: 0, failed: 1, untested: 0 })],
    });
    const summary = summarize([
      { app: "cart", run: pass },
      { app: "cart", run: fail },
      { app: "notes", run: pass },
    ]);
    expect(summary.total).toEqual({ passed: 2, runs: 3 });
    expect(summary.apps.cart).toEqual({ passed: 1, runs: 2 });
    expect(summary.failures).toEqual({ false_failure: 1 });
  });
});

describe("dockerMemoryMiB", () => {
  it("reads the used half of docker stats' memory column", () => {
    expect(dockerMemoryMiB("512.3MiB / 2GiB")).toBe(512);
    expect(dockerMemoryMiB("1.25GiB / 2GiB")).toBe(1280);
    expect(dockerMemoryMiB("900KiB / 2GiB")).toBe(1);
    expect(dockerMemoryMiB("--")).toBeNull();
  });
});
