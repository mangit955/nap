#!/bin/bash
# Free local Linux smoke. It builds a disposable Docker image, never an E2B template.
set -euo pipefail
root=$(cd "$(dirname "$0")/../../../.." && pwd)
context=$(mktemp -d "${TMPDIR:-/tmp}/nap-desktop-smoke.XXXXXX")
name="nap-desktop-smoke-$$"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; rm -rf "$context"; }
trap cleanup EXIT
bun build "$root/packages/sandbox/scripts/desktop-driver.ts" --target=node --format=esm --outfile="$context/driver.mjs"
bun build "$root/packages/sandbox/scripts/desktop-smoke/forced-cleanup.ts" --target=node --format=esm --outfile="$context/forced-cleanup.mjs"
cp "$root/packages/sandbox/scripts/desktop-smoke/Dockerfile" "$root/packages/sandbox/scripts/desktop-smoke/smoke.sh" "$context/"
docker build -t nap-desktop-local-smoke "$context"
docker run --name "$name" --network none --memory 1024m --cpus 2 nap-desktop-local-smoke

if [[ -n "${1:-}" ]]; then
  mkdir -p "$1"
  docker cp "$name:/tmp/recording.mp4" "$1/capture.mp4"
  docker cp "$name:/tmp/report.json" "$1/report.json"
  docker cp "$name:/tmp/forced-report.json" "$1/forced-report.json"
fi
