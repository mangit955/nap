/**
 * The table `route-coverage.test.ts` and `authorization.test.ts` share.
 *
 * Two tests, one list, on purpose: the coverage test proves the list names every registered
 * route, and the authorization test proves every guarded entry actually refuses a stranger. Split
 * the list in two and each half can be complete while the pair is useless — a route present in
 * the coverage list and absent from the behaviour list is a route nobody checks.
 *
 * Not imported by anything that runs in production. It lives beside the middleware rather than in
 * a test file because two test files need it, and a fixture copied into both is a fixture that
 * disagrees with itself by the third edit.
 */

import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryProjectSandboxStore } from "@nap/db/testing/in-memory-project-sandbox-store";
import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemoryUserKeyStore } from "@nap/db/testing/in-memory-user-key-store";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { ResumeOutcome, TurnOutcome } from "@nap/shared/ports/runtime";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { encryptionKeyFrom } from "../account/secret-box.ts";
import type { AppDeps } from "../app.ts";
import { TurnRegistry } from "../turns/registry.ts";

/** A model that costs nothing, which is what a caller with no key of their own may run. */
const FREE_MODEL = "poolside/laguna-s-2.1:free";

/** The signed-in user everything below belongs to. */
export const OWNER = FAKE_OWNER;
/** Somebody else entirely. Every guarded route must treat them as though nothing is there. */
export const STRANGER = "00000000-0000-4000-8000-0000000000ff";

export const PROJECT = "1f2e3d4c-5b6a-4798-8765-43210fedcba9";
export const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";

type RouteEntry = {
  method: string;
  /** As Hono records it — the pattern, with its parameters. */
  path: string;
  /** A concrete path to actually request, naming the owner's resources. */
  examplePath: string;
};

/** Reachable without signing in, each for a reason `requireUser` spells out. */
export const PUBLIC_ROUTES: RouteEntry[] = [
  { method: "GET", path: "/health", examplePath: "/health" },
  { method: "GET", path: "/livez", examplePath: "/livez" },
  { method: "GET", path: "/readyz", examplePath: "/readyz" },
  { method: "GET", path: "/auth/providers", examplePath: "/auth/providers" },
  { method: "ALL", path: "/api/auth/*", examplePath: "/api/auth/sign-in/email" },
];

export type GuardedRoute = RouteEntry & {
  /** Sent as JSON when present, so a route with a required body is not refused for the body. */
  body?: unknown;
};

/**
 * Everything else. Each is exercised three ways in `authorization.test.ts`: signed out, signed in
 * as somebody else, and signed in as the owner.
 */
export const GUARDED_ROUTES: GuardedRoute[] = [
  { method: "GET", path: "/ws", examplePath: `/ws?sessionId=${SESSION}` },
  { method: "GET", path: "/models", examplePath: "/models" },
  // Somebody else's API key is the single most sensitive thing this app stores, so these are
  // the three entries in this table it would be worst to be missing.
  { method: "GET", path: "/account/api-key", examplePath: "/account/api-key" },
  {
    method: "PUT",
    path: "/account/api-key",
    examplePath: "/account/api-key",
    body: { apiKey: "sk-or-v1-0123456789abcdef0123" },
  },
  { method: "DELETE", path: "/account/api-key", examplePath: "/account/api-key" },
  { method: "GET", path: "/projects", examplePath: "/projects" },
  { method: "POST", path: "/projects", examplePath: "/projects", body: { name: "New" } },
  { method: "GET", path: "/projects/:projectId", examplePath: `/projects/${PROJECT}` },
  {
    method: "GET",
    path: "/projects/:projectId/thumbnail",
    examplePath: `/projects/${PROJECT}/thumbnail`,
  },
  {
    method: "POST",
    path: "/projects/:projectId/open",
    examplePath: `/projects/${PROJECT}/open`,
  },
  {
    method: "POST",
    path: "/projects/:projectId/close",
    examplePath: `/projects/${PROJECT}/close`,
  },
  {
    method: "PATCH",
    path: "/projects/:projectId",
    examplePath: `/projects/${PROJECT}`,
    body: { name: "Renamed" },
  },
  { method: "DELETE", path: "/projects/:projectId", examplePath: `/projects/${PROJECT}` },
  {
    method: "GET",
    path: "/sessions/:sessionId/files",
    examplePath: `/sessions/${SESSION}/files`,
  },
  {
    method: "GET",
    path: "/sessions/:sessionId/file",
    examplePath: `/sessions/${SESSION}/file?path=src/App.tsx`,
  },
  {
    method: "POST",
    path: "/sessions/:sessionId/turns",
    examplePath: `/sessions/${SESSION}/turns`,
    body: { message: "hello" },
  },
  {
    method: "POST",
    path: "/sessions/:sessionId/turns/cancel",
    examplePath: `/sessions/${SESSION}/turns/cancel`,
  },
];

