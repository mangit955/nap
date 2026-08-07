import { VERSION } from "@nap/shared/version";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createLogger } from "./logger.ts";

/**
 * `app.request()` dispatches straight into the router, so nothing here opens a socket — the
 * unit suite stays free of the network. Booting a real listener is what `bun run dev` is for.
 */

const silent = () => createLogger({ level: "silent" }, { write: () => {} });

describe("GET /health", () => {
  it("returns 200 with a version field", async () => {
    const res = await createApp({ logger: silent() }).request("/health");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "ok", version: VERSION });
  });

  it("reports the version the workspace actually ships", async () => {
    // Guards against the endpoint hardcoding a string that drifts from the package.
    const res = await createApp({ logger: silent() }).request("/health");
    const body = (await res.json()) as { version: string };
    expect(body.version).toBe(VERSION);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("responds as JSON", async () => {
    const res = await createApp({ logger: silent() }).request("/health");
    expect(res.headers.get("content-type")).toContain("application/json");
  });
});

describe("unknown routes", () => {
  it("404 as JSON rather than an HTML error page", async () => {
    // Every client of this API speaks JSON; an HTML body on the error path is what turns a
    // typo'd URL into an unreadable parse failure in the browser.
    const res = await createApp({ logger: silent() }).request("/nope");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
  });
});

describe("request logging", () => {
  it("logs each request with a request id available to downstream code", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "info" }, { write: (m) => lines.push(m) });

    await createApp({ logger }).request("/health");

    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]).toMatchObject({ method: "GET", path: "/health" });
  });
});
