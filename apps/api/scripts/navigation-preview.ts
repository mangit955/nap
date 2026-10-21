/** Real web/API/database fixture. Only GitHub, the sandbox, model and blob store are synthetic.
 * Run with God's Hand run_check.py --timeout 900 -- bun apps/api/scripts/navigation-preview.ts.
 * Sign in as reader@navigation.test / Navigation-preview-42. Uses disposable localhost services.
 */
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@nap/db/client";
import { PostgresGitHubStore } from "@nap/db/github-store";
import { InProcessEventBus } from "@nap/db/in-process-event-bus";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
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
import { loopingLLMProvider } from "@nap/loadgen/looping-llm-provider";
import { NavigationSchema } from "@nap/shared/session-navigation";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { eq } from "drizzle-orm";
import { upgradeWebSocket, websocket } from "hono/bun";
import { encryptionKeyFrom } from "../src/account/secret-box.ts";
import { createAuth } from "../src/auth/auth.ts";
import { composeNap } from "../src/compose.ts";
import { GitHubApp, type GitHubFetch } from "../src/github/app.ts";
import { createLogger } from "../src/logger.ts";
import { fakeSandbox } from "./fake-turn.ts";
import { loadgenConfig } from "./loadgen-composition.ts";

const WEB = "http://localhost:3037";
const API = "http://localhost:3038";
const postgres = await startDockerPostgres();
const { db, close } = createDatabase(postgres.url);
const auth = createAuth(db, {
  secret: "navigation-preview-local-secret-32",
  baseUrl: API,
  webOrigin: WEB,
  allowAnonymous: true,
});
const signedUp = await auth.handler(
  new Request(`${API}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: WEB, "content-type": "application/json" },
    body: JSON.stringify({
      name: "Morgan",
      email: "reader@navigation.test",
      password: "Navigation-preview-42",
    }),
  }),
);
if (!signedUp.ok)
  throw new Error(`Preview signup failed: ${signedUp.status} ${await signedUp.text()}`);
const [owner] = await db.select().from(users).where(eq(users.email, "reader@navigation.test"));
if (!owner) throw new Error("Fixture owner missing");
const github = new PostgresGitHubStore(db);
for (const [installationId, accountLogin] of [
  [99, "northstar-labs"],
  [100, "meadow-studio"],
] as const) {
  await github.bindInstallation({
    installationId,
    userId: owner.id,
    githubUserId: 7,
    githubLogin: "fixture-reader",
    accountLogin,
    accountType: "Organization",
    status: "active",
  });
}
const repositories = Array.from({ length: 125 }, (_, i) => ({
  id: 1000 + i,
  full_name: `northstar-labs/${i === 0 ? "atlas-web" : i === 1 ? "harbor-api" : `garden-${String(i).padStart(3, "0")}`}`,
  default_branch: "main",
  private: true,
}));
const transport: GitHubFetch = async (url, init) => {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (path.startsWith("/app/installations/") && !path.endsWith("access_tokens")) {
    const id = Number(path.split("/").at(-1));
    return Response.json({
      id,
      app_id: 42,
      account: {
        id: id + 100,
        login: id === 99 ? "northstar-labs" : "meadow-studio",
        type: "Organization",
      },
      suspended_at: null,
    });
  }
  if (path.endsWith("/access_tokens"))
    return Response.json({
      token: path.includes("/99/") ? "local-northstar" : "local-meadow",
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
  if (path === "/installation/repositories") {
    const all = new Headers(init?.headers).get("authorization")?.includes("northstar")
      ? repositories
      : [
          {
            id: 2000,
            full_name: "meadow-studio/atlas-web",
            default_branch: "main",
            private: false,
          },
        ];
    const page = Number(parsed.searchParams.get("page") ?? 1);
    return Response.json({ repositories: all.slice((page - 1) * 100, page * 100) });
  }
  if (path.endsWith("/permission"))
    return Response.json({ permission: "write", user: { id: 7, login: "fixture-reader" } });
  if (path.includes("/git/ref/heads/")) return Response.json({ object: { sha: "0".repeat(40) } });
  if (path.startsWith("/repos/")) {
    const repo = repositories.find((r) => path === `/repos/${r.full_name}`);
    if (repo) return Response.json({ ...repo, archived: false, disabled: false });
    if (path === "/repos/meadow-studio/atlas-web")
      return Response.json({
        id: 2000,
        full_name: "meadow-studio/atlas-web",
        default_branch: "main",
        private: false,
      });
  }
  return Response.json({ message: "Unavailable in local fixture" }, { status: 404 });
};
const githubApp = new GitHubApp(
  {
    appId: 42,
    slug: "nap-navigation-fixture",
    clientId: "fixture-client",
    clientSecret: "fixture-secret",
    privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
    webhookSecret: "navigation-fixture-webhook-secret",
    apiUrl: API,
    webOrigin: WEB,
  },
  transport,
);
for (let i = 0; i < 115; i++) {
  const created =
    i < 4
      ? await github.importRepository({
          userId: owner.id,
          installationId: 99,
          name:
            [
              "Refine calendar navigation",
              "Add invite validation",
              "Improve account settings",
              "Review accessibility",
            ][i] ?? "Repository session",
          repository: {
            id: 1000,
            fullName: "northstar-labs/atlas-web",
            defaultBranch: "main",
            private: true,
          },
          baseBranch: "main",
          environment: { setupCommand: null, devCommand: null, previewPort: null },
          autoPublish: false,
        })
      : await createProjectSession(db, {
          userId: owner.id,
          name: `Explore workspace ${String(i).padStart(3, "0")}`,
        });
  if (!created) throw new Error("Fixture import failed");
  await db
    .update(projects)
    .set({
      navigation: NavigationSchema.parse({
        pinned: i < 2,
        position: i,
        doneAt: i === 2 ? new Date().toISOString() : null,
        archivedAt: i === 3 ? new Date().toISOString() : null,
        snoozedUntil: i === 4 ? new Date(Date.now() + 3600000).toISOString() : null,
      }),
      status: "ready",
    })
    .where(eq(projects.id, created.projectId));
}
const config = {
  ...loadgenConfig(2),
  NAP_WEB_ORIGIN: WEB,
  NAP_MODEL: "openai/gpt-5.6-luna",
  NAP_FREE_MODEL: "openai/gpt-5.6-luna",
  NAP_ALLOWED_MODELS: ["openai/gpt-5.6-luna", "deepseek/deepseek-chat-v3.1"],
  NAP_WORKER_CONCURRENCY: 1,
};
const composed = composeNap({
  config,
  auth,
  logger: createLogger({ level: "warn" }),
  sessions: new PostgresSessionStore(db),
  projects: new PostgresProjectStore(db),
  sessionStarts: new PostgresSessionStartStore(db),
  sessionNavigation: new PostgresSessionNavigationStore(db),
  github: {
    store: github,
    app: githubApp,
    broker: {
      fetch: async () => ({ ok: true, value: Buffer.from("local fixture bundle") }),
      push: async () => ({ ok: true, value: undefined }),
    },
  },
  projectSandboxes: new PostgresProjectSandboxStore(db),
  capacity: new PostgresSandboxCapacity(db, { perUser: 2, total: 4 }),
  rateLimits: {
    rate: new PostgresTurnRateLimiter(db, { limit: 100, windowMs: 3600000, tier: "paid" }),
    freeRate: new PostgresTurnRateLimiter(db, { limit: 100, windowMs: 3600000, tier: "free" }),
  },
  queue: new PostgresTurnQueue(db),
  snapshots: new PostgresSnapshotStore(db),
  userKeys: new PostgresUserKeyStore(db),
  events: new PostgresEventStore(db),
  bus: new InProcessEventBus(),
  sandbox: fakeSandbox()
    .script(/symbolic-ref -q HEAD/, { exitCode: 0, stdout: "refs/heads/main\n" })
    .script(/symbolic-ref --short HEAD/, { exitCode: 0, stdout: "main\n" }),
  objects: new InMemoryObjectStore(),
  provider: loopingLLMProvider([
    {
      text: "Navigation fixture completed. This response came through the real queue and event stream.",
    },
  ]),
  encryptionKey: encryptionKeyFrom(Buffer.alloc(32, 7).toString("base64")),
  verifyKey: async () => ({ ok: true }),
  createProject: (options) => createProjectSession(db, options),
  upgradeWebSocket,
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 3038,
  fetch: composed.app.fetch,
  websocket,
});
const web = Bun.spawn(["bun", "run", "dev", "--port", "3037"], {
  cwd: process.env.NAP_PREVIEW_WEB_DIR ?? fileURLToPath(new URL("../../web", import.meta.url)),
  env: { ...process.env, NEXT_PUBLIC_API_URL: API, NEXT_PUBLIC_API_WS_URL: "ws://localhost:3038" },
  stdout: "inherit",
  stderr: "inherit",
});
console.log(`Navigation fixture: ${WEB}/sign-in; reader@navigation.test / Navigation-preview-42`);
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
