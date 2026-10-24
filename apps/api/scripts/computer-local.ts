/** Free local Nap with real Docker files, Chrome, input and video; scripted model and RAM storage. */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
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
import { E2BSandboxDesktop } from "@nap/sandbox/e2b-sandbox-desktop";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { eq } from "drizzle-orm";
import { upgradeWebSocket, websocket } from "hono/bun";
import { encryptionKeyFrom } from "../src/account/secret-box.ts";
import { createAuth } from "../src/auth/auth.ts";
import { composeNap } from "../src/compose.ts";
import { HTTP_SERVER_OPTIONS } from "../src/http-options.ts";
import { createLogger } from "../src/logger.ts";
import { computerLocalProvider } from "./computer-local-model.ts";
import { LocalDockerSandboxManager } from "./computer-local-sandbox.ts";
import { prepareComputerLocalWeb } from "./computer-local-web.ts";
import { loadgenConfig } from "./loadgen-composition.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WEB = "http://127.0.0.1:3047";
const API = "http://127.0.0.1:3048";
const EMAIL = "reader@computer.test";
const PASSWORD = "Computer-local-42";
const abort = new AbortController();
const cleanup: { name: string; close: () => Promise<unknown> }[] = [];
let stopping: Promise<void> | undefined;
let ending = false;
let starting = true;
let runDirectory: string | undefined;

async function own(name: string, close: () => Promise<unknown>) {
  if (ending) {
    await close();
    throw new Error("Local computer startup was stopped.");
  }
  cleanup.push({ name, close });
}
function stop() {
  if (stopping) return stopping;
  ending = true;
  abort.abort();
  stopping = (async () => {
    const failures: string[] = [];
    for (const resource of cleanup.reverse()) {
      try {
        await resource.close();
      } catch {
        failures.push(resource.name);
      }
    }
    if (runDirectory)
      await writeFile(
        join(runDirectory, "cleanup.json"),
        JSON.stringify({ ok: failures.length === 0, failures }, null, 2),
      );
    if (failures.length) throw new Error(`Local cleanup failed: ${failures.join(", ")}`);
  })();
  return stopping;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (starting) {
      ending = true;
      abort.abort();
      return;
    }
    void stop().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(String(error));
        process.exit(1);
      },
    );
  });
}

