# Nap on Kubernetes

Three deployments, one database, and nothing else. `base/` is what a real cluster runs; `local/`
is what the two laptop overlays share; `proof/` watches a turn cross pods, and `load/` puts a
hundred concurrent users through the whole thing with the autoscalers running.

Why this shape at all is `docs/scaling-design.md` §13, and what each object is for is written at
the top of its own file — including the parts that are wrong by default and would fail silently.
The rules those files have to keep are asserted in `test/k8s.test.ts`, which runs in `bun run test`
and needs no cluster.

## base/

| File | What it holds |
|---|---|
| `namespace.yaml` | The namespace, and a ServiceAccount with no RBAC and no mounted token |
| `configmap.yaml` | Every `NAP_*` tunable, and nothing anybody could spend |
| `secret.example.yaml` | The *shape* of `nap-secrets`, every value empty. **Not applied** |
| `deployment-api.yaml` | The pods that serve; probes on `/livez` and `/readyz` |
| `service-api.yaml` | The only Service, plus the API's PodDisruptionBudget |
| `ingress-api.yaml` | TLS and the WebSocket timeouts that must outlast the app's heartbeat |
| `hpa-api.yaml` | API pods scale on `nap_ws_connections`, with CPU as a secondary trigger |
| `deployment-worker.yaml` | The pods that execute; a 900s grace period around a 600s drain |
| `scaledobject-worker.yaml` | KEDA on queue depth, capped by the sandbox ceiling |
| `deployment-reaper.yaml` | Exactly one, `strategy: Recreate`, advisory-locked as well |
| `networkpolicy.yaml` | Egress to the internet, and to nothing inside the cluster |
| `job-migrate.yaml` | The schema change, run deliberately. **Not applied** by the kustomization |

Deploying, in order:

```bash
kubectl -n nap create secret generic nap-secrets --from-literal=…   # see secret.example.yaml
kubectl apply -f base/job-migrate.yaml && kubectl -n nap wait --for=condition=complete job/nap-migrate
kubectl apply -k base
```

Two dependencies outside a stock cluster: KEDA, for the worker's ScaledObject, and Prometheus with
prometheus-adapter, for the API's socket metric. Without either, that half degrades rather than
fails — the workers stay at their floor, and the API scales on CPU alone. `load/monitoring.yaml`
is a minimal working example of the second, installed by `load/run.sh`.

**The gauge is `apps/api/src/metrics.ts`**, served at `/metrics` on the same port the app listens
on, and the API pods carry the scrape annotations that find it. The metric's *name* is read out of
that module by `test/k8s.test.ts` rather than repeated in the manifest, so renaming it in code and
leaving the HPA behind fails a test instead of an autoscaler.

## local/

Not applied directly. It is everything `proof/` and `load/` have in common — the three commands
pointed at `cluster-proof.ts`, `imagePullPolicy: Never`, the in-cluster Postgres, and a localhost
Ingress with no TLS. Two copies of those would drift, and both overlays' value depends on it being
the same deployment underneath.

## proof/

```bash
infra/k8s/proof/run.sh          # create a kind cluster, deploy, check
infra/k8s/proof/run.sh --down   # delete it
```

It builds the image, loads it into kind, runs the real migration Job, and brings up API 3 /
workers 2 / reaper 1 against a Postgres in the cluster. Then it checks the two things no manifest
can assert: that a turn submitted to one API pod completes and streams to a socket on another, and
that a rolling restart of the API loses no events — the client reconnects with its last `seq` and
gets exactly the gap.

The pods run `apps/api/scripts/cluster-proof.ts` rather than the real entrypoint: the same
composition, queue, log and `pg_notify` fanout, with a scripted model and an in-memory sandbox in
place of OpenRouter and E2B. So it costs nothing, and it proves nothing about a vendor —
`bun run acceptance` is what does that, against a deployment, on purpose, with money.

Three of the base's objects are removed here because this cluster cannot run them: the ScaledObject
(no KEDA), the HPA (no Prometheus) and the NetworkPolicy (kind's CNI enforces none). They are
deleted out loud in `patch-remove-unsupported.yaml` rather than quietly left out.

## load/

```bash
infra/k8s/load/run.sh                   # create a kind cluster, deploy, ramp to 100
infra/k8s/load/run.sh --profile=smoke   # a three-minute wiring check
infra/k8s/load/run.sh --down            # delete it
```

The §23 ramp — the same k6 script, the same profiles, the same thresholds as the single-process
baseline in `docs/scaling-baseline.md` — against the cluster instead of against one process. The
difference between the two reports is the architecture underneath, which is the only thing that
changed.

It installs three things `proof/` does not, each because an acceptance criterion needs something
to read: **KEDA**, so the worker ScaledObject can scale on queue depth; **metrics-server**, so the
HPA's CPU trigger is not permanently unavailable; and **Prometheus with prometheus-adapter**, so
its `nap_ws_connections` trigger is not either. It keeps the ScaledObject and the HPA that
`proof/` deletes, and removes only the NetworkPolicy, which kind's CNI enforces none of.

Its ceilings are its own and its autoscalers are derived from them: 200 sandboxes at 25 turns a
worker, so ceil(200 / 25) = 8 workers. That is the same arithmetic the base uses at its own
numbers, and `test/k8s.test.ts` runs the same rule over both — an overlay that raised the ceiling
and left the scaler behind is a failing test rather than a cluster spending on pods that can only
queue behind a capacity refusal.

`apps/api/scripts/loadgen-cluster.ts` is what drives k6 and samples the cluster while it runs:
replica counts per component, pod CPU and memory, `turn_requests` depth, and the socket gauge read
*through the custom-metrics API* — the whole path an HPA uses, rather than a scrape that proves
only that the number exists. Results land in `napload-results/`; the write-up is
`docs/scaling-cluster.md`.

**One known contamination, and the baseline shares it:** k6, Docker and the cluster are all on the
same laptop, so the load generator competes with the system under test. The report records the
machine's load average for exactly that reason.
