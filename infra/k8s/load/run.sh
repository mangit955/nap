#!/usr/bin/env bash
# The §23 ramp, against the cluster instead of against one process.
#
#   infra/k8s/load/run.sh                    # create the cluster if needed, deploy, ramp to 100
#   infra/k8s/load/run.sh --profile=smoke    # a three-minute wiring check
#   infra/k8s/load/run.sh --profile=realism  # a hundred connected, twenty-five active
#   infra/k8s/load/run.sh --down             # delete the cluster
#
# Free: the pods run `apps/api/scripts/cluster-proof.ts` with `NAP_PROOF_CALIBRATED_LATENCY=true`,
# so the model and the sandbox are the same fakes the single-process baseline ran against, slowed
# to the same recorded speeds. Nothing reaches a vendor. Slow: it builds the image, pulls four
# others, and the headline profile is twenty minutes of load.
#
# It differs from `infra/k8s/proof/run.sh` in what it installs, and each of the three is here
# because an acceptance criterion needs something to read:
#
#   - **KEDA**, so the ScaledObject can scale workers on queue depth.
#   - **metrics-server**, so the HPA's CPU trigger is not "unavailable".
#   - **Prometheus and prometheus-adapter**, so its `nap_ws_connections` trigger is not either.
#     See monitoring.yaml.
#
# The measurement is contaminated in one known way and the report says so: k6, the cluster and
# Docker are all on the same laptop, so the load generator competes with the system under test.
# The baseline had the same problem in the same direction — see `docs/scaling-baseline.md`.
set -euo pipefail

CLUSTER=nap-load
NAMESPACE=nap
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
INGRESS_URL=http://localhost:8081
PROFILE=ramp

for arg in "$@"; do
  case "$arg" in
    --down)
      kind delete cluster --name "$CLUSTER"
      exit 0
      ;;
    --profile=*) PROFILE="${arg#--profile=}" ;;
    *)
      echo "unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

step "cluster"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config "$ROOT/infra/k8s/load/kind-cluster.yaml"
fi
kubectl config use-context "kind-$CLUSTER" >/dev/null

step "ingress controller"
kubectl apply -f https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.15.1/deploy/static/provider/kind/deploy.yaml
# `rollout status` rather than `wait --for=condition=ready pod`: the apply returns before the
# ReplicaSet has created anything, and a `wait` on a selector that matches no pod yet fails
# immediately with "no matching resources found" rather than waiting for one.
kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=300s

step "metrics-server"
# `--kubelet-insecure-tls`, because kind's kubelet serving certificate is self-signed and
# metrics-server otherwise reports every node as unavailable — which shows up as an HPA with no
# CPU reading rather than as an error.
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml
kubectl -n kube-system patch deployment metrics-server --type=json \
  -p='[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' \
  2>/dev/null || true
kubectl -n kube-system rollout status deployment/metrics-server --timeout=300s

step "KEDA"
kubectl apply --server-side -f https://github.com/kedacore/keda/releases/download/v2.17.1/keda-2.17.1.yaml
kubectl -n keda rollout status deployment/keda-operator --timeout=300s
# The metrics API server is named `keda-metrics-apiserver`, not `keda-operator-metrics-apiserver`
# — the release manifest and the Helm chart differ, and only one of them is what this applies.
kubectl -n keda rollout status deployment/keda-metrics-apiserver --timeout=300s

step "prometheus and the adapter"
kubectl apply -f "$ROOT/infra/k8s/load/monitoring.yaml"
kubectl -n monitoring rollout status deployment/prometheus --timeout=300s
kubectl -n monitoring rollout status deployment/prometheus-adapter --timeout=300s

step "image"
docker build -t nap:load "$ROOT"
kind load docker-image nap:load --name "$CLUSTER"

step "deploy"
kubectl apply -k "$ROOT/infra/k8s/load"
kubectl -n "$NAMESPACE" rollout status deployment/nap-postgres --timeout=300s

step "migrate"
kubectl -n "$NAMESPACE" delete job nap-migrate --ignore-not-found
sed 's|ghcr.io/mangit955/nap:latest|nap:load|' "$ROOT/infra/k8s/base/job-migrate.yaml" \
  | kubectl apply -f -
kubectl -n "$NAMESPACE" wait --for=condition=complete job/nap-migrate --timeout=300s

step "roll out"
kubectl -n "$NAMESPACE" rollout restart deployment/nap-api deployment/nap-worker deployment/nap-reaper
for deployment in nap-api nap-worker nap-reaper; do
  kubectl -n "$NAMESPACE" rollout status "deployment/$deployment" --timeout=600s
done
kubectl -n "$NAMESPACE" get pods -o wide

step "what the autoscalers can read"
# Printed rather than asserted: an unavailable metric is a degradation, not a failure, and the
# run should still happen and say so. `loadgen-cluster.ts` records the same thing in the report.
kubectl -n "$NAMESPACE" get hpa || true
kubectl -n "$NAMESPACE" get scaledobject || true
kubectl get --raw "/apis/custom.metrics.k8s.io/v1beta1/namespaces/$NAMESPACE/pods/*/nap_ws_connections" \
  2>/dev/null | head -c 400 || echo "custom metrics API not answering yet"

step "postgres port-forward"
# The report needs to read `turn_requests` depth and `pg_stat_activity` while the load runs, and
# nothing outside the cluster can otherwise reach the database.
kubectl -n "$NAMESPACE" port-forward service/nap-postgres 15432:5432 >/tmp/nap-load-pf.log 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
sleep 3

step "ramp"
bun run "$ROOT/apps/api/scripts/loadgen-cluster.ts" \
  --profile="$PROFILE" \
  --base="$INGRESS_URL" \
  --namespace="$NAMESPACE" \
  --database-url="postgres://nap:nap@localhost:15432/nap"
