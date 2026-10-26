#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run this as the operator user, without sudo." >&2
  exit 1
fi
if [[ ! -r /dev/kvm || ! -w /dev/kvm ]]; then
  echo "Current user needs read/write access to /dev/kvm." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
node_binary="$(command -v node)" || { echo 'Node.js is required.' >&2; exit 1; }
tsx_cli="$repo_root/apps/node-agent/node_modules/tsx/dist/cli.mjs"
[[ -f "$tsx_cli" ]] || {
  echo 'Install repository dependencies before running guest acceptance.' >&2
  exit 1
}
guest_root="$HOME/.local/share/trinity/firecracker-guest"
images="$guest_root/images"
runtime="$guest_root/run"
marker="$guest_root/.trinity-development-guest"
if [[ ! -f "$marker" || ! -f "$images/vmlinux" || ! -f "$images/rootfs.ext4" || ! -f "$images/data.ext4" ]]; then
  echo "Build the development guest first: sudo bash scripts/build-firecracker-guest.sh" >&2
  exit 1
fi
if ! grep -qx 'TRINITY DEVELOPMENT GUEST; HOST KERNEL; NOT PRODUCTION VALIDATED' "$marker"; then
  echo "Development marker mismatch; refusing to boot these images." >&2
  exit 1
fi

source "$repo_root/scripts/firecracker-image-check.sh"
verify_firecracker_guest_images "$images"

command -v flock >/dev/null 2>&1 || {
  echo "flock is required." >&2
  exit 1
}
install -d -m 0700 "$runtime"
exec 9>"$runtime/guest.lock"
flock -n 9 || {
  echo "A Firecracker guest test is already running." >&2
  exit 1
}

python3 - "$runtime/api.sock" <<'PY'
import pathlib
import sys
for path in map(pathlib.Path, sys.argv[1:]):
    if path.exists() or path.is_symlink():
        raise SystemExit(f"Unexpected stale API socket path: {path}")
PY

environment_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
tenant_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
user_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
session_id="$(python3 -c 'import uuid; print(uuid.uuid4())')"
relay_state_root="$(mktemp -d /tmp/tr-fcs.XXXXXX)"
firecracker_pid=""
cleanup() {
  if [[ -n "$firecracker_pid" ]] && kill -0 "$firecracker_pid" 2>/dev/null; then
    kill -TERM "$firecracker_pid" 2>/dev/null || true
    wait "$firecracker_pid" 2>/dev/null || true
    rm -f "$runtime/api.sock"
  fi
  if [[ -n "$relay_state_root" && "$relay_state_root" == /tmp/tr-fcs.* ]]; then
    python3 - "$relay_state_root" "$UID" <<'PY'
import os
import pathlib
import shutil
import sys
path = pathlib.Path(sys.argv[1])
if path.parent == pathlib.Path("/tmp") and path.name.startswith("tr-fcs.") and path.stat().st_uid == int(sys.argv[2]):
    shutil.rmtree(path)
PY
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for phase in write read; do
  generation="$(python3 -c 'import uuid; print(uuid.uuid4())')"
vsock_dir="$relay_state_root/jailer/firecracker/$generation/root"
install -d -m 0700 "$vsock_dir"
api_socket="$runtime/api.sock"
vsock_socket="$vsock_dir/vsock.sock"
console_log="$runtime/firecracker-$generation.log"
config_dir="$runtime/config-$generation"
install -d -m 0700 "$config_dir"
firecracker_pid=""

python3 - "$images" "$vsock_socket" "$config_dir" "$environment_id" "$generation" "$tenant_id" "$user_id" <<'PY'
import json
import pathlib
import sys
images, vsock_socket, config_dir = map(pathlib.Path, sys.argv[1:4])
environment, generation, tenant, user = sys.argv[4:]
configs = {
    "boot-source.json": {
        "kernel_image_path": str(images / "vmlinux"),
        "boot_args": f"console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda ro trinity.environment={environment} trinity.generation={generation} trinity.tenant={tenant} trinity.user={user}",
    },
    "rootfs.json": {
        "drive_id": "rootfs",
        "path_on_host": str(images / "rootfs.ext4"),
        "is_root_device": True,
        "is_read_only": True,
    },
    "data.json": {
        "drive_id": "data", "path_on_host": str(images / "data.ext4"),
        "is_root_device": False, "is_read_only": False,
    },
    "machine-config.json": {"vcpu_count": 2, "mem_size_mib": 2048, "smt": False},
    "vsock.json": {"guest_cid": 3, "uds_path": str(vsock_socket)},
}
for name, value in configs.items():
    (config_dir / name).write_text(json.dumps(value), encoding="utf-8")
PY

/usr/local/bin/firecracker --api-sock "$api_socket" >"$console_log" 2>&1 &
firecracker_pid=$!
for _ in {1..30}; do
  [[ -S "$api_socket" ]] && break
  kill -0 "$firecracker_pid" 2>/dev/null || {
    tail -n 80 "$console_log" >&2
    exit 1
  }
  sleep 1
done
[[ -S "$api_socket" ]] || {
  echo "Firecracker API socket did not appear." >&2
  tail -n 80 "$console_log" >&2
  exit 1
}

for endpoint in boot-source drives/rootfs drives/data machine-config vsock; do
  case "$endpoint" in
    boot-source) body="$config_dir/boot-source.json" ;;
    drives/rootfs) body="$config_dir/rootfs.json" ;;
    drives/data) body="$config_dir/data.json" ;;
    machine-config) body="$config_dir/machine-config.json" ;;
    vsock) body="$config_dir/vsock.json" ;;
  esac
  curl --silent --show-error --fail --unix-socket "$api_socket" \
    -H 'Content-Type: application/json' -X PUT --data-binary "@$body" \
    "http://localhost/$endpoint" >/dev/null
done
curl --silent --show-error --fail --unix-socket "$api_socket" \
  -H 'Content-Type: application/json' -X PUT \
  --data-binary '{"action_type":"InstanceStart"}' \
  http://localhost/actions >/dev/null

ready=false
for _ in {1..90}; do
  if grep -Fq 'TRINITY_GUEST_RPC_READY' "$console_log"; then
    ready=true
    break
  fi
  kill -0 "$firecracker_pid" 2>/dev/null || break
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo "Guest runtime did not become ready." >&2
  tail -n 120 "$console_log" >&2
  exit 1
fi

(cd "$repo_root" && "$node_binary" "$tsx_cli" "$repo_root/scripts/firecracker-guest-check.ts" \
  "$relay_state_root" "$environment_id" "$generation" "$tenant_id" "$user_id" "$session_id" "$phase" "$runtime/preview-$generation.json")
echo "Real guest $phase acceptance passed."
echo "Console log: $console_log"

kill -TERM "$firecracker_pid"
wait "$firecracker_pid" || true
firecracker_pid=""
rm -f "$api_socket"
done
echo 'Boot, actual guest RPC, persistent data across reboot and Zendriver preview passed.'
echo 'This direct VMM development check does not validate jailer, Node Agent/PG routing or network isolation.'
