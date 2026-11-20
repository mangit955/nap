/**
 * The whole of Nap, running for an agent to drive like a user, for nothing.
 *
 * Real: the Next web app, the API composition, auth, Postgres (a throwaway Docker container), the
 * turn queue, the worker, the event log and the WebSocket. Fake: the model (`verify-nap-model.ts`),
 * the sandbox (in memory), object storage (in memory) and the app a project previews (a static page
 * served here). Nothing reaches E2B, OpenRouter, R2 or GitHub, so a run costs $0.
 *
 * It also starts a headless Chrome with a DevTools port, which the driver
 * (`apps/verify-nap/scripts/verify-nap.ts`) connects to for every action, so one browser and its
 * sign-in persist across driver commands.
 *
 * Run: bun apps/api/scripts/verify-nap.ts [--port=3057] [--production]
 *   web on the port, the API on port+1, the previewed app on port+2, Chrome's DevTools on port+3.
 * Ready when it prints `verify-nap ready` and `<run>/run.json` exists. Stop it with SIGTERM to the pid
 * in run.json (or `bun run verify-nap stop`): it removes everything it started — the web copy, the
 * Chrome profile, the database — and keeps `<run>/evidence`, `run.json` and the logs.
 *
 * The web app runs from a copy under the run directory because Next refuses a second dev server
 * for the same app directory, and a person's own `bun run dev` must not stop a verification run.
 * See `.agents/skills/verify-nap/SKILL.md`.
 */
import { randomBytes } from "node:crypto";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@nap/db/client";
import { InProcessEventBus } from "@nap/db/in-process-event-bus";
import { InProcessNotifyTransport } from "@nap/db/in-process-notify-transport";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresProjectSandboxStore } from "@nap/db/postgres-project-sandbox-store";
import { PostgresProjectStore } from "@nap/db/postgres-project-store";
import { PostgresProjectTitleStore } from "@nap/db/postgres-project-title-store";
import { PostgresSandboxCapacity } from "@nap/db/postgres-sandbox-capacity";
import { PostgresSessionListChannel } from "@nap/db/postgres-session-list-channel";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { PostgresSnapshotStore } from "@nap/db/postgres-snapshot-store";
import { PostgresTurnQueue } from "@nap/db/postgres-turn-queue";
import { PostgresTurnRateLimiter } from "@nap/db/postgres-turn-rate-limiter";
import { PostgresUserKeyStore } from "@nap/db/postgres-user-key-store";
import { users } from "@nap/db/schema";
import { createProjectSession } from "@nap/db/session-bootstrap";
import { PostgresSessionNavigationStore } from "@nap/db/session-navigation-store";
import { PostgresSessionStartStore } from "@nap/db/session-start-store";
import { startDockerPostgres } from "@nap/db/testing/docker-postgres";
import { BUNDLE_COMMAND, bundled } from "@nap/sandbox/testing/script-git";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { eq } from "drizzle-orm";
import { upgradeWebSocket, websocket } from "hono/bun";
import { encryptionKeyFrom } from "../src/account/secret-box.ts";
import { createAuth } from "../src/auth/auth.ts";
import { composeNap } from "../src/compose.ts";
import { HTTP_SERVER_OPTIONS } from "../src/http-options.ts";
import { createLogger } from "../src/logger.ts";
import { prepareComputerLocalWeb } from "./computer-local-web.ts";
import { fakeSandbox } from "./fake-turn.ts";
import { loadgenConfig } from "./loadgen-composition.ts";
import { verifyNapProvider } from "./verify-nap-model.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const portArgument = process.argv.find((arg) => arg.startsWith("--port="));
const base = Number(portArgument?.slice("--port=".length) ?? 3057);
if (!Number.isInteger(base) || base < 1024 || base > 65_000)
  throw new Error(`--port must be an integer from 1024 to 65000, got ${portArgument}`);
const ttlArgument = process.argv.find((arg) => arg.startsWith("--ttl-minutes="));
/**
 * How long the fixture runs before stopping itself. An agent whose session ends without `stop`
 * would otherwise leave Postgres, Next and Chrome running until somebody noticed.
 */
const ttlMinutes = Number(ttlArgument?.slice("--ttl-minutes=".length) ?? 120);
if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 24 * 60)
  throw new Error(`--ttl-minutes must be an integer from 1 to 1440, got ${ttlArgument}`);
/**
 * `next build` then `next start` instead of `next dev`. Slower to come up, and a code change needs a
 * new run, but it is the only way to see navigation as a visitor does: Next prefetches routes only in
 * a production build, and `next dev` compiles and adds requests a deployed app never makes.
 */
