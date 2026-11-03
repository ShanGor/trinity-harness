#!/usr/bin/env bash
# Operate existing rootless containers; deployment is scripts/deploy-podman.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/lib/podman-services.sh

usage() {
  printf 'Usage: %s {start|stop|restart|status}\n' "$0"
  printf 'Manage the five deployed Podman containers without builds or migrations.\n'
}
[[ $# == 1 ]] || { usage >&2; exit 2; }
case "$1" in
  -h|--help) usage; exit 0 ;;
  start|stop|restart|status) ACTION=$1 ;;
  *) usage >&2; exit 2 ;;
esac
command -v podman >/dev/null
NAMES=(trinity-browser-runtime trinity-server trinity-agent-worker trinity-audit-consumer trinity-gateway)

if [[ "$ACTION" == status ]]; then
  RESULT=0
  for name in "${NAMES[@]}"; do
    if podman container exists "$name"; then
      state=$(podman inspect --format '{{.State.Status}}' "$name")
      [[ "$state" == running ]] || RESULT=1
      printf '%-26s %s\n' "$name" "$state"
    else
      printf '%-26s missing\n' "$name"
      RESULT=1
    fi
  done
  exit "$RESULT"
fi

# Check the complete deployment before restart can stop anything.
if [[ "$ACTION" != stop ]]; then
  for tool in node curl systemctl; do command -v "$tool" >/dev/null; done
  for name in "${NAMES[@]}"; do
    if ! podman container exists "$name"; then
      printf '%s is missing. Run ./scripts/deploy-podman.sh first, as the same user.\n' "$name" >&2
      exit 1
    fi
  done
  STATE=$(mktemp -d)
  trap 'rm -rf "$STATE"' EXIT
  chmod 700 "$STATE"
  # Inspect contains credentials; never print it or reload a possibly changed .env.
  podman inspect trinity-server trinity-gateway > "$STATE/containers.json"
  node --input-type=module - "$STATE" "${WEB_PORT:-}" <<'JS'
import fs from 'node:fs';
import { deployedRuntimeConfig } from './scripts/podman-runtime.mjs';
const [state, webPort] = process.argv.slice(2);
const config = deployedRuntimeConfig(JSON.parse(fs.readFileSync(`${state}/containers.json`, 'utf8')), webPort);
fs.writeFileSync(`${state}/runtime.json`, JSON.stringify(config), {mode: 0o600});
JS
fi

if [[ "$ACTION" == stop || "$ACTION" == restart ]]; then
  # Stop ingress/consumers before their API and browser dependencies. Preserve containers.
  for ((i=${#NAMES[@]}-1; i>=0; i--)); do
    name=${NAMES[i]}
    if podman container exists "$name"; then
      podman stop --time 60 "$name" >/dev/null
      printf 'Stopped %s\n' "$name"
    else
      printf 'Skipped missing %s\n' "$name"
    fi
  done
fi
[[ "$ACTION" != stop ]] || exit 0

ensure_podman_node_agent
NODE_ENDPOINT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).nodeEndpoint' "$STATE/runtime.json")
curl --retry 30 --retry-connrefused --retry-delay 1 --connect-timeout 2 --max-time 5 --retry-max-time 60 --silent --show-error --output /dev/null "$NODE_ENDPOINT/instances"
node scripts/podman-runtime.mjs "$STATE/runtime.json" node
podman start trinity-browser-runtime >/dev/null
BROWSER_ENDPOINT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).browserEndpoint' "$STATE/runtime.json")
curl --retry 30 --retry-connrefused --retry-delay 1 --connect-timeout 2 --max-time 5 --retry-max-time 60 --silent --show-error --output /dev/null "$BROWSER_ENDPOINT/execute"
node scripts/podman-runtime.mjs "$STATE/runtime.json" browser
for name in trinity-server trinity-agent-worker trinity-audit-consumer trinity-gateway; do
  podman start "$name" >/dev/null
done
WEB_PORT=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).webPort' "$STATE/runtime.json")
curl --retry 30 --retry-connrefused --retry-delay 1 --connect-timeout 2 --max-time 5 --retry-max-time 60 --fail --silent --show-error "http://127.0.0.1:$WEB_PORT/api/health"
curl --connect-timeout 2 --max-time 5 --fail --silent --show-error "http://127.0.0.1:$WEB_PORT/" >/dev/null
for name in "${NAMES[@]}"; do
  [[ "$(podman inspect --format '{{.State.Running}}' "$name")" == true ]]
done
printf '\nTrinity is listening on http://0.0.0.0:%s\n' "$WEB_PORT"
