import { createSign } from "node:crypto";
import { type GitHubRepository, GitHubRepositorySchema } from "@nap/shared/github-protocol";
import type { Result } from "@nap/shared/result";
import { z } from "zod";

export const GitHubConfigSchema = z.object({
  appId: z.number().int().positive(),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  privateKey: z.string().min(1),
  webhookSecret: z.string().min(20),
  apiUrl: z.url(),
  webOrigin: z.url(),
});
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type GitHubError = {
  code: "access_denied" | "unavailable" | "conflict" | "cancelled";
  message: string;
};
export type GitHubResult<T> = Result<T, GitHubError>;
export type GitHubFetch = (url: string, init?: RequestInit) => Promise<Response>;
const Id = z.number().int().positive().safe();
const User = z.object({ id: Id, login: z.string().regex(/^[a-zA-Z0-9-]+$/) });
const Installation = z.object({
  id: Id,
  app_id: Id,
  account: User.extend({ type: z.enum(["User", "Organization"]) }),
  suspended_at: z.string().nullable(),
});
const Repository = z.object({
  id: Id,
  full_name: z.string(),
  default_branch: z.string(),
  private: z.boolean(),
  archived: z.boolean().optional(),
  disabled: z.boolean().optional(),
});
const Permission = z.object({ permission: z.string(), user: User });
const PullRequest = z.object({
  number: Id,
  html_url: z.url(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable(),
  head: z.object({ sha: z.string(), ref: z.string(), repo: z.object({ id: Id }).nullable() }),
  base: z.object({ ref: z.string(), repo: z.object({ id: Id }) }),
});
const Checks = z.object({
  check_runs: z.array(
    z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() }),
  ),
});
const Statuses = z.object({
  state: z.string(),
  statuses: z.array(z.object({ context: z.string(), state: z.string() })),
});
const Review = z.object({
  id: Id,
  state: z.string(),
  user: User,
  body: z.string().nullable(),
  submitted_at: z.string().nullable(),
});
const Comment = z.object({ id: Id, body: z.string(), user: User, updated_at: z.string() });
const Tokens = z.object({ token: z.string(), expires_at: z.iso.datetime() });
const empty = z.unknown();
type Permissions = Record<string, "read" | "write">;
type Token = { token: string; expiresAt: number };

/**
 * GitHub answers an exhausted rate limit with 403 or 429, and a 403 is otherwise how it says
 * access is gone. Reading the limit headers is the only way to tell them apart, and telling them
 * apart is the difference between waiting an hour and disconnecting somebody's repositories.
 * https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api
 */
export function isRateLimited(response: Pick<Response, "status" | "headers">): boolean {
  if (response.status !== 403 && response.status !== 429) return false;
  return (
    response.status === 429 ||
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after")
  );
}

const RATE_LIMITED: GitHubError = {
  code: "unavailable",
  message: "GitHub is rate limiting Nap's requests for this connection. Try again shortly.",
};

function failure<T>(status?: number): GitHubResult<T> {
  if (status === 401 || status === 403 || status === 404)
    return {
      ok: false,
      error: {
        code: "access_denied",
        message:
          "GitHub access is unavailable. Reconnect and check the app's selected repositories and permissions.",
      },
    };
  if (status === 409 || status === 422)
    return {
      ok: false,
      error: {
        code: "conflict",
        message:
          "GitHub could not apply this change. Check the branch and pull request before retrying.",
      },
    };
  return {
    ok: false,
    error: {
      code: "unavailable",
      message: "GitHub could not complete this request. Try again shortly.",
    },
  };
}

export class GitHubApp {
  readonly #tokens = new Map<string, Token>();
  constructor(
    readonly config: GitHubConfig,
    readonly fetcher: GitHubFetch = fetch,
    readonly now: () => number = Date.now,
  ) {}

