/**
 * Runs one turn from the command line and prints the event stream.
 *
 * `bun run harness "add a dark mode toggle"`
 *
 * This is the acceptance check for the intelligence plane: everything from a sentence typed
 * by a person to a commit in a sandbox, with no web app in the way. When something breaks
 * between the runtime, the agent and the sandbox, this is the shortest way to see it.
 *
 * **It runs on fakes unless told otherwise, and that is the important part.** A real run
 * spends money — a model call per step, and a sandbox billed by the second — so the default
 * exercises the whole composition with a scripted model and an in-memory sandbox, which
 * costs nothing and can be run in a loop. `--real` is the deliberate act of spending.
 *
 * Only the wiring lives here. What the flags mean and how an event is rendered are in
 * `../src/harness.ts`, where they are tested; the rule deciding whether a run costs money is
 * not one to leave in an untested script.
 */

import { join } from "node:path";
import { NapAgentService } from "@nap/agent/agent-service";
import { createBedrockClient, toBedrockModel } from "@nap/agent/bedrock";
import { ClaudeProvider } from "@nap/agent/claude-provider";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { NAP_TEMPLATE, TEMPLATE_DEV_PORT, TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { loadEnvFile } from "@nap/shared/env-file";
import type { LLMProvider } from "@nap/shared/ports/llm-provider";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { formatEvent, HARNESS_DEFAULTS, HARNESS_USAGE, parseHarnessArgs } from "../src/harness.ts";
import { SingleAgentRuntime } from "../src/single-agent-runtime.ts";

/** Credentials live here by convention; Bun only auto-loads a `.env` from the working directory. */
const ENV_FILE = join(import.meta.dirname, "..", "..", "..", "apps", "api", ".env");

const parsedArgs = parseHarnessArgs(process.argv.slice(2));
if (!parsedArgs.ok) {
  console.error(`${parsedArgs.error}\n\n${HARNESS_USAGE}`);
  process.exit(1);
}
const options = parsedArgs.value;

/**
 * A model that writes one file and then answers.
 *
 * Enough to exercise every part of the stream a real turn produces — a tool call, its
 * result, a file diff, a message, a commit — without a request leaving the machine.
 */
function scriptedProvider(): LLMProvider {
  return new ScriptedLLMProvider([
    [
      {
        text: "I'll add the component.",
        toolCalls: [
          {
            id: "call_1",
            name: "write_file",
            input: {
              path: `${TEMPLATE_WORKDIR}/src/DarkModeToggle.tsx`,
              contents:
                "export function DarkModeToggle() {\n  return <button>Toggle theme</button>;\n}\n",
            },
          },
        ],
        usage: { inputTokens: 1_200, outputTokens: 90 },
      },
      { text: "Added the toggle component.", usage: { inputTokens: 1_400, outputTokens: 20 } },
    ],
  ]);
}

/** An in-memory sandbox answering the commands a turn actually runs, git included. */
function fakeSandbox(): InMemorySandboxManager {
  return (
    new InMemorySandboxManager({
      // Anything unscripted gets a plausible success: this sandbox is a stand-in, not the
      // subject of the run.
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
      // Serving from the start, so the dry run shows the `preview.ready` a real one emits.
      serves: [TEMPLATE_DEV_PORT],
    })
      // Non-zero means the index differs from HEAD, which is what makes a commit happen.
      .script(/git diff --cached --quiet/, { exitCode: 1 })
      .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${"0".repeat(40)}\n` })
  );
}

let sandbox: SandboxManager;
let provider: LLMProvider;

if (options.real) {
  loadEnvFile(ENV_FILE, process.env);

  // Bedrock reaches the same models through an AWS account, so it needs AWS credentials and
  // a region instead of an Anthropic key. The region is checked here rather than left to the
  // SDK because its client constructor throws on a missing one, and a stack trace is a worse
  // answer than a sentence naming the variable.
  const required =
    options.platform === "bedrock"
      ? ["E2B_API_KEY", "AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"]
      : ["E2B_API_KEY", "ANTHROPIC_API_KEY"];

  for (const key of required) {
    if (process.env[key]) continue;
    console.error(`${key} is not set. Add it to ${ENV_FILE}, or export it, then retry.`);
    process.exit(1);
  }

  const model = options.platform === "bedrock" ? toBedrockModel(options.model) : options.model;

  console.log(
    `REAL RUN — ${model} via ${options.platform} at ${options.effort} effort, ` +
      `${options.maxSteps} steps max, ${options.budgetTokens} context tokens, ` +
      "on a real E2B sandbox. This costs money.\n",
  );
  sandbox = new E2BSandboxManager({ template: NAP_TEMPLATE });
  provider = new ClaudeProvider({
    model,
    effort: options.effort,
    maxTokens: HARNESS_DEFAULTS.maxOutputTokens,
    // Same provider, same loop, same events — only the transport underneath differs.
    ...(options.platform === "bedrock" ? { client: createBedrockClient() } : {}),
  });
} else {
  console.log("Dry run on a scripted model and an in-memory sandbox. Pass --real to spend.\n");
  sandbox = fakeSandbox();
  provider = scriptedProvider();
}

const sessionId = crypto.randomUUID();
const sessions = new InMemorySessionStore([{ sessionId, projectId: crypto.randomUUID() }]);
const events = new InMemoryEventStore();
const bus = new InMemoryEventBus();

// Subscribed before the turn starts, so nothing it emits is missed. The event store is in
// memory because the Postgres one belongs to the streaming milestone — this run is not a
// persistence test, and everything printed here was still appended before it was published.
bus.subscribe(sessionId, (event) => console.log(formatEvent(event)));

const runtime = new SingleAgentRuntime({
  sessions,
  sandbox,
  context: new NapContextEngine({ budgetTokens: options.budgetTokens }),
  agent: new NapAgentService({ provider, budget: { maxSteps: options.maxSteps } }),
  events,
  bus,
  memory: new NoopMemoryProvider(),
});

const startedAt = Date.now();
const outcome = await runtime.runTurn({ sessionId, message: options.prompt });
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log(
  outcome.ok
    ? `\nDone in ${seconds}s — commit ${outcome.commitSha ?? "none (no files changed)"}`
    : `\nFailed in ${seconds}s — ${outcome.reason}: ${outcome.message}`,
);

const sandboxId = (await sessions.get(sessionId))?.sandboxId ?? null;

if (options.real && sandboxId !== null) {
  const preview = await sandbox.getPreviewUrl(sandboxId, TEMPLATE_DEV_PORT);
  if (preview.ok) console.log(`Preview: ${preview.value}`);

  if (options.keep) {
    console.log(`Sandbox ${sandboxId} left running — it is billed until it is destroyed.`);
  } else {
    // Billed by the second, so it goes away unless asked for. Losing the workspace is fine:
    // snapshotting a project is a later milestone, and this run's purpose was the stream.
    await sandbox.destroy(sandboxId);
    console.log(`Sandbox ${sandboxId} destroyed.`);
  }
}

process.exit(outcome.ok ? 0 : 1);
