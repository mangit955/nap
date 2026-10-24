import { generateKeyPairSync, randomUUID } from "node:crypto";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryGitHubStore } from "@nap/db/testing/in-memory-github-store";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { GitHubRepository, RepositoryJob } from "@nap/shared/github-protocol";
import type { SessionRecord } from "@nap/shared/ports/session-store";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { describe, expect, it } from "vitest";
import { GitHubApp, type GitHubFetch, type GitHubResult } from "./app.ts";
import type { GitBroker } from "./git-broker.ts";
import { GitHubIntegration } from "./integration.ts";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const config = {
  appId: 42,
  slug: "nap-test",
  clientId: "client",
  clientSecret: "server-client-secret",
  privateKey,
  webhookSecret: "server-webhook-secret",
  apiUrl: "https://nap.example",
  webOrigin: "https://web.example",
};
const TOKEN = "server-only-installation-token";
const SHA = "a".repeat(40);
const repository: GitHubRepository = {
  id: 123,
  fullName: "org/app",
  defaultBranch: "main",
  private: true,
};
const json = (body: unknown, status = 200) => Response.json(body, { status });

type Pull = {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  head: { sha: string; ref: string; repo: { id: number } };
  base: { ref: string; repo: { id: number } };
};

class GitHubTransport {
  installationStatus = 200;
  installationHeaders: Record<string, string> = {};
  suspended: string | null = null;
  tokenStatus = 200;
  permission = { permission: "write", user: { id: 7, login: "owner" } };
  repositoryId = repository.id;
  fullName = repository.fullName;
  pullRequests: Pull[] = [];
  /** Repositories selected after the fixture's own, in the order GitHub lists them. */
  selection: string[] = [];
  /** How GitHub answers a permission check, by repository full name. */
  permissionFor: (fullName: string) => Response = () => json(this.permission);
  createBehavior: "success" | "error" | "lost-response" = "success";
  creates = 0;
  /** What each branch on GitHub points at, as the broker's pushes left it. */
  readonly branches = new Map<string, string>();
  readonly calls: { path: string; method: string; body: unknown }[] = [];

