/** Local, free UI verification through the real routes, queue, worker, runtime and WebSocket.
 * Run from the repository root: bun apps/api/scripts/compaction-preview.ts
 * Open http://localhost:3035/compaction-check. Ctrl-C removes the temporary route.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NapAgentService } from "@nap/agent/agent-service";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { SingleAgentRuntime } from "@nap/runtime/single-agent-runtime";
import { startTurnWorker } from "@nap/runtime/turn-worker";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import type { LLMProvider } from "@nap/shared/ports/llm-provider";
import { upgradeWebSocket, websocket } from "hono/bun";
import { createApp } from "../src/app.ts";
import { createLogger } from "../src/logger.ts";
import { TurnRegistry } from "../src/turns/registry.ts";

const SESSION = "00000000-0000-4000-8000-000000000101";
const PROJECT = "00000000-0000-4000-8000-000000000102";
const OWNER = "00000000-0000-4000-8000-000000000001";
const events = new InMemoryEventStore();
const bus = new InMemoryEventBus();
const sessions = new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]);
const projects = new InMemoryProjectStore([
  {
    projectId: PROJECT,
    name: "Compaction check",
    status: "ready",
    sandboxId: null,
    updatedAt: new Date().toISOString(),
    sessionIds: [SESSION],
  },
]);
const queue = new InMemoryTurnQueue();
const registry = new TurnRegistry();
let mode = "success";
const provider: LLMProvider = {
  startTurn() {
    let inputTokens = 0;
    let outputTokens = 0;
    return {
      usage: () => ({ inputTokens, outputTokens }),
      async complete(request) {
        const summary = request.purpose === "compaction";
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, summary ? (mode === "slow" ? 60_000 : 1800) : 300);
          request.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        request.signal?.throwIfAborted();
        const usage = { inputTokens: summary ? 1200 : 300, outputTokens: summary ? 100 : 40 };
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        if (summary && mode === "fail")
          return {
            type: "error",
            message: "Scripted summary failure. Previous context was kept.",
            retryable: false,
            usage,
          };
        return {
          type: "message",
          text: summary
            ? "The app uses a purple theme and must remain keyboard accessible. The user prohibited deployment. Continue with the next request."
            : "The requested change is recorded. The original constraints are still available.",
          toolCalls: [],
          usage,
        };
      },
    };
  },
};
const runtime = new SingleAgentRuntime({
  sessions,
  events,
  bus,
  sandbox: scriptGit(new InMemorySandboxManager(), { dirty: false }),
  context: new NapContextEngine(),
  memory: new NoopMemoryProvider(),
  agent: new NapAgentService({ provider }),
});
await runtime.runTurn({
  turnId: crypto.randomUUID(),
  sessionId: SESSION,
  message: "Keep the purple theme, keyboard navigation, and do not deploy.",
});
const app = createApp({
  logger: createLogger({ level: "silent" }, { write: () => {} }),
  webOrigin: "http://localhost:3035",
  authenticate: async () => ({ userId: OWNER, isAnonymous: false }),
  stream: { store: events, bus, sessions, upgradeWebSocket },
  turns: {
    queue,
    registry,
    sessions,
    projects,
    allowedModels: ["fixture/free"],
    freeModel: "fixture/free",
    defaultModel: "fixture/free",
  },
});
app.post("/fixture/:mode", (c) => {
  mode = c.req.param("mode");
  return c.json({ mode });
});
const worker = startTurnWorker({
  queue,
  runtime,
  concurrency: 2,
  running: registry,
  pollIntervalMs: 20,
  drainTimeoutMs: 1000,
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 3036, fetch: app.fetch, websocket });
const webDir = fileURLToPath(new URL("../../web", import.meta.url));
const route = `${webDir}/src/app/compaction-check`;
await mkdir(route);
await writeFile(
  `${route}/page.tsx`,
  'export { CompactionPreview as default } from "../../testing/compaction-preview.tsx";\n',
  { flag: "wx" },
);
const web = Bun.spawn(["bun", "run", "dev", "--port", "3035"], {
  cwd: webDir,
  stdout: "inherit",
  stderr: "inherit",
});
console.log(
  "Compaction UI: http://localhost:3035/compaction-check (scripted model, no credentials or spend)",
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  web.kill();
  await worker.stop();
  server.stop(true);
  await rm(route, { recursive: true });
  process.exit(0);
}
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
void web.exited.then(() => stop());
