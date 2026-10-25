/** Local app on real auth/Postgres/queue/WebSocket with fake desktop/model/storage. No cloud clients.
 * Run: bun apps/api/scripts/computer-preview.ts. Stop with Ctrl-C to remove the disposable database.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@nap/db/client";
import { InProcessEventBus } from "@nap/db/in-process-event-bus";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresProjectComputerAccess } from "@nap/db/postgres-project-computer-access";
import { PostgresProjectSandboxStore } from "@nap/db/postgres-project-sandbox-store";
import { PostgresProjectStore } from "@nap/db/postgres-project-store";
import { PostgresSandboxCapacity } from "@nap/db/postgres-sandbox-capacity";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { PostgresSnapshotStore } from "@nap/db/postgres-snapshot-store";
import { PostgresTurnQueue } from "@nap/db/postgres-turn-queue";
import { PostgresTurnRateLimiter } from "@nap/db/postgres-turn-rate-limiter";
import { PostgresUserKeyStore } from "@nap/db/postgres-user-key-store";
import { projects, users } from "@nap/db/schema";
import { createProjectSession } from "@nap/db/session-bootstrap";
import { PostgresSessionNavigationStore } from "@nap/db/session-navigation-store";
import { PostgresSessionStartStore } from "@nap/db/session-start-store";
import { startDockerPostgres } from "@nap/db/testing/docker-postgres";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { eq } from "drizzle-orm";
import { upgradeWebSocket, websocket } from "hono/bun";
import { encryptionKeyFrom } from "../src/account/secret-box.ts";
import { createAuth } from "../src/auth/auth.ts";
import { composeNap } from "../src/compose.ts";
import { createLogger } from "../src/logger.ts";
import { computerPreviewProvider } from "./computer-preview-model.ts";
import { fakeSandbox } from "./fake-turn.ts";
import { loadgenConfig } from "./loadgen-composition.ts";

const WEB = "http://localhost:3037";
const API = "http://localhost:3038";
const EMAIL = "reader@computer.test";
const PASSWORD = "Computer-preview-42";
const secret = "computer-preview-local-secret-32";
const postgres = await startDockerPostgres();
const { db, close } = createDatabase(postgres.url);
const auth = createAuth(db, {
  secret,
  baseUrl: API,
  webOrigin: WEB,
  allowAnonymous: true,
});
const signedUp = await auth.handler(
  new Request(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: WEB, "content-type": "application/json" },
    body: JSON.stringify({ name: "Local reader", email: EMAIL, password: PASSWORD }),
  }),
);
if (!signedUp.ok) throw new Error(`Local signup failed: ${signedUp.status}`);
const [owner] = await db.select().from(users).where(eq(users.email, EMAIL));
if (!owner) throw new Error("Local owner missing");
const created = await createProjectSession(db, { userId: owner.id, name: "Computer playground" });
const frame = new Uint8Array(
  await readFile(
    fileURLToPath(
      new URL(
        "../../../docs/assets/computer-use/panel-review/fixture-desktop.jpg",
        import.meta.url,
      ),
    ),
  ),
);
const desktop = new FakeSandboxDesktop({ bytes: frame, width: 1024, height: 768 });
const sandbox = fakeSandbox().script(/git diff --no-ext-diff/, {
  exitCode: 0,
  stdout: "+++ src/Notes.tsx\n+<button>Save</button>",
});
const previewUrl = "http://localhost:3039";
sandbox.getPreviewUrl = async (sandboxId, port) => {
  const alive = await InMemorySandboxManager.prototype.getPreviewUrl.call(sandbox, sandboxId, port);
  return alive.ok ? { ...alive, value: previewUrl } : alive;
};
const preview = Bun.serve({
  hostname: "127.0.0.1",
  port: 3039,
  fetch: () =>
    new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;max-width:640px;margin:60px auto;padding:24px;background:#f6f7fb;color:#20222a}input,button{font:inherit;padding:12px;border-radius:10px;border:1px solid #ccc}button{background:#346bf1;color:white}li{padding:12px}</style></head><body><p>Local synthetic app · no cloud services</p><h1>Notes</h1><form><input aria-label="Note" placeholder="Write a note" required><button>Save</button></form><ul aria-label="Saved notes"></ul><script>document.querySelector('form').onsubmit=e=>{e.preventDefault();const i=document.querySelector('input');const li=document.createElement('li');li.textContent=i.value;document.querySelector('ul').append(li);i.value='';};</script></body></html>`,
      { headers: { "content-type": "text/html" } },
    ),
});
const config = {
  ...loadgenConfig(2),
  NAP_WEB_ORIGIN: WEB,
  NAP_MODEL: "anthropic/claude-sonnet-5",
  NAP_FREE_MODEL: "anthropic/claude-sonnet-5",
  NAP_ALLOWED_MODELS: ["anthropic/claude-sonnet-5"],
  NAP_WORKER_CONCURRENCY: 1,
  NAP_MAX_STEPS: 40,
  NAP_CONTEXT_BUDGET_TOKENS: 80_000,
};
const events = new PostgresEventStore(db);
const queue = new PostgresTurnQueue(db);
const composed = composeNap({
  config,
  auth,
  logger: createLogger({ level: "warn" }),
  sessions: new PostgresSessionStore(db),
  projects: new PostgresProjectStore(db),
  sessionStarts: new PostgresSessionStartStore(db),
  sessionNavigation: new PostgresSessionNavigationStore(db),
  projectSandboxes: new PostgresProjectSandboxStore(db),
  capacity: new PostgresSandboxCapacity(db, { perUser: 2, total: 4 }),
  rateLimits: {
    rate: new PostgresTurnRateLimiter(db, { limit: 1000, windowMs: 3600000, tier: "paid" }),
    freeRate: new PostgresTurnRateLimiter(db, { limit: 1000, windowMs: 3600000, tier: "free" }),
  },
  queue,
  snapshots: new PostgresSnapshotStore(db),
  userKeys: new PostgresUserKeyStore(db),
  events,
  bus: new InProcessEventBus(),
  sandbox,
  desktop: desktop.transport,
  computerAccess: { access: new PostgresProjectComputerAccess(db), secret },
  objects: new InMemoryObjectStore(),
  provider: computerPreviewProvider(350),
  encryptionKey: encryptionKeyFrom(Buffer.alloc(32, 7).toString("base64")),
  verifyKey: async () => ({
    ok: false,
    message: "Real API keys are disabled in this local preview.",
  }),
  createProject: (options) => createProjectSession(db, options),
  upgradeWebSocket,
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 3038,
  fetch: composed.app.fetch,
  websocket,
});
const seedId = crypto.randomUUID();
await queue.enqueue({
  id: seedId,
  sessionId: created.sessionId,
  userId: owner.id,
  kind: "turn",
  message: "Save notes and find them in the list",
  model: config.NAP_MODEL,
  billsToUser: false,
});
const seedDeadline = Date.now() + 60_000;
for (;;) {
  const status = await queue.getStatus({
    id: seedId,
    sessionId: created.sessionId,
    userId: owner.id,
  });
  if (status?.state === "done") break;
  if (!status || status.state === "failed" || status.state === "orphaned")
    throw new Error("The local preview seed turn did not finish successfully.");
  if (Date.now() >= seedDeadline) throw new Error("The local preview seed turn is still pending.");
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}
await db.update(projects).set({ status: "ready" }).where(eq(projects.id, created.projectId));
const web = Bun.spawn(["bun", "run", "dev", "--port", "3037"], {
  cwd: fileURLToPath(new URL("../../web", import.meta.url)),
  env: { ...process.env, NEXT_PUBLIC_API_URL: API, NEXT_PUBLIC_API_WS_URL: "ws://localhost:3038" },
  stdout: "inherit",
  stderr: "inherit",
});
console.log(
  `\nLocal app: ${WEB}/sign-in\nLogin: ${EMAIL} / ${PASSWORD}\nWorkspace: ${WEB}/p/${created.projectId}\nAll model, desktop and storage operations are fakes. First app test fails; after Fix it, the next passes.`,
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  web.kill();
  composed.github.stop();
  composed.reaper.stop();
  composed.janitor.stop();
  await composed.worker.stop();
  server.stop(true);
  preview.stop(true);
  await close();
  await postgres.stop();
  process.exit(0);
}
process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
void web.exited.then(() => stop());
