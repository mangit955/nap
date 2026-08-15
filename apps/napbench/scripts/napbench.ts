/**
 * Runs one benchmark task, or a named suite, and prints what happened.
 *
 * `bun run napbench todo-crud`
 * `bun run napbench --real --suite=all`
 *
 * The composition root: this is the only place where a real sandbox, a real model, a real
 * browser and a real filesystem meet the pure evaluator in `@nap/bench`. Everything it decides
 * is decided elsewhere — the flags in `@nap/bench/cli`, the tasks in `@nap/bench/suite`, the
 * scoring in the runner, the aggregation in `@nap/bench/summary` — because a rule that lives in
 * a script is a rule nobody tests, and one of these rules decides whether money is spent.
 *
 * **It runs on fakes unless told otherwise.** A dry run exercises every stage — seeding, turns,
 * the preview probe, the checks, the report and trajectory files, the aggregation — against a
 * scripted model, an in-memory sandbox and a scripted browser. It is free, offline, and its
 * scores mean nothing: what it proves is that the machinery joins up, which is the thing worth
 * proving before a paid run.
 *
 * **Isolation is structural.** Every run gets its own session, its own stores and its own
 * sandbox, so nothing a run leaves behind can be what makes the next one pass. Suites run
 * serially, which keeps sandbox concurrency and spend predictable.
 */

