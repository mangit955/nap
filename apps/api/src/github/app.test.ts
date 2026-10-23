import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubApp } from "./app.ts";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const config = {
  appId: 42,
  slug: "nap-test",
  clientId: "client",
  clientSecret: "secret",
  privateKey: key,
  webhookSecret: "webhook",
  apiUrl: "https://nap.example",
  webOrigin: "https://web.example",
};

describe("GitHub installation authority", () => {
  it("refreshes before token expiry and keeps repository and permission caches separate", async () => {
    let now = Date.now();
    let minted = 0;
    const app = new GitHubApp(
      config,
      async () =>
        Response.json({
          token: `scoped-${++minted}`,
          expires_at: new Date(now + 3600000).toISOString(),
        }),
      () => now,
    );
    expect(await app.token(99, 123, { contents: "read" })).toMatchObject({ value: "scoped-1" });
    now += 3539000;
    expect(await app.token(99, 123, { contents: "read" })).toMatchObject({ value: "scoped-1" });
    now += 1000;
    expect(await app.token(99, 123, { contents: "read" })).toMatchObject({ value: "scoped-2" });
    expect(await app.token(99, 124, { contents: "read" })).toMatchObject({ value: "scoped-3" });
    expect(await app.token(99, 123, { contents: "write" })).toMatchObject({ value: "scoped-4" });
    app.invalidate(99);
    expect(await app.token(99, 123, { contents: "read" })).toMatchObject({ value: "scoped-5" });
  });
  it("refuses an installation ID absent from the authorizing user's installations", async () => {
    const paths: string[] = [];
    const app = new GitHubApp(config, async (url) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === "/login/oauth/access_token")
        return Response.json({ access_token: "user-token" });
      if (path === "/user") return Response.json({ id: 7, login: "owner" });
      if (path === "/user/installations") return Response.json({ installations: [] });
      return new Response(null, { status: 204 });
    });
    const result = await app.authorizeInstallation("code", 99);
    expect(result).toMatchObject({ ok: false, error: { code: "access_denied" } });
    expect(paths).toContain("/applications/client/token");
  });

  it("scopes tokens to one repository and permissions, refreshes expired/401 tokens without exposing them", async () => {
    const bodies: unknown[] = [];
    let minted = 0;
    let requests = 0;
    const app = new GitHubApp(config, async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/access_tokens")) {
        bodies.push(JSON.parse(String(init?.body)));
        minted += 1;
        return Response.json({
          token: `token-${minted}`,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }
      requests += 1;
      return requests === 1
        ? Response.json({ message: "token-1 secret" }, { status: 401 })
        : Response.json({ permission: "write", user: { id: 7, login: "owner" } });
    });
    const result = await app.permission(
      99,
      { id: 123, fullName: "org/repo", defaultBranch: "main", private: true },
      "owner",
    );
    expect(result).toMatchObject({ ok: true, value: { permission: "write", user: { id: 7 } } });
    expect(minted).toBe(2);
    expect(bodies).toEqual([
      { repository_ids: [123], permissions: { metadata: "read" } },
      { repository_ids: [123], permissions: { metadata: "read" } },
    ]);
    expect(JSON.stringify(result)).not.toContain("token-");
  });

  it("sanitizes transport failures and ignores raw upstream messages", async () => {
    const app = new GitHubApp(config, async () => {
      throw new Error("credential-secret");
    });
    const result = await app.installation(1);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("credential-secret");
  });
});

it("reads every repository page beyond the old thousand-repository cap", async () => {
  const pages: number[] = [];
  const app = new GitHubApp(config, async (url) => {
    const target = new URL(String(url));
    if (target.pathname.endsWith("/access_tokens"))
      return Response.json({
        token: "installation",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    const page = Number(target.searchParams.get("page"));
    pages.push(page);
    return Response.json({
      repositories: Array.from({ length: page <= 11 ? 100 : 1 }, (_, i) => ({
        id: page * 100 + i,
        full_name: `example/repo-${page}-${i}`,
        default_branch: "main",
        private: true,
        archived: false,
        disabled: false,
      })),
    });
  });
  const result = await app.repositories(99);
  expect(result.ok && result.value.length).toBe(1101);
  expect(pages).toHaveLength(12);
});

describe("pull request inspection", () => {
  const repository = { id: 123, fullName: "org/repo", defaultBranch: "main", private: true };
  function fixture(moveHead = false) {
    let reads = 0;
    return new GitHubApp(config, async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/access_tokens"))
        return Response.json({
          token: "read-only",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      if (path.endsWith("/pulls/5"))
        return Response.json({
          number: 5,
          title: "Change the panel",
          body: "Description",
          draft: false,
          user: { id: 7, login: "owner" },
          html_url: "https://github.com/org/repo/pull/5",
          state: "open",
          merged_at: null,
          head: {
            sha: moveHead && reads++ > 0 ? "new-head" : "head",
            ref: "task",
            repo: { id: 123 },
          },
          base: { sha: "base", ref: "main", repo: { id: 123 } },
        });
      if (path.endsWith("/files"))
        return Response.json([
          {
            filename: "src/app.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-old\n+new",
          },
          { filename: "image.png", status: "added", additions: 0, deletions: 0 },
        ]);
      if (path.endsWith("/check-runs"))
        return Response.json({
          check_runs: [{ name: "Tests", status: "completed", conclusion: "success" }],
        });
      if (path.endsWith("/status")) return Response.json({ state: "success", statuses: [] });
      if (path.endsWith("/pulls/5/comments"))
        return Response.json([
          {
            id: 4,
            body: "Earlier review",
            user: { id: 7, login: "owner" },
            path: "src/app.ts",
            line: null,
            original_line: 1,
            side: "RIGHT",
            commit_id: "old-head",
            html_url: "https://github.com/org/repo/pull/5#discussion_r4",
          },
        ]);
      return Response.json([]);
    });
  }
  it("returns revision-bound patches and keeps outdated comment coordinates", async () => {
    const result = await fixture().inspectPullRequest(99, repository, 5);
    expect(result).toMatchObject({
      ok: true,
      value: {
        head: { sha: "head" },
        base: { sha: "base" },
        comments: [{ path: "src/app.ts", originalLine: 1, line: null, outdated: true }],
      },
    });
    if (!result.ok) return;
    expect(result.value.files[1]).toMatchObject({ truncated: true, patch: "" });
    expect(result.value.checks).toHaveLength(1);
  });
  it("rejects a PR whose head changes while its files and comments are being fetched", async () => {
    const result = await fixture(true).inspectPullRequest(99, repository, 5);
    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
