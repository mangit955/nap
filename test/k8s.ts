/**
 * The rules `infra/k8s/` has to keep, as functions rather than as review comments.
 *
 * Every check here exists because the mistake it catches is *silent*. A probe pointed at
 * `/health` never takes a broken pod out of the rotation, because that endpoint answers 200 while
 * degraded on purpose. An ingress with the default 60-second read timeout closes healthy
 * WebSockets from the middle, and the pod sees an ordinary disconnect. A worker whose grace period
 * is shorter than its drain is killed mid-turn, which costs a human a reopen and looks like a
 * successful rollout. None of these fail an apply, and none of them show up in a green cluster.
 *
 * Written against parsed manifests rather than against the filesystem, so each rule can be tested
 * on the manifests we ship *and* on a synthetic one that breaks it — a check nobody has watched
 * fail is not known to work.
 */

import { parseAllDocuments } from "yaml";

export type Manifest = {
  /** Which file it came from, so a violation names something you can open. */
  file: string;
  doc: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Walks a dotted path, answering `undefined` the moment the shape stops matching. */
function at(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Every YAML document in every file, flattened — a file may hold several. */
export function parseManifests(files: { file: string; contents: string }[]): Manifest[] {
  const manifests: Manifest[] = [];
  for (const { file, contents } of files) {
    for (const document of parseAllDocuments(contents)) {
      const doc: unknown = document.toJS();
      // An empty document is what a file of nothing but comments parses to, and it is not a
      // manifest — silently skipping it is right, since nothing was declared.
      if (isRecord(doc)) manifests.push({ file, doc });
    }
  }
  return manifests;
}

export function kindOf(manifest: Manifest): string {
  return str(manifest.doc.kind) ?? "";
}

export function nameOf(manifest: Manifest): string {
  return str(at(manifest.doc, "metadata.name")) ?? "";
}

export function byKind(manifests: Manifest[], kind: string): Manifest[] {
  return manifests.filter((manifest) => kindOf(manifest) === kind);
}

export function byName(manifests: Manifest[], kind: string, name: string): Manifest | undefined {
  return byKind(manifests, kind).find((manifest) => nameOf(manifest) === name);
}

/** The containers of anything with a pod template — Deployments and Jobs alike. */
function containers(manifest: Manifest): Record<string, unknown>[] {
  return list(at(manifest.doc, "spec.template.spec.containers")).filter(isRecord);
}

function initContainers(manifest: Manifest): Record<string, unknown>[] {
  return list(at(manifest.doc, "spec.template.spec.initContainers")).filter(isRecord);
}

/**
 * Probes must be pointed at the endpoints written for them.
 *
 * `/health` is deliberately 200-while-degraded — it is for a human with curl, and a probe on it
 * would keep a pod that cannot reach Postgres in the load balancer for ever. `/livez` never
 * touches the database, so a Neon blip cannot restart every pod at once; `/readyz` does, and also
 * fails on a lost LISTEN connection, so a pod whose fanout has degraded leaves the rotation.
 */
export function probeViolations(manifests: Manifest[]): string[] {
  const violations: string[] = [];

  for (const manifest of byKind(manifests, "Deployment")) {
    for (const container of containers(manifest)) {
      for (const probe of ["livenessProbe", "readinessProbe", "startupProbe"]) {
        const path = str(at(container, `${probe}.httpGet.path`));
        if (path === undefined) continue;
        if (path === "/health") {
          violations.push(
            `${manifest.file}: ${nameOf(manifest)}'s ${probe} reads /health, which answers 200 while degraded — use /livez or /readyz`,
          );
        }
      }
    }
  }

  const api = byName(manifests, "Deployment", "nap-api");
  if (api === undefined) return [...violations, "no Deployment named nap-api"];

  for (const [probe, expected] of [
    ["livenessProbe", "/livez"],
    ["readinessProbe", "/readyz"],
  ] as const) {
    const paths = containers(api).map((container) => str(at(container, `${probe}.httpGet.path`)));
    if (!paths.includes(expected)) {
      violations.push(`${api.file}: nap-api has no ${probe} on ${expected}`);
    }
  }

  return violations;
}

/**
 * A worker's grace period must comfortably outlast its own drain.
 *
 * The drain is the worker waiting for turns it is already running, renewing their leases the whole
 * time; the grace period is how long Kubernetes waits before SIGKILL. If the grace is the shorter
 * of the two, the drain never gets to finish on its own terms — the leases are left to expire, the
 * jobs are left open for somebody to continue by hand, and a rollout that looked clean has cost
 * every in-flight turn its human.
 */
export function drainViolations(manifests: Manifest[], drainTimeoutSeconds: number): string[] {
  const worker = byName(manifests, "Deployment", "nap-worker");
  if (worker === undefined) return ["no Deployment named nap-worker"];

  const grace = num(at(worker.doc, "spec.template.spec.terminationGracePeriodSeconds"));
  if (grace === undefined) {
    return [
      `${worker.file}: nap-worker sets no terminationGracePeriodSeconds, so it gets the 30s default and is killed mid-turn`,
    ];
  }

  // A minute of headroom past the drain: the abort that follows a timed-out drain is itself given
  // ten seconds, and the process still has to settle the requests it was holding.
  const required = drainTimeoutSeconds + 60;
  if (grace < required) {
    return [
      `${worker.file}: nap-worker's grace period is ${grace}s, which does not cover a ${drainTimeoutSeconds}s drain — needs at least ${required}s`,
    ];
  }
  return [];
}

/**
 * Nothing in git may hold a credential.
 *
 * The Secret's *shape* is checked in (`secret.example.yaml`) so a missing key is readable rather
 * than a decode failure at boot, and every value in it is empty. A filled-in one committed by
 * accident is not fixed by deleting it later: it is in the history, and the credential has to be
 * rotated.
 */
export function secretViolations(manifests: Manifest[]): string[] {
  const violations: string[] = [];

  for (const manifest of byKind(manifests, "Secret")) {
    for (const field of ["data", "stringData"]) {
      const values = at(manifest.doc, field);
      if (!isRecord(values)) continue;
      for (const [key, value] of Object.entries(values)) {
        if (typeof value === "string" && value !== "") {
          violations.push(
            `${manifest.file}: Secret ${nameOf(manifest)} carries a value for ${key}`,
          );
        }
      }
    }
  }

  // The other half of the same rule: a credential inlined as a container env value rather than
  // read from the Secret. Anything whose name says "key", "secret", "token" or "password" — plus
  // the database URL, which carries a password inside it.
  const sensitive = /(_KEY|_SECRET|_TOKEN|PASSWORD|DATABASE_URL)$/;
  for (const manifest of manifests) {
    for (const container of [...containers(manifest), ...initContainers(manifest)]) {
      for (const entry of list(container.env)) {
        if (!isRecord(entry)) continue;
        const name = str(entry.name) ?? "";
        const value = str(entry.value);
        if (value !== undefined && value !== "" && sensitive.test(name)) {
          violations.push(`${manifest.file}: ${nameOf(manifest)} sets ${name} inline`);
        }
      }
    }
  }

  return violations;
}

/**
 * The same rule one level up: an overlay's generated Secret may only hold obvious fakes.
 *
 * `infra/k8s/proof/` really does check in a `secretGenerator` with values in it, because a cluster
 * on a laptop needs credentials and none of the things they open exist. The risk is that somebody
 * debugging against a real database pastes a real URL into it and commits — which the rule above
 * would not see, since a kustomization is not a `kind: Secret`.
 *
 * So: every literal must be visibly local. A host that is not the in-cluster Postgres, or a value
 * with a vendor's key prefix, is a real credential in a file that is not allowed to have one.
 */
export function generatedSecretViolations(kustomization: string, file: string): string[] {
  const violations: string[] = [];
  // Vendor prefixes worth naming: OpenRouter and Anthropic both start `sk-`, E2B's start `e2b_`.
  const vendorKey = /^(sk-|e2b_|AKIA)/;

  for (const rawLine of kustomization.split("\n")) {
    const literal = /^\s*-\s+([A-Z0-9_]+)=(.*)$/.exec(rawLine.trim());
    if (literal === null) continue;
    const [, key = "", value = ""] = literal;

    if (vendorKey.test(value)) {
      violations.push(`${file}: ${key} looks like a real vendor key`);
      continue;
    }

    // Anything with a host in it has to be the cluster's own Postgres. A managed database is
    // reached at a domain; nothing in a proof cluster is.
    const host = /:\/\/[^@/]*@?([^:/]+)/.exec(value)?.[1];
    if (host !== undefined && host !== "nap-postgres" && host !== "localhost") {
      violations.push(`${file}: ${key} points at ${host}, which is not in this cluster`);
    }
  }

  return violations;
}

/**
 * The ingress has to be more patient than the application.
 *
 * A Nap socket is idle by design between turns: the server pings on an interval and gives up on a
 * client that has been silent for `heartbeatTimeoutMs`. A proxy whose read timeout expires first
 * closes healthy connections from the middle, and it is invisible from both ends — the pod sees a
 * disconnect, the browser reconnects.
 *
 * The rule is the application's *window*, not its ping interval, and that is deliberate: at
 * ingress-nginx's 60-second default the connection survives, but only because our own ping happens
 * to be every 30 seconds, so the margin is one missed ping. The proxy must never be the thing that
 * decides a connection is dead — saying nothing here leaves that to a coincidence.
 */
export function ingressTimeoutViolations(
  manifests: Manifest[],
  heartbeatTimeoutMs: number,
): string[] {
  const violations: string[] = [];
  const required = heartbeatTimeoutMs / 1000;

  for (const manifest of byKind(manifests, "Ingress")) {
    const annotations = at(manifest.doc, "metadata.annotations");
    for (const key of [
      "nginx.ingress.kubernetes.io/proxy-read-timeout",
      "nginx.ingress.kubernetes.io/proxy-send-timeout",
    ]) {
      const annotation = isRecord(annotations) ? str(annotations[key]) : undefined;
      if (annotation === undefined) {
        violations.push(
          `${manifest.file}: ${nameOf(manifest)} sets no ${key}, so it keeps the 60s default and cuts idle sockets`,
        );
        continue;
      }
      const seconds = Number(annotation);
      if (!Number.isFinite(seconds) || seconds <= required) {
        violations.push(
          `${manifest.file}: ${nameOf(manifest)}'s ${key} is ${annotation}s, which is not longer than the application's ${required}s heartbeat window`,
        );
      }
    }
  }

  return violations;
}

/**
 * The reaper is one process, and a rollout may not briefly make it two.
 *
 * Two reapers snapshot and destroy the same project at the same moment, the second teardown
 * landing on a sandbox that is already gone. `replicas: 1` is most of it; `strategy: Recreate` is
 * the rest, because a RollingUpdate deliberately runs the old pod and the new one together.
 */
export function reaperViolations(manifests: Manifest[]): string[] {
  const reaper = byName(manifests, "Deployment", "nap-reaper");
  if (reaper === undefined) return ["no Deployment named nap-reaper"];

  const violations: string[] = [];
  const replicas = num(at(reaper.doc, "spec.replicas"));
  if (replicas !== 1) {
    violations.push(`${reaper.file}: nap-reaper runs ${String(replicas)} replicas; it must run 1`);
  }

  const strategy = str(at(reaper.doc, "spec.strategy.type"));
  if (strategy !== "Recreate") {
    violations.push(
      `${reaper.file}: nap-reaper's strategy is ${strategy ?? "unset (RollingUpdate)"}, which overlaps two sweeps during a rollout`,
    );
  }

  // Nothing may scale it either — an autoscaler pointed at the reaper would undo both of the above.
  for (const manifest of [
    ...byKind(manifests, "HorizontalPodAutoscaler"),
    ...byKind(manifests, "ScaledObject"),
  ]) {
    const target =
      str(at(manifest.doc, "spec.scaleTargetRef.name")) ??
      str(at(manifest.doc, "spec.scaleTargetRef.kind"));
    if (target === "nap-reaper") {
      violations.push(`${manifest.file}: ${nameOf(manifest)} autoscales the reaper`);
    }
  }

  return violations;
}

/**
 * Kubernetes must not be able to outrun the thing that bounds the bill.
 *
 * `NAP_MAX_SANDBOXES_TOTAL` is the cluster-wide ceiling on sandboxes, and therefore on E2B spend.
 * A worker runs `NAP_WORKER_CONCURRENCY` turns at once, so past
 * ceil(total / concurrency) workers every extra pod can only queue behind a capacity refusal —
 * money spent on pods instead of on turns. The autoscaler's target is the same number for the same
 * reason: it is one pod's worth of work, and any other value makes the queue depth mean something
 * the deployment does not.
 */
export function workerCeilingViolations(manifests: Manifest[]): string[] {
  const config = byName(manifests, "ConfigMap", "nap-config");
  const scaled = byName(manifests, "ScaledObject", "nap-worker");
  if (config === undefined) return ["no ConfigMap named nap-config"];
  if (scaled === undefined) return ["no ScaledObject named nap-worker"];

  const data = at(config.doc, "data");
  const total = Number(isRecord(data) ? str(data.NAP_MAX_SANDBOXES_TOTAL) : undefined);
  const concurrency = Number(isRecord(data) ? str(data.NAP_WORKER_CONCURRENCY) : undefined);
  if (!Number.isFinite(total) || !Number.isFinite(concurrency)) {
    return ["nap-config must set NAP_MAX_SANDBOXES_TOTAL and NAP_WORKER_CONCURRENCY"];
  }

  const violations: string[] = [];
  const ceiling = Math.ceil(total / concurrency);
  const max = num(at(scaled.doc, "spec.maxReplicaCount"));
  if (max !== ceiling) {
    violations.push(
      `${scaled.file}: maxReplicaCount is ${String(max)}, but the sandbox ceiling allows ${ceiling} workers (${total} / ${concurrency})`,
    );
  }

  for (const trigger of list(at(scaled.doc, "spec.triggers"))) {
    const target = Number(str(at(trigger, "metadata.targetQueryValue")));
    if (target !== concurrency) {
      violations.push(
        `${scaled.file}: targetQueryValue is ${String(target)}, which is not one worker's NAP_WORKER_CONCURRENCY (${concurrency})`,
      );
    }
  }

  return violations;
}

/**
 * Migrations are a decision, never a side effect of a restart.
 *
 * A dozen replicas starting at once would race the same schema change, and the losers either
 * crash-loop or apply half of one. So no long-running pod may migrate: not in its command, not in
 * an initContainer, and not through the Kustomization, which would re-run the Job on every apply.
 */
export function migrationViolations(manifests: Manifest[], kustomization: string[]): string[] {
  const violations: string[] = [];
  const migrates = (command: unknown): boolean =>
    list(command).some((word) => (str(word) ?? "").includes("migrate"));

  for (const manifest of byKind(manifests, "Deployment")) {
    for (const container of [...containers(manifest), ...initContainers(manifest)]) {
      if (migrates(container.command) || migrates(container.args)) {
        violations.push(`${manifest.file}: ${nameOf(manifest)} migrates at pod boot`);
      }
    }
  }

  if (kustomization.some((resource) => resource.includes("job-migrate"))) {
    violations.push("kustomization.yaml applies the migration Job; it is run deliberately instead");
  }
  if (kustomization.some((resource) => resource.includes("secret"))) {
    violations.push(
      "kustomization.yaml applies a Secret manifest; the real one is created out of band",
    );
  }

  return violations;
}

/**
 * No second source of truth about what is running.
 *
 * The whole argument for a Postgres queue was that the deployment needs one database and nothing
 * else — no Redis for the fanout, no broker for the queue, no mesh to find anything. Anything of
 * that shape appearing in here is that decision being quietly reversed, so it fails a test rather
 * than a review.
 */
export function extraInfrastructureViolations(manifests: Manifest[]): string[] {
  const banned = /redis|kafka|nats|rabbitmq|zookeeper|consul|istio|linkerd|memcached/i;
  const violations: string[] = [];

  for (const manifest of manifests) {
    for (const container of [...containers(manifest), ...initContainers(manifest)]) {
      const image = str(container.image) ?? "";
      if (banned.test(image)) {
        violations.push(`${manifest.file}: ${nameOf(manifest)} runs ${image}`);
      }
    }
  }

  // A Service for anything but the API would mean something is being called rather than reading
  // the queue: work reaches a worker through `turn_requests` and reaches the reaper not at all.
  for (const service of byKind(manifests, "Service")) {
    if (nameOf(service) !== "nap-api") {
      violations.push(`${service.file}: Service ${nameOf(service)} — only the API is connected to`);
    }
  }

  return violations;
}

/**
 * The worker's liveness probe and the heartbeat it reads have to agree.
 *
 * The probe restarts a pod whose claim loop has been silent for some number of seconds; the
 * process writes the file it reads at most every `writeIntervalMs`. If the throttle were the
 * larger of the two, a perfectly healthy worker would be killed on a timer — during a turn, which
 * is the one thing the long grace period exists to avoid.
 *
 * The threshold is read out of the probe's own shell command, which is the only place it exists.
 * `undefined` means there is no such probe to check against — the caller decides whether that is a
 * finding, because a worker without one is a different complaint from a worker with a wrong one.
 */
export function heartbeatPathViolations(manifests: Manifest[]): string[] {
  const worker = byName(manifests, "Deployment", "nap-worker");
  if (worker === undefined) return ["no Deployment named nap-worker"];

  const violations: string[] = [];
  for (const container of containers(worker)) {
    const configured = list(container.env)
      .filter(isRecord)
      .find((entry) => str(entry.name) === "NAP_WORKER_HEARTBEAT_FILE");
    const path = str(configured?.value);
    if (path === undefined) {
      violations.push(
        `${worker.file}: the worker is not told where to write its heartbeat, so its liveness probe reads a file nothing creates`,
      );
      continue;
    }

    // Every probe on this container has to be reading that exact file. Two places naming one path
    // is precisely the pair that drifts, and the failure is a healthy pod restarted on a timer.
    for (const probe of ["livenessProbe", "startupProbe"]) {
      const command = list(at(container, `${probe}.exec.command`))
        .map((word) => str(word) ?? "")
        .join(" ");
      if (command === "") continue;
      if (!command.includes(path)) {
        violations.push(
          `${worker.file}: the worker's ${probe} does not read ${path}, which is where it was told to write`,
        );
      }
    }
  }

  return violations;
}

export function heartbeatThresholdSeconds(manifests: Manifest[]): number | undefined {
  const worker = byName(manifests, "Deployment", "nap-worker");
  if (worker === undefined) return undefined;

  for (const container of containers(worker)) {
    for (const word of list(at(container, "livenessProbe.exec.command"))) {
      // The probe is a shell test of the file's age: `… -lt 120`.
      const match = /-lt\s+(\d+)/.exec(str(word) ?? "");
      if (match?.[1] !== undefined) return Number(match[1]);
    }
  }
  return undefined;
}
