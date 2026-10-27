#!/usr/bin/env bash
# Operator-owned wrapper for the pinned Zendriver launch. The matching guest
# firewall must be active before this wrapper may be used.
set -euo pipefail
args=()
seen=0
for arg in "$@"; do
  case "$arg" in
    --remote-debugging-port=0)
      ((seen += 1))
      args+=(--remote-debugging-port=39142)
      ;;
    --remote-debugging-*)
      exit 64
      ;;
    *) args+=("$arg") ;;
  esac
done
[[ "$seen" -eq 1 ]] || exit 64
export HOME=/home/trinity-chrome
exec /usr/bin/setpriv --reuid=1002 --regid=1002 --clear-groups \
  --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs \
  /opt/google/chrome/google-chrome "${args[@]}" --start-maximized