  invalidate(installationId: number): void {
    for (const key of this.#tokens.keys())
      if (key.startsWith(`${installationId}:`)) this.#tokens.delete(key);
  }

  #jwt(): string {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(this.now() / 1000);
    const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: this.config.clientId })}`;
    return `${payload}.${createSign("RSA-SHA256").update(payload).sign(this.config.privateKey, "base64url")}`;
  }

  async #http<T>(
    path: string,
    authorization: string,
    schema: z.ZodType<T>,
    options: { method?: string; body?: unknown; signal?: AbortSignal | undefined } = {},
  ): Promise<GitHubResult<T> & { status?: number; hasNext?: boolean }> {
    try {
      const response = await this.fetcher(`https://api.github.com${path}`, {
        method: options.method ?? "GET",
        redirect: "error",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: authorization,
          "X-GitHub-Api-Version": "2026-03-10",
          "Content-Type": "application/json",
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal:
          options.signal === undefined
            ? AbortSignal.timeout(20_000)
            : AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]),
      });
      if (isRateLimited(response))
        return { ok: false, error: RATE_LIMITED, status: response.status };
      if (!response.ok) return { ...failure<T>(response.status), status: response.status };
      const parsed = schema.safeParse(response.status === 204 ? null : await response.json());
      return parsed.success
        ? {
            ok: true,
            value: parsed.data,
            hasNext: /rel="next"/.test(response.headers.get("link") ?? ""),
          }
        : failure();
    } catch {
      return options.signal?.aborted
        ? { ok: false, error: { code: "cancelled", message: "GitHub operation cancelled." } }
        : failure();
    }
  }

  /** `status` is 404 only when GitHub says the installation no longer exists. */
  async installation(
    id: number,
  ): Promise<GitHubResult<z.infer<typeof Installation>> & { status?: number }> {
    try {
      return await this.#http(`/app/installations/${id}`, `Bearer ${this.#jwt()}`, Installation);
    } catch {
      return failure();
    }
  }

  async authorizeInstallation(
    code: string,
    installationId: number,
  ): Promise<
    GitHubResult<{
      githubUserId: number;
      githubLogin: string;
      installation: z.infer<typeof Installation>;
    }>
  > {
    let token: string | undefined;
    try {
      const response = await this.fetcher("https://github.com/login/oauth/access_token", {
        method: "POST",
        redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
          code,
          redirect_uri: `${this.config.apiUrl}/github/callback`,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) return failure(response.status);
      const parsed = z.object({ access_token: z.string().min(1) }).safeParse(await response.json());
      if (!parsed.success) return failure(401);
      token = parsed.data.access_token;
      const user = await this.#http("/user", `Bearer ${token}`, User);
      if (!user.ok) return user;
      let found: z.infer<typeof Installation> | undefined;
      for (let page = 1; page <= 10; page += 1) {
        const result = await this.#http(
          `/user/installations?per_page=100&page=${page}`,
          `Bearer ${token}`,
          z.object({ installations: z.array(Installation) }),
        );
        if (!result.ok) return result;
        found = result.value.installations.find(
          (entry) => entry.id === installationId && entry.app_id === this.config.appId,
        );
        if (found !== undefined || result.value.installations.length < 100) break;
      }
      if (found === undefined || found.suspended_at !== null) return failure(403);
      if (found.account.type === "User" && found.account.id !== user.value.id) return failure(403);
      return {
        ok: true,
        value: { githubUserId: user.value.id, githubLogin: user.value.login, installation: found },
      };
    } catch {
      return failure();
    } finally {
      if (token !== undefined)
        await this.#http(
          `/applications/${encodeURIComponent(this.config.clientId)}/token`,
          `Basic ${Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64")}`,
          empty,
          { method: "DELETE", body: { access_token: token } },
        );
    }
  }

  async token(
    installationId: number,
    repositoryId: number | null,
    permissions: Permissions,
    force = false,
  ): Promise<GitHubResult<string>> {
    const key = `${installationId}:${repositoryId}:${JSON.stringify(permissions)}`;
    const cached = this.#tokens.get(key);
    if (!force && cached !== undefined && cached.expiresAt > this.now() + 60_000)
      return { ok: true, value: cached.token };
    try {
      const result = await this.#http(
        `/app/installations/${installationId}/access_tokens`,
        `Bearer ${this.#jwt()}`,
        Tokens,
        {
          method: "POST",
          body: {
            ...(repositoryId === null ? {} : { repository_ids: [repositoryId] }),
            permissions,
          },
        },
      );
      if (!result.ok) return result;
      this.#tokens.set(key, {
        token: result.value.token,
        expiresAt: Date.parse(result.value.expires_at),
      });
      return { ok: true, value: result.value.token };
    } catch {
      return failure();
    }
  }

  async #repo<T>(
    installationId: number,
    repository: GitHubRepository,
    suffix: string,
    schema: z.ZodType<T>,
    permissions: Permissions,
    options: { method?: string; body?: unknown; signal?: AbortSignal | undefined } = {},
  ): Promise<GitHubResult<T> & { hasNext?: boolean }> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.token(installationId, repository.id, permissions, attempt === 1);
      if (!token.ok) return token;
      const response = await this.#http(
        `/repos/${repository.fullName}${suffix}`,
        `Bearer ${token.value}`,
        schema,
        options,
      );
      if (response.status !== 401 || attempt === 1) return response;
    }
    return failure();
  }

  async #collection<T>(
    installationId: number,
    repository: GitHubRepository,
    path: string,
    schema: z.ZodType<T[]>,
    permissions: Permissions,
  ): Promise<GitHubResult<T[]>> {
    const items: T[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const result = await this.#repo(
        installationId,
        repository,
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
        schema,
        permissions,
      );
      if (!result.ok) return result;
      items.push(...result.value);
      if (!result.hasNext && result.value.length < 100) return { ok: true, value: items };
    }
    return {
      ok: false,
      error: {
        code: "unavailable",
        message:
          "GitHub returned more than 1,000 records. Status could not be fully read; review the pull request on GitHub.",
      },
    };
  }

  async repositories(
    installationId: number,
    refresh = false,
  ): Promise<GitHubResult<GitHubRepository[]>> {
    const token = await this.token(installationId, null, { metadata: "read" }, refresh);
    if (!token.ok) return token;
    const repositories: GitHubRepository[] = [];
    for (let page = 1; ; page += 1) {
      const response = await this.#http(
        `/installation/repositories?per_page=100&page=${page}`,
        `Bearer ${token.value}`,
        z.object({ repositories: z.array(Repository) }),
      );
      if (response.status === 401 && !refresh) return this.repositories(installationId, true);
      if (!response.ok) return response;
      for (const repo of response.value.repositories) {
        if (repo.archived || repo.disabled) continue;
        const parsed = GitHubRepositorySchema.safeParse({
          id: repo.id,
          fullName: repo.full_name,
          defaultBranch: repo.default_branch,
          private: repo.private,
        });
        if (parsed.success) repositories.push(parsed.data);
      }
      if (response.value.repositories.length < 100) return { ok: true, value: repositories };
    }
  }

  permission(installationId: number, repository: GitHubRepository, login: string) {
    return this.#repo(
      installationId,
      repository,
      `/collaborators/${encodeURIComponent(login)}/permission`,
      Permission,
      { metadata: "read" },
    );
  }
  async repository(installationId: number, repository: GitHubRepository) {
    const current = await this.#repo(installationId, repository, "", Repository, {
      metadata: "read",
    });
    if (current.ok && current.value.id === repository.id) return current;
    // GitHub redirects renamed repositories. Rediscover by stable ID instead of forwarding credentials.
    const selected = await this.repositories(installationId);
    if (!selected.ok) return selected;
    const renamed = selected.value.find((entry) => entry.id === repository.id);
    if (renamed === undefined) return failure<z.infer<typeof Repository>>(403);
    return this.#repo(installationId, renamed, "", Repository, { metadata: "read" });
  }
  branch(installationId: number, repository: GitHubRepository, branch: string) {
    return this.#repo(
      installationId,
      repository,
      `/git/ref/heads/${encodeURIComponent(branch)}`,
      z.object({ object: z.object({ sha: z.string() }) }),
      { contents: "read" },
    );
  }
  pullRequest(installationId: number, repository: GitHubRepository, number: number) {
    return this.#repo(installationId, repository, `/pulls/${number}`, PullRequest, {
      pull_requests: "read",
    });
  }
  findPullRequests(
    installationId: number,
    repository: GitHubRepository,
    branch: string,
    base: string,
  ) {
    const owner = repository.fullName.split("/")[0];
    return this.#repo(
      installationId,
      repository,
      `/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(base)}&per_page=100`,
      z.array(PullRequest),
      { pull_requests: "read" },
    );
  }
  createPullRequest(
    installationId: number,
    repository: GitHubRepository,
    options: {
      head: string;
      base: string;
      title: string;
      body: string;
      signal?: AbortSignal | undefined;
    },
  ) {
    return this.#repo(
      installationId,
      repository,
      "/pulls",
      PullRequest,
      { pull_requests: "write" },
      {
        method: "POST",
        body: {
          head: options.head,
          base: options.base,
          title: options.title,
          body: options.body,
          draft: true,
        },
        signal: options.signal,
      },
    );
  }
  async checks(installationId: number, repository: GitHubRepository, sha: string) {
    const result = await this.#collection(
      installationId,
      repository,
      `/commits/${encodeURIComponent(sha)}/check-runs`,
      Checks.transform((value) => value.check_runs),
      { checks: "read" },
    );
    return result.ok ? { ok: true as const, value: { check_runs: result.value } } : result;
  }
  async statuses(installationId: number, repository: GitHubRepository, sha: string) {
    const result = await this.#collection(
      installationId,
      repository,
      `/commits/${encodeURIComponent(sha)}/status`,
      Statuses.transform((value) => value.statuses),
      { statuses: "read" },
    );
    return result.ok ? { ok: true as const, value: { statuses: result.value } } : result;
  }
  reviews(installationId: number, repository: GitHubRepository, number: number) {
    return this.#collection(
      installationId,
      repository,
      `/pulls/${number}/reviews`,
      z.array(Review),
      { pull_requests: "read" },
    );
  }
  comments(installationId: number, repository: GitHubRepository, number: number) {
    return this.#collection(
      installationId,
      repository,
      `/issues/${number}/comments`,
      z.array(Comment),
      { pull_requests: "read" },
    );
  }
  reviewComments(installationId: number, repository: GitHubRepository, number: number) {
    return this.#collection(
      installationId,
      repository,
      `/pulls/${number}/comments`,
      z.array(Comment),
      { pull_requests: "read" },
    );
  }
}
