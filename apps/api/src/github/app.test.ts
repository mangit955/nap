import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
  it.each([
    { login: "owner", accepted: true },
    { login: "nap-test[bot]", accepted: false },
    { login: "owner/other", accepted: false },
    { login: "", accepted: false },
    { login: "owner name", accepted: false },
  ])("keeps OAuth authority validation for login $login", async ({ login, accepted }) => {
    const app = new GitHubApp(config, async (url) => {
      const path = new URL(url).pathname;
      if (path === "/login/oauth/access_token")
        return Response.json({ access_token: "user-token" });
      if (path === "/user") return Response.json({ id: 7, login });
      if (path === "/user/installations")
        return Response.json({
          installations: [
            {
              id: 99,
              app_id: config.appId,
              account: { id: 7, login: "owner", type: "User" },
              suspended_at: null,
            },
          ],
        });
      if (path === "/applications/client/token") return new Response(null, { status: 204 });
      throw new Error(`Unexpected request: ${path}`);
    });
    expect(await app.authorizeInstallation("code", 99)).toMatchObject({ ok: accepted });
  });
  it.each(["User", "Bot"])(
    "does not accept a bot login as a %s installation owner",
    async (type) => {
      const app = new GitHubApp(config, async () =>
        Response.json({
          id: 99,
          app_id: config.appId,
          account: { id: 7, login: "nap-test[bot]", type },
          suspended_at: null,
        }),
      );
      expect(await app.installation(99)).toMatchObject({ ok: false });
    },
  );
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