try {
  // Fail before Docker allocation; never replace another service on either new port.
  for (const port of [3047, 3048]) {
    await new Promise<void>((ready, fail) => {
      const probe = createServer();
      probe.once("error", () => fail(new Error(`Local computer port ${port} is occupied.`)));
      probe.listen(port, "127.0.0.1", () =>
        probe.close((error) => (error ? fail(error) : ready())),
      );
    });
  }
  await mkdir(join(repositoryRoot, ".scratch"), { recursive: true });
  runDirectory = await mkdtemp(join(repositoryRoot, ".scratch/computer-local-"));
  const opened = await LocalDockerSandboxManager.open({
    repositoryRoot,
    memoryMB: 2048,
    ttlMs: 60 * 60_000,
    evidenceDirectory: join(runDirectory, "sandbox"),
    signal: abort.signal,
  });
  if (!opened.ok) throw new Error(opened.error.message);
  const sandbox = opened.value;
  await own("Docker sandbox", async () => {
    const closed = await sandbox.close();
    if (!closed.ok) throw new Error(closed.error.message);
  });
  const postgres = await startDockerPostgres({ signal: abort.signal });
  await own("local Postgres", postgres.stop);
  const { db, close } = createDatabase(postgres.url);
  await own("database client", close);
  const copied = await prepareComputerLocalWeb({ repositoryRoot, runDirectory });
  if (!copied.ok) throw new Error(copied.error.message);
  await own("isolated web copy", copied.value.close);
  const secret = randomBytes(32).toString("hex");
  const auth = createAuth(db, { secret, baseUrl: API, webOrigin: WEB, allowAnonymous: true });
  const signedUp = await auth.handler(
    new Request(`${API}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: WEB, "content-type": "application/json" },
      body: JSON.stringify({ name: "Local computer reader", email: EMAIL, password: PASSWORD }),
    }),
  );
  if (!signedUp.ok) throw new Error(`Local signup failed: ${signedUp.status}`);
  const [owner] = await db.select().from(users).where(eq(users.email, EMAIL));
  if (!owner) throw new Error("Local owner missing.");
  const created = await createProjectSession(db, {
    userId: owner.id,
    name: "Real Docker computer · scripted model · RAM recordings",
  });
  const desktop = new E2BSandboxDesktop({ sandbox });
  const config = {
    ...loadgenConfig(2),
    NAP_WEB_ORIGIN: WEB,
    NAP_MODEL: "anthropic/claude-sonnet-5",
    NAP_FREE_MODEL: "anthropic/claude-sonnet-5",
    NAP_ALLOWED_MODELS: ["anthropic/claude-sonnet-5"],
    NAP_WORKER_CONCURRENCY: 1,
    NAP_MAX_STEPS: 40,
    NAP_CONTEXT_BUDGET_TOKENS: 80_000,
    NAP_SANDBOX_TTL_MINUTES: 60,
    NAP_REAP_IDLE_MINUTES: 59,
    NAP_DRAIN_TIMEOUT_SECONDS: 30,
  };
  const composed = composeNap({
    config,
    auth,
    logger: createLogger({ level: "warn" }),
    sessions: new PostgresSessionStore(db),
    projects: new PostgresProjectStore(db),
    sessionStarts: new PostgresSessionStartStore(db),
    sessionNavigation: new PostgresSessionNavigationStore(db),
    projectSandboxes: new PostgresProjectSandboxStore(db),
    capacity: new PostgresSandboxCapacity(db, { perUser: 2, total: 2 }),
    rateLimits: {
      rate: new PostgresTurnRateLimiter(db, { limit: 1000, windowMs: 3600000, tier: "paid" }),
      freeRate: new PostgresTurnRateLimiter(db, { limit: 1000, windowMs: 3600000, tier: "free" }),
    },
    queue: new PostgresTurnQueue(db),
    snapshots: new PostgresSnapshotStore(db),
    userKeys: new PostgresUserKeyStore(db),
    events: new PostgresEventStore(db),
    bus: new InProcessEventBus(),
    sandbox,
    desktop,
    recordings: desktop,
    computerAccess: { access: new PostgresProjectComputerAccess(db), secret },
    objects: new InMemoryObjectStore(),
    provider: computerLocalProvider(),
    encryptionKey: encryptionKeyFrom(randomBytes(32).toString("base64")),
    verifyKey: async () => ({
      ok: false,
      message: "Real API keys are disabled in this local app.",
    }),
    createProject: (options) => createProjectSession(db, options),
    upgradeWebSocket,
  });
  await own("Nap worker and timers", async () => {
    composed.github.stop();
    composed.reaper.stop();
    composed.janitor.stop();
    await composed.worker.stop();
  });
  const seeded = await composed.runtime.runTurn({
    sessionId: created.sessionId,
    turnId: crypto.randomUUID(),
    message:
      "Build the local Notes demonstration so I can test saving a note in the real computer.",
    model: config.NAP_MODEL,
    signal: abort.signal,
  });
  if (!seeded.ok) throw new Error("The local source/build turn did not finish successfully.");
  await db.update(projects).set({ status: "ready" }).where(eq(projects.id, created.projectId));
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 3048,
    ...HTTP_SERVER_OPTIONS,
    fetch: composed.app.fetch,
    websocket,
  });
  await own("local API", async () => {
    await server.stop(true);
  });
  const web = Bun.spawn(
    [
      "node",
      join(repositoryRoot, "apps/web/node_modules/next/dist/bin/next"),
      "dev",
      copied.value.directory,
      "--webpack",
      "--port",
      "3047",
      "--hostname",
      "127.0.0.1",
    ],
    {
      cwd: copied.value.directory,
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: API,
        NEXT_PUBLIC_API_WS_URL: "ws://127.0.0.1:3048",
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  await own("local Next server", async () => {
    web.kill("SIGTERM");
    const kill = setTimeout(() => web.kill("SIGKILL"), 15_000);
    try {
      await web.exited;
    } finally {
      clearTimeout(kill);
    }
  });
  void web.exited.then(() => {
    if (!ending)
      void stop().catch((error: unknown) => {
        console.error(String(error));
        process.exitCode = 1;
      });
  });
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline && !ending) {
    try {
      ready = (await fetch(`${WEB}/sign-in`, { signal: AbortSignal.timeout(3000) })).status === 200;
      if (ready) break;
    } catch {
      /* Next's first compilation may still be in progress. */
    }
    await Bun.sleep(300);
  }
  if (!ready) throw new Error("The isolated local web app did not become ready.");
  const workspace = `${WEB}/p/${created.projectId}`;
  await writeFile(
    join(runDirectory, "run.json"),
    JSON.stringify(
      { mode: "scripted-local-docker", pid: process.pid, workspace, api: API, ...created },
      null,
      2,
    ),
  );
  starting = false;
  console.log(
    `\nLocal real computer: ${workspace}\nLogin: ${EMAIL} / ${PASSWORD}\nScripted model, real Docker files/Git/build/Chrome/input/video. Recordings are RAM-only until exit.\nNo E2B, OpenRouter or other model calls. Stop with Ctrl-C.\nRun evidence: ${runDirectory}\n`,
  );
} catch (error) {
  const cancelled = abort.signal.aborted;
  console.error(String(error));
  try {
    await stop();
  } catch (cleanupError) {
    console.error(String(cleanupError));
  }
  process.exitCode = cancelled ? 0 : 1;
}