  readonly fetch: GitHubFetch = async (url, init) => {
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const body: unknown = init?.body === undefined ? null : JSON.parse(String(init.body));
    this.calls.push({ path, method, body });
    if (path === "/app/installations/99")
      return Response.json(
        {
          id: 99,
          app_id: 42,
          account: { id: 88, login: "org", type: "Organization" },
          suspended_at: this.suspended,
        },
        { status: this.installationStatus, headers: this.installationHeaders },
      );
    if (path.endsWith("/access_tokens"))
      return json(
        { token: TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
        this.tokenStatus,
      );
    if (path === "/installation/repositories")
      return json({
        repositories: [
          {
            id: this.repositoryId,
            full_name: this.fullName,
            default_branch: "main",
            private: true,
          },
          ...this.selection.map((fullName, i) => ({
            id: 2000 + i,
            full_name: fullName,
            default_branch: "main",
            private: true,
          })),
        ],
      });
    if (path.endsWith("/permission"))
      return this.permissionFor(path.split("/").slice(2, 4).join("/"));
    if (path === "/repos/org/app" && this.fullName !== "org/app")
      return new Response(null, {
        status: 301,
        headers: { location: `https://api.github.com/repos/${this.fullName}` },
      });
    if (path === `/repos/${this.fullName}`)
      return json({
        id: this.repositoryId,
        full_name: this.fullName,
        default_branch: "main",
        private: true,
        archived: false,
        disabled: false,
      });
    if (path.startsWith("/repos/org/app/git/ref/heads/") && method === "GET") {
      const head = this.branches.get(decodeURIComponent(path.slice(29)));
      return head === undefined
        ? json({ message: "Not Found" }, 404)
        : json({ ref: path.slice(15), object: { sha: head } });
    }
    if (path === "/repos/org/app/pulls" && method === "GET") return json(this.pullRequests);
    if (path === "/repos/org/app/pulls" && method === "POST") {
      this.creates += 1;
      if (this.createBehavior === "error") return json({ message: `${TOKEN}: unavailable` }, 503);
      if (
        typeof body !== "object" ||
        body === null ||
        !("head" in body) ||
        !("base" in body) ||
        typeof body.head !== "string" ||
        typeof body.base !== "string"
      )
        throw new Error("Missing PR refs");
      const pull = this.pull(body.head, body.base);
      this.pullRequests.push(pull);
      return this.createBehavior === "lost-response"
        ? json({ message: "response lost" }, 503)
        : json(pull, 201);
    }
    throw new Error(`Unhandled GitHub request ${method} ${path}`);
  };

  pull(head: string, base = "main"): Pull {
    return {
      number: 10,
      html_url: "https://github.com/org/app/pull/10",
      state: "open",
      merged_at: null,
      head: { sha: SHA, ref: head, repo: { id: repository.id } },
      base: { ref: base, repo: { id: repository.id } },
    };
  }
}

class RecordingBroker implements GitBroker {
  readonly fetches: Parameters<GitBroker["fetch"]>[0][] = [];
  readonly pushes: Parameters<GitBroker["push"]>[0][] = [];
  afterPush: (() => void) | undefined;
  pushFailure: GitHubResult<void> | undefined;
  constructor(readonly remote = new Map<string, string>()) {}
  async fetch(input: Parameters<GitBroker["fetch"]>[0]): Promise<GitHubResult<Uint8Array>> {
    this.fetches.push(input);
    return { ok: true, value: new TextEncoder().encode("repository bundle") };
  }
  async push(input: Parameters<GitBroker["push"]>[0]): Promise<GitHubResult<void>> {
    this.pushes.push(input);
    if (this.pushFailure === undefined) this.remote.set(input.branch, input.sha);
    this.afterPush?.();
    return this.pushFailure ?? { ok: true, value: undefined };
  }
}

async function fixture() {
  const store = new InMemoryGitHubStore();
  const userId = randomUUID();
  await store.bindInstallation({
    installationId: 99,
    userId,
    githubUserId: 7,
    githubLogin: "owner",
    accountLogin: "org",
    accountType: "Organization",
    status: "active",
  });
  const binding = await store.importRepository({
    userId,
    installationId: 99,
    repository,
    name: "App",
    baseBranch: "main",
    environment: { setupCommand: "bun install", devCommand: null, previewPort: null },
    autoPublish: true,
  });
  if (binding === null) throw new Error("Fixture import failed");
  const session: SessionRecord = {
    sessionId: binding.sessionId,
    projectId: binding.projectId,
    userId,
    sandboxId: null,
  };
  const transport = new GitHubTransport();
  const broker = new RecordingBroker(transport.branches);
  const events = new InMemoryEventStore();
  const objects = new InMemoryObjectStore();
  const snapshots = new InMemorySnapshotStore();
  const sandbox = new InMemorySandboxManager();
  const service = new GitHubIntegration({
    store,
    app: new GitHubApp(config, transport.fetch),
    broker,
    events,
    objects,
    snapshots,
    sandbox,
    sessions: new InMemorySessionStore([session]),
    bus: new InMemoryEventBus(),
  });
  const jobId = randomUUID();
  const job: RepositoryJob = {
    jobId,
    projectId: binding.projectId,
    sessionId: binding.sessionId,
    baseBranch: "main",
    headBranch: `nap/${jobId}`,
    baseSha: "b".repeat(40),
    headSha: SHA,
    pushedSha: null,
    pullRequestNumber: null,
    pullRequestUrl: null,
    pullRequestState: "none",
    publishState: "ready",
    checkState: "unknown",
    reviewState: "unknown",
    error: null,
    updatedAt: new Date().toISOString(),
  };
  await store.createJob(job);
  return {
    store,
    binding,
    session,
    transport,
    broker,
    events,
    objects,
    snapshots,
    sandbox,
    service,
    job,
  };
}

async function verified(f: Awaited<ReturnType<typeof fixture>>) {
  const envelope = {
    sessionId: f.session.sessionId,
    turnId: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  await f.events.append({
    ...envelope,
    type: "job.started",
    payload: { jobId: f.job.jobId, objective: "Fix the app" },
  });
  await f.events.append({
    ...envelope,
    type: "turn.completed",
    payload: { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1, commitSha: SHA },
  });
  await f.events.append({
    ...envelope,
    type: "verification.started",
    payload: { jobId: f.job.jobId },
  });
  await f.events.append({
    ...envelope,
    type: "verification.completed",
    payload: { jobId: f.job.jobId, checks: [{ name: "test", outcome: "passed", output: null }] },
  });
  await f.events.append({
    ...envelope,
    type: "job.checkpointed",
    payload: { jobId: f.job.jobId, commitSha: SHA },
  });
  await f.events.append({
    ...envelope,
    type: "job.completed",
    payload: { jobId: f.job.jobId, outcome: "verified" },
  });
  await f.objects.put("saved.bundle", new TextEncoder().encode("saved repository"));
  await f.snapshots.record({ projectId: f.session.projectId, key: "saved.bundle", gitSha: SHA });
}

function publish(f: Awaited<ReturnType<typeof fixture>>, signal?: AbortSignal) {
  return f.service.publish({ session: f.session, jobId: f.job.jobId, sandboxId: null, signal });
}

describe("GitHubIntegration authorization", () => {
  it("does not query GitHub for an installation owned by someone else", async () => {
    const f = await fixture();
    expect(await f.service.repositories(randomUUID(), 99)).toMatchObject({
      ok: false,
      error: { code: "access_denied" },
    });
    expect(f.transport.calls).toEqual([]);
  });

  it("checks stable GitHub identity as well as current write permission", async () => {
    const f = await fixture();
    f.transport.permission.user = { id: 55, login: "owner" };
    expect(await f.service.authorize(f.session.userId, 99, repository)).toMatchObject({
      ok: false,
      error: { code: "access_denied" },
    });
    expect(await f.service.repositories(f.session.userId, 99)).toEqual({ ok: true, value: [] });
    f.transport.permission.user = { id: 7, login: "renamed-owner" };
    expect(await f.service.authorize(f.session.userId, 99, repository)).toMatchObject({ ok: true });
    f.transport.permission.permission = "read";
    expect(await f.service.authorize(f.session.userId, 99, repository)).toMatchObject({
      ok: false,
    });
  });

  it("lists a large selection on one token, in GitHub's order, showing only what the user can write", async () => {
    // Minting a token per repository and checking them one at a time took ~20s for 44
    // repositories, past the server's idle timeout, and the picker reported a network failure.
    const f = await fixture();
    f.transport.selection = Array.from({ length: 40 }, (_, i) => `org/repo-${i}`);
    const as = (permission: string, id = 7) => json({ permission, user: { id, login: "owner" } });
    const answers: Record<string, () => Response> = {
      "org/repo-1": () => json({ message: "Not Found" }, 404),
      "org/repo-2": () => as("read"),
      "org/repo-3": () => as("admin", 55),
      "org/repo-4": () => as("maintain"),
      "org/repo-5": () => as("admin"),
      "org/repo-6": () => as("triage"),
    };
    f.transport.permissionFor = (name) => answers[name]?.() ?? as("write");
    const result = await f.service.repositories(f.session.userId, 99);
    if (!result.ok) throw new Error("Expected a listing");
    const hidden = new Set([2001, 2002, 2003, 2006]);
    expect(result.value.map((entry) => entry.id)).toEqual([
      repository.id,
      ...Array.from({ length: 40 }, (_, i) => 2000 + i).filter((id) => !hidden.has(id)),
    ]);
    const mints = f.transport.calls.filter((call) => call.path.endsWith("/access_tokens"));
    expect(mints).toEqual([
      {
        path: "/app/installations/99/access_tokens",
        method: "POST",
        body: { permissions: { metadata: "read" } },
      },
    ]);
  });

  it("fails the whole listing when any permission check is unavailable", async () => {
    const f = await fixture();
    f.transport.selection = Array.from({ length: 20 }, (_, i) => `org/repo-${i}`);
    f.transport.permissionFor = (name) =>
      name === "org/repo-12" ? json({ message: "down" }, 502) : json(f.transport.permission);
    expect(await f.service.repositories(f.session.userId, 99)).toMatchObject({
      ok: false,
      error: { code: "unavailable" },
    });
  });

  it("rejects an installation removed remotely and a repository whose ID changed", async () => {
    const f = await fixture();
    f.transport.repositoryId = 999;
    expect(await f.service.authorize(f.session.userId, 99, repository)).toMatchObject({
      ok: false,
    });
    f.transport.installationStatus = 404;
    expect(await f.service.authorize(f.session.userId, 99, repository)).toMatchObject({
      ok: false,
    });
    expect((await f.store.installation(f.session.userId, 99))?.status).toBe("removed");
  });

  it("keeps an installation connected through rate limiting and its own credential failures", async () => {
    // A throttled 403 looks like a denial unless the limit headers are read. Persisting it as a
    // removal would disconnect the owner's repositories until they reinstalled the app.
    const f = await fixture();
    const throttles = [
      { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999" } },
      { status: 403, headers: { "retry-after": "60" } },
      { status: 429, headers: {} },
      { status: 401, headers: {} },
    ];
    for (const throttle of throttles) {
      f.transport.installationStatus = throttle.status;
      f.transport.installationHeaders = throttle.headers;
      expect(await f.service.authorize(f.session.userId, 99, repository)).toMatchObject({
        ok: false,
        error: { code: "unavailable" },
      });
      expect((await f.store.installation(f.session.userId, 99))?.status).toBe("active");
    }
    f.transport.installationStatus = 200;
    f.transport.installationHeaders = {};
    expect(await f.service.authorize(f.session.userId, 99, repository)).toMatchObject({
      ok: true,
    });
  });

  it("delivers Git credentials only to the server broker and rechecks delayed clone access", async () => {
    const f = await fixture();
    const source = await f.service.source(f.session);
    if (!source.ok || source.value === null) throw new Error("Expected repository source");
    expect(JSON.stringify(source)).not.toContain(TOKEN);
    expect(await source.value.initialBundle()).toMatchObject({ ok: true });
    expect(f.broker.fetches).toMatchObject([{ fullName: "org/app", branch: "main", token: TOKEN }]);
    expect(
      f.transport.calls
        .filter((call) => call.path.endsWith("/access_tokens"))
        .map((call) => call.body),
    ).toContainEqual({ repository_ids: [123], permissions: { contents: "read" } });
    await f.store.disconnect(f.session.userId, 99);
    expect(await source.value.initialBundle()).toMatchObject({
      ok: false,
      error: { code: "access_denied" },
    });
    expect(f.broker.fetches).toHaveLength(1);
    expect(
      JSON.stringify({
        binding: await f.store.repository(f.session.projectId, f.session.userId),
        jobs: await f.store.jobs(f.session.projectId, f.session.userId),
        events: await f.events.readFrom(f.session.sessionId, 0),
      }),
    ).not.toContain(TOKEN);
  });
});

describe("verified PR publication", () => {
  it("records a verified result on cancellation without pushing, and permits later publication", async () => {
    const f = await fixture();
    const sandbox = await f.sandbox.create(f.session.projectId);
    if (!sandbox.ok) throw new Error("Fixture sandbox failed");
    f.sandbox.script(/rev-parse HEAD/, { stdout: SHA });
    await f.store.updateJob(f.job.jobId, { publishState: "working", headSha: null });
    expect(
      await f.service.finishJob({
        session: f.session,
        sandboxId: sandbox.value.id,
        jobId: f.job.jobId,
        outcome: "verified",
        signal: AbortSignal.abort(),
      }),
    ).toMatchObject({ ok: true });
    expect(await f.store.job(f.job.jobId)).toMatchObject({ publishState: "ready", headSha: SHA });
    expect(f.broker.pushes).toHaveLength(0);
    await verified(f);
    expect(await publish(f)).toMatchObject({ ok: true });
  });

  it("recovers from a process loss after publication started without duplicating a PR", async () => {
    const f = await fixture();
    await verified(f);
    await f.store.updateJob(f.job.jobId, { publishState: "publishing", pushedSha: SHA });
    f.transport.pullRequests.push(f.transport.pull(f.job.headBranch));
    expect(await publish(f)).toMatchObject({ ok: true });
    expect(f.transport.creates).toBe(0);
    expect(await f.store.job(f.job.jobId)).toMatchObject({
      publishState: "published",
      pullRequestNumber: 10,
    });
  });
  it("preserves a failed push without opening a PR", async () => {
    const f = await fixture();
    await verified(f);
    f.broker.pushFailure = {
      ok: false,
      error: { code: "conflict", message: "Remote branch changed." },
    };
    expect(await publish(f)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(f.transport.creates).toBe(0);
    expect(await f.store.job(f.job.jobId)).toMatchObject({
      pushedSha: null,
      publishState: "failed",
      error: "Remote branch changed.",
    });
  });

  it("publishes the verified snapshot through a scoped broker and creates a draft PR", async () => {
    const f = await fixture();
    await verified(f);
    expect(await publish(f)).toEqual({ ok: true, value: undefined });
    expect(f.broker.pushes).toMatchObject([
      { fullName: "org/app", branch: f.job.headBranch, sha: SHA, token: TOKEN },
    ]);
    const create = f.transport.calls.find(
      (call) => call.path === "/repos/org/app/pulls" && call.method === "POST",
    );
    expect(create?.body).toMatchObject({ head: f.job.headBranch, base: "main", draft: true });
    expect(await f.store.job(f.job.jobId)).toMatchObject({
      pushedSha: SHA,
      pullRequestNumber: 10,
      publishState: "published",
    });
  });

  it("keeps a successful push when PR creation fails, then adopts an existing PR on retry", async () => {
    const f = await fixture();
    await verified(f);
    f.transport.createBehavior = "error";
    expect(await publish(f)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await f.store.job(f.job.jobId)).toMatchObject({
      pushedSha: SHA,
      pullRequestNumber: null,
      publishState: "failed",
    });
    expect(JSON.stringify(await f.store.job(f.job.jobId))).not.toContain(TOKEN);
    f.transport.pullRequests.push(f.transport.pull(f.job.headBranch));
    expect(await publish(f)).toMatchObject({ ok: true });
    expect(f.transport.creates).toBe(1);
    expect(await f.store.job(f.job.jobId)).toMatchObject({
      pushedSha: SHA,
      pullRequestNumber: 10,
      publishState: "published",
    });
  });

  it("opens the pull request for a pushed job after later work moved the workspace on", async () => {
    // The push landed and the pull request did not; then the next message committed on top. The
    // verified commit is already on GitHub, so the retry needs nothing from the workspace.
    const f = await fixture();
    await verified(f);
    f.transport.createBehavior = "error";
    expect(await publish(f)).toMatchObject({ ok: false });
    expect(await f.store.job(f.job.jobId)).toMatchObject({
      pushedSha: SHA,
      publishState: "failed",
    });
    const later = "c".repeat(40);
    await f.snapshots.record({
      projectId: f.session.projectId,
      key: "later.bundle",
      gitSha: later,
    });
    const sandbox = await f.sandbox.create(f.session.projectId);
    if (!sandbox.ok) throw new Error("Fixture sandbox failed");
    f.sandbox.script(/status --porcelain/, { stdout: "" });
    f.sandbox.script(/rev-parse HEAD/, { stdout: later });
    f.transport.createBehavior = "success";

    for (const sandboxId of [null, sandbox.value.id])
      expect(
        await f.service.publish({ session: f.session, jobId: f.job.jobId, sandboxId }),
      ).toMatchObject({ ok: true });

    expect(f.broker.pushes).toHaveLength(1);
    expect(f.transport.creates).toBe(2);
    expect(await f.store.job(f.job.jobId)).toMatchObject({
      pushedSha: SHA,
      pullRequestNumber: 10,
      publishState: "published",
      error: null,
    });
  });

  it("still asks the workspace when the pushed branch has since moved on GitHub", async () => {
    // Somebody else pushed to the job's branch: what is there is no longer what was verified, so
    // the shortcut does not apply and the moved workspace refuses as before.
    const f = await fixture();
    await verified(f);
    f.transport.createBehavior = "error";
    expect(await publish(f)).toMatchObject({ ok: false });
    f.transport.branches.set(f.job.headBranch, "d".repeat(40));
    await f.snapshots.record({
      projectId: f.session.projectId,
      key: "later.bundle",
      gitSha: "c".repeat(40),
    });
    f.transport.createBehavior = "success";

    expect(await publish(f)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(f.broker.pushes).toHaveLength(1);
    expect(f.transport.creates).toBe(1);
  });

  it("recovers a lost creation response without making a duplicate PR", async () => {
    const f = await fixture();
    await verified(f);
    f.transport.createBehavior = "lost-response";
    expect(await publish(f)).toMatchObject({ ok: true });
    expect(await publish(f)).toMatchObject({ ok: true });
    expect(f.transport.creates).toBe(1);
    expect(f.transport.pullRequests).toHaveLength(1);
  });

  it("rejects unverified jobs, stale snapshots and closed PRs without pushing", async () => {
    const f = await fixture();
    expect(await publish(f)).toMatchObject({ ok: false, error: { code: "conflict" } });
    await verified(f);
    await f.snapshots.record({
      projectId: f.session.projectId,
      key: "other.bundle",
      gitSha: "c".repeat(40),
    });
    expect(await publish(f)).toMatchObject({ ok: false, error: { code: "conflict" } });
    await f.snapshots.record({ projectId: f.session.projectId, key: "saved.bundle", gitSha: SHA });
    f.transport.pullRequests.push({ ...f.transport.pull(f.job.headBranch), state: "closed" });
    expect(await publish(f)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(f.broker.pushes).toEqual([]);
  });

  it("stops before push on cancellation and retains the pushed SHA if cancellation follows push", async () => {
    const f = await fixture();
    await verified(f);
    const stopped = new AbortController();
    stopped.abort();
    expect(await publish(f, stopped.signal)).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(f.broker.pushes).toEqual([]);
    const afterPush = new AbortController();
    f.broker.afterPush = () => afterPush.abort();
    expect(await publish(f, afterPush.signal)).toMatchObject({
      ok: false,
      error: { code: "cancelled" },
    });
    expect(await f.store.job(f.job.jobId)).toMatchObject({
      pushedSha: SHA,
      pullRequestNumber: null,
    });
    expect(f.transport.creates).toBe(0);
  });

  it("does not publish for a stranger or when the live worktree moved after verification", async () => {
    const f = await fixture();
    await verified(f);
    expect(
      await f.service.publish({
        session: { ...f.session, userId: randomUUID() },
        jobId: f.job.jobId,
        sandboxId: null,
      }),
    ).toMatchObject({ ok: false });
    const sandbox = await f.sandbox.create(f.session.projectId);
    if (!sandbox.ok) throw new Error("Fixture sandbox failed");
    f.sandbox.script(/status --porcelain/, { stdout: " M unverified.ts" });
    f.sandbox.script(/rev-parse HEAD/, { stdout: SHA });
    expect(
      await f.service.publish({
        session: f.session,
        jobId: f.job.jobId,
        sandboxId: sandbox.value.id,
      }),
    ).toMatchObject({ ok: false });
    expect(f.broker.pushes).toEqual([]);
    expect(f.sandbox.commands(sandbox.value.id).some((command) => command.includes(TOKEN))).toBe(
      false,
    );
  });
});

it("recovers a repository rename by numeric identity and sends only the canonical name to Git", async () => {
  const f = await fixture();
  f.transport.fullName = "org/renamed";
  const source = await f.service.source(f.session);
  if (!source.ok || source.value === null) throw new Error("Expected renamed source");
  expect(await source.value.initialBundle()).toMatchObject({ ok: true });
  expect(f.broker.fetches).toMatchObject([{ fullName: "org/renamed" }]);
  expect(await f.store.repository(f.session.projectId, f.session.userId)).toMatchObject({
    repository: { id: 123, fullName: "org/renamed" },
    baseBranch: "main",
  });
  expect(
    f.transport.calls.some(
      (call) => call.path === "/repos/org/renamed/collaborators/owner/permission",
    ),
  ).toBe(true);
});

describe("job branch preparation", () => {
  it("continues approved feedback on the existing PR branch and refuses a moved workspace", async () => {
    const f = await fixture();
    await f.store.updateJob(f.job.jobId, {
      pushedSha: SHA,
      publishState: "published",
      pullRequestNumber: 10,
      pullRequestUrl: "https://github.com/org/app/pull/10",
      pullRequestState: "open",
    });
    const requestId = randomUUID();
    const feedbackId = "comment:approved";
    await f.store.addFeedback({
      id: feedbackId,
      projectId: f.binding.projectId,
      jobId: f.job.jobId,
      kind: "comment",
      summary: "Fix the review",
      requestId: null,
      createdAt: new Date().toISOString(),
    });
    await f.store.approveFeedback(f.binding.projectId, f.binding.userId, feedbackId, {
      id: requestId,
      userId: f.binding.userId,
      sessionId: f.binding.sessionId,
      kind: "turn",
      message: "Fix the review",
      target: { kind: "api", model: "test-model", billsToUser: false },
    });
    const sandbox = await f.sandbox.create(f.session.projectId);
    if (!sandbox.ok) throw new Error("Fixture sandbox failed");
    let head = SHA;
    f.sandbox.script(/status --porcelain/, { stdout: "" });
    f.sandbox.script(/rev-parse HEAD/, () => ({ stdout: head }));
    f.sandbox.script(/symbolic-ref --short HEAD/, { stdout: f.job.headBranch });
    const jobId = randomUUID();
    expect(
      await f.service.prepareJob({
        session: f.session,
        sandboxId: sandbox.value.id,
        jobId,
        requestId,
      }),
    ).toMatchObject({ ok: true });
    expect(await f.store.job(jobId)).toMatchObject({
      headBranch: f.job.headBranch,
      baseSha: f.job.baseSha,
      pullRequestNumber: 10,
      pushedSha: SHA,
    });
    expect(
      f.sandbox.commands(sandbox.value.id).some((command) => command.includes("checkout")),
    ).toBe(false);
    // Unfinished edits from other work must not ride along into a PR the feedback is about.
    f.sandbox.script(/status --porcelain/, { stdout: " M stray.ts" });
    const dirtyJob = randomUUID();
    expect(
      await f.service.prepareJob({
        session: f.session,
        sandboxId: sandbox.value.id,
        jobId: dirtyJob,
        requestId,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await f.store.job(dirtyJob)).toBeNull();
    f.sandbox.script(/status --porcelain/, { stdout: "" });
    head = "c".repeat(40);
    const refusedJob = randomUUID();
    expect(
      await f.service.prepareJob({
        session: f.session,
        sandboxId: sandbox.value.id,
        jobId: refusedJob,
        requestId,
      }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await f.store.job(refusedJob)).toBeNull();
  });

  it("rejects a finish notification naming another project's job before changing it", async () => {
    const f = await fixture();
    const other = await f.store.importRepository({
      userId: f.binding.userId,
      installationId: 99,
      repository,
      name: "Other",
      baseBranch: "main",
      environment: f.binding.environment,
      autoPublish: true,
    });
    if (other === null) throw new Error("Expected second import");
    const job = await f.store.createJob({
      ...f.job,
      jobId: randomUUID(),
      projectId: other.projectId,
      sessionId: other.sessionId,
    });
    expect(
      await f.service.finishJob({
        session: f.session,
        sandboxId: "unused",
        jobId: job.jobId,
        outcome: "exhausted",
      }),
    ).toMatchObject({ ok: false, error: { code: "access_denied" } });
    expect(await f.store.job(job.jobId)).toEqual(job);
  });

  it("creates a dedicated branch and preserves unfinished work on subsequent preparation", async () => {
    const f = await fixture();
    const sandbox = await f.sandbox.create(f.session.projectId);
    if (!sandbox.ok) throw new Error("Fixture sandbox failed");
    let dirty = false;
    let branch = "main";
    f.sandbox.script(/status --porcelain/, () => ({ stdout: dirty ? " M local.ts" : "" }));
    f.sandbox.script(/rev-parse HEAD/, { stdout: SHA });
    f.sandbox.script(/symbolic-ref --short HEAD/, () => ({ stdout: branch }));
    f.sandbox.script(/checkout -b/, (command) => {
      branch = command.match(/checkout -b '([^']+)'/)?.[1] ?? "missing";
      return {};
    });
    const jobId = randomUUID();
    expect(
      await f.service.prepareJob({ session: f.session, sandboxId: sandbox.value.id, jobId }),
    ).toMatchObject({ ok: true });
    expect(await f.store.job(jobId)).toMatchObject({ headBranch: `nap/${jobId}`, baseSha: SHA });
    const commands = f.sandbox.commands(sandbox.value.id);
    expect(commands.some((command) => command.includes(`nap/${jobId}`))).toBe(true);
    expect(commands.some((command) => /reset|clean -f/.test(command))).toBe(false);
    // The first job stopped with edits in place. The next one continues them on that branch.
    dirty = true;
    const next = randomUUID();
    expect(
      await f.service.prepareJob({
        session: f.session,
        sandboxId: sandbox.value.id,
        jobId: next,
      }),
    ).toMatchObject({ ok: true });
    expect(await f.store.job(next)).toMatchObject({ headBranch: `nap/${jobId}`, baseSha: SHA });
    expect(
      f.sandbox.commands(sandbox.value.id).filter((command) => command.includes("checkout -b")),
    ).toHaveLength(1);
    expect(
      f.sandbox.commands(sandbox.value.id).some((command) => /reset|clean -f/.test(command)),
    ).toBe(false);
  });

  it("does not publish a failed or cancelled verification outcome", async () => {
    const f = await fixture();
    expect(
      await f.service.finishJob({
        session: f.session,
        sandboxId: "unused",
        jobId: f.job.jobId,
        outcome: "exhausted",
      }),
    ).toMatchObject({ ok: true });
    expect(await f.store.job(f.job.jobId)).toMatchObject({
      publishState: "failed",
      pushedSha: null,
    });
    expect(f.broker.pushes).toEqual([]);
  });
});