export type SeededSandbox = {
  sandbox: InMemorySandboxManager;
  sandboxId: string;
  objects: InMemoryObjectStore;
};

/**
 * A world the owner's requests can actually succeed in: a sandbox with one readable file, and a
 * bucket holding the project's thumbnail.
 *
 * Both exist so the owner's request 200s *on its merits* rather than 404ing because the fixture
 * is empty — which would make "the owner is not refused" pass for the wrong reason and, worse,
 * look identical to being refused.
 */
export async function seedSandbox(): Promise<SeededSandbox> {
  const sandbox = new InMemorySandboxManager();
  const created = await sandbox.create(PROJECT);
  if (!created.ok) throw new Error("could not create the fixture sandbox");

  await sandbox.writeFile(created.value.id, `${TEMPLATE_WORKDIR}/src/App.tsx`, "export default 1;");

  const objects = new InMemoryObjectStore();
  await objects.put(`projects/${PROJECT}/thumbnail.png`, new Uint8Array([137, 80, 78, 71]));

  return { sandbox, sandboxId: created.value.id, objects };
}

/**
 * Every dependency registered, so the router contains every route there is.
 *
 * The coverage test depends on this being *complete*: a dependency left out means the routes it
 * registers never appear, and the test happily reports full coverage of a smaller app.
 */
export function fullyWiredDeps(seeded?: SeededSandbox): Omit<AppDeps, "logger"> {
  const sandbox = seeded?.sandbox ?? new InMemorySandboxManager();
  const sessions = new InMemorySessionStore([
    { sessionId: SESSION, projectId: PROJECT, userId: OWNER, sandboxId: seeded?.sandboxId ?? null },
  ]);
  const projects = new InMemoryProjectStore([
    {
      projectId: PROJECT,
      name: "Todo app",
      status: "idle",
      sandboxId: null,
      updatedAt: "2026-08-10T11:00:00.000Z",
      sessionIds: [SESSION],
      userId: OWNER,
    },
  ]);

  return {
    stream: {
      store: new InMemoryEventStore(),
      bus: new InMemoryEventBus(),
      sessions,
      upgradeWebSocket: async () => new Response(null),
    },
    files: { sessions, sandbox },
    account: {
      keys: new InMemoryUserKeyStore(),
      encryptionKey: encryptionKeyFrom(Buffer.alloc(32).toString("base64")),
      verify: async () => ({ ok: true }),
    },
    models: {
      allowed: ["openai/gpt-5.6-luna", FREE_MODEL],
      fallback: "openai/gpt-5.6-luna",
      freeModel: FREE_MODEL,
    },
    turns: {
      // Never actually reached by an authorization test: a turn that got as far as running
      // would mean the route let somebody through, which is the thing being tested.
      runtime: {
        runTurn: async (): Promise<TurnOutcome> => ({ ok: true, turnId: "t", commitSha: null }),
        resumeSession: async (): Promise<ResumeOutcome> => ({
          ok: false,
          reason: "internal",
          message: "unreachable",
        }),
      },
      registry: new TurnRegistry(),
      freeModel: FREE_MODEL,
      defaultModel: "openai/gpt-5.6-luna",
      allowedModels: ["openai/gpt-5.6-luna"],
      sessions,
      projects,
    },
    projects: {
      projects,
      projectSandboxes: new InMemoryProjectSandboxStore([]),
      snapshots: new InMemorySnapshotStore(),
      objects: seeded?.objects ?? new InMemoryObjectStore(),
      sandbox,
      createProject: async (options) => {
        void options;
        return { projectId: PROJECT, sessionId: SESSION };
      },
      // Never actually reached, for the same reason the runtime above is not.
      runtime: {
        resumeSession: async (): Promise<ResumeOutcome> => ({
          ok: false,
          reason: "internal",
          message: "unreachable",
        }),
      },
      events: { events: new InMemoryEventStore(), bus: new InMemoryEventBus() },
      isBusy: () => false,
    },
    auth: {
      handler: async () => new Response(null),
      getUser: async () => null,
      socialProviders: [],
      demo: false,
    },
  };
}
