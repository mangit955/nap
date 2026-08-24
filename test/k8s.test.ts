import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WS_CONNECTIONS_METRIC } from "../apps/api/src/metrics.ts";
import { HEARTBEAT_WRITE_INTERVAL_MS } from "../apps/api/src/worker-heartbeat.ts";
import { DEFAULT_HEARTBEAT } from "../apps/api/src/ws/event-stream.ts";
import {
  byName,
  drainViolations,
  extraInfrastructureViolations,
  generatedSecretViolations,
  heartbeatPathViolations,
  heartbeatThresholdSeconds,
  ingressTimeoutViolations,
  type Manifest,
  migrationViolations,
  parseManifests,
  probeViolations,
  reaperViolations,
  scaleDownViolations,
  secretViolations,
  socketMetricViolations,
  workerCeilingViolations,
} from "./k8s.ts";

/**
 * The Kubernetes manifests, checked against the things that would fail silently in a cluster.
 *
 * Each rule is asserted twice: once on the manifests we ship, and once on a synthetic one that
 * breaks it. The second half is the important one — a check that has never been seen to fail may
 * be passing on everything, and every rule here guards a failure that produces no error anywhere.
 *
 * The numbers are read from the code they have to agree with rather than repeated: the heartbeat
 * window comes from `DEFAULT_HEARTBEAT`, the drain from the ConfigMap, the worker ceiling from
 * `NAP_MAX_SANDBOXES_TOTAL`. A test that hard-coded them would keep passing after somebody changed
 * the application and left the cluster behind.
 */

const BASE = join(import.meta.dirname, "..", "infra", "k8s", "base");
const LOAD = join(import.meta.dirname, "..", "infra", "k8s", "load");

function loadBase(): Manifest[] {
  const files = readdirSync(BASE)
    .filter((file) => file.endsWith(".yaml") && file !== "kustomization.yaml")
    .map((file) => ({ file, contents: readFileSync(join(BASE, file), "utf8") }));
  return parseManifests(files);
}

/** Everything `kubectl apply -k` would create — which deliberately excludes two of the files. */
function loadApplied(): Manifest[] {
  const applied = new Set(kustomizationResources());
  return loadBase().filter((manifest) => applied.has(manifest.file));
}

function kustomizationResources(): string[] {
  const contents = readFileSync(join(BASE, "kustomization.yaml"), "utf8");
  const [document] = parseManifests([{ file: "kustomization.yaml", contents }]);
  const resources = document?.doc.resources;
  return Array.isArray(resources) ? resources.filter((entry) => typeof entry === "string") : [];
}

/**
 * The load overlay's own ConfigMap and ScaledObject patches.
 *
 * Read as plain manifests rather than through kustomize, which is enough for the one rule that
 * has to hold here: both patches name every field `workerCeilingViolations` reads, so the
 * derived relation between the sandbox ceiling and the worker maximum can be checked without
 * building the overlay. An overlay that raised the ceiling and left the scaler behind would be a
 * cluster spending on pods that can only queue behind a capacity refusal.
 */
function loadOverlay(): Manifest[] {
  return parseManifests(
    ["patch-config.yaml", "patch-scale.yaml"].map((file) => ({
      file,
      contents: readFileSync(join(LOAD, file), "utf8"),
    })),
  );
}

function synthetic(contents: string): Manifest[] {
  return parseManifests([{ file: "synthetic.yaml", contents }]);
}

describe("the manifests parse", () => {
  it("finds the three deployments and the one Service", () => {
    const manifests = loadApplied();
    expect(byName(manifests, "Deployment", "nap-api")).toBeDefined();
    expect(byName(manifests, "Deployment", "nap-worker")).toBeDefined();
    expect(byName(manifests, "Deployment", "nap-reaper")).toBeDefined();
    expect(byName(manifests, "Service", "nap-api")).toBeDefined();
  });
});

