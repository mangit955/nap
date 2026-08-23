#!/usr/bin/env bash
# Brings up the whole deployment on a laptop and checks the two things a manifest cannot assert.
#
#   infra/k8s/proof/run.sh            # create the cluster if needed, deploy, check
#   infra/k8s/proof/run.sh --down     # delete the cluster and stop paying for the RAM
#
# Free: no vendor is reached, because the pods run `apps/api/scripts/cluster-proof.ts` — the same
# `composeNap`, the same Postgres queue and the same `pg_notify` fanout, with a scripted model and
# an in-memory sandbox. Slow the first time: it builds the API image and pulls a node image.
#
# What it is for is the last two acceptance criteria of the manifests: at API 3 / workers 2 /
# reaper 1, a turn submitted to any pod completes and streams to a socket on any other pod, and a
# rolling restart of the API loses no events. Everything else about the manifests is asserted for
# free in `test/k8s.test.ts`, which needs no cluster.
set -euo pipefail

CLUSTER=nap
NAMESPACE=nap
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INGRESS_URL=http://localhost:8080

if [[ "${1:-}" == "--down" ]]; then
  kind delete cluster --name "$CLUSTER"
  exit 0
fi

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

step "cluster"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config "$ROOT/infra/k8s/proof/kind-cluster.yaml"
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

step "ingress controller"
# kind's own ingress-nginx manifest: it is the one built for the `ingress-ready` node label above.
# Pinned to the release this was run against rather than `main`, so a proof that passes today and
# fails next month has changed for a reason somebody chose.
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.15.1/deploy/static/provider/kind/deploy.yaml
kubectl -n ingress-nginx wait --for=condition=ready pod \
  --selector=app.kubernetes.io/component=controller --timeout=300s

step "image"
docker build -t nap:proof "$ROOT"
kind load docker-image nap:proof --name "$CLUSTER"

step "deploy"
kubectl apply -k "$ROOT/infra/k8s/proof"
kubectl -n "$NAMESPACE" rollout status deployment/nap-postgres --timeout=300s

step "migrate"
# The real Job, with the image swapped for the one loaded above. Deliberate and separate, exactly
# as it is in production: a dozen pods racing a schema change is why nothing migrates at boot.
kubectl -n "$NAMESPACE" delete job nap-migrate --ignore-not-found
sed 's|ghcr.io/mangit955/nap:latest|nap:proof|' "$ROOT/infra/k8s/base/job-migrate.yaml" \
  | kubectl apply -f -
kubectl -n "$NAMESPACE" wait --for=condition=complete job/nap-migrate --timeout=300s

step "roll out"
# After the migration, so the first pods to start find the schema they expect.
kubectl -n "$NAMESPACE" rollout restart deployment/nap-api deployment/nap-worker deployment/nap-reaper
for deployment in nap-api nap-worker nap-reaper; do
  kubectl -n "$NAMESPACE" rollout status "deployment/$deployment" --timeout=300s
done
kubectl -n "$NAMESPACE" get pods -o wide

step "port-forwards"
# Two *individual* pods, because the whole question is whether it matters which one you talk to.
# The ingress covers the other half, where it deliberately does not matter.
pods=($(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/component=api -o name))
if [[ ${#pods[@]} -lt 2 ]]; then
  echo "need at least two API pods, found ${#pods[@]}" >&2
  exit 1
fi
kubectl -n "$NAMESPACE" port-forward "${pods[0]}" 18081:3001 >/tmp/nap-proof-pf-a.log 2>&1 &
PF_A=$!
kubectl -n "$NAMESPACE" port-forward "${pods[1]}" 18082:3001 >/tmp/nap-proof-pf-b.log 2>&1 &
PF_B=$!
trap 'kill $PF_A $PF_B 2>/dev/null || true' EXIT
sleep 3

step "checks"
bun run "$ROOT/apps/api/scripts/cluster-proof-check.ts" \
  --a=http://localhost:18081 --b=http://localhost:18082 --ingress="$INGRESS_URL"
