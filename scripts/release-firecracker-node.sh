#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo 'Usage: FIRECRACKER_MAINTENANCE_URL=https://server.example FIRECRACKER_MAINTENANCE_TOKEN=<token> bash scripts/release-firecracker-node.sh <node-id> -- <release-command> [args...]' >&2
}

if [[ $# -lt 3 || "$2" != '--' ]]; then
  usage
  exit 64
fi
node_id="$1"
shift 2
[[ "$node_id" =~ ^[a-z0-9-]{1,63}$ ]] || { usage; exit 64; }
[[ -z "${NODE_ID:-}" || "$NODE_ID" == "$node_id" ]] || {
  echo "NODE_ID is set to '$NODE_ID' but this release targets '$node_id'." >&2
  exit 64
}
maintenance_url="${FIRECRACKER_MAINTENANCE_URL:-}"
maintenance_token="${FIRECRACKER_MAINTENANCE_TOKEN:-}"
unset FIRECRACKER_MAINTENANCE_TOKEN
[[ -n "$maintenance_url" && -n "$maintenance_token" ]] || {
  echo 'Set FIRECRACKER_MAINTENANCE_URL and FIRECRACKER_MAINTENANCE_TOKEN.' >&2
  exit 64
}
[[ "$maintenance_token" =~ ^[A-Za-z0-9_-]{32,}$ ]] || {
  echo 'FIRECRACKER_MAINTENANCE_TOKEN must be at least 32 URL-safe characters.' >&2
  exit 64
}

for command in awk curl flock install pgrep python3 systemctl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done

python3 - "$maintenance_url" "$node_id" <<'PY'
import re
import sys
from urllib.parse import urlsplit

url, node_id = sys.argv[1:]
parsed = urlsplit(url)
loopback = parsed.hostname in {"127.0.0.1", "::1", "localhost"}
if (
    not re.fullmatch(r"[a-z0-9-]{1,63}", node_id)
    or parsed.scheme not in ({"https", "http"} if loopback else {"https"})
    or not parsed.hostname
    or parsed.username
    or parsed.password
    or parsed.path not in {"", "/"}
    or parsed.query
    or parsed.fragment
):
    raise SystemExit("FIRECRACKER_MAINTENANCE_URL must be an HTTPS server origin (HTTP loopback is allowed)")
PY

if [[ -n "${XDG_RUNTIME_DIR:-}" ]]; then
  state_base="$XDG_RUNTIME_DIR"
elif [[ -n "${HOME:-}" ]]; then
  state_base="$HOME/.cache"
else
  echo 'Set HOME or XDG_RUNTIME_DIR so this release can lock per-node operations.' >&2
  exit 1
fi
state_dir="$state_base/trinity-firecracker-release"
install -d -m 0700 "$state_dir"
exec {lock_fd}>"$state_dir/$node_id.lock"
flock -n "$lock_fd" || { echo "A release is already running for node $node_id." >&2; exit 1; }

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
api_origin="${maintenance_url%/}"

post_action() {
  local action="$1"
  local url="$api_origin/api/ops/firecracker-nodes/$node_id/$action"
  printf 'header = "Authorization: Bearer %s"\n' "$maintenance_token" |
    curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
      --connect-timeout 10 --max-time 1800 --config - --request POST \
      --header 'content-type: application/json' \
      --data '{}' "$url"
}

status="$(post_action drain)" || {
  echo 'Could not contact the maintenance API; no release command was run.' >&2
  exit 1
}
if [[ "$status" != 200 ]]; then
  case "$status" in
    401)
      echo 'The server rejected the maintenance token. Verify the server and release pipeline use the same FIRECRACKER_MAINTENANCE_TOKEN, and that the updated server build is deployed. This request did not authorize a drain; an earlier maintenance gate, if any, remains unchanged.' >&2
      ;;
    404)
      echo 'The maintenance API returned 404. A "Route POST:... not found" response means this server build lacks the maintenance route or the API URL is wrong; an "unknown Firecracker node" response means FIRECRACKER_NODES lacks this node. No release command was run.' >&2
      ;;
    409)
      echo 'The server could not stop every environment; the node remains in maintenance and no release command was run.' >&2
      ;;
    503)
      echo 'The server could not confirm the drain; the node may remain in maintenance and no release command was run.' >&2
      ;;
    *)
      echo "Node drain was not confirmed (HTTP $status); no release command was run." >&2
      ;;
  esac
  cat "$response_file" >&2
  exit 1
fi
python3 - "$response_file" "$node_id" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as response_file:
    value = json.load(response_file)
if value.get("nodeId") != sys.argv[2] or value.get("state") != "draining" or value.get("remaining") != 0:
    raise SystemExit("The maintenance API did not confirm that every environment stopped")
PY

active_units="$(systemctl list-units --all --type=service --plain --no-legend 'trinity-vm@*.service' | awk '$3 != "inactive" && $3 != "failed" { print }')"
active_vmm="$(pgrep -a firecracker || true)"
if [[ -n "$active_units" || -n "$active_vmm" ]]; then
  echo 'The host still reports a Firecracker unit or process; the node remains in maintenance.' >&2
  [[ -z "$active_units" ]] || printf '%s\n' "$active_units" >&2
  [[ -z "$active_vmm" ]] || printf '%s\n' "$active_vmm" >&2
  exit 1
fi

echo "All environments on $node_id are stopped; running the release command."
"$@"

status="$(post_action resume)" || {
  echo 'Release command completed, but the maintenance API could not be reached; the node remains in maintenance.' >&2
  exit 1
}
if [[ "$status" != 200 ]]; then
  echo "Release command completed, but node resume failed (HTTP $status); the node remains in maintenance." >&2
  cat "$response_file" >&2
  exit 1
fi
echo "Release completed and node $node_id is ready for new environment assignments."