describe("probes", () => {
  it("point at the endpoints written for them", () => {
    expect(probeViolations(loadApplied())).toEqual([]);
  });

  it("catches a probe on /health, which answers 200 while degraded", () => {
    const violations = probeViolations(
      synthetic(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: nap-api }
spec:
  template:
    spec:
      containers:
        - name: api
          livenessProbe: { httpGet: { path: /health, port: http } }
          readinessProbe: { httpGet: { path: /readyz, port: http } }
`),
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("/health");
    // And the missing /livez is reported too, rather than the wrong path hiding it.
    expect(violations[1]).toContain("livenessProbe on /livez");
  });
});

describe("the worker's drain", () => {
  it("fits inside the grace period the manifest gives it", () => {
    const manifests = loadApplied();
    const config = byName(manifests, "ConfigMap", "nap-config");
    const data = config?.doc.data;
    const drain = Number(
      typeof data === "object" && data !== null
        ? ((data as Record<string, string>).NAP_DRAIN_TIMEOUT_SECONDS ?? Number.NaN)
        : Number.NaN,
    );
    expect(drain).toBeGreaterThan(0);
    expect(drainViolations(manifests, drain)).toEqual([]);
  });

  it("catches a grace period shorter than the drain", () => {
    const violations = drainViolations(
      synthetic(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: nap-worker }
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30
      containers: [{ name: worker }]
`),
      600,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("does not cover a 600s drain");
  });

  it("catches a worker that sets none at all, and so inherits 30 seconds", () => {
    const violations = drainViolations(
      synthetic(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: nap-worker }
spec:
  template:
    spec:
      containers: [{ name: worker }]
`),
      600,
    );
    expect(violations[0]).toContain("sets no terminationGracePeriodSeconds");
  });
});

describe("credentials", () => {
  // Includes secret.example.yaml, which is not applied: the point is that nothing in the
  // directory holds a value, whether it is applied or not.
  it("appear nowhere in the manifests", () => {
    expect(secretViolations(loadBase())).toEqual([]);
  });

  it("catches a filled-in Secret", () => {
    const violations = secretViolations(
      synthetic(`
apiVersion: v1
kind: Secret
metadata: { name: nap-secrets }
stringData:
  OPENROUTER_API_KEY: sk-or-not-a-real-one
`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("OPENROUTER_API_KEY");
  });

  it("are fakes even in the proof overlay, which really does check literals in", () => {
    const file = join(BASE, "..", "proof", "kustomization.yaml");
    expect(
      generatedSecretViolations(readFileSync(file, "utf8"), "proof/kustomization.yaml"),
    ).toEqual([]);
  });

  /*
   * The host is a reserved `.invalid` one (RFC 2606) rather than something that looks like a real
   * provider. The rule under test is "the host is not this cluster's", so the flavour of the
   * hostname changes nothing here — but a fixture shaped like live Neon credentials is one every
   * secret scanner reports, and a test that exists to catch pasted credentials is a silly place
   * to spend somebody's triage.
   */
  it("catches a real database or a vendor key pasted into that overlay", () => {
    const violations = generatedSecretViolations(
      [
        "secretGenerator:",
        "  - name: nap-secrets",
        "    literals:",
        "      - DATABASE_URL=postgres://nap:placeholder@db.example.invalid/nap",
        "      - OPENROUTER_API_KEY=sk-or-v1-something",
        "      - E2B_API_KEY=proof-not-a-key",
      ].join("\n"),
      "synthetic",
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("not in this cluster");
    expect(violations[1]).toContain("real vendor key");
  });

  it("catches one inlined as a container env value", () => {
    const violations = secretViolations(
      synthetic(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: nap-worker }
spec:
  template:
    spec:
      containers:
        - name: worker
          env:
            - { name: DATABASE_URL, value: "postgres://nap:placeholder@db.example.invalid/nap" }
`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("DATABASE_URL");
  });
});

describe("the ingress", () => {
  it("is more patient than the application's heartbeat", () => {
    expect(ingressTimeoutViolations(loadApplied(), DEFAULT_HEARTBEAT.timeoutMs)).toEqual([]);
  });

  it("catches ingress-nginx's own default, which is shorter than the heartbeat window", () => {
    const violations = ingressTimeoutViolations(
      synthetic(`
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: nap
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"
`),
      DEFAULT_HEARTBEAT.timeoutMs,
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("not longer than");
  });

  it("catches an ingress that says nothing about timeouts, which is the same 60 seconds", () => {
    const violations = ingressTimeoutViolations(
      synthetic(`
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata: { name: nap }
`),
      DEFAULT_HEARTBEAT.timeoutMs,
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("keeps the 60s default");
  });
});

describe("the reaper", () => {
  it("is one, and stays one through a rollout", () => {
    expect(reaperViolations(loadApplied())).toEqual([]);
  });

  it("catches a rolling update, which deliberately overlaps two sweeps", () => {
    const violations = reaperViolations(
      synthetic(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: nap-reaper }
spec:
  replicas: 2
  strategy: { type: RollingUpdate }
`),
    );
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("must run 1");
    expect(violations[1]).toContain("overlaps two sweeps");
  });

  it("catches anything that would scale it", () => {
    const violations = reaperViolations([
      ...loadApplied(),
      ...synthetic(`
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: nap-reaper-scaler }
spec:
  scaleTargetRef: { name: nap-reaper }
`),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("autoscales the reaper");
  });
});

describe("the worker autoscaler", () => {
  it("cannot outrun the ceiling that bounds the bill", () => {
    expect(workerCeilingViolations(loadApplied())).toEqual([]);
  });

  it("catches a maximum above what the sandbox ceiling can feed", () => {
    const violations = workerCeilingViolations(
      synthetic(`
apiVersion: v1
kind: ConfigMap
metadata: { name: nap-config }
data:
  NAP_MAX_SANDBOXES_TOTAL: "10"
  NAP_WORKER_CONCURRENCY: "5"
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: nap-worker }
spec:
  maxReplicaCount: 25
  triggers:
    - type: postgresql
      metadata: { targetQueryValue: "5" }
`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("allows 2 workers");
  });

  it("catches a target that is not one worker's concurrency", () => {
    const violations = workerCeilingViolations(
      synthetic(`
apiVersion: v1
kind: ConfigMap
metadata: { name: nap-config }
data:
  NAP_MAX_SANDBOXES_TOTAL: "10"
  NAP_WORKER_CONCURRENCY: "5"
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: nap-worker }
spec:
  maxReplicaCount: 2
  triggers:
    - type: postgresql
      metadata: { targetQueryValue: "1" }
`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("not one worker's NAP_WORKER_CONCURRENCY");
  });
});

describe("migrations", () => {
  it("are a deliberate Job, and no pod runs one at boot", () => {
    expect(migrationViolations(loadBase(), kustomizationResources())).toEqual([]);
  });

  it("catches a migrating initContainer", () => {
    const violations = migrationViolations(
      synthetic(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: nap-api }
spec:
  template:
    spec:
      initContainers:
        - name: migrate
          command: ["bun", "run", "packages/db/scripts/migrate.ts"]
      containers: [{ name: api }]
`),
      [],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("migrates at pod boot");
  });

  it("catches the Job or a Secret being applied along with everything else", () => {
    const violations = migrationViolations([], ["job-migrate.yaml", "secret.example.yaml"]);
    expect(violations).toHaveLength(2);
  });
});

