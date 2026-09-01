/**
 * The claims `.railway/railway.ts` makes that nothing else would notice breaking.
 *
 * Railway's deployment is three services built from one image, differing only in the entrypoint
 * they start and whether they answer a healthcheck. Every mistake worth guarding here is silent:
 * a worker that inherits `/health` boots correctly, logs `worker claiming`, and *then* fails its
 * deploy; a second reaper tears down every sandbox twice; a drain shorter than the application's
 * own turns a rolling restart into a kill. None of them is a crash, and none shows up in a test
 * suite that never reads this file.
 *
 * Kept pure — a compiled project graph in, violations out — so the rules can be run against
 * deliberately broken input as well as against the real config. See docs/DEPLOY.md.
 */

/** The subset of Railway's compiled graph these rules read. */
export type ServiceLike = {
  name: string;
  type?: string;
  deploy?: {
    startCommand?: string | null;
    healthcheckPath?: string | null;
    sleepApplication?: boolean | null;
    drainingSeconds?: number | null;
    multiRegionConfig?: Record<string, { numReplicas?: number | null } | null> | null;
    numReplicas?: number | null;
  } | null;
  variables?: Record<string, { type?: string; value?: string | null } | null> | null;
};

export type ProjectLike = { name: string; resources: readonly ServiceLike[] };

export type DeploymentViolation = { service: string; rule: string; detail: string };

/**
 * The entrypoint each role must start. The API's is the Dockerfile's default and so is absent
 * rather than empty — setting it would be harmless but would hide a change to the image.
 */
const REQUIRED_START: Record<string, string | null> = {
  "nap-api": null,
  "nap-worker": "bun apps/api/src/worker.ts",
  "nap-reaper": "bun apps/api/src/reaper.ts",
};

/**
 * `NAP_DRAIN_TIMEOUT_SECONDS`'s default, from apps/api/src/env.ts. The platform's grace period has
 * to comfortably exceed it or the worker's drain never finishes.
 */
const WORKER_DRAIN_TIMEOUT_SECONDS = 600;

/** Anything matching this in a committed config file is a credential that should be preserve()d. */
const SECRET_NAME = /(SECRET|_KEY|KEY_|TOKEN|PASSWORD|DATABASE_URL)/;

function replicasOf(service: ServiceLike): number | undefined {
  const deploy = service.deploy;
  if (!deploy) return undefined;
  if (typeof deploy.numReplicas === "number") return deploy.numReplicas;
  const regions = Object.values(deploy.multiRegionConfig ?? {});
  const counts = regions.map((r) => r?.numReplicas ?? 0);
  return counts.length === 0 ? undefined : counts.reduce((a, b) => a + b, 0);
}

export function findDeploymentViolations(project: ProjectLike): DeploymentViolation[] {
  const violations: DeploymentViolation[] = [];
  const services = project.resources.filter((r) => (r.type ?? "service") === "service");
  const byName = new Map(services.map((s) => [s.name, s]));

  for (const name of Object.keys(REQUIRED_START)) {
    if (!byName.has(name)) {
      violations.push({ service: name, rule: "present", detail: "service is not declared" });
    }
  }

  for (const service of services) {
    const { name, deploy } = service;
    const expectedStart = REQUIRED_START[name];
    const actualStart = deploy?.startCommand ?? null;

    if (name in REQUIRED_START && actualStart !== expectedStart) {
      violations.push({
        service: name,
        rule: "start-command",
        detail: `starts ${actualStart ?? "the image default"}, expected ${expectedStart ?? "the image default"}`,
      });
    }

    // Only the process that serves HTTP may be healthchecked. The other two answer nothing, so a
    // healthcheck on them fails the deploy of a process that booted perfectly.
    const healthcheck = deploy?.healthcheckPath ?? "";
    const serves = name === "nap-api";
    if (serves && healthcheck === "") {
      violations.push({
        service: name,
        rule: "healthcheck",
        detail: "serves HTTP but declares no healthcheck",
      });
    }
    if (!serves && healthcheck !== "") {
      violations.push({
        service: name,
        rule: "healthcheck",
        detail: `serves nothing but is healthchecked on ${healthcheck}`,
      });
    }

    // A sleeping reaper is not reaping, while the sandboxes it should have destroyed keep billing.
    if (deploy?.sleepApplication !== false) {
      violations.push({
        service: name,
        rule: "no-sleep",
        detail: "app sleeping is not explicitly off",
      });
    }

    // Exactly one reaper, permanently: two would snapshot and destroy every idle project twice.
    if (name === "nap-reaper" && replicasOf(service) !== 1) {
      violations.push({
        service: name,
        rule: "single-reaper",
        detail: `has ${replicasOf(service) ?? "an unspecified number of"} replicas, must have exactly 1`,
      });
    }

    // Railway's default grace period is zero seconds, so an undeclared drain is a SIGKILL.
    const draining = deploy?.drainingSeconds ?? 0;
    if (draining <= 0) {
      violations.push({
        service: name,
        rule: "drain",
        detail: "no draining period; SIGTERM is followed by SIGKILL",
      });
    }
    if (name === "nap-worker" && draining <= WORKER_DRAIN_TIMEOUT_SECONDS) {
      violations.push({
        service: name,
        rule: "drain",
        detail: `drains for ${draining}s, which does not exceed NAP_DRAIN_TIMEOUT_SECONDS (${WORKER_DRAIN_TIMEOUT_SECONDS}s)`,
      });
    }

    // No credential in a committed file. A secret must be preserve()d, never given a literal value.
    for (const [key, config] of Object.entries(service.variables ?? {})) {
      if (!SECRET_NAME.test(key)) continue;
      if (config?.type === "literal" || typeof config?.value === "string") {
        violations.push({
          service: name,
          rule: "no-committed-secret",
          detail: `${key} has a literal value; use preserve()`,
        });
      }
    }
  }

  return violations;
}
