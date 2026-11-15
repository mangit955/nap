/**
 * Runs "Test the app" against three correct apps, N times each, on the local Docker desktop,
 * and says how many runs passed and why the rest did not.
 *
 *   bun run computer:reliability                       # scripted model: free, measures Nap alone
 *   bun run computer:reliability --model=<image model id> [--allow-spend]
 *
 * Each run gets a fresh 2-GiB machine, as production does, and the app is committed to it as a
 * verified job without a build turn — so a run spends only the test's own model calls. The
 * desktop is left cold: the test starts it, as it does for somebody who presses the button.
 * Everything a run leaves behind — events, screenshots, the recording, the classification — is
 * written under the output directory, which is ignored by git. See
 * docs/computer-use-reliability.md for what a run measures and what it does not.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NapAgentService } from "@nap/agent/agent-service";
import { ClaudeProvider } from "@nap/agent/claude-provider";
import { createOpenRouterClient, toOpenRouterModel } from "@nap/agent/openrouter";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import { isolatedProjectComputer } from "@nap/runtime/testing/isolated-project-computer";
import { E2BSandboxDesktop } from "@nap/sandbox/e2b-sandbox-desktop";
import { TEMPLATE_DEV_PORT, TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { loadEnvFile } from "@nap/shared/env-file";
import type { PendingEvent, StoredEvent } from "@nap/shared/ports/event-store";
import type { LLMProvider } from "@nap/shared/ports/llm-provider";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { TurnOutcome } from "@nap/shared/ports/runtime";
import { shellQuote } from "@nap/shared/shell";
import { LocalDockerSandboxManager } from "./computer-local-sandbox.ts";
import { type ReliabilityApp, reliabilityApps } from "./computer-reliability-apps.ts";
import { parseReliabilityArgs, scriptedTestTurn, spendStop } from "./computer-reliability-args.ts";
import {
  classifyRun,
  dockerMemoryMiB,
  type Preparation,
  summarize,
} from "./computer-reliability-classify.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MEMORY_MB = 2_048;
const RUN_LIMIT_MS = 15 * 60_000;

const options = parseReliabilityArgs(process.argv.slice(2));
if (!options.ok) {
  console.error(options.error.message);
  process.exit(1);
}
const { model, apps: selected, runs, allowSpend, maxSpendUsd } = options.value;
loadEnvFile(join(repositoryRoot, "apps/api/.env"), process.env);
const apiKey = process.env.OPENROUTER_API_KEY;
if (model !== null && !apiKey) {
  console.error("OPENROUTER_API_KEY must be set to test with a real model.");
  process.exit(1);
}
if (model !== null && !model.endsWith(":free") && !allowSpend) {
  console.error(`${model} is not a free model. Pass --allow-spend once the cost is agreed.`);
  process.exit(1);
}
const out = resolve(
  options.value.out ??
    join(
      repositoryRoot,
      "computer-reliability-results",
      new Date().toISOString().replaceAll(":", "-"),
    ),
);
mkdirSync(out, { recursive: true });
const keyUsage = async (): Promise<number | null> => {
  if (model === null || !apiKey) return null;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    const body = (await response.json()) as { data?: { usage?: number } };
    return typeof body.data?.usage === "number" ? body.data.usage : null;
  } catch {
    return null;
  }
};

const opened = await LocalDockerSandboxManager.open({
  repositoryRoot,
  memoryMB: MEMORY_MB,
  ttlMs: 60 * 60_000,
  evidenceDirectory: join(out, "sandbox"),
});
if (!opened.ok) {
  console.error(opened.error.message);
  process.exit(1);
}
const sandbox = opened.value;
const desktop = new E2BSandboxDesktop({ sandbox });
const usageBefore = await keyUsage();
const results: {
  app: string;
  index: number;
  spendUsd: number | null;
  run: ReturnType<typeof classifyRun>;
}[] = [];

try {
  pass: for (const app of reliabilityApps(repositoryRoot).filter((entry) =>
    selected.includes(entry.id),
  ))
    for (let index = 1; index <= runs; index += 1) {
      // The scripted model reads no key, so a cap given with it has nothing to check.
      const stop = spendStop(model === null ? null : maxSpendUsd, usageBefore, await keyUsage());
      if (stop !== null) {
        console.log(stop);
        break pass;
      }
      const before = await keyUsage();
      const run = await runOnce(app, index);
      const after = await keyUsage();
      const spendUsd = before !== null && after !== null ? after - before : null;
      results.push({ app: app.id, index, spendUsd, run });
      console.log(
        `${app.id} ${index}/${runs}: ${run.passed ? "PASS" : `FAIL ${run.kind}`} — ${run.detail}`,
      );
    }
} finally {
  const closed = await sandbox.close();
  if (!closed.ok) console.error(`Local Docker cleanup failed: ${closed.error.message}`);
}
const usageAfter = await keyUsage();
const summary = {
  model: model ?? "scripted",
  memoryMB: MEMORY_MB,
  runsPerApp: runs,
  spendUsd: usageBefore !== null && usageAfter !== null ? usageAfter - usageBefore : null,
  ...summarize(results),
  runs: results.map(({ app, index, spendUsd, run }) => ({ app, index, spendUsd, ...run })),
};
writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
console.log(
  `\n${summary.total.passed} of ${summary.total.runs} passed. Failures: ${JSON.stringify(summary.failures)}\nEvidence: ${out}`,
);

async function runOnce(app: ReliabilityApp, index: number) {
  const directory = join(out, app.id, String(index).padStart(2, "0"));
  mkdirSync(join(directory, "screenshots"), { recursive: true });
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const jobId = randomUUID();
  const turnId = randomUUID();
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
        : { ok: false, error: { code: "not_found", message: "No such object." } };
    },
    async delete(key) {
      bytes.delete(key);
      return { ok: true, value: undefined };
    },
  };
  const timings: Record<string, number> = {};
  const started = Date.now();
  const mark = (name: string) => {
    timings[name] = Date.now() - started;
  };
  let preparation: Preparation = { ok: true };
  let outcome: TurnOutcome | null = null;
  let timedOut = false;
  let memory: { peakMiB: number | null; oomKills: number } = { peakMiB: null, oomKills: 0 };
  let sandboxId: string | undefined;
  const fail = (stage: Exclude<Preparation, { ok: true }>["stage"], message: string) => {
    preparation = { ok: false, stage, message };
  };
  const body = async (): Promise<void> => {
    const created = await sandbox.create(projectId);
    mark("sandbox");
    if (!created.ok) return fail("sandbox_start", created.error.message);
    sandboxId = created.value.id;
    const id = sandboxId;
    const exec = async (command: string) => {
      const result = await sandbox.exec(id, `cd ${shellQuote(TEMPLATE_WORKDIR)} && ${command}`);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    for (const [path, contents] of Object.entries(app.files)) {
      const written = await sandbox.writeFile(id, `${TEMPLATE_WORKDIR}/${path}`, contents);
      if (!written.ok) return fail("checks", written.error.message);
    }
    for (const [name, command] of Object.entries(app.checks)) {
      const checked = await exec(command);
      if (checked.exitCode !== 0)
        return fail("checks", `${name} failed: ${checked.stderr || checked.stdout}`.slice(0, 2000));
    }
    mark("checks");
    const base = (await exec("git rev-parse HEAD")).stdout.trim();
    const committed = await exec(
      "git add -A && git -c commit.gpgsign=false -c user.name=Nap -c user.email=reliability@nap.invalid commit -q -m 'Build the app' && git rev-parse HEAD",
    );
    if (committed.exitCode !== 0) return fail("checks", committed.stderr);
    const commitSha = committed.stdout.trim().split("\n").at(-1) ?? "";
    if ((await exec("git status --porcelain")).stdout.trim())
      return fail("checks", "The app left uncommitted files after its checks.");
    const ready = await sandbox.waitForPreview(id, TEMPLATE_DEV_PORT, { timeoutMs: 60_000 });
    mark("preview");
    if (!ready.ok) return fail("dev_server", ready.error.message);
    // The file that carries the heading, as Vite serves it: the page itself for the plain apps,
    // the transformed component for React.
    const entry =
      Object.entries(app.files).find(([, contents]) => contents.includes(app.heading))?.[0] ?? "";
    const served = await exec(
      `curl --fail --silent --max-time 10 http://localhost:${TEMPLATE_DEV_PORT}/${entry === "index.html" ? "" : entry}`,
    );
    if (served.exitCode !== 0 || !served.stdout.includes(app.heading))
      return fail("dev_server", `The dev server is not serving ${app.id}'s ${entry}.`);
    const prefix = { sessionId, turnId: jobId, createdAt: new Date().toISOString() };
    const checks = Object.keys(app.checks).map((name) => ({
      name,
      outcome: "passed" as const,
      output: null,
    }));
    const seeded: PendingEvent[] = [
      { ...prefix, type: "job.started", payload: { jobId, objective: app.goal } },
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
    writeFileSync(
      join(directory, "job.json"),
      JSON.stringify({ base, commitSha, checks }, null, 2),
    );

    const provider: LLMProvider =
      model === null
        ? new ScriptedLLMProvider([scriptedTestTurn()])
        : new ClaudeProvider({
            model: toOpenRouterModel(model),
            effort: "medium",
            client: createOpenRouterClient(apiKey ? { apiKey } : {}),
          });
    const runtime = new SingleAgentRuntime({
      sessions: new InMemorySessionStore([{ sessionId, projectId, sandboxId: id }]),
      sandbox,
      events,
      bus: new InMemoryEventBus(),
      context: new NapContextEngine({ budgetTokens: 80_000 }),
      agent: new NapAgentService({ provider }),
      memory: new NoopMemoryProvider(),
      computer: { coordinator: isolatedProjectComputer(desktop), objects, recordings: desktop },
    });
    const limit = AbortSignal.timeout(RUN_LIMIT_MS);
    const sampler = sampleMemory(id);
    try {
      outcome = await runtime.runTurn({
        kind: "test",
        sessionId,
        turnId,
        jobId,
        model: model ?? "openai/gpt-5.6-luna",
        signal: limit,
      });
    } catch (error) {
      outcome = {
        ok: false,
        turnId,
        reason: "internal",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    timedOut = limit.aborted;
    mark("test");
    memory = { peakMiB: await sampler.stop(), oomKills: await oomKills(exec) };
  };
  try {
    await body();
  } catch (error) {
    if (preparation.ok)
      fail("sandbox_start", error instanceof Error ? error.message : String(error));
  }
  const log: StoredEvent[] = await events.readFrom(sessionId, 0);
  const run = classifyRun({
    preparation,
    outcome,
    events: log,
    timedOut,
    oomKills: memory.oomKills,
  });
  let usage = { inputTokens: 0, outputTokens: 0 };
  for (const event of log)
    if (event.type === "turn.completed" && event.turnId === turnId) usage = event.payload.usage;
  writeFileSync(join(directory, "events.json"), JSON.stringify(log, null, 2));
  for (const event of log) {
    if (event.type === "computer.screenshot") {
      const image = bytes.get(event.payload.key);
      if (image)
        writeFileSync(
          join(directory, "screenshots", `${String(event.seq).padStart(4, "0")}.jpg`),
          image,
        );
    }
    if (event.type === "test.recording" && event.payload.recording.state === "available") {
      const video = bytes.get(event.payload.recording.key);
      if (video) writeFileSync(join(directory, "recording.mp4"), video);
    }
  }
  writeFileSync(
    join(directory, "result.json"),
    JSON.stringify({ app: app.id, index, ...run, outcome, timings, memory, usage }, null, 2),
  );
  if (sandboxId) {
    const destroyed = await sandbox.destroy(sandboxId);
    if (!destroyed.ok) console.error(`Could not destroy ${sandboxId}: ${destroyed.error.message}`);
  }
  return run;
}

/**
 * The machine's largest memory use while the test ran, from `docker stats` every few seconds.
 * Docker's figure leaves out reclaimable page cache, which the cgroup's own `memory.peak` counts
 * and which fills any limit on a machine that has built anything. A sample, so a spike between
 * two reads is missed.
 */
function sampleMemory(containerId: string): { stop(): Promise<number | null> } {
  let peak: number | null = null;
  let running = true;
  const loop = (async () => {
    while (running) {
      const read = Bun.spawn(
        ["docker", "stats", "--no-stream", "--format", "{{.MemUsage}}", containerId],
        { stdout: "pipe", stderr: "ignore" },
      );
      const used = dockerMemoryMiB(await new Response(read.stdout).text());
      if (used !== null) peak = Math.max(peak ?? 0, used);
      await Bun.sleep(2_000);
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return peak;
    },
  };
}

/** How many processes the machine's cgroup killed for memory. */
async function oomKills(
  exec: (command: string) => Promise<{ exitCode: number; stdout: string }>,
): Promise<number> {
  try {
    const read = await exec("grep '^oom_kill ' /sys/fs/cgroup/memory.events 2>/dev/null");
    const kills = read.stdout.match(/^oom_kill (\d+)/m)?.[1];
    return kills === undefined ? 0 : Number(kills);
  } catch {
    return 0;
  }
}
