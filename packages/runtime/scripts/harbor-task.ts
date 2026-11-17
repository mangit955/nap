/**
 * One Terminal-Bench task, run by Nap's agent inside the task's own machine.
 *
 * Started by `harbor/nap_harbor/agent.py` for each trial, never by hand: its stdout and stdin are
 * the exec channel to the task's machine (see `@nap/sandbox/exec-channel`), so everything meant
 * for a person goes to stderr, which the Python side files as `nap.log`.
 *
 * Only the wiring lives here. The turn is `runTaskTurn` and the command line is
 * `parseHarborTaskArgs`, both tested; see harbor/README.md for how a run is started.
 */

import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { NapAgentService } from "@nap/agent/agent-service";
import { ClaudeProvider } from "@nap/agent/claude-provider";
import { countRequests } from "@nap/agent/counted-client";
import { createOpenRouterClient, toOpenRouterModel } from "@nap/agent/openrouter";
import { NapReviewer } from "@nap/agent/reviewer";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { REVIEW_PROMPTS } from "@nap/context/review-prompt";
import { ChannelSandboxManager } from "@nap/sandbox/channel-sandbox-manager";
import { LineExecChannel } from "@nap/sandbox/exec-channel";
import { loadEnvFile } from "@nap/shared/env-file";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { LLMProvider } from "@nap/shared/ports/llm-provider";
import {
  HARBOR_TASK_DEFAULTS,
  HARBOR_TASK_FILES,
  HARBOR_TASK_USAGE,
  parseHarborTaskArgs,
} from "../src/harbor-task-args.ts";
import { formatEvent } from "../src/harness.ts";
import { runTaskTurn } from "../src/task-turn.ts";

/** Credentials live here by convention; Bun only auto-loads a `.env` from the working directory. */
const ENV_FILE = join(import.meta.dirname, "..", "..", "..", "apps", "api", ".env");

// Stdout is the channel. Anything a library prints with `console.log` would be read as a line of
// it — ignored, but lost to the log — so the console goes to stderr from here on.
console.log = console.error;

const parsed = parseHarborTaskArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.error}\n\n${HARBOR_TASK_USAGE}`);
  process.exit(2);
}
const options = parsed.value;

/**
 * What `--scripted` runs instead of a model: one command and one file in the task's machine,
 * then an answer. Each goes through the channel, so a wiring check exercises both kinds of tool
 * the real agent uses, and the file is something a test can look for afterwards
 * (harbor/tests/test_nap_entrypoint.py).
 */
function scriptedProvider(): LLMProvider {
  return new ScriptedLLMProvider([
    [
      { toolCalls: [{ id: "call_1", name: "run_command", input: { command: "pwd -P && ls -a" } }] },
      {
        toolCalls: [
          {
            id: "call_2",
            name: "write_file",
            input: {
              path: `${PROJECT_ROOT_PATH}/nap-scripted.txt`,
              contents: "written by Nap's scripted model\n",
            },
          },
        ],
        usage: { inputTokens: 1_000, outputTokens: 40 },
      },
      { text: "Wrote the marker file.", usage: { inputTokens: 1_100, outputTokens: 10 } },
    ],
  ]);
}

if (!options.scripted) {
  loadEnvFile(ENV_FILE, process.env);
  if (!process.env.OPENROUTER_API_KEY) {
    console.error(
      `OPENROUTER_API_KEY is not set. Add it to ${ENV_FILE}, or export it, then retry.`,
    );
    process.exit(2);
  }
}

const channel = new LineExecChannel((line) => process.stdout.write(`${line}\n`));
const answers = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
// Harbor closes the channel when it gives up on the trial: its timeout, or an interrupt. Nothing
// can reach the machine after that, so the turn stops rather than spending requests on tools that
// can only fail, and still writes what it counted.
const stopped = new AbortController();
answers.on("line", (line) => channel.receive(line));
answers.on("close", () => {
  channel.close("Harbor closed the channel to the task's machine.");
  stopped.abort();
});

const instruction = readFileSync(join(options.jobDir, HARBOR_TASK_FILES.instruction), "utf8");
const trajectory = createWriteStream(join(options.jobDir, HARBOR_TASK_FILES.trajectory));

console.error(
  `Nap on a Terminal-Bench task — ${options.model}, ${options.maxSteps} steps at most` +
    (options.review ? ", reviewed" : "") +
    (options.scripted ? ", scripted" : options.spend ? ", spending allowed" : ", free"),
);

// The scripted model sends no HTTP requests, so none are counted; its steps still are, at the
// provider, like a real model's.
const http = options.scripted ? undefined : countRequests(createOpenRouterClient());

const result = await runTaskTurn({
  sandbox: new ChannelSandboxManager({ sandboxId: "harbor-task", channel: channel.exec }),
  context: new NapContextEngine(),
  memory: new NoopMemoryProvider(),
  provider:
    http === undefined
      ? scriptedProvider()
      : new ClaudeProvider({
          model: toOpenRouterModel(options.model),
          effort: HARBOR_TASK_DEFAULTS.effort,
          maxTokens: HARBOR_TASK_DEFAULTS.maxOutputTokens,
          client: http.client,
        }),
  requests: http?.requests ?? (() => 0),
  signal: stopped.signal,
  agentFor: (provider, maxSteps) => new NapAgentService({ provider, budget: { maxSteps } }),
  maxSteps: options.maxSteps,
  ...(options.review
    ? {
        reviewerFor: (provider: LLMProvider) =>
          new NapReviewer({ provider, prompts: REVIEW_PROMPTS }),
      }
    : {}),
  instruction,
  model: options.model,
  onEvent: (event) => {
    trajectory.write(`${JSON.stringify(event)}\n`);
    console.error(formatEvent(event));
  },
});

await new Promise<void>((resolve) => trajectory.end(resolve));
writeFileSync(
  join(options.jobDir, HARBOR_TASK_FILES.result),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.error(
  `\n${result.status} in ${(result.durationMs / 1_000).toFixed(1)}s — ${result.steps} steps, ` +
    `${result.requests} model requests, ` +
    (result.reviews === undefined
      ? ""
      : `${result.reviews.length} reviews (${result.reviews.filter((review) => review.sentBack).length} sent it back), `) +
    `${result.usage.inputTokens} input and ${result.usage.outputTokens} output tokens` +
    (result.failure === null ? "" : ` — ${result.failure.reason}: ${result.failure.message}`),
);
// Exits whatever the outcome: the result file says how the turn went, and stdin, still open to
// Harbor, would otherwise keep this process alive.
process.exit(0);
