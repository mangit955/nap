import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { githubAppManifest, githubConfigFromEnv } from "./config.ts";

it("is disabled without app credentials, rejects partial configuration without exposing values", () => {
  expect(
    githubConfigFromEnv({
      NAP_API_URL: "http://localhost:3001",
      NAP_WEB_ORIGIN: "http://localhost:3000",
    }),
  ).toBeNull();
  expect(() =>
    githubConfigFromEnv({
      NAP_API_URL: "http://localhost:3001",
      NAP_WEB_ORIGIN: "http://localhost:3000",
      NAP_GITHUB_CLIENT_SECRET: "do-not-leak",
    }),
  ).toThrow("Incomplete GitHub App configuration");
});
it("builds the exact setup and callback URLs and requests only implemented permissions", () => {
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  const config = githubConfigFromEnv({
    NAP_API_URL: "https://api.example/",
    NAP_WEB_ORIGIN: "https://web.example/",
    NAP_GITHUB_APP_ID: 1,
    NAP_GITHUB_APP_SLUG: "nap-test",
    NAP_GITHUB_CLIENT_ID: "client",
    NAP_GITHUB_CLIENT_SECRET: "secret",
    NAP_GITHUB_PRIVATE_KEY: key,
    NAP_GITHUB_WEBHOOK_SECRET: "a-webhook-secret-long-enough",
  });
  expect(config?.apiUrl).toBe("https://api.example");
  const manifest = githubAppManifest("https://api.example", "https://web.example");
  expect(manifest).toMatchObject({
    callback_urls: ["https://api.example/github/callback"],
    setup_url: "https://api.example/github/setup",
    request_oauth_on_install: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      checks: "read",
      statuses: "read",
    },
  });
  expect(manifest.default_permissions).not.toHaveProperty("workflows");
});
