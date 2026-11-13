import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { NapRole } from "../apps/api/src/compose.ts";
import { connectionsHeld } from "../apps/api/src/database-pool.ts";
import { PoolEnvSchema } from "../apps/api/src/env.ts";
import { connectionBudgetViolations, type DeployedProcess } from "./connection-budget.ts";

/**
 * Every deployment this repo describes, checked against the database it runs on.
 *
 * The per-process numbers come from `connectionsHeld`, the function boot sizes the pool with, and
 * the settings from the files the deployments read, with the env schema's own defaults for what
 * they leave out. A test that repeated either would go on passing after the pool rule changed.
 */

const ROOT = join(import.meta.dirname, "..");
const K8S = join(ROOT, "infra", "k8s");

/**
 * Render Postgres's limit by plan. Every plan under 8 GB of memory allows 100, per Render's own
 * table (render.com/docs/databases). A plan missing from here fails the test rather than being
 * guessed at: an upgrade is exactly when somebody should look this up again.
 */
const RENDER_MAX_CONNECTIONS: Record<string, number> = {
  free: 100,
  "basic-256mb": 100,
  "basic-1gb": 100,
  "basic-4gb": 100,
};

type RenderService = {
  name: string;
  type: string;
  dockerCommand?: string;
  numInstances?: number;
  envVars?: { key: string; value?: string }[];
};

function roleOf(command: string | undefined): NapRole {
  if (command === undefined) return "api";
  if (command.includes("worker.ts")) return "worker";
  if (command.includes("reaper.ts")) return "reaper";
  throw new Error(`no role for the command ${command}`);
}

function renderDeployment(): { processes: DeployedProcess[]; maxConnections: number } {
  const render = parse(readFileSync(join(ROOT, "render.yaml"), "utf8")) as {
    databases: { plan: string }[];
    services: RenderService[];
  };
  const plan = render.databases[0]?.plan ?? "";
  const maxConnections = RENDER_MAX_CONNECTIONS[plan];
  if (maxConnections === undefined) throw new Error(`no connection limit known for ${plan}`);

  const processes = render.services.map((service) => {
    const values = Object.fromEntries(
      (service.envVars ?? [])
        .filter((v) => v.value !== undefined)
        .map((v) => [v.key, v.value as string]),
    );
    return {
      name: service.name,
      replicas: service.numInstances ?? 1,
      connections: connectionsHeld(roleOf(service.dockerCommand), PoolEnvSchema.parse(values)),
    };
  });
  return { processes, maxConnections };
}

function yamlDocuments(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split(/^---$/m)
    .map((text) => parse(text) as Record<string, unknown> | null)
    .filter((doc): doc is Record<string, unknown> => doc !== null);
}

function configData(path: string): Record<string, string> {
  const map = yamlDocuments(path).find((doc) => doc.kind === "ConfigMap") as
    | { data: Record<string, string> }
    | undefined;
  return map?.data ?? {};
}

/** The local Postgres's `max_connections`: Postgres's default of 100 unless its args raise it. */
function localPostgresMaxConnections(): number {
  const text = readFileSync(join(K8S, "local", "postgres.yaml"), "utf8");
  const raised = /max_connections=(\d+)/.exec(text);
  return raised?.[1] === undefined ? 100 : Number(raised[1]);
}

function k8sDeployment(
  overlay: "proof" | "load",
  replicas: { api: number; worker: number; reaper: number },
): DeployedProcess[] {
  const env = PoolEnvSchema.parse({
    ...configData(join(K8S, "base", "configmap.yaml")),
    ...configData(join(K8S, overlay, "patch-config.yaml")),
  });
  return (["api", "worker", "reaper"] as const).map((role) => ({
    name: `nap-${role}`,
    replicas: replicas[role],
    connections: connectionsHeld(role, env),
  }));
}

describe("the connection budget", () => {
  it("fits the Render deployment, its rollouts included, on its database's plan", () => {
    const { processes, maxConnections } = renderDeployment();
    expect(connectionBudgetViolations(processes, maxConnections)).toEqual([]);
  });

  it("fits the proof cluster, whose replica counts are fixed", () => {
    // The proof overlay deletes both autoscalers, so the base deployments' counts are the counts.
    const base = (file: string) =>
      Number(
        (
          yamlDocuments(join(K8S, "base", file)).find((doc) => doc.kind === "Deployment") as {
            spec: { replicas: number };
          }
        ).spec.replicas,
      );
    const processes = k8sDeployment("proof", {
      api: base("deployment-api.yaml"),
      worker: base("deployment-worker.yaml"),
      reaper: base("deployment-reaper.yaml"),
    });
    expect(connectionBudgetViolations(processes, localPostgresMaxConnections())).toEqual([]);
  });

  it("fits the load cluster at both autoscalers' maximums", () => {
    // The ramp drives the autoscalers to their ceilings on purpose, so those are the counts.
    const scale = yamlDocuments(join(K8S, "load", "patch-scale.yaml"));
    const workers = scale.find((doc) => doc.kind === "ScaledObject") as {
      spec: { maxReplicaCount: number };
    };
    const api = scale.find((doc) => doc.kind === "HorizontalPodAutoscaler") as {
      spec: { maxReplicas: number };
    };
    const processes = k8sDeployment("load", {
      api: api.spec.maxReplicas,
      worker: workers.spec.maxReplicaCount,
      reaper: 1,
    });
    expect(connectionBudgetViolations(processes, localPostgresMaxConnections())).toEqual([]);
  });

  it("catches a second worker on the Render plan, and says by how much", () => {
    // The rule seen failing: what scaling the worker without resizing anything would do to the
    // free database. Raise the plan or shrink the pools first.
    const { processes, maxConnections } = renderDeployment();
    const twoWorkers = processes.map((p) => (p.name === "nap-worker" ? { ...p, replicas: 2 } : p));

    const violations = connectionBudgetViolations(twoWorkers, maxConnections);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/can hold \d+ connections at once, over the 97/);
    expect(violations[0]).toContain("nap-worker: 2 ×");
  });
});
