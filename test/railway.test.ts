import { createRailwayContext, project as defineProject } from "railway/iac";
import { describe, expect, it } from "vitest";
import railwayConfig from "../.railway/railway.ts";
import { findDeploymentViolations, type ProjectLike, type ServiceLike } from "./railway.ts";

/**
 * The Railway deployment, checked against the mistakes that produce no error anywhere.
 *
 * Each rule is asserted twice: once against the config we ship, and once against a synthetic
 * service that breaks it. The second half is the one that matters — a rule nobody has watched fail
 * may be passing on everything, and every failure guarded here is silent in production.
 *
 * The config is *compiled* rather than parsed, so this tests what Railway would receive rather
 * than what the file looks like. That is what catches an option written under a plausible-looking
 * name the SDK ignores.
 */

const compiled = (await railwayConfig(createRailwayContext(), defineProject)) as ProjectLike;

/** A service that satisfies every rule, so a test can break exactly one thing. */
function healthyWorker(overrides: Partial<ServiceLike["deploy"]> = {}): ServiceLike {
  return {
    name: "nap-worker",
    type: "service",
    deploy: {
      startCommand: "bun apps/api/src/worker.ts",
      healthcheckPath: "",
      sleepApplication: false,
      drainingSeconds: 900,
      multiRegionConfig: { sfo: { numReplicas: 1 } },
      ...overrides,
    },
  };
}

function projectOf(...resources: ServiceLike[]): ProjectLike {
  return { name: "nap", resources };
}

describe("the shipped Railway config", () => {
  it("declares the three processes and nothing else", () => {
    expect(compiled.resources.map((r) => r.name).sort()).toEqual([
      "nap-api",
      "nap-reaper",
      "nap-worker",
    ]);
  });

  it("breaks none of the deployment rules", () => {
    expect(findDeploymentViolations(compiled)).toEqual([]);
  });

  it("builds every service from the repository's Dockerfile", () => {
    for (const service of compiled.resources) {
      expect((service as { build?: { dockerfilePath?: string } }).build?.dockerfilePath).toBe(
        "Dockerfile",
      );
    }
  });
});

describe("the rules, on input that breaks them", () => {
  it("catches a worker that inherits the API's healthcheck", () => {
    const violations = findDeploymentViolations(
      projectOf(healthyWorker({ healthcheckPath: "/health" })),
    );
    expect(violations).toContainEqual({
      service: "nap-worker",
      rule: "healthcheck",
      detail: "serves nothing but is healthchecked on /health",
    });
  });

  it("catches a worker left on the image's default entrypoint", () => {
    const violations = findDeploymentViolations(projectOf(healthyWorker({ startCommand: null })));
    expect(violations.map((v) => v.rule)).toContain("start-command");
  });

  it("catches a second reaper", () => {
    const reaper = healthyWorker({
      startCommand: "bun apps/api/src/reaper.ts",
      multiRegionConfig: { sfo: { numReplicas: 2 } },
    });
    const violations = findDeploymentViolations(projectOf({ ...reaper, name: "nap-reaper" }));
    expect(violations.map((v) => v.rule)).toContain("single-reaper");
  });

  it("catches a drain the worker's own timeout would outlast", () => {
    const violations = findDeploymentViolations(projectOf(healthyWorker({ drainingSeconds: 30 })));
    expect(violations.map((v) => v.detail)).toContainEqual(
      expect.stringContaining("does not exceed NAP_DRAIN_TIMEOUT_SECONDS"),
    );
  });

  it("catches an undeclared drain, which on Railway means SIGKILL", () => {
    const violations = findDeploymentViolations(
      projectOf(healthyWorker({ drainingSeconds: null })),
    );
    expect(violations.map((v) => v.rule)).toContain("drain");
  });

  it("catches app sleeping left on", () => {
    const violations = findDeploymentViolations(
      projectOf(healthyWorker({ sleepApplication: null })),
    );
    expect(violations.map((v) => v.rule)).toContain("no-sleep");
  });

  it("catches a credential given a literal value", () => {
    const worker = healthyWorker();
    const violations = findDeploymentViolations(
      projectOf({
        ...worker,
        variables: { OPENROUTER_API_KEY: { type: "literal", value: "sk-or-v1-oops" } },
      }),
    );
    expect(violations).toContainEqual({
      service: "nap-worker",
      rule: "no-committed-secret",
      detail: "OPENROUTER_API_KEY has a literal value; use preserve()",
    });
  });

  it("catches a missing service", () => {
    const violations = findDeploymentViolations(projectOf(healthyWorker()));
    expect(
      violations
        .filter((v) => v.rule === "present")
        .map((v) => v.service)
        .sort(),
    ).toEqual(["nap-api", "nap-reaper"]);
  });
});