import { join } from "node:path";
import { NapAgentService } from "@nap/agent/agent-service";
import { createBedrockClient, toBedrockModel } from "@nap/agent/bedrock";
import { ClaudeProvider } from "@nap/agent/claude-provider";
import { createOpenRouterClient, toOpenRouterModel } from "@nap/agent/openrouter";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import type { BrowserSessionFactory } from "@nap/bench/browser-session";
import { DEFAULT_CATEGORY_WEIGHTS } from "@nap/bench/category";
import { NAPBENCH_DEFAULTS, NAPBENCH_USAGE, parseNapBenchArgs } from "@nap/bench/cli";
import { deriveRunMetrics } from "@nap/bench/metrics";
import { type BenchReport, evaluatorErrorReport } from "@nap/bench/report";
import { type BenchRunResult, runBenchTask } from "@nap/bench/runner";
import { resolveSelection } from "@nap/bench/suite";
import { formatRunSummary, formatSuiteSummary, summariseSuite } from "@nap/bench/summary";
import type { BenchTask } from "@nap/bench/task";
import { ScriptedBrowserSession } from "@nap/bench/testing/scripted-browser-session";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { NAP_TEMPLATE, TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { loadEnvFile } from "@nap/shared/env-file";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { LLMProvider } from "@nap/shared/ports/llm-provider";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { launchPlaywrightBrowser } from "../src/playwright-browser-session.ts";
import { resolveResultsDir } from "../src/results-dir.ts";
import { writeBenchReport, writeBenchTrajectory } from "../src/write-report.ts";
import { fileScreenshotStore } from "../src/write-screenshot.ts";

/** Credentials live here by convention; Bun only auto-loads a `.env` from the working directory. */
const ENV_FILE = join(import.meta.dirname, "..", "..", "..", "apps", "api", ".env");
const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

const parsedArgs = parseNapBenchArgs(process.argv.slice(2));
if (!parsedArgs.ok) {
  console.error(`${parsedArgs.error}\n\n${NAPBENCH_USAGE}`);
  process.exit(1);
}
const options = parsedArgs.value;

// Resolved before anything is created, so a mistyped task id costs a sentence rather than a
// sandbox.
const selected = resolveSelection(options.selection);
if (!selected.ok) {
  console.error(`${selected.error}\n\n${NAPBENCH_USAGE}`);
  process.exit(1);
}
const { name: selectionName, tasks } = selected.value;

const resultsDir = resolveResultsDir(REPO_ROOT);

/**
 * A model that writes one file and answers, once per prompt the task asks.
 *
 * It does not attempt the task: a scripted model cannot build a to-do application, and one
 * pretending to would make a dry run's scores look meaningful. What it exercises is the turn,
 * the tool loop, the event stream and everything downstream of them.
 *
 * Scripted per *task* rather than once, because a script is consumed as it is used: one shared
 * provider would run out after the first run and every task after it would fail its turn, which
 * reads as an agent error and is really an exhausted fixture.
 */
function scriptedProvider(task: BenchTask): LLMProvider {
  return new ScriptedLLMProvider(
    task.prompts.map(() => [
      {
        text: "I'll start with the entry point.",
        toolCalls: [
          {
            id: "call_1",
            name: "write_file",
            input: {
              path: `${PROJECT_ROOT_PATH}/src/App.tsx`,
              contents: "export default function App() {\n  return <h1>Dry run</h1>;\n}\n",
            },
          },
        ],
        usage: { inputTokens: 900, outputTokens: 40 },
      },
      { text: "Done.", usage: { inputTokens: 1_000, outputTokens: 20 } },
    ]),
  );
}

/** An in-memory sandbox that answers a turn's commands and serves the template's port. */
function fakeSandbox(): InMemorySandboxManager {
  return new InMemorySandboxManager({
    defaultExec: () => ({ exitCode: 0, stdout: "" }),
    serves: [TEMPLATE_DEV_PORT],
  })
    .script(/git diff --cached --quiet/, { exitCode: 1 })
    .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${"0".repeat(40)}\n` });
}

/** A browser that loads an empty page, so browser checks run and honestly fail. */
const scriptedBrowser: BrowserSessionFactory = async () => ({
  ok: true,
  value: new ScriptedBrowserSession(),
});

let sandbox: SandboxManager;
/**
 * Where a run's model comes from.
 *
 * A function of the task rather than one instance, because the fake half has to be rebuilt per
 * run while the real one must not be — a `ClaudeProvider` is stateless between turns, and a
 * scripted one is exactly the opposite.
 */
let providerFor: (task: BenchTask) => LLMProvider;
let browser: BrowserSessionFactory;
let closeBrowser: () => Promise<void> = async () => undefined;
/** Absent on a dry run: pricing a scripted model against a real price table is a fiction. */
let pricedModel: string | undefined;

if (options.real) {
  loadEnvFile(ENV_FILE, process.env);

  const required =
    options.platform === "openrouter"
      ? ["E2B_API_KEY", "OPENROUTER_API_KEY"]
      : options.platform === "bedrock"
        ? ["E2B_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"]
        : ["E2B_API_KEY", "ANTHROPIC_API_KEY"];

  for (const key of required) {
    if (process.env[key]) continue;
    console.error(`${key} is not set. Add it to ${ENV_FILE}, or export it, then retry.`);
    process.exit(1);
  }

  // Checked before the first sandbox rather than when the first browser check runs: every
  // browser check in the suite would error for this reason, and discovering it after paying
  // for a turn is the expensive way to learn it.
  const chromePath = process.env.NAP_CHROME_PATH;
  if (!chromePath) {
    console.error(
      "NAP_CHROME_PATH is not set, and the benchmark tasks drive a real browser.\n" +
        "Point it at a Chrome or Chromium binary, then retry.",
    );
    process.exit(1);
  }

  const launched = await launchPlaywrightBrowser({ executablePath: chromePath });
  if (!launched.ok) {
    console.error(launched.error.message);
    process.exit(1);
  }
  browser = launched.value.session;
  closeBrowser = launched.value.close;

  const model =
    options.platform === "openrouter"
      ? toOpenRouterModel(options.model)
      : options.platform === "bedrock"
        ? toBedrockModel(options.model)
        : options.model;
  pricedModel = model;

  console.log(
    `REAL RUN — ${tasks.length} task(s) from "${selectionName}", serially, on ${model} via ` +
      `${options.platform} at ${options.effort} effort, ${options.maxSteps} steps max, ` +
      `${options.budgetTokens} context tokens, on real E2B sandboxes. This costs money.\n`,
  );

  sandbox = new E2BSandboxManager({ template: NAP_TEMPLATE });
  const claude = new ClaudeProvider({
    model,
    effort: options.effort,
    maxTokens: NAPBENCH_DEFAULTS.maxOutputTokens,
    ...(options.platform === "bedrock" ? { client: createBedrockClient() } : {}),
    ...(options.platform === "openrouter" ? { client: createOpenRouterClient() } : {}),
  });
  providerFor = () => claude;
} else {
  console.log(
    `Dry run of "${selectionName}" (${tasks.length} task(s)) on a scripted model, an in-memory ` +
      "sandbox and a scripted browser.\nIt is free, and the scores mean nothing — it exercises " +
      "the machinery, not a model. Pass --real to spend.\n",
  );
  sandbox = fakeSandbox();
  providerFor = scriptedProvider;
  browser = scriptedBrowser;
}

const reports: BenchReport[] = [];

for (const task of tasks) {
  console.log(`\n── ${task.id}: ${task.name}`);

  const sessionId = crypto.randomUUID();
  const events = new InMemoryEventStore();
  const sessions = new InMemorySessionStore([{ sessionId, projectId: crypto.randomUUID() }]);
  const runtime = composeRuntime(task, sessions, events);

  const runId = crypto.randomUUID();
  let result: BenchRunResult | undefined;

  try {
    result = await runBenchTask(task, {
      runtime,
      sandbox,
      sessions,
      events,
      sessionId,
      runId,
      browser,
      screenshots: fileScreenshotStore(resultsDir),
      weights: DEFAULT_CATEGORY_WEIGHTS,
      model: pricedModel,
    });
  } catch (error) {
    // NapBench's own crash. Recorded as an `evaluator` error rather than allowed to abort the
    // suite: the remaining tasks are still worth running, and the aggregate has to show that
    // this one produced nothing rather than quietly containing one run fewer.
    console.error(`  the benchmark itself failed: ${describe(error)}`);
    reports.push(
      evaluatorErrorReport({
        runId,
        taskId: task.id,
        sessionId,
        weights: DEFAULT_CATEGORY_WEIGHTS,
        metrics: deriveRunMetrics(await events.readFrom(sessionId, 0), { model: pricedModel }),
      }),
    );
  }

  if (result !== undefined) {
    reports.push(result.report);
    const reportPath = await writeBenchReport(resultsDir, result.report);
    await writeBenchTrajectory(resultsDir, result.trajectory);
    console.log(formatRunSummary(result.report));
    console.log(`  ${reportPath}`);
  }

  await releaseSandbox(sessionId, sessions);
}

await closeBrowser();

console.log(formatSuiteSummary(summariseSuite(selectionName, reports)));

// Non-zero unless every run passed, so this can gate anything without the caller parsing text.
// A suite with an errored run is a failure of the exercise even when the runs that finished
// scored well — the number it produced is not comparable data.
process.exit(reports.every((report) => report.status === "passed") ? 0 : 1);

/** The runtime a run drives, composed fresh so nothing is shared between runs but the ports. */
function composeRuntime(
  task: BenchTask,
  sessions: InMemorySessionStore,
  events: InMemoryEventStore,
) {
  return new SingleAgentRuntime({
    sessions,
    sandbox,
    context: new NapContextEngine({ budgetTokens: options.budgetTokens }),
    agent: new NapAgentService({
      provider: providerFor(task),
      budget: { maxSteps: options.maxSteps },
    }),
    events,
    bus: new InMemoryEventBus(),
    memory: new NoopMemoryProvider(),
  });
}

/**
 * Gives back whatever the run was using, so a suite does not accumulate paid sandboxes.
 *
 * Only on a real run, and only when `--keep` was not asked for: an in-memory sandbox costs
 * nothing to leave behind, and keeping a real one is sometimes exactly what somebody wants
 * after a task scored badly.
 */
async function releaseSandbox(sessionId: string, sessions: InMemorySessionStore): Promise<void> {
  if (!options.real) return;

  const sandboxId = (await sessions.get(sessionId))?.sandboxId ?? null;
  if (sandboxId === null) return;

  if (options.keep) {
    console.log(`  sandbox ${sandboxId} left running — it is billed until it is destroyed.`);
    return;
  }
  await sandbox.destroy(sandboxId);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
