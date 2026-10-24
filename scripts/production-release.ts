import { pathToFileURL } from "node:url";
import { z } from "zod";

const Config = z.object({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  renderKey: z.string().min(1),
  vercelToken: z.string().min(1),
});
const RenderDeploy = z.object({
  id: z.string(),
  status: z.string(),
  commit: z.object({ id: z.string() }),
});
const VercelDeploy = z.object({
  id: z.string(),
  readyState: z.string(),
  meta: z.object({ githubCommitSha: z.string() }),
});
const services = [
  ["api", "srv-dbc2u5m1egvs739agesg"],
  ["reaper", "srv-dbc2vg8n74is73f6cg10"],
  ["worker", "srv-dbc2vg3rjlhs73al1lng"],
] as const;
const project = "prj_Bq52DMps37jGzCZCoZW9K8puDUeV";
const teamQuery = "?teamId=team_wMX8jYWlNAfotw26ahY1ldcJ";
const activeRenderStates = new Set([
  "created",
  "build_in_progress",
  "pre_deploy_in_progress",
  "update_in_progress",
]);
const activeVercelStates = new Set(["QUEUED", "INITIALIZING", "BUILDING"]);
const timeoutMs = 20 * 60 * 1000;

type ReleaseIO = {
  request: (url: string, init?: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (message: string) => void;
};

/** Deploy one commit to every process, stopping before the web app if any backend fails. */
export async function releaseProduction(input: unknown, overrides: Partial<ReleaseIO> = {}) {
  const config = Config.parse(input);
  const io: ReleaseIO = {
    request: fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    log: console.log,
    ...overrides,
  };
  async function request(url: string, token?: string, body?: unknown): Promise<unknown> {
    const response = await io.request(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    // Upstream error bodies can contain credentials or internal configuration.
    if (!response.ok) throw new Error(`${new URL(url).pathname}: HTTP ${response.status}`);
    return response.json();
  }

  // Discover bad credentials before rolling any process forward.
  const vercel = z.object({ id: z.literal(project), rootDirectory: z.literal("apps/web") });
  vercel.parse(
    await request(`https://api.vercel.com/v9/projects/${project}${teamQuery}`, config.vercelToken),
  );
  for (const [, id] of services) {
    z.object({ autoDeploy: z.literal("no") }).parse(
      await request(`https://api.render.com/v1/services/${id}`, config.renderKey),
    );
  }

  for (const [name, id] of services) {
    const base = `https://api.render.com/v1/services/${id}/deploys`;
    const recent = z
      .array(z.object({ deploy: RenderDeploy }))
      .parse(await request(`${base}?limit=1`, config.renderKey))[0]?.deploy;
    if (recent && activeRenderStates.has(recent.status) && recent.commit.id !== config.commit) {
      throw new Error(`${name}: another commit is deploying (${recent.id})`);
    }
    const reuse =
      recent?.commit.id === config.commit &&
      (recent.status === "live" || activeRenderStates.has(recent.status));
    const deploy = reuse
      ? recent
      : RenderDeploy.parse(await request(base, config.renderKey, { commitId: config.commit }));
    io.log(`${name}: ${deploy.id} at ${config.commit}`);
    const deadline = io.now() + timeoutMs;
    while (true) {
      const current = RenderDeploy.parse(await request(`${base}/${deploy.id}`, config.renderKey));
      if (current.commit.id !== config.commit) throw new Error(`${name}: commit mismatch`);
      if (current.status === "live") break;
      if (!activeRenderStates.has(current.status)) throw new Error(`${name}: ${current.status}`);
      if (io.now() >= deadline) throw new Error(`${name}: deployment timed out (${deploy.id})`);
      await io.sleep(15_000);
    }
    if (name === "api") {
      z.object({ status: z.literal("ok") }).parse(
        await request("https://nap-api.onrender.com/readyz"),
      );
    }
    io.log(`${name}: live`);
  }

  // A deploy hook follows a branch tip. Pinning sha keeps a concurrent merge out of this release.
  const deploy = VercelDeploy.parse(
    await request(`https://api.vercel.com/v13/deployments${teamQuery}`, config.vercelToken, {
      name: "nap",
      project,
      target: "production",
      gitSource: { type: "github", repoId: "1326279429", ref: "main", sha: config.commit },
    }),
  );
  io.log(`web: ${deploy.id} at ${config.commit}`);
  const deadline = io.now() + timeoutMs;
  while (true) {
    const current = VercelDeploy.parse(
      await request(
        `https://api.vercel.com/v13/deployments/${deploy.id}${teamQuery}`,
        config.vercelToken,
      ),
    );
    if (current.meta.githubCommitSha !== config.commit) throw new Error("web: commit mismatch");
    if (current.readyState === "READY") break;
    if (!activeVercelStates.has(current.readyState)) throw new Error(`web: ${current.readyState}`);
    if (io.now() >= deadline) throw new Error(`web: deployment timed out (${deploy.id})`);
    await io.sleep(15_000);
  }
  io.log(`Production release complete: ${config.commit}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await releaseProduction({
    commit: process.argv[2],
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: This entrypoint runs directly in CI, outside Turbo.
    renderKey: process.env.RENDER_API_KEY,
    vercelToken: process.env.VERCEL_TOKEN,
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Production release failed");
    process.exitCode = 1;
  });
}