const production = process.argv.includes("--production");
const ports = { web: base, api: base + 1, preview: base + 2, cdp: base + 3 };
const WEB = `http://127.0.0.1:${ports.web}`;
const API = `http://127.0.0.1:${ports.api}`;
const PREVIEW = `http://127.0.0.1:${ports.preview}`;
const EMAIL = "verify@nap.test";
/**
 * New every run and written only to run.json, which the driver reads to sign in. The database is
 * a throwaway container, but a password literal in source is still one a scanner rightly flags.
 */
const PASSWORD = randomBytes(18).toString("base64url");
const MODEL = "verify/scripted";
const SEEDED_SESSION = "Seeded notes app";
/** Long enough to steer a turn by hand from the driver; short enough not to bore anyone. */
const STEP_DELAY_MS = 2_500;

const abort = new AbortController();
const cleanup: { name: string; close: () => Promise<unknown> }[] = [];
let stopping: Promise<void> | undefined;
let ending = false;
let starting = true;
let runDirectory: string | undefined;

async function own(name: string, close: () => Promise<unknown>) {
  if (ending) {
    await close();
    throw new Error("verify-nap startup was stopped.");
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
    if (failures.length) throw new Error(`verify-nap cleanup failed: ${failures.join(", ")}`);
  })();
  return stopping;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  // `on`, not `once`: a second Ctrl-C during cleanup would otherwise fall through to the default
  // handler and kill the process halfway through removing the database container.
  process.on(signal, () => {
    if (ending) return;
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

/**
 * What has been started so far, rewritten as each thing comes up, so `verify-nap stop` can remove
 * it if this process is killed before its own cleanup runs. Each process records a marker its
 * command line contains, so a pid the OS reuses later is never signalled.
 */
const started: {
  pid: number;
  container: string | null;
  processes: { name: string; pid: number; marker: string }[];
} = { pid: process.pid, container: null, processes: [] };

/**
 * Written to a temporary file and renamed into place, so a driver reading it never sees half a
 * file. Synchronous because the container's name has to be on disk before Docker is asked to
 * create it: a kill in between would otherwise leave a container nothing recorded.
 */
function record() {
  if (!runDirectory) return;
  const path = join(runDirectory, "started.json");
  writeFileSync(`${path}.tmp`, JSON.stringify(started, null, 2));
  renameSync(`${path}.tmp`, path);
}

async function assertFree(port: number) {
  await new Promise<void>((ready, fail) => {
    const probe = createServer();
    probe.once("error", () =>
      fail(new Error(`Port ${port} is taken. Pass --port=<base> to run beside it.`)),
    );
    probe.listen(port, "127.0.0.1", () => probe.close((error) => (error ? fail(error) : ready())));
  });
}

async function waitFor(name: string, url: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !ending) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(3_000) })).ok) return;
    } catch {
      // Not listening yet: Next's first compile and Chrome's start both take a while.
    }
    await Bun.sleep(300);
  }
  throw new Error(`${name} did not answer ${url} within ${timeoutMs / 1000}s.`);
}

function chromePath(): string {
  const configured = process.env.NAP_CHROME_PATH;
  if (configured) return configured;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  throw new Error("Set NAP_CHROME_PATH to a Chrome or Chromium binary.");
}

