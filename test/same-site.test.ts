/**
 * The deployment as committed puts the app and the API on one site.
 *
 * Production once ran the app on `vercel.app` and the API on `onrender.com`: two sites, so the
 * session cookie was third-party and Safari and Brave dropped it — sign-in answered 200 and every
 * request after it was a 401. The API now refuses to boot that way, but only once deployed; this
 * reads the same two URLs out of `render.yaml` so the mistake fails CI instead.
 *
 * The one site is reached by publishing the API under the web app's own origin: Vercel forwards
 * `/backend/*` to Render (`apps/web/vercel.json`). That forward carries every authenticated
 * response, so it must never be cached — a cached response is somebody else's.
 * See `docs/DEPLOY.md` § One site for both halves.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";
import { isCrossSite } from "../apps/api/src/auth/cross-site.ts";

const repoRoot = join(import.meta.dirname, "..");

const RenderSchema = z.object({
  services: z.array(
    z.object({
      name: z.string(),
      envVars: z.array(z.object({ key: z.string(), value: z.string().optional() })).optional(),
    }),
  ),
});

const VercelSchema = z.object({
  rewrites: z.array(z.object({ source: z.string(), destination: z.string() })).default([]),
  headers: z
    .array(
      z.object({
        source: z.string(),
        headers: z.array(z.object({ key: z.string(), value: z.string() })),
      }),
    )
    .default([]),
});

function renderEnv(service: string): Map<string, string | undefined> {
  const blueprint = RenderSchema.parse(parse(readFileSync(join(repoRoot, "render.yaml"), "utf8")));
  const found = blueprint.services.find((candidate) => candidate.name === service);
  if (found === undefined) throw new Error(`render.yaml has no service named ${service}`);
  return new Map((found.envVars ?? []).map((variable) => [variable.key, variable.value]));
}

function vercelConfig() {
  return VercelSchema.parse(
    JSON.parse(readFileSync(join(repoRoot, "apps/web/vercel.json"), "utf8")),
  );
}

describe("the committed deployment", () => {
  it.each(["nap-api", "nap-worker", "nap-reaper"])("serves %s's two URLs from one site", (name) => {
    const env = renderEnv(name);
    const apiUrl = env.get("NAP_API_URL");
    const webOrigin = env.get("NAP_WEB_ORIGIN");

    expect(env.get("NODE_ENV")).toBe("production");
    expect(apiUrl).toBeDefined();
    expect(webOrigin).toBeDefined();
    expect(isCrossSite(apiUrl ?? "", webOrigin ?? "")).toBe(false);
  });

  it("forwards the API's public path to Render, uncached", () => {
    const apiUrl = new URL(renderEnv("nap-api").get("NAP_API_URL") ?? "");
    const source = `${apiUrl.pathname.replace(/\/+$/, "")}/:path*`;
    const config = vercelConfig();

    const rewrite = config.rewrites.find((candidate) => candidate.source === source);
    expect(rewrite?.destination).toMatch(/^https:\/\/[^/]+\.onrender\.com\/:path\*$/);

    const caching = config.headers
      .filter((rule) => rule.source === source)
      .flatMap((rule) => rule.headers)
      .find((header) => header.key === "x-vercel-enable-rewrite-caching");
    expect(caching?.value).toBe("0");
  });
});
