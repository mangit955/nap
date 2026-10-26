import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { APP_TEST_TASKS } from "@nap/bench/app-test";
import { expectEventSequence } from "@nap/db/testing/event-assertions";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { expect, it } from "vitest";
import { runScriptedAppTest } from "./app-test-harness.ts";

it("drives production test turns on all fixtures with zero scripted bug detection", async () => {
  const reports = [];
  for (const task of APP_TEST_TASKS) {
    const report = await runScriptedAppTest(task);
    reports.push(report);
    expect(report.assessment).toMatchObject({
      status: "measured",
      observed: "passed",
      score: task.expected === "passed" ? 1 : 0,
    });
    expect(report.events.find((e) => e.type === "test.started")?.payload).toMatchObject({
      commitSha: report.fixture.commitSha,
    });
    expect(
      report.events.filter((e) => e.type === "turn.started").map((e) => e.payload.source),
    ).toEqual(["test"]);
    expectEventSequence(
      report.events.filter(
        (event) =>
          event.turnId === report.outcome.turnId &&
          ["test.started", "turn.started", "turn.completed", "test.completed"].includes(event.type),
      ),
      ["test.started", "turn.started", "turn.completed", "test.completed"],
    );
    expect(report.events.some((e) => e.type === "user.message" || e.type === "file.changed")).toBe(
      false,
    );
    expect(report.commands.some((command) => /git .*commit|git add/.test(command))).toBe(false);
    expect(report.commands.filter((command) => /git /.test(command))).toHaveLength(3);
    expect(report.prompt).toContain(JSON.stringify(report.fixture.diff));
    expect(report.prompt).not.toContain(task.id);
    expect(report.prompt).not.toMatch(/expectedResult|groundTruth/);
    expect(report.mode).toBe("scripted");
    expect(report.modelCapability).toBeNull();
  }
  expect(
    reports.filter((r) => r.task.expected === "failed" && r.assessment.score === 1),
  ).toHaveLength(0);
}, 20_000);

it("cannot pass a capture outage or a model that merely answers", async () => {
  const task = APP_TEST_TASKS[0]!;
  const desktop = new FakeSandboxDesktop({
    bytes: new Uint8Array([255, 216, 255, 217]),
    width: 1024,
    height: 768,
  }).failWith({ code: "unavailable", message: "capture down" });
  expect((await runScriptedAppTest(task, { desktop })).assessment).toMatchObject({
    status: "unmeasured",
    score: null,
  });
  expect(
    (await runScriptedAppTest(task, { provider: new ScriptedLLMProvider([[{ text: "" }]]) }))
      .assessment,
  ).toMatchObject({ status: "unmeasured", score: null });
});

it("leaves the planted source intact when a provider attempts a repair", async () => {
  const provider = new ScriptedLLMProvider([
    [
      {
        toolCalls: [
          {
            id: "repair",
            name: "write_file",
            input: { path: "/home/user/app/src/app.js", contents: "repaired" },
          },
        ],
      },
      {},
    ],
  ]);
  const report = await runScriptedAppTest(APP_TEST_TASKS[1]!, { provider });
  expect(report.events.find((e) => e.type === "tool.result")?.payload.ok).toBe(false);
  expect(report.sourceUnchanged).toBe(true);
  expect(report.assessment).toMatchObject({ status: "unmeasured", score: null });
});
