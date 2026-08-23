# Nap on Kubernetes

Three deployments, one database, and nothing else. `base/` is what a real cluster runs; `proof/`
is the same thing on a laptop with fakes behind it, so the multi-pod behaviour can be watched
rather than assumed.

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
| `hpa-api.yaml` | API pods scale on open sockets, with CPU as a secondary trigger |
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
fails — the workers stay at their floor, and the API scales on CPU alone.

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