/** The app a project previews: what the preview pane's iframe loads. Static, and labelled. */
const PREVIEW_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Verify fixture app</title>
<style>body{font:16px system-ui;max-width:560px;margin:48px auto;padding:0 16px;color:#1d2230}button{font:inherit;padding:8px 14px}</style></head>
<body><p>Previewed by the verify-nap fixture · not a real sandbox</p><h1>Fixture notes</h1>
<button type="button" id="add">Add note</button><ul aria-label="Notes"></ul>
<script>let n=0;document.getElementById('add').onclick=()=>{const li=document.createElement('li');li.textContent='Note '+(++n);document.querySelector('ul').append(li);};</script>
</body></html>`;

try {
  if (base + 3 > 65_535) throw new Error("--port leaves no room for the three ports after it.");
  for (const port of Object.values(ports)) await assertFree(port);
  const chrome = chromePath();

  await mkdir(join(repositoryRoot, ".scratch"), { recursive: true });
  runDirectory = await mkdtemp(join(repositoryRoot, ".scratch/verify-nap-"));
  const evidence = join(runDirectory, "evidence");
  await mkdir(evidence);
  record();

  const postgres = await startDockerPostgres({
    signal: abort.signal,
    onName: (name) => {
      started.container = name;
      record();
    },
  });
  await own("Postgres container", postgres.stop);
  const { db, close } = createDatabase(postgres.url);
  await own("database client", close);
  const copied = await prepareComputerLocalWeb({ repositoryRoot, runDirectory });
  if (!copied.ok) throw new Error(copied.error.message);
  await own("web app copy", copied.value.close);

  const secret = randomBytes(32).toString("hex");
  const auth = createAuth(db, { secret, baseUrl: API, webOrigin: WEB, allowAnonymous: true });
  const signedUp = await auth.handler(
    new Request(`${API}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { origin: WEB, "content-type": "application/json" },
      body: JSON.stringify({ name: "Verify Reader", email: EMAIL, password: PASSWORD }),
    }),
  );
  if (!signedUp.ok) throw new Error(`Seed sign-up failed: ${signedUp.status}`);
  const [owner] = await db.select().from(users).where(eq(users.email, EMAIL));
  if (!owner) throw new Error("The seeded user is missing after sign-up.");

  const preview = Bun.serve({
    hostname: "127.0.0.1",
    port: ports.preview,
    fetch: () => new Response(PREVIEW_PAGE, { headers: { "content-type": "text/html" } }),
  });
  await own("preview server", async () => {
    await preview.stop(true);
  });

  // Every running project previews the same static page: the pane is what is being verified,
  // not the generated app. The bundle is scripted so a project can be put away and restored, which
  // is how the put-away screen and a restore are reached through the interface.
  const sandbox = fakeSandbox(() => PREVIEW).script(BUNDLE_COMMAND, bundled());

  const config = {
    ...loadgenConfig(2),
    NAP_WEB_ORIGIN: WEB,
    NAP_MODEL: MODEL,
    NAP_FREE_MODEL: MODEL,
    NAP_ALLOWED_MODELS: [MODEL],
    NAP_WORKER_CONCURRENCY: 2,
    NAP_DRAIN_TIMEOUT_SECONDS: 5,
    // Room to start several projects in one run beside the seeded one. The route reads these and
    // the capacity store below is built from the same numbers, so the two cannot disagree.
    NAP_MAX_SANDBOXES_PER_USER: 4,
    NAP_FREE_MAX_SANDBOXES_PER_USER: 4,
    NAP_MAX_SANDBOXES_TOTAL: 8,
  };
  // One process serves the sockets and writes every row, so its notices need go nowhere else —
  // as `bootNap` arranges it with no `LISTEN` connection.
  const sessionList = new PostgresSessionListChannel(db, new InProcessNotifyTransport(), {
    hearing: () => true,
  });
  const composed = composeNap({
    config,
    auth,
    logger: createLogger({ level: "warn" }),
    sessions: new PostgresSessionStore(db, { sessionList }),
    projects: new PostgresProjectStore(db, { sessionList }),
    titles: new PostgresProjectTitleStore(db, { sessionList }),
    sessionStarts: new PostgresSessionStartStore(db, { claims: null, sessionList }),
    sessionNavigation: new PostgresSessionNavigationStore(db, { sessionList }),
    projectSandboxes: new PostgresProjectSandboxStore(db, { sessionList }),
    capacity: new PostgresSandboxCapacity(db, {
      perUser: config.NAP_MAX_SANDBOXES_PER_USER,
      total: config.NAP_MAX_SANDBOXES_TOTAL,
    }),
    rateLimits: {
      rate: new PostgresTurnRateLimiter(db, { limit: 1_000, windowMs: 3_600_000, tier: "paid" }),
      freeRate: new PostgresTurnRateLimiter(db, {
        limit: 1_000,
        windowMs: 3_600_000,
        tier: "free",
      }),
    },
    queue: new PostgresTurnQueue(db, { claims: null, sessionList }),
    snapshots: new PostgresSnapshotStore(db),
    userKeys: new PostgresUserKeyStore(db),
    events: new PostgresEventStore(db),
    bus: new InProcessEventBus(),
    cancels: null,
    claims: null,
    sessionList,
    sandbox,
    objects: new InMemoryObjectStore(),
    provider: verifyNapProvider({ stepDelayMs: STEP_DELAY_MS }),
    encryptionKey: encryptionKeyFrom(randomBytes(32).toString("base64")),
    verifyKey: async () => ({
      ok: false,
      message: "Real API keys are disabled in the verify-nap fixture.",
    }),
    createProject: (options) => createProjectSession(db, options, { sessionList }),
    upgradeWebSocket,
  });
  await own("worker and timers", async () => {
    composed.github.stop();
    composed.reaper.stop();
    composed.janitor.stop();
    await composed.worker.stop();
  });

  // One finished session, so the list, the file tree and the preview have something in them
  // before the driver does anything.
  const seeded = await createProjectSession(db, { userId: owner.id, name: SEEDED_SESSION });
  const seedTurn = await composed.runtime.runTurn({
    sessionId: seeded.sessionId,
    turnId: crypto.randomUUID(),
    message: "Build a small notes app with a list of notes.",
    model: MODEL,
    signal: abort.signal,
  });
  if (!seedTurn.ok) throw new Error("The seed turn did not finish.");

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: ports.api,
    ...HTTP_SERVER_OPTIONS,
    fetch: composed.app.fetch,
    websocket,
  });
  await own("API server", async () => {
    await server.stop(true);
  });

  const webLog = await open(join(runDirectory, "web.log"), "a");
  await own("web log", () => webLog.close());
  const next = join(repositoryRoot, "apps/web/node_modules/next/dist/bin/next");
  const webEnv = {
    ...process.env,
    NEXT_PUBLIC_API_URL: API,
    NEXT_PUBLIC_API_WS_URL: `ws://127.0.0.1:${ports.api}`,
  };
  if (production) {
    const build = Bun.spawn(["node", next, "build", copied.value.directory, "--webpack"], {
      cwd: copied.value.directory,
      env: { ...webEnv, NODE_ENV: "production" },
      stdout: webLog.fd,
      stderr: webLog.fd,
    });
    if ((await build.exited) !== 0) throw new Error("next build failed; see web.log.");
  }
  const web = Bun.spawn(
    [
      "node",
      next,
      ...(production
        ? ["start", copied.value.directory]
        : ["dev", copied.value.directory, "--webpack"]),
      "--port",
      String(ports.web),
      "--hostname",
      "127.0.0.1",
    ],
    {
      cwd: copied.value.directory,
      env: production ? { ...webEnv, NODE_ENV: "production" } : webEnv,
      stdout: webLog.fd,
      stderr: webLog.fd,
    },
  );
  await own("Next server", () => kill(web));
  started.processes.push({ name: "Next server", pid: web.pid, marker: copied.value.directory });
  record();

  const profile = join(runDirectory, "chrome-profile");
  const browser = Bun.spawn(
    [
      chrome,
      "--headless=new",
      `--remote-debugging-port=${ports.cdp}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  started.processes.push({ name: "Chrome", pid: browser.pid, marker: profile });
  record();
  await own("Chrome", async () => {
    await kill(browser);
    await rm(profile, { recursive: true, force: true });
  });

  for (const child of [web, browser])
    void child.exited.then(() => {
      if (!ending) {
        console.error("A child process exited early; stopping. See web.log in the run directory.");
        void stop().finally(() => process.exit(1));
      }
    });

  await waitFor("The API", `${API}/health`, 30_000);
  await waitFor("Chrome's DevTools", `http://127.0.0.1:${ports.cdp}/json/version`, 30_000);
  // The first request compiles the route; sign-in is the page every drive starts from.
  await waitFor("The web app", `${WEB}/sign-in`, 180_000);

  const run = {
    pid: process.pid,
    runDirectory,
    evidence,
    web: WEB,
    api: API,
    preview: PREVIEW,
    cdp: `http://127.0.0.1:${ports.cdp}`,
    email: EMAIL,
    password: PASSWORD,
    model: MODEL,
    seeded: { name: SEEDED_SESSION, ...seeded },
    stepDelayMs: STEP_DELAY_MS,
    startedAt: new Date().toISOString(),
    stopsAt: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
  };
  await writeFile(join(runDirectory, "run.json"), JSON.stringify(run, null, 2));
  starting = false;
  setTimeout(() => {
    console.log(`verify-nap: --ttl-minutes=${ttlMinutes} has passed; stopping.`);
    process.kill(process.pid, "SIGTERM");
  }, ttlMinutes * 60_000);
  console.log(`verify-nap ready\n${JSON.stringify(run, null, 2)}`);
} catch (error) {
  const cancelled = abort.signal.aborted;
  console.error(String(error));
  try {
    await stop();
  } catch (cleanupError) {
    console.error(String(cleanupError));
  }
  process.exit(cancelled ? 0 : 1);
}

async function kill(child: Bun.Subprocess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const hard = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    await child.exited;
  } finally {
    clearTimeout(hard);
  }
}