describe("permission checks across an installation", () => {
  const selection = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: 1000 + i,
      fullName: `org/repo-${i}`,
      defaultBranch: "main",
      private: true,
    }));

  /**
   * Answers each permission check a few macrotasks later, so checks that are genuinely running at
   * once overlap here and a serial loop shows up as one in flight at a time.
   */
  function transport(answer: (repo: string, token: string) => Response) {
    const minted: unknown[] = [];
    const checked: { repo: string; token: string }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetcher = async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/access_tokens")) {
        minted.push(JSON.parse(String(init?.body)));
        return Response.json({
          token: `token-${minted.length}`,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      }
      const repo = path.split("/")[3] ?? "";
      const authorization = new Headers(init?.headers).get("authorization") ?? "";
      const token = authorization.replace("Bearer ", "");
      checked.push({ repo, token });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      for (let tick = 0; tick < 3; tick += 1) await new Promise((r) => setTimeout(r, 0));
      inFlight -= 1;
      return answer(repo, token);
    };
    return {
      app: new GitHubApp(config, fetcher),
      minted,
      checked,
      maxInFlight: () => maxInFlight,
    };
  }
  const write = () => Response.json({ permission: "write", user: { id: 7, login: "owner" } });

  it("checks every repository on one installation-wide token, a bounded number at a time, in listing order", async () => {
    const t = transport((repo) =>
      repo === "repo-3"
        ? Response.json({ message: "Not Found" }, { status: 404 })
        : Response.json({
            permission: repo === "repo-5" ? "read" : "write",
            user: { id: 7, login: "owner" },
          }),
    );
    const repositories = selection(30);
    const result = await t.app.permissions(99, repositories, "owner");
    if (!result.ok) throw new Error("Expected permissions");
    expect(result.value).toHaveLength(30);
    expect(result.value[3]).toBeNull();
    expect(result.value[5]).toMatchObject({ permission: "read" });
    expect(result.value[29]).toMatchObject({ permission: "write" });
    // One token for the whole listing, not one per repository — and an installation-wide one.
    expect(t.minted).toEqual([{ permissions: { metadata: "read" } }]);
    expect(t.checked).toHaveLength(30);
    expect(t.maxInFlight()).toBe(8);
  });

  it("keeps input order when permission checks complete out of order, including a skipped repository", async () => {
    const repositories = selection(10);
    const gates = repositories.map(() => {
      let release = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      return { promise, release };
    });
    const started: number[] = [];
    const expected = repositories.map((repo, index) =>
      index === 3 ? null : { permission: "write", user: { id: repo.id, login: "owner" } },
    );
    const app = new GitHubApp(config, async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/access_tokens"))
        return Response.json({
          token: "installation",
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      const index = Number(path.split("/")[3]?.replace("repo-", ""));
      started.push(index);
      await gates[index]?.promise;
      return index === 3 ? new Response(null, { status: 404 }) : Response.json(expected[index]);
    });
    const pending = app.permissions(99, repositories, "owner");
    try {
      await vi.waitFor(() => expect(started).toHaveLength(8));
      gates[7]!.release();
      // A replacement request proves the previous result was consumed before the next release.
      await vi.waitFor(() => expect(started).toContain(8));
      gates[3]!.release();
      await vi.waitFor(() => expect(started).toContain(9));
    } finally {
      for (const gate of gates) gate.release();
      await pending;
    }
    expect(await pending).toEqual({ ok: true, value: expected });
  });

  it("refreshes a rejected installation token once and uses it directly for newly launched checks", async () => {
    const t = transport((_repo, token) =>
      token === "token-1"
        ? Response.json({ message: "Bad credentials" }, { status: 401 })
        : write(),
    );
    const result = await t.app.permissions(99, selection(20), "owner");
    if (!result.ok) throw new Error("Expected permissions");
    expect(result.value.every((entry) => entry?.permission === "write")).toBe(true);
    expect(t.minted).toHaveLength(2);
    expect(t.checked.filter(({ token }) => token === "token-1")).toHaveLength(8);
    expect(t.checked).toHaveLength(28);
    expect(t.checked.filter(({ repo }) => Number(repo.replace("repo-", "")) >= 8)).toEqual(
      selection(12).map((_, index) => ({ repo: `repo-${index + 8}`, token: "token-2" })),
    );
  });

  it.each([403, 404, 409, 422])(
    "returns null entries when the initial token is denied or conflicts with status %i",
    async (status) => {
      const paths: string[] = [];
      const app = new GitHubApp(config, async (url) => {
        paths.push(new URL(url).pathname);
        return new Response(null, { status });
      });
      expect(await app.permissions(99, selection(3), "owner")).toEqual({
        ok: true,
        value: [null, null, null],
      });
      expect(paths).toEqual(["/app/installations/99/access_tokens"]);
    },
  );

  it.each([502, 503])(
    "fails when the initial token is unavailable with status %i",
    async (status) => {
      const paths: string[] = [];
      const app = new GitHubApp(config, async (url) => {
        paths.push(new URL(url).pathname);
        return new Response(null, { status });
      });
      expect(await app.permissions(99, selection(3), "owner")).toMatchObject({
        ok: false,
        error: { code: "unavailable" },
      });
      expect(paths).toEqual(["/app/installations/99/access_tokens"]);
    },
  );

  it.each([502, 503])(
    "fails when the shared refresh is unavailable with status %i",
    async (status) => {
      let minted = 0;
      let checked = 0;
      const app = new GitHubApp(config, async (url) => {
        if (new URL(url).pathname.endsWith("/access_tokens")) {
          minted += 1;
          return minted === 1
            ? Response.json({
                token: "rejected",
                expires_at: new Date(Date.now() + 3600000).toISOString(),
              })
            : new Response(null, { status });
        }
        checked += 1;
        return new Response(null, { status: 401 });
      });
      expect(await app.permissions(99, selection(20), "owner")).toMatchObject({
        ok: false,
        error: { code: "unavailable" },
      });
      expect(minted).toBe(2);
      expect(checked).toBe(8);
    },
  );

  it("skips repositories still returning 401 after one refresh without looping", async () => {
    let minted = 0;
    let checked = 0;
    const app = new GitHubApp(config, async (url) => {
      if (new URL(url).pathname.endsWith("/access_tokens"))
        return Response.json({
          token: `token-${++minted}`,
          expires_at: new Date(Date.now() + 3600000).toISOString(),
        });
      checked += 1;
      // Bound even a broken retry loop so a failed assertion leaves no pending work.
      return new Response(null, { status: checked <= 40 ? 401 : 503 });
    });
    expect(await app.permissions(99, selection(20), "owner")).toEqual({
      ok: true,
      value: Array(20).fill(null),
    });
    expect(minted).toBe(2);
    expect(checked).toBe(40);
  });

  it("fails the whole check when GitHub is unavailable, and stops asking", async () => {
    const t = transport((repo) =>
      repo === "repo-1" ? Response.json({ message: "down" }, { status: 503 }) : write(),
    );
    const result = await t.app.permissions(99, selection(40), "owner");
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(t.checked.length).toBeLessThan(40);
  });
});

