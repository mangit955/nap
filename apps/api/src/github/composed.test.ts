import { generateKeyPairSync, randomUUID } from "node:crypto";
import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { REPOSITORY_SYSTEM_PROMPT, SYSTEM_PROMPT } from "@nap/context/system-prompt";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryGitHubStore } from "@nap/db/testing/in-memory-github-store";
import { InMemoryProjectSandboxStore } from "@nap/db/testing/in-memory-project-sandbox-store";
import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySandboxCapacity } from "@nap/db/testing/in-memory-sandbox-capacity";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { InMemoryTurnRateLimiter } from "@nap/db/testing/in-memory-turn-rate-limiter";
import { InMemoryUserKeyStore } from "@nap/db/testing/in-memory-user-key-store";
import { decodeRepositoryBundle } from "@nap/sandbox/git-bundle";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { foldJobs } from "@nap/shared/job-state";
import type { SessionRecord, SessionStore } from "@nap/shared/ports/session-store";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import type { WSEvents } from "hono/ws";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { encryptionKeyFrom } from "../account/secret-box.ts";
import { composeNap, type NapDeps } from "../compose.ts";
import { createLogger } from "../logger.ts";
import { GitHubApp, type GitHubFetch } from "./app.ts";
import type { GitBroker } from "./git-broker.ts";

const ORIGIN = "http://localhost:3000";
const TOKEN = "server-only-installation-token";
const MODEL = "openai/gpt-5.6-luna";
const config: NapDeps["config"] = {
  NAP_WEB_ORIGIN: ORIGIN,
  NAP_MODEL: MODEL,
  NAP_FREE_MODEL: MODEL,
  NAP_ALLOWED_MODELS: [MODEL],
  NAP_MAX_STEPS: 4,
  NAP_CONTEXT_BUDGET_TOKENS: 10_000,
  NAP_MAX_SANDBOXES_PER_USER: 3,
  NAP_FREE_MAX_SANDBOXES_PER_USER: 3,
  NAP_MAX_SANDBOXES_TOTAL: 10,
  NAP_SANDBOX_TTL_MINUTES: 30,
  NAP_REAP_IDLE_MINUTES: 10,
  NAP_REAP_INTERVAL_SECONDS: 60,
  NAP_JANITOR_INTERVAL_SECONDS: 60,
  NAP_WORKER_CONCURRENCY: 1,
  NAP_DRAIN_TIMEOUT_SECONDS: 1,
  NAP_CAPTURE_CONCURRENCY: 1,
};
const ids = z.object({ projectId: z.uuid(), sessionId: z.uuid() });
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { origin: ORIGIN, "content-type": "application/json" },
  body: JSON.stringify(body),
});