describe("what else the cluster runs", () => {
  it("is nothing: one database, and no second source of truth", () => {
    expect(extraInfrastructureViolations(loadApplied())).toEqual([]);
  });

  it("catches a Redis appearing to carry the fanout", () => {
    const violations = extraInfrastructureViolations(
      synthetic(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: nap-redis }
spec:
  template:
    spec:
      containers: [{ name: redis, image: "redis:7-alpine" }]
---
apiVersion: v1
kind: Service
metadata: { name: nap-redis }
`),
    );
    expect(violations).toHaveLength(2);
  });
});

describe("the worker's liveness probe", () => {
  it("reads a file the claim loop writes far more often than the probe's threshold", () => {
    const threshold = heartbeatThresholdSeconds(loadApplied());
    expect(threshold).toBeDefined();
    // Four times the write interval at least: a throttle anywhere near the threshold would restart
    // a perfectly healthy worker on a slow tick, mid-turn.
    expect((threshold ?? 0) * 1000).toBeGreaterThanOrEqual(HEARTBEAT_WRITE_INTERVAL_MS * 4);
  });

  it("reads the same file the pod is told to write", () => {
    expect(heartbeatPathViolations(loadApplied())).toEqual([]);
  });

  it("catches a probe and a pod naming two different files", () => {
    const violations = heartbeatPathViolations(
      synthetic(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: nap-worker }
spec:
  template:
    spec:
      containers:
        - name: worker
          env:
            - { name: NAP_WORKER_HEARTBEAT_FILE, value: /tmp/nap-worker-alive }
          livenessProbe:
            exec:
              command: ["/bin/sh", "-c", "test $(( $(date +%s) - $(stat -c %Y /tmp/alive) )) -lt 120"]
`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("does not read /tmp/nap-worker-alive");
  });

  it("catches a worker with a probe and no file to write", () => {
    const violations = heartbeatPathViolations(
      synthetic(`
apiVersion: apps/v1
kind: Deployment
metadata: { name: nap-worker }
spec:
  template:
    spec:
      containers:
        - name: worker
          livenessProbe:
            exec: { command: ["/bin/sh", "-c", "test -f /tmp/nap-worker-alive"] }
`),
    );
    expect(violations[0]).toContain("not told where to write");
  });
});

describe("the load overlay", () => {
  it("re-derives the worker ceiling from its own raised sandbox cap", () => {
    // The numbers differ from the base's — 200 sandboxes and 25 a worker rather than 10 and 5 —
    // and the *relation* between them is what must not.
    expect(workerCeilingViolations(loadOverlay())).toEqual([]);
  });

  it("stabilizes scale-down past its own shorter drain", () => {
    // The overlay lowers the drain and does not touch the stabilization window, so the rule is
    // checked against its ConfigMap and the base's ScaledObject — which is what kustomize will
    // merge. Assembled by hand rather than by shelling out to kustomize, which would put a
    // binary between this suite and a rule it can read directly.
    const scaled = byName(loadBase(), "ScaledObject", "nap-worker");
    const config = byName(loadOverlay(), "ConfigMap", "nap-config");
    expect(scaled).toBeDefined();
    expect(config).toBeDefined();
    expect(scaleDownViolations([scaled, config].filter((m) => m !== undefined))).toEqual([]);
  });
});

describe("the API autoscaler", () => {
  it("scales on a gauge the API really exports, and scrapes where it is served", () => {
    // The name comes from the module that publishes it, so renaming the series in code and
    // leaving this manifest behind is a failing test rather than an HPA on CPU alone.
    expect(
      socketMetricViolations(loadApplied(), { metric: WS_CONNECTIONS_METRIC, path: "/metrics" }),
    ).toEqual([]);
  });

  it("catches an HPA on a metric nothing publishes, scraped from nowhere", () => {
    const violations = socketMetricViolations(
      synthetic(`
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: nap-api }
spec:
  metrics:
    - type: Pods
      pods:
        metric: { name: nap_sockets_open }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: nap-api }
spec:
  template:
    spec:
      containers:
        - name: api
          ports: [{ containerPort: 3001 }]
`),
      { metric: WS_CONNECTIONS_METRIC, path: "/metrics" },
    );
    // The wrong series, no CPU behind it, and no annotations at all: five ways for an autoscaler
    // to read nothing, none of which errors in a cluster.
    expect(violations).toHaveLength(5);
    expect(violations.join("\n")).toContain(WS_CONNECTIONS_METRIC);
  });

  it("catches a scrape pointed at a port the container does not listen on", () => {
    const violations = socketMetricViolations(
      synthetic(`
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata: { name: nap-api }
spec:
  metrics:
    - type: Pods
      pods:
        metric: { name: ${WS_CONNECTIONS_METRIC} }
    - type: Resource
      resource: { name: cpu }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: nap-api }
spec:
  template:
    metadata:
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/path: /metrics
        prometheus.io/port: "9090"
    spec:
      containers:
        - name: api
          ports: [{ containerPort: 3001 }]
`),
      { metric: WS_CONNECTIONS_METRIC, path: "/metrics" },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("listens on 3001");
  });
});

describe("scaling in", () => {
  it("stabilizes for at least as long as a worker takes to drain", () => {
    expect(scaleDownViolations(loadApplied())).toEqual([]);
  });

  it("catches a window shorter than the drain it has to outlast", () => {
    const violations = scaleDownViolations(
      synthetic(`
apiVersion: v1
kind: ConfigMap
metadata: { name: nap-config }
data:
  NAP_DRAIN_TIMEOUT_SECONDS: "600"
---
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata: { name: nap-worker }
spec:
  advanced:
    horizontalPodAutoscalerConfig:
      behavior:
        scaleDown:
          stabilizationWindowSeconds: 60
`),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("600s a worker spends draining");
  });
});