describe("pull request inspection", () => {
  const repository = { id: 123, fullName: "org/repo", defaultBranch: "main", private: true };
  const human = { id: 7, login: "owner", type: "User" };
  function fixture({
    moveHead = false,
    author = human,
    reviewAuthor = human,
    commentAuthor = human,
    anchorAuthor = human,
  }: {
    moveHead?: boolean;
    author?: typeof human;
    reviewAuthor?: typeof human | null;
    commentAuthor?: typeof human | null;
    anchorAuthor?: typeof human | null;
  } = {}) {
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
          user: author,
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
            user: anchorAuthor,
            path: "src/app.ts",
            line: null,
            original_line: 1,
            side: "RIGHT",
            commit_id: "old-head",
            html_url: "https://github.com/org/repo/pull/5#discussion_r4",
          },
        ]);
      if (path.endsWith("/reviews"))
        return Response.json([
          {
            id: 6,
            state: "COMMENTED",
            user: reviewAuthor,
            body: "Review body",
            submitted_at: "2026-10-19T10:00:00.000Z",
          },
        ]);
      if (path.endsWith("/issues/5/comments"))
        return Response.json([
          {
            id: 8,
            user: commentAuthor,
            body: "Discussion body",
            updated_at: "2026-10-19T11:00:00.000Z",
          },
        ]);
      throw new Error(`Unexpected request: ${path}`);
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
    const result = await fixture({ moveHead: true }).inspectPullRequest(99, repository, 5);
    expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it.each([
    human,
    { id: 42, login: "nap-test[bot]", type: "Bot" },
    { id: 10137, login: "ghost", type: "User" },
  ])("accepts the display PR author $login", async (author) => {
    const result = await fixture({ author }).inspectPullRequest(99, repository, 5);
    expect(result).toMatchObject({ ok: true, value: { author: author.login } });
  });
  it.each(["reviewAuthor", "commentAuthor", "anchorAuthor"] as const)(
    "accepts a bot as %s without losing the inspection",
    async (field) => {
      const actor = { id: 42, login: "nap-test[bot]", type: "Bot" };
      const result = await fixture({ [field]: actor }).inspectPullRequest(99, repository, 5);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const displayed =
        field === "anchorAuthor"
          ? result.value.comments[0]
          : result.value.timeline.find((item) =>
              field === "reviewAuthor" ? item.kind === "review" : item.kind === "comment",
            );
      expect(displayed?.author).toBe(actor.login);
    },
  );
  it.each(["reviewAuthor", "commentAuthor", "anchorAuthor"] as const)(
    "preserves content and labels a deleted %s",
    async (field) => {
      const result = await fixture({ [field]: null }).inspectPullRequest(99, repository, 5);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const displayed =
        field === "anchorAuthor"
          ? result.value.comments[0]
          : result.value.timeline.find((item) =>
              field === "reviewAuthor" ? item.kind === "review" : item.kind === "comment",
            );
      expect(displayed?.author).toBe("Deleted user");
      expect(displayed?.body).toBe(
        field === "anchorAuthor"
          ? "Earlier review"
          : field === "reviewAuthor"
            ? "Review body"
            : "Discussion body",
      );
    },
  );
});
