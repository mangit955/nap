import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryGitHubStore } from "@nap/db/testing/in-memory-github-store";
import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { SignInRequiredSchema } from "@nap/shared/api-error";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createApp } from "../app.ts";
import { createLogger } from "../logger.ts";
import { GitHubApp } from "./app.ts";
import { GitHubIntegration } from "./integration.ts";
import { GitHubEventProcessor } from "./webhook.ts";

const OTHER = "00000000-0000-4000-8000-000000000002";
const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const config = {
  appId: 42,
  slug: "nap-test",
  clientId: "client",
  clientSecret: "do-not-persist-client-secret",
  privateKey: key,
  webhookSecret: "test-webhook-secret-long-enough",
  apiUrl: "https://api.example",
  webOrigin: "https://web.example",
};
const installation = {
  id: 99,
  app_id: 42,
  account: { id: 7, login: "owner", type: "User" },
  suspended_at: null,
};
const repository = { id: 123, full_name: "owner/repo", default_branch: "main", private: true };

function fixture() {
  const queue = new InMemoryTurnQueue();
  const projects = new InMemoryProjectStore();
  const store = new InMemoryGitHubStore({
    queue,
    onImport: (repo, name) =>
      projects.put({
        projectId: repo.projectId,
        userId: repo.userId,
        name,
        status: "creating",
        sandboxId: null,
        updatedAt: new Date().toISOString(),
        sessionIds: [repo.sessionId],
      }),
  });
  const events = new InMemoryEventStore();
  const bus = new InMemoryEventBus();
  let userId = FAKE_OWNER;
  let anonymous = false;
  let authorized = true;
  let permission = "write";
  const feedbackState: {
    headSha: string;
    headRef: string;
    state: "open" | "closed";
    comments: {
      id: number;
      body: string;
      user: { id: number; login: string };
      updated_at: string;
    }[];
    checks: { name: string; status: string; conclusion: string | null }[];
  } = { headSha: "a".repeat(40), headRef: "nap/linked", state: "open", comments: [], checks: [] };
  const requests: string[] = [];
  const selection: Record<string, unknown>[] = [repository];
  const github = new GitHubApp(config, async (url, options) => {
    const path = new URL(url).pathname;
    requests.push(path);
    if (path === "/login/oauth/access_token")
      return Response.json({ access_token: "do-not-persist-user-token" });
    if (path === "/user") return Response.json({ id: 7, login: "owner" });
    if (path === "/user/installations")
      return Response.json({ installations: authorized ? [installation] : [] });
    if (path === "/applications/client/token") return new Response(null, { status: 204 });
    if (path === "/app/installations/99") return Response.json(installation);
    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: "do-not-persist-installation-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    if (path === "/installation/repositories") return Response.json({ repositories: selection });
    if (path.endsWith("/permission"))
      return Response.json({ permission, user: { id: 7, login: "owner" } });
    if (path === "/repos/owner/repo") return Response.json(repository);
    if (path === "/repos/owner/repo/git/ref/heads/main")
      return Response.json({ object: { sha: "a".repeat(40) } });
    if (path === "/repos/owner/repo/pulls/10")
      return Response.json({
        number: 10,
        title: "Repository changes",
        body: "Description",
        draft: false,
        user: { id: 7, login: "owner" },
        html_url: "https://github.com/owner/repo/pull/10",
        state: feedbackState.state,
        merged_at: null,
        head: { sha: feedbackState.headSha, ref: feedbackState.headRef, repo: { id: 123 } },
        base: { ref: "main", sha: "b".repeat(40), repo: { id: 123 } },
      });
    if (path.endsWith("/check-runs")) return Response.json({ check_runs: feedbackState.checks });
    if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
    if (path.endsWith("/files")) return Response.json([]);
    if (path.endsWith("/reviews")) return Response.json([]);
    if (path === "/repos/owner/repo/issues/10/comments")
      return Response.json(feedbackState.comments);
    if (path === "/repos/owner/repo/pulls/10/comments") return Response.json([]);
    throw new Error(`Unexpected transport ${options?.method ?? "GET"} ${path}`);
  });
  const integration = new GitHubIntegration({
    store,
    app: github,
    broker: {
      fetch: async () => ({ ok: true, value: new Uint8Array() }),
      push: async () => ({ ok: true, value: undefined }),
    },
    sandbox: new InMemorySandboxManager(),
    sessions: new InMemorySessionStore(),
    objects: new InMemoryObjectStore(),
    snapshots: new InMemorySnapshotStore(),
    events,
    bus,
  });
  const app = createApp({
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    authenticate: async () => ({ userId, isAnonymous: anonymous }),
    stream: { store: events, bus, upgradeWebSocket: async () => new Response(null) },
    github: {
      store,
      app: github,
      integration,
      projects,
      queue,
      webOrigin: config.webOrigin,
      admission: { allowedModels: ["free"], freeModel: "free", defaultModel: "free" },
    },
  });
  const request = (path: string, body: unknown = {}, method = "POST", origin = config.webOrigin) =>
    app.request(path, {
      method,
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const bind = () =>
    store.bindInstallation({
      installationId: 99,
      userId: FAKE_OWNER,
      githubUserId: 7,
      githubLogin: "owner",
      accountLogin: "owner",
      accountType: "User",
      status: "active",
    });
  return {
    app,
    store,
    events,
    queue,
    projects,
    sandbox: integration.deps.sandbox,
    integration,
    feedbackState,
    requests,
    request,
    bind,
    setUser: (id: string) => {
      userId = id;
    },
    setAnonymous: () => {
      anonymous = true;
    },
    denyAuthorization: () => {
      authorized = false;
    },
    readOnly: () => {
      permission = "read";
    },
    /** An "All repositories" installation: `count` more repositories beside the one imported. */
    selectMany: (count: number) => {
      for (let index = 0; index < count; index += 1)
        selection.push({ ...repository, id: 1000 + index, full_name: `owner/other-${index}` });
    },
  };
}

async function connect(f: ReturnType<typeof fixture>) {
  const initiated = await f.request("/github/connect");
  expect(initiated.status).toBe(200);
  const { url } = z.object({ url: z.string() }).parse(await initiated.json());
  const installState = new URL(url).searchParams.get("state");
  const setup = await f.app.request(`/github/setup?installation_id=99&state=${installState}`);
  expect(setup.status).toBe(302);
  const authState = new URL(setup.headers.get("location")!).searchParams.get("state");
  return `/github/callback?code=one-use-code&state=${authState}`;
}

describe("GitHub connection routes", () => {
  it("requires signed state, GitHub authority, owner binding, and single-use callbacks", async () => {
    const f = fixture();
    const callback = await connect(f);
    f.setUser(OTHER);
    expect((await f.app.request(callback)).headers.get("location")).toContain("github=error");
    expect(f.requests).not.toContain("/login/oauth/access_token");
    f.setUser(FAKE_OWNER);
    expect((await f.app.request(callback)).headers.get("location")).toBe(
      `${config.webOrigin}/settings/connections/github?github=connected`,
    );
    expect((await f.store.installation(FAKE_OWNER, 99))?.githubUserId).toBe(7);
    expect((await f.app.request(callback)).headers.get("location")).toContain("github=error");
    const connections = await (await f.app.request("/github/connections")).text();
    expect(connections).not.toContain("do-not-persist");
    f.setUser(OTHER);
    expect(await (await f.app.request("/github/connections")).json()).toMatchObject({
      installations: [],
    });
    expect((await f.request("/github/connect", { installationId: 99 })).status).toBe(404);
  });
  it("does not bind a supplied installation ID when GitHub denies the relationship", async () => {
    const f = fixture();
    const callback = await connect(f);
    f.denyAuthorization();
    expect((await f.app.request(callback)).headers.get("location")).toContain("github=error");
    expect(await f.store.listInstallations(FAKE_OWNER)).toEqual([]);
  });
  it("refuses anonymous users and cross-site state changes", async () => {
    const f = fixture();
    expect(
      (await f.request("/github/connect", {}, "POST", "https://attacker.example")).status,
    ).toBe(403);
    f.setAnonymous();
    expect((await f.request("/github/connect")).status).toBe(403);
  });
  it("tells a guest the refusal is about signing in, in a code the web can act on", async () => {
    // The project's GitHub dialog swaps its whole body for a sign-in prompt on this code, so it
    // has to be the guest refusal and nothing else — a cross-site 403 must not carry it.
    const f = fixture();
    const crossSite = await f.request("/github/connect", {}, "POST", "https://attacker.example");
    expect(await crossSite.json()).not.toHaveProperty("code");
    f.setAnonymous();
    for (const path of ["/github/connections", `/projects/${crypto.randomUUID()}/github`]) {
      const response = await f.app.request(path);
      expect(response.status).toBe(403);
      expect(SignInRequiredSchema.safeParse(await response.json()).success).toBe(true);
    }
  });
  it("returns a repository-selection change to Connections without binding or granting anything", async () => {
    // GitHub's redirect after Manage access carries `setup_action=update` and none of Nap's state.
    const f = fixture();
    await f.bind();
    const update = "/github/setup?installation_id=99&setup_action=update";
    const mints = () => f.requests.filter((path) => path.endsWith("/access_tokens")).length;
    const github = f.integration.deps.app;
    if (github === null) throw new Error("Fixture app missing");
    await github.token(99, null, { metadata: "read" });
    const response = await f.app.request(update);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      `${config.webOrigin}/settings/connections/github`,
    );
    // The selection changed, so a token minted before it is not reused.
    await github.token(99, null, { metadata: "read" });
    expect(mints()).toBe(2);
    // Somebody else's installation: the same page, nothing bound, nothing of the owner's touched.
    f.setUser(OTHER);
    expect((await f.app.request(update)).headers.get("location")).toBe(
      `${config.webOrigin}/settings/connections/github`,
    );
    await github.token(99, null, { metadata: "read" });
    expect(mints()).toBe(2);
    expect(await f.store.listInstallations(OTHER)).toEqual([]);
    expect((await f.store.installation(FAKE_OWNER, 99))?.status).toBe("active");
    expect(f.requests).not.toContain("/login/oauth/access_token");
    // A stateless first install is still refused: only an update may skip Nap's state.
    expect(
      (await f.app.request("/github/setup?installation_id=99&setup_action=install")).headers.get(
        "location",
      ),
    ).toContain("github=error");
  });
  it("cannot transfer a disconnected installation to another nap owner", async () => {
    const f = fixture();
    await f.bind();
    expect((await f.request("/github/installations/99", {}, "DELETE")).status).toBe(200);
    f.setUser(OTHER);
    const callback = await connect(f);
    expect((await f.app.request(callback)).headers.get("location")).toContain("github=error");
    expect((await f.store.installation(FAKE_OWNER, 99))?.status).toBe("disconnected");
  });
});

async function feedbackFixture(kind: "comment" | "checks" = "comment") {
  const f = fixture();
  await f.bind();
  const binding = await f.store.importRepository({
    userId: FAKE_OWNER,
    installationId: 99,
    repository: { id: 123, fullName: "owner/repo", defaultBranch: "main", private: true },
    name: "Review app",
    baseBranch: "main",
    environment: { setupCommand: null, devCommand: null, previewPort: null },
    autoPublish: true,
  });
  if (binding === null) throw new Error("Fixture import failed");
  const job = await f.store.createJob({
    jobId: randomUUID(),
    projectId: binding.projectId,
    sessionId: binding.sessionId,
    baseBranch: "main",
    headBranch: f.feedbackState.headRef,
    baseSha: "b".repeat(40),
    headSha: f.feedbackState.headSha,
    pushedSha: f.feedbackState.headSha,
    pullRequestNumber: 10,
    pullRequestUrl: "https://github.com/owner/repo/pull/10",
    pullRequestState: "open",
    publishState: "published",
    checkState: "unknown",
    reviewState: "unknown",
    error: null,
    updatedAt: new Date().toISOString(),
  });
  if (kind === "comment")
    f.feedbackState.comments = [
      {
        id: 500,
        body: "/nap Fix the failing test",
        user: { id: 7, login: "owner" },
        updated_at: "2026-10-19T12:00:00Z",
      },
    ];
  else f.feedbackState.checks = [{ name: "tests", status: "completed", conclusion: "failure" }];
  expect(
    await new GitHubEventProcessor(f.integration).refreshPullRequest(binding, job),
  ).toMatchObject({
    ok: true,
  });
  const feedback = (await f.store.feedbackForProject(binding.projectId, FAKE_OWNER)).find(
    (entry) => entry.kind === kind,
  );
  if (feedback === undefined) throw new Error("Expected pending feedback");
  return {
    ...f,
    binding,
    job,
    feedback,
    path: `/projects/${binding.projectId}/github/feedback/${encodeURIComponent(feedback.id)}`,
  };
}

describe("GitHub feedback approval routes", () => {
  it("queues one owner-approved turn and returns its original identity on replay", async () => {
    const f = await feedbackFixture();
    const response = await f.request(f.path);
    expect(response.status).toBe(202);
    const body = z.object({ requestId: z.uuid() }).parse(await response.json());
    expect(await f.queue.claim("worker")).toMatchObject({
      id: body.requestId,
      kind: "turn",
      sessionId: f.binding.sessionId,
      userId: FAKE_OWNER,
      model: "free",
      billsToUser: false,
      message: expect.stringContaining("Fix the failing test"),
    });
    expect(
      (await f.store.feedback(f.binding.projectId, FAKE_OWNER, f.feedback.id))?.requestId,
    ).toBe(body.requestId);
    await f.queue.settle(body.requestId, "worker", "done");
    const repeated = await f.request(f.path);
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual(body);
    expect(await f.queue.claim("worker")).toBeNull();
  });

  it.each(["deleted", "closed", "head moved"] as const)(
    "refuses stale approval when the comment is %s",
    async (change) => {
      const f = await feedbackFixture();
      if (change === "deleted") f.feedbackState.comments = [];
      if (change === "closed") f.feedbackState.state = "closed";
      if (change === "head moved") f.feedbackState.headSha = "c".repeat(40);
      expect((await f.request(f.path)).status).toBe(409);
      expect(await f.queue.claim("worker")).toBeNull();
      expect(await f.store.feedback(f.binding.projectId, FAKE_OWNER, f.feedback.id)).toBeNull();
    },
  );

  it("refuses recovered checks, another owner and lost write permission before queue admission", async () => {
    const f = await feedbackFixture("checks");
    f.setUser(OTHER);
    expect((await f.request(f.path)).status).toBe(404);
    f.setUser(FAKE_OWNER);
    f.feedbackState.checks = [{ name: "tests", status: "completed", conclusion: "success" }];
    expect((await f.request(f.path)).status).toBe(409);
    const denied = await feedbackFixture();
    denied.readOnly();
    expect((await denied.request(denied.path)).status).toBe(403);
    expect(await f.queue.claim("worker")).toBeNull();
  });
});

describe("repository import and access", () => {
  const input = {
    installationId: 99,
    repositoryId: 123,
    baseBranch: "main",
    name: "Imported repo",
    environment: { setupCommand: "bun install", devCommand: null, previewPort: null },
    autoPublish: true,
  };
  it("filters read-only repositories and imports only an authorized selected repository", async () => {
    const f = fixture();
    await f.bind();
    expect((await f.request("/github/import", { ...input, repositoryId: 999 })).status).toBe(403);
    const imported = await f.request("/github/import", input);
    expect(imported.status).toBe(201);
    const ids = z
      .object({ projectId: z.string(), sessionId: z.string() })
      .parse(await imported.json());
    const record = await f.store.repository(ids.projectId, FAKE_OWNER);
    expect(record).toMatchObject({
      sessionId: ids.sessionId,
      repository: { id: 123 },
      environment: input.environment,
    });
    const own = await f.app.request(`/projects/${ids.projectId}/github`);
    expect(own.status).toBe(200);
    f.setUser(OTHER);
    expect((await f.app.request(`/projects/${ids.projectId}/github`)).status).toBe(404);
    expect((await f.app.request("/github/installations/99/repositories")).status).toBe(403);
    f.setUser(FAKE_OWNER);
    f.readOnly();
    expect(await (await f.app.request("/github/installations/99/repositories")).json()).toEqual({
      repositories: [],
    });
  });
  it("checks permission on the imported repository alone, however many the installation holds", async () => {
    const f = fixture();
    await f.bind();
    f.selectMany(60);
    expect((await f.request("/github/import", input)).status).toBe(201);
    const permissions = f.requests.filter((path) => path.endsWith("/permission"));
    expect(permissions).toEqual(["/repos/owner/repo/collaborators/owner/permission"]);
    expect(f.requests.length).toBeLessThan(15);
    // The checks import relied on still hold for the one repository: write permission is required.
    const readOnly = fixture();
    await readOnly.bind();
    readOnly.readOnly();
    expect((await readOnly.request("/github/import", input)).status).toBe(403);
  });
  it("refuses removed repository access rather than using a cached association", async () => {
    const f = fixture();
    await f.bind();
    await f.store.setInstallationStatus(99, "removed");
    expect((await f.request("/github/import", input)).status).toBe(403);
  });
  it("lets only the owner save environment settings and reports the running preview separately", async () => {
    const f = fixture();
    await f.bind();
    const response = await f.request("/github/import", input);
    const ids = z
      .object({ projectId: z.string(), sessionId: z.string() })
      .parse(await response.json());
    const project = await f.projects.get(ids.projectId, FAKE_OWNER);
    const sandbox = await f.sandbox.create(ids.projectId);
    if (project === null || !sandbox.ok) throw new Error("Fixture workspace missing");
    f.projects.put({ ...project, sandboxId: sandbox.value.id, status: "ready" });
    await f.sandbox.writeFile(
      sandbox.value.id,
      "/tmp/nap-repository-preview.json",
      JSON.stringify({ previewPort: null }),
    );
    const environment = {
      setupCommand: "npm ci",
      devCommand: "npm run dev -- --host 0.0.0.0",
      previewPort: 5173,
    };
    const path = `/projects/${ids.projectId}/github/environment`;
    f.setUser(OTHER);
    expect((await f.request(path, environment, "PATCH")).status).toBe(404);
    f.setUser(FAKE_OWNER);
    expect((await f.request(path, { ...environment, previewPort: null }, "PATCH")).status).toBe(
      400,
    );
    expect((await f.request(path, environment, "PATCH")).status).toBe(200);
    expect(await (await f.app.request(`/projects/${ids.projectId}/github`)).json()).toMatchObject({
      repository: { environment },
      runningPreviewPort: null,
    });
    expect((await f.projects.get(ids.projectId, FAKE_OWNER))?.sandboxId).toBe(sandbox.value.id);
  });
});

it("authenticates raw webhook bytes and durably deduplicates the delivery without requiring sign-in", async () => {
  const f = fixture();
  const raw = JSON.stringify({ installation: { id: 99 }, action: "deleted" });
  const headers = {
    "x-github-delivery": "delivery-123",
    "x-github-event": "installation",
    "x-hub-signature-256": `sha256=${createHmac("sha256", config.webhookSecret).update(raw).digest("hex")}`,
  };
  const send = (body: string) =>
    f.app.request("/github/webhook", { method: "POST", headers, body });
  expect((await send(raw)).status).toBe(202);
  expect((await send(raw)).status).toBe(202);
  expect((await send(`${raw} `)).status).toBe(401);
  expect(await f.store.claimDelivery()).toMatchObject({ id: "delivery-123", attempts: 1 });
  expect(await f.store.claimDelivery()).toBeNull();
});

it.each(["success", "cancel"])(
  "returns the owner to the saved draft after GitHub %s",
  async (outcome) => {
    const f = fixture();
    const draftId = randomUUID();
    const initiated = await f.request("/github/connect", { draftId });
    const { url } = z.object({ url: z.string() }).parse(await initiated.json());
    const state = new URL(url).searchParams.get("state");
    const setup = await f.app.request(`/github/setup?installation_id=99&state=${state}`);
    const authState = new URL(setup.headers.get("location")!).searchParams.get("state");
    const callback = await f.app.request(
      `/github/callback?state=${authState}&${outcome === "success" ? "code=accepted" : "error=access_denied"}`,
    );
    expect(callback.headers.get("location")).toBe(
      `${config.webOrigin}/dashboard?draft=${draftId}&repositories=1&github=${outcome === "success" ? "connected" : "error"}`,
    );
  },
);

describe("linked pull request inspection authorization", () => {
  it("reads an owned linked PR and refuses a stranger before contacting GitHub", async () => {
    const f = await feedbackFixture();
    const path = `/projects/${f.binding.projectId}/github/pull-requests/10`;
    const response = await f.app.request(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      number: 10,
      head: { sha: f.feedbackState.headSha },
      files: [],
    });
    f.setUser(OTHER);
    const before = f.requests.length;
    expect((await f.app.request(path)).status).toBe(404);
    expect(f.requests).toHaveLength(before);
  });
  it("refuses unlinked PRs and revoked GitHub authority", async () => {
    const f = await feedbackFixture();
    expect(
      (await f.app.request(`/projects/${f.binding.projectId}/github/pull-requests/11`)).status,
    ).toBe(404);
    f.readOnly();
    expect(
      (await f.app.request(`/projects/${f.binding.projectId}/github/pull-requests/10`)).status,
    ).toBe(403);
  });
});
