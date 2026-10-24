import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { releaseProduction } from "../scripts/production-release.ts";

const commit = "a".repeat(40);
const config = { commit, renderKey: "render-secret", vercelToken: "vercel-secret" };

function provider({
  fail = "",
  pending = false,
  wrongCommit = false,
  existing = false,
  renderStatus = "live",
  webStatus = "READY",
} = {}) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  let clock = 0;
  return {
    calls,
    now: () => clock,
    sleep: async () => {
      clock += 20 * 60 * 1000;
    },
    log: () => {},
    request: async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      if (fail && url.includes(fail)) return new Response("secret upstream error", { status: 500 });
      let data: unknown;
      if (url.includes("api.vercel.com/v9/projects")) {
        data = { id: "prj_Bq52DMps37jGzCZCoZW9K8puDUeV", rootDirectory: "apps/web" };
      } else if (url.includes("api.vercel.com")) {
        data = { id: "dpl_web", readyState: webStatus, meta: { githubCommitSha: commit } };
      } else if (url.endsWith("/readyz")) {
        data = { status: "ok" };
      } else if (url.includes("/deploys?")) {
        data = existing
          ? [{ deploy: { id: "dep_existing", status: "live", commit: { id: commit } } }]
          : [];
      } else if (url.includes("/deploys")) {
        data = {
          id: "dep_release",
          status: pending ? "build_in_progress" : renderStatus,
          commit: { id: wrongCommit ? "b".repeat(40) : commit },
        };
      } else {
        data = { autoDeploy: "no" };
      }
      return Response.json(data);
    },
  };
}

describe("production release", () => {
  it("waits for API, readiness, reaper and worker before publishing the exact web commit", async () => {
    const io = provider();
    await releaseProduction(config, io);
    const writes = io.calls.filter((c) => c.method === "POST");
    expect(writes.map((c) => c.url)).toEqual([
      "https://api.render.com/v1/services/srv-dbc2u5m1egvs739agesg/deploys",
      "https://api.render.com/v1/services/srv-dbc2vg8n74is73f6cg10/deploys",
      "https://api.render.com/v1/services/srv-dbc2vg3rjlhs73al1lng/deploys",
      "https://api.vercel.com/v13/deployments?teamId=team_wMX8jYWlNAfotw26ahY1ldcJ",
    ]);
    for (const c of writes.slice(0, 3)) expect(c.body).toEqual({ commitId: commit });
    expect(writes[3]?.body).toMatchObject({
      target: "production",
      gitSource: { ref: "main", sha: commit },
    });
    expect(io.calls.findIndex((c) => c.url.endsWith("/readyz"))).toBeLessThan(
      io.calls.indexOf(writes[1]!),
    );
    for (const write of writes.slice(0, 3)) {
      const index = io.calls.indexOf(write);
      expect(io.calls[index + 1]?.url).toBe(`${write.url}/dep_release`);
    }
  });

  it("fails before starting any deployment when credentials are missing", async () => {
    const io = provider();
    await expect(releaseProduction({ ...config, vercelToken: "" }, io)).rejects.toThrow();
    expect(io.calls).toEqual([]);
  });

  it("preflights Vercel credentials before changing Render", async () => {
    const io = provider({ fail: "api.vercel.com" });
    await expect(releaseProduction(config, io)).rejects.toThrow("HTTP 500");
    expect(io.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("stops the release when a backend deployment fails without logging its response body", async () => {
    const io = provider({ fail: "srv-dbc2vg8n74is73f6cg10/deploys/" });
    await expect(releaseProduction(config, io)).rejects.toThrow("HTTP 500");
    expect(io.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("rejects a deployment that reports a different commit", async () => {
    const io = provider({ wrongCommit: true });
    await expect(releaseProduction(config, io)).rejects.toThrow("commit mismatch");
    expect(io.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("times out a stalled deploy before starting the next service", async () => {
    const io = provider({ pending: true });
    await expect(releaseProduction(config, io)).rejects.toThrow("timed out");
    expect(io.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("reuses backend deployments already live at the release commit on a retry", async () => {
    const io = provider({ existing: true });
    await releaseProduction(config, io);
    expect(io.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(io.calls.find((c) => c.method === "POST")?.url).toContain("api.vercel.com");
  });

  it("stops before the reaper when API readiness fails", async () => {
    const io = provider({ fail: "/readyz" });
    await expect(releaseProduction(config, io)).rejects.toThrow("HTTP 500");
    expect(io.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("rejects a failed Render deployment instead of continuing to the web", async () => {
    const io = provider({ renderStatus: "build_failed" });
    await expect(releaseProduction(config, io)).rejects.toThrow("build_failed");
    expect(io.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("reports a failed Vercel build as a failed release", async () => {
    const io = provider({ webStatus: "ERROR" });
    await expect(releaseProduction(config, io)).rejects.toThrow("web: ERROR");
  });

  it("gates production on both CI jobs and prevents main releases from cancelling each other", () => {
    const workflow = parse(
      readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    );
    expect(workflow.concurrency).toEqual({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions are literal configuration here.
      group: "${{ github.workflow }}-${{ github.ref }}",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expressions are literal configuration here.
      "cancel-in-progress": "${{ github.ref != 'refs/heads/main' }}",
    });
    expect(workflow.jobs.production.needs).toEqual(["check", "python"]);
    expect(workflow.jobs.production.if).toBe(
      "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')",
    );
    const vercel = JSON.parse(
      readFileSync(new URL("../apps/web/vercel.json", import.meta.url), "utf8"),
    );
    expect(vercel.git.deploymentEnabled).toEqual({ main: false });
    const render = parse(readFileSync(new URL("../render.yaml", import.meta.url), "utf8"));
    expect(
      render.services.map((service: { autoDeployTrigger: string }) => service.autoDeployTrigger),
    ).toEqual(["off", "off", "off"]);
  });
});
