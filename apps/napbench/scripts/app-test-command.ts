import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NapAgentService } from "@nap/agent/agent-service";
import {
  APP_TEST_TASKS,
  type AppTestAssessment,
  type AppTestTask,
  parseAppTestArgs,
  runAppTest,
} from "@nap/bench/app-test";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import { NAP_TEMPLATE, TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import type { VerifiedCheck } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { ContextEngine } from "@nap/shared/ports/context-engine";
import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import type { LLMProvider } from "@nap/shared/ports/llm-provider";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { SandboxDesktop } from "@nap/shared/ports/sandbox-desktop";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { shellQuote } from "@nap/shared/shell";
import { z } from "zod";
import { prepareAppTestFixture } from "../src/app-test-fixture.ts";

type RealOptions = Extract<ReturnType<typeof parseAppTestArgs>, { real: true }>;
export type AppTestFactories = {
  sandbox(options: { template: string; timeoutMs: number }): SandboxManager;
  desktop(sandbox: SandboxManager): SandboxDesktop;
  provider(options: {
    apiKey: string;
    model: string;
    maxOutputTokens: number;
    effort: RealOptions["effort"];
  }): LLMProvider;
};
type AppTestRunReport = {
  task: AppTestTask;
  seedOrigin: "harness";
  fixture: { baseSha: string; commitSha: string; diff: string; checks: VerifiedCheck[] } | null;
  events: StoredEvent[];
  assessment: AppTestAssessment;
  cleanup: { ok: true } | { ok: false; sandboxId: string; message: string };
  screenshots: { key: string; path: string }[];
};
const keysSchema = z.object({
  E2B_API_KEY: z.string().trim().min(1),
  OPENROUTER_API_KEY: z.string().trim().min(1),
});
const shaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const unmeasured = (reason: string): AppTestAssessment => ({
  status: "unmeasured",
  score: null,
  reason,
});

/** Validation precedes every factory. Tests inject ports; only the CLI selects production factories. */
export async function runAppTestCommand(input: {
  args: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  factories?: AppTestFactories;
}) {
  const options = parseAppTestArgs(input.args);
  const tasks = APP_TEST_TASKS.filter(
    (task) => options.taskId === null || task.id === options.taskId,
  );
  const runs: AppTestRunReport[] = [];
  if (options.real) {
    const parsed = keysSchema.safeParse(input.env);
    if (!parsed.success)
      throw new Error(
        `${parsed.error.issues.map((issue) => issue.path.join(".")).join(", ")} must be set for real app tests.`,
      );
    const context = new NapContextEngine({ budgetTokens: options.budgetTokens });
    // Check local output access before creating a paid machine.
    mkdirSync(dirname(options.out), { recursive: true });
    closeSync(openSync(options.out, "a"));
    const factories =
      input.factories ?? (await import("./app-test-production.ts")).appTestProductionFactories;
    for (const task of tasks)
      runs.push(
        await realFixture({
          task,
          options,
          context,
          factories,
          apiKey: parsed.data.OPENROUTER_API_KEY,
        }),
      );
  } else {
    const { runScriptedAppTest } = await import("./app-test-harness.ts");
    for (const task of tasks)
      runs.push({ ...(await runScriptedAppTest(task)), cleanup: { ok: true }, screenshots: [] });
  }
  const measured = runs.filter((run) => run.assessment.status === "measured");
  const bugs = measured.filter((run) => run.task.expected === "failed");
  const correct = measured.filter((run) => run.task.expected === "passed");
  const outcomes = {
    bugsCaught: bugs.filter((run) => run.assessment.score === 1).length,
    bugsTested: bugs.length,
    correctAccepted: correct.filter((run) => run.assessment.score === 1).length,
    correctTested: correct.length,
    unmeasured: runs.length - measured.length,
  };
  const execution = options.real ? (input.factories ? "injected" : "production") : "scripted";
  const report = {
    mode: options.real ? "real" : "scripted",
    execution,
    configuration: options.real
      ? {
          model: options.model,
          effort: options.effort,
          maxSteps: options.maxSteps,
          maxTokens: options.maxTokens,
          budgetTokens: options.budgetTokens,
          maxOutputTokens: options.maxOutputTokens,
          template: options.template ?? NAP_TEMPLATE,
        }
      : null,
    modelCapability: execution === "production" && outcomes.unmeasured === 0 ? outcomes : null,
    realEvaluation: execution === "production" ? "recorded" : "pending",
    apparatus: options.real ? null : outcomes,
    outcomes,
    runs,
  };
  return { out: options.out, report, exitCode: outcomes.unmeasured === 0 ? 0 : 1 };
}

async function realFixture(input: {
  task: AppTestTask;
  options: RealOptions;
  context: ContextEngine;
  factories: AppTestFactories;
  apiKey: string;
}): Promise<AppTestRunReport> {
  const { task, options, factories } = input;
  const fixture = prepareAppTestFixture(task);
  const sessionId = crypto.randomUUID();
  const projectId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const events = new InMemoryEventStore();
  const bytes = new Map<string, Uint8Array>();
  const objects: ObjectStore = {
    async put(key, value) {
      bytes.set(key, value.slice());
      return { ok: true, value: undefined };
    },
    async get(key) {
      const value = bytes.get(key);
      return value
        ? { ok: true, value: value.slice() }
        : { ok: false, error: { code: "not_found", message: "No such test object." } };
    },
    async delete(key) {
      bytes.delete(key);
      return { ok: true, value: undefined };
    },
  };
  let sandbox: SandboxManager | undefined;
  let sandboxId: string | undefined;
  const report: AppTestRunReport = {
    task,
    seedOrigin: "harness",
    fixture: null,
    events: [],
    assessment: unmeasured("The fixture did not start."),
    cleanup: { ok: true },
    screenshots: [],
  };
  try {
    sandbox = factories.sandbox({
      template: options.template ?? NAP_TEMPLATE,
      timeoutMs: 30 * 60 * 1000,
    });
    const created = await sandbox.create(projectId);
    if (!created.ok) throw new Error(created.error.message);
    sandboxId = created.value.id;
    const manager = sandbox;
    const id = sandboxId;
    const exec = async (command: string) => {
      const result = await manager.exec(id, `cd ${shellQuote(PROJECT_ROOT_PATH)} && ${command}`);
      if (!result.ok) throw new Error(result.error.message);
      if (result.value.exitCode !== 0)
        throw new Error(`Fixture command failed: ${command}\n${result.value.stderr}`);
      return result.value.stdout;
    };
    const clean = async () => {
      if ((await exec("git status --porcelain")).trim())
        throw new Error("Fixture source is dirty.");
    };
    await clean();
    const baseSha = shaSchema.parse((await exec("git rev-parse HEAD")).trim());
    for (const [path, contents] of Object.entries(fixture.files)) {
      const result = await sandbox.writeFile(sandboxId, `${PROJECT_ROOT_PATH}/${path}`, contents);
      if (!result.ok) throw new Error(result.error.message);
    }
    await exec("node --check src/app.js");
    await exec("git diff --check");
    await exec("git add -- index.html src/app.js");
    await exec(
      "env GIT_AUTHOR_DATE=2026-10-24T00:00:00Z GIT_COMMITTER_DATE=2026-10-24T00:00:00Z git -c core.hooksPath=/dev/null -c commit.gpgsign=false -c user.name=NapBench -c user.email=bench@nap.test commit -m 'Implement app flow'",
    );
    const commitSha = shaSchema.parse((await exec("git rev-parse HEAD")).trim());
    if ((await exec(`git rev-parse ${shellQuote(`${commitSha}^`)}`)).trim() !== baseSha)
      throw new Error("Unexpected specimen commit parent.");
    const changed = (
      await exec(`git diff --name-only ${shellQuote(baseSha)} ${shellQuote(commitSha)} --`)
    )
      .trim()
      .split("\n")
      .sort();
    if (changed.join("\n") !== "index.html\nsrc/app.js")
      throw new Error("Unexpected changed fixture paths.");
    const diff = await exec(
      `git diff --no-ext-diff --no-textconv ${shellQuote(baseSha)} ${shellQuote(commitSha)} --`,
    );
    if (!diff.includes("diff --git a/src/app.js b/src/app.js"))
      throw new Error("The source diff is empty or missing the app entry point.");
    const verifySource = async () => {
      await clean();
      if ((await exec("git rev-parse HEAD")).trim() !== commitSha)
        throw new Error("Fixture HEAD changed.");
      for (const [path, contents] of Object.entries(fixture.files)) {
        const actual = await manager.readFile(id, `${PROJECT_ROOT_PATH}/${path}`);
        if (!actual.ok || actual.value !== contents)
          throw new Error("Fixture source does not match its specimen.");
        const committed = await exec(`git show ${shellQuote(`${commitSha}:${path}`)}`);
        if (committed !== contents)
          throw new Error("Committed source does not match its specimen.");
      }
    };
    await exec(`git diff --check ${shellQuote(baseSha)} ${shellQuote(commitSha)} --`);
    await verifySource();
    const ready = await sandbox.waitForPreview(sandboxId, TEMPLATE_DEV_PORT, { timeoutMs: 30_000 });
    if (!ready.ok) throw new Error(ready.error.message);
    const heading = fixture.files["index.html"].match(/<h1>([^<]+)<\/h1>/)?.[1];
    if (!heading) throw new Error("Fixture has no heading.");
    const served = await exec(
      `curl --fail --silent --max-time 5 http://localhost:${TEMPLATE_DEV_PORT}/`,
    );
    if (!served.includes(`<h1>${heading}</h1>`))
      throw new Error("The dev server is serving a different app.");
    const desktop = factories.desktop(sandbox);
    const start = await desktop.start({
      sandboxId,
      devServerUrl: `http://localhost:${TEMPLATE_DEV_PORT}`,
    });
    if (!start.ok) throw new Error(start.error.message);
    const dom = await desktop.act(sandboxId, { action: "read_dom" });
    if (!dom.ok || dom.value.kind !== "text" || !dom.value.text.includes(`<h1>${heading}</h1>`))
      throw new Error("The desktop is not showing the fixture.");
    const frame = await desktop.screenshot(sandboxId);
    if (!frame.ok) throw new Error(frame.error.message);
    await objects.put("preflight", frame.value.bytes);
    await verifySource();
    const checks: VerifiedCheck[] = ["fixture-syntax", "fixture-source", "preview", "desktop"].map(
      (name) => ({ name, outcome: "passed", output: null }),
    );
    report.fixture = { baseSha, commitSha, diff, checks };
    const prefix = { sessionId, turnId: jobId, createdAt: new Date().toISOString() };
    const seeded: PendingEvent[] = [
      { ...prefix, type: "job.started", payload: { jobId, objective: task.objective } },
      {
        ...prefix,
        type: "turn.completed",
        payload: { commitSha, usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0 },
      },
      { ...prefix, type: "verification.started", payload: { jobId } },
      { ...prefix, type: "verification.completed", payload: { jobId, checks } },
      { ...prefix, type: "job.checkpointed", payload: { jobId, commitSha } },
      { ...prefix, type: "job.completed", payload: { jobId, outcome: "verified" } },
    ];
    for (const event of seeded) await events.append(event);
    const provider = factories.provider({
      apiKey: input.apiKey,
      model: options.model,
      effort: options.effort,
      maxOutputTokens: options.maxOutputTokens,
    });
    const runtime = new SingleAgentRuntime({
      sessions: new InMemorySessionStore([{ sessionId, projectId, sandboxId }]),
      sandbox,
      events,
      bus: new InMemoryEventBus(),
      context: input.context,
      agent: new NapAgentService({
        provider,
        testBudget: { maxSteps: options.maxSteps, maxTokens: options.maxTokens },
      }),
      memory: new NoopMemoryProvider(),
      computer: { desktop, objects },
    });
    const result = await runAppTest({
      task,
      runtime,
      events,
      sessionId,
      turnId,
      jobId,
      commitSha,
      model: options.model,
    });
    await verifySource();
    for (const event of result.events)
      if (event.type === "computer.screenshot" && !bytes.has(event.payload.key))
        throw new Error("Missing screenshot object.");
    report.assessment = result.assessment;
  } catch (error) {
    report.assessment = unmeasured(message(error));
  } finally {
    try {
      report.events = await events.readFrom(sessionId, 0);
      for (const [key, contents] of bytes) {
        const path = join(
          "app-test-artifacts",
          sessionId,
          `${createHash("sha256").update(key).digest("hex")}.jpg`,
        );
        const absolute = join(dirname(options.out), path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, contents);
        report.screenshots.push({ key, path });
      }
    } catch (error) {
      report.assessment = unmeasured(`Could not archive screenshots: ${message(error)}`);
    }
    if (sandbox && sandboxId) {
      try {
        const destroyed = await sandbox.destroy(sandboxId);
        if (!destroyed.ok) {
          report.cleanup = { ok: false, sandboxId, message: destroyed.error.message };
          report.assessment = unmeasured("Owned sandbox cleanup failed.");
        }
      } catch (error) {
        report.cleanup = { ok: false, sandboxId, message: message(error) };
        report.assessment = unmeasured("Owned sandbox cleanup failed.");
      }
    }
    fixture.dispose();
  }
  return report;
}