it("imports through the queue, publishes a verified dedicated branch, and retries without model auth while templates still run", async () => {
  const queue = new InMemoryTurnQueue();
  const projects = new InMemoryProjectStore();
  const records = new Map<string, SessionRecord>();
  const putProject = (record: SessionRecord, name: string) => {
    records.set(record.sessionId, record);
    projects.put({
      ...record,
      name,
      status: record.sandboxId === null ? "creating" : "ready",
      sessionIds: [record.sessionId],
      updatedAt: new Date().toISOString(),
    });
  };
  const sessions: SessionStore = {
    get: async (sessionId) => structuredClone(records.get(sessionId) ?? null),
    setSandboxId: async (sessionId, sandboxId) => {
      const record = records.get(sessionId);
      if (record === undefined) throw new Error("Session missing from composed fixture");
      const project = await projects.get(record.projectId, record.userId);
      putProject({ ...record, sandboxId }, project?.name ?? "Imported app");
    },
  };
  const store = new InMemoryGitHubStore({
    queue,
    onImport: (binding, name) => putProject({ ...binding, sandboxId: null }, name),
  });
  await store.bindInstallation({
    installationId: 99,
    userId: FAKE_OWNER,
    githubUserId: 7,
    githubLogin: "owner",
    accountLogin: "org",
    accountType: "Organization",
    status: "active",
  });
  let sha = "a".repeat(40);
  let branch = "main";
  const sandbox = new InMemorySandboxManager({
    defaultExec: () => ({ exitCode: 0, stdout: "" }),
    serves: [TEMPLATE_DEV_PORT],
    seed: {
      [`${PROJECT_ROOT_PATH}/package.json`]: JSON.stringify({ scripts: { test: "vitest run" } }),
    },
  })
    .script(/rev-parse HEAD/, () => ({ exitCode: 0, stdout: `${sha}\n` }))
    .script(/symbolic-ref -q HEAD/, () => ({ exitCode: 0, stdout: `refs/heads/${branch}\n` }))
    .script(/symbolic-ref --short HEAD/, () => ({ exitCode: 0, stdout: `${branch}\n` }))
    .script(/checkout -b '([^']+)'/, (command) => {
      const match = /checkout -b '([^']+)'/.exec(command);
      if (match?.[1] === undefined) throw new Error("Missing branch");
      branch = match[1];
      return { exitCode: 0 };
    })
    .script(/git diff --cached --quiet/, { exitCode: 1 })
    .script(/user.name=Nap commit/, () => {
      sha = sha === "a".repeat(40) ? "b".repeat(40) : "c".repeat(40);
      return { exitCode: 0 };
    })
    .script(/git bundle create/, {
      exitCode: 0,
      stdout: Buffer.from("repository bundle").toString("base64"),
    });
  const provider = new ScriptedLLMProvider([
    [{ text: "Updated repository." }],
    [{ text: "Built template." }],
  ]);
  const events = new InMemoryEventStore();
  const snapshots = new InMemorySnapshotStore();
  const userKeys = new InMemoryUserKeyStore();
  const keyReads = vi.spyOn(userKeys, "get");
  const broker = {
    fetch: vi.fn<GitBroker["fetch"]>(async () => ({
      ok: true,
      value: Buffer.from("repository bundle"),
    })),
    push: vi.fn<GitBroker["push"]>(async () => ({ ok: true, value: undefined })),
  } satisfies GitBroker;
  const pulls: unknown[] = [];
  const pullBodies: unknown[] = [];
  const transport: GitHubFetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === "/app/installations/99")
      return Response.json({
        id: 99,
        app_id: 42,
        account: { id: 88, login: "org", type: "Organization" },
        suspended_at: null,
      });
    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: TOKEN,
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    const repository = { id: 123, full_name: "org/app", default_branch: "main", private: true };
    if (path === "/installation/repositories") return Response.json({ repositories: [repository] });
    if (path === "/repos/org/app")
      return Response.json({ ...repository, archived: false, disabled: false });
    if (path.endsWith("/permission"))
      return Response.json({ permission: "write", user: { id: 7, login: "owner" } });
    if (path === "/repos/org/app/git/ref/heads/main") return Response.json({ object: { sha } });
    if (path === "/repos/org/app/pulls" && init?.method === "POST") {
      const body = z
        .object({ head: z.string(), base: z.string(), draft: z.boolean() })
        .parse(JSON.parse(String(init.body)));
      pullBodies.push(body);
      const pull = {
        number: 10,
        html_url: "https://github.com/org/app/pull/10",
        state: "open",
        merged_at: null,
        head: { ref: body.head, sha, repo: { id: 123 } },
        base: { ref: body.base, repo: { id: 123 } },
      };
      pulls.push(pull);
      return Response.json(pull, { status: 201 });
    }
    if (path === "/repos/org/app/pulls") return Response.json(pulls);
    throw new Error(`Unexpected GitHub request: ${init?.method ?? "GET"} ${path}`);
  };
  const githubApp = new GitHubApp(
    {
      appId: 42,
      slug: "nap-test",
      clientId: "client",
      clientSecret: "server-client-secret",
      privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 })
        .privateKey.export({ type: "pkcs8", format: "pem" })
        .toString(),
      webhookSecret: "server-webhook-secret",
      apiUrl: "https://nap.example",
      webOrigin: ORIGIN,
    },
    transport,
  );
  const composed = composeNap({
    role: "worker",
    config,
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    sessions,
    projects,
    queue,
    snapshots,
    events,
    userKeys,
    sandbox,
    provider,
    github: { store, app: githubApp, broker },
    projectSandboxes: new InMemoryProjectSandboxStore(),
    capacity: new InMemorySandboxCapacity(),
    rateLimits: {
      rate: new InMemoryTurnRateLimiter({ limit: 15, windowMs: 3_600_000 }),
      freeRate: new InMemoryTurnRateLimiter({ limit: 15, windowMs: 3_600_000 }),
    },
    bus: new InMemoryEventBus(),
    objects: new InMemoryObjectStore(),
    encryptionKey: encryptionKeyFrom(Buffer.alloc(32, 7).toString("base64")),
    verifyKey: async () => ({ ok: true }),
    createProject: async ({ userId, name }) => {
      const created = { projectId: randomUUID(), sessionId: randomUUID() };
      putProject({ ...created, userId, sandboxId: null }, name ?? "Untitled app");
      return created;
    },
    authenticate: async () => ({ userId: FAKE_OWNER, isAnonymous: false }),
    upgradeWebSocket: async (_c: unknown, _events: WSEvents) => new Response(null),
  });
  try {
    const imported = await composed.app.request(
      "/github/import",
      post({
        installationId: 99,
        repositoryId: 123,
        name: "Imported app",
        baseBranch: "main",
        environment: {
          setupCommand: "bun install --frozen-lockfile",
          devCommand: null,
          previewPort: null,
        },
        autoPublish: true,
      }),
    );
    expect(imported.status).toBe(201);
    const repository = ids.parse(await imported.json());
    await vi.waitFor(() => expect(queue.stateOf(store.enqueued[0]?.id ?? "")).toBe("done"));
    expect(provider.requests).toHaveLength(0);
    expect(broker.fetch).toHaveBeenCalledOnce();
    expect(snapshots.all()).toHaveLength(1);
    const session = await sessions.get(repository.sessionId);
    if (session?.sandboxId === null || session === null)
      throw new Error("Import did not acquire a sandbox");
    expect(await events.readFrom(repository.sessionId, 0)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "system.notice",
          payload: { level: "info", text: "Repository workspace ready." },
        }),
      ]),
    );
    expect(
      (
        await composed.app.request(
          `/sessions/${repository.sessionId}/turns`,
          post({ message: "Fix the repository." }),
        )
      ).status,
    ).toBe(202);
    await vi.waitFor(async () => {
      expect((await store.jobs(repository.projectId, FAKE_OWNER))[0]?.publishState).toBe(
        "published",
      );
      expect(await queue.isBusy([repository.sessionId])).toBe(false);
    });
    const job = (await store.jobs(repository.projectId, FAKE_OWNER))[0];
    if (job === undefined) throw new Error("Repository job missing");
    expect(job).toMatchObject({
      baseBranch: "main",
      headBranch: `nap/${job.jobId}`,
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      pushedSha: "b".repeat(40),
      pullRequestNumber: 10,
    });
    expect(provider.requests[0]?.systemPrompt).toContain(REPOSITORY_SYSTEM_PROMPT);
    expect(pullBodies).toEqual([{ head: job.headBranch, base: "main", draft: true }]);
    expect(broker.push).toHaveBeenCalledOnce();
    const pushed = broker.push.mock.calls[0]?.[0];
    if (pushed === undefined) throw new Error("No pushed bundle");
    expect(decodeRepositoryBundle(pushed.bytes)).toMatchObject({
      ok: true,
      value: { head: `refs/heads/${job.headBranch}` },
    });
    expect(foldJobs(await events.readFrom(repository.sessionId, 0)).jobs[0]?.phase).toBe(
      "verified",
    );
    expect(
      sandbox.commands(session.sandboxId).some((command) => command.includes("bun run test")),
    ).toBe(true);

    const retry = await composed.app.request(
      `/projects/${repository.projectId}/github/publish`,
      post({ jobId: job.jobId }),
    );
    expect(retry.status).toBe(202);
    const retryId = z.object({ requestId: z.uuid() }).parse(await retry.json()).requestId;
    await vi.waitFor(() => expect(queue.stateOf(retryId)).toBe("done"));
    keyReads.mockClear();
    const publishId = randomUUID();
    await queue.enqueue({
      id: publishId,
      userId: FAKE_OWNER,
      sessionId: repository.sessionId,
      kind: "publish",
      message: job.jobId,
      target: { kind: "api", model: MODEL, billsToUser: true },
    });
    await vi.waitFor(() => expect(queue.stateOf(publishId)).toBe("done"));
    expect(keyReads).not.toHaveBeenCalled();
    expect(provider.requests).toHaveLength(1);
    expect(pullBodies).toHaveLength(1);
    expect((await store.job(job.jobId))?.pullRequestNumber).toBe(10);
    expect(
      JSON.stringify([
        provider.requests,
        await events.readFrom(repository.sessionId, 0),
        sandbox.commands(session.sandboxId),
      ]),
    ).not.toContain(TOKEN);

    const created = await composed.app.request("/projects", post({ name: "Template app" }));
    expect(created.status).toBe(201);
    const template = ids.parse(await created.json());
    expect(
      (
        await composed.app.request(
          `/sessions/${template.sessionId}/turns`,
          post({ message: "Build a template app." }),
        )
      ).status,
    ).toBe(202);
    await vi.waitFor(async () =>
      expect(foldJobs(await events.readFrom(template.sessionId, 0)).jobs[0]?.phase).toBe(
        "verified",
      ),
    );
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.systemPrompt).toContain(SYSTEM_PROMPT);
    expect(broker.fetch).toHaveBeenCalledOnce();
    expect(pullBodies).toHaveLength(1);
    expect(await store.jobs(template.projectId, FAKE_OWNER)).toEqual([]);
  } finally {
    await composed.worker.stop();
    await composed.reaper.stop();
    await composed.janitor.stop();
    await composed.github.stop();
  }
});
