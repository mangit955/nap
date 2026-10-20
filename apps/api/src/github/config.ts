import { createPrivateKey } from "node:crypto";
import type { Env } from "../env.ts";
import { type GitHubConfig, GitHubConfigSchema } from "./app.ts";

type ConfigEnv = Pick<
  Env,
  | "NAP_API_URL"
  | "NAP_WEB_ORIGIN"
  | "NAP_GITHUB_APP_ID"
  | "NAP_GITHUB_APP_SLUG"
  | "NAP_GITHUB_CLIENT_ID"
  | "NAP_GITHUB_CLIENT_SECRET"
  | "NAP_GITHUB_PRIVATE_KEY"
  | "NAP_GITHUB_WEBHOOK_SECRET"
>;

export function githubConfigFromEnv(env: ConfigEnv): GitHubConfig | null {
  const values = [
    env.NAP_GITHUB_APP_ID,
    env.NAP_GITHUB_APP_SLUG,
    env.NAP_GITHUB_CLIENT_ID,
    env.NAP_GITHUB_CLIENT_SECRET,
    env.NAP_GITHUB_PRIVATE_KEY,
    env.NAP_GITHUB_WEBHOOK_SECRET,
  ];
  if (values.every((value) => value === undefined)) return null;
  const parsed = GitHubConfigSchema.safeParse({
    appId: env.NAP_GITHUB_APP_ID,
    slug: env.NAP_GITHUB_APP_SLUG,
    clientId: env.NAP_GITHUB_CLIENT_ID,
    clientSecret: env.NAP_GITHUB_CLIENT_SECRET,
    privateKey: env.NAP_GITHUB_PRIVATE_KEY?.replaceAll("\\n", "\n"),
    webhookSecret: env.NAP_GITHUB_WEBHOOK_SECRET,
    apiUrl: env.NAP_API_URL.replace(/\/+$/, ""),
    webOrigin: env.NAP_WEB_ORIGIN.replace(/\/+$/, ""),
  });
  if (!parsed.success)
    throw new Error(
      "Incomplete GitHub App configuration. Set all NAP_GITHUB_* variables; see docs/github-integration.md.",
    );
  try {
    if (createPrivateKey(parsed.data.privateKey).asymmetricKeyType !== "rsa")
      throw new Error("Invalid key type");
  } catch {
    throw new Error(
      "NAP_GITHUB_PRIVATE_KEY must contain the GitHub App RSA private key in PEM format.",
    );
  }
  return parsed.data;
}

export function githubAppManifest(apiUrl: string, webOrigin: string) {
  const api = new URL(apiUrl).origin;
  const web = new URL(webOrigin).origin;
  return {
    name: "Nap repository connection",
    url: web,
    hook_attributes: { url: `${api}/github/webhook`, active: true },
    redirect_url: `${web}/settings/connections`,
    callback_urls: [`${api}/github/callback`],
    setup_url: `${api}/github/setup`,
    setup_on_update: true,
    request_oauth_on_install: false,
    public: true,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      checks: "read",
      statuses: "read",
      metadata: "read",
    },
    default_events: [
      "installation",
      "installation_repositories",
      "repository",
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "issue_comment",
      "check_run",
      "check_suite",
      "status",
    ],
  };
}
