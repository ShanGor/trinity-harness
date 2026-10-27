#!/usr/bin/env bash
set -euo pipefail

operator_user="${SUDO_USER:-}"
if [[ -z "$operator_user" && "${PKEXEC_UID:-}" =~ ^[1-9][0-9]*$ ]]; then
  operator_user="$(getent passwd "$PKEXEC_UID" | cut -d: -f1)"
fi
[[ $(id -u) -eq 0 && -n "$operator_user" && "$operator_user" != root ]] || {
  echo 'Run from the operator account through pkexec or sudo.' >&2
  exit 1
}
network_check=denied
test_host=""
test_port=443
desktop=false
source_override=''
network_selected=false
while [[ $# -gt 0 ]]; do
  case "$1" in
  --desktop) [[ "$desktop" == false ]] || exit 64; desktop=true ;;
  --guest-root) [[ $# -ge 2 && -z "$source_override" ]] || exit 64; source_override="$2"; shift ;;
  --check-network-denied) [[ "$network_selected" == false ]] || exit 64; network_selected=true ;;
  --check-network-egress)
    [[ "$network_selected" == false ]] || exit 64
    network_selected=true
    network_check=egress
    test_host="${TRINITY_EGRESS_TEST_HOST:-}"
    test_port="${TRINITY_EGRESS_TEST_PORT:-443}"
    [[ -n "$test_host" ]] || { echo 'Set TRINITY_EGRESS_TEST_HOST to an operator-approved DNS name or IPv4 address.' >&2; exit 64; }
    python3 - "$test_host" "$test_port" <<'PY'
import ipaddress
import re
import sys

host, port = sys.argv[1:]
if not re.fullmatch(r"[0-9]{1,5}", port):
    raise SystemExit("TRINITY_EGRESS_TEST_PORT must be an integer from 1 to 65535")
try:
    number = int(port)
except ValueError:
    raise SystemExit("TRINITY_EGRESS_TEST_PORT must be an integer from 1 to 65535")
if not 1 <= number <= 65535:
    raise SystemExit("TRINITY_EGRESS_TEST_PORT must be an integer from 1 to 65535")
try:
    address = ipaddress.ip_address(host)
    if address.version != 4:
        raise SystemExit("The Firecracker guest egress test supports IPv4 destinations only")
except ValueError:
    labels = host.rstrip(".").split(".")
    if len(host) > 253 or not labels or any(
        not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
        for label in labels
    ):
        raise SystemExit("TRINITY_EGRESS_TEST_HOST must be a DNS name or IPv4 address")
PY
    ;;
  *) echo 'Usage: run-firecracker-jailer-test.sh [--desktop] [--guest-root PATH] [--check-network-denied|--check-network-egress]' >&2; exit 64 ;;
  esac
  shift
done
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
operator_home="$(getent passwd "$operator_user" | cut -d: -f6)"
operator_group="$(id -gn "$operator_user")"
source_root="${source_override:-$operator_home/.local/share/trinity/firecracker-guest}"
[[ "$(dirname "$source_root")" == "$operator_home/.local/share/trinity" && "$(basename "$source_root")" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ && ! -L "$source_root" && ! -L "$operator_home/.local/share/trinity" ]] || {
  echo 'Guest root must be a direct, non-symlinked operator Trinity directory.' >&2; exit 1;
}
base=/srv/trinity-node
report="$operator_home/.local/share/trinity/firecracker-jailer-test"
if [[ "$desktop" == true ]]; then
  report="$report/desktop-$(date -u +%Y%m%dT%H%M%SZ)-$$"
fi

for command in bridge ip nft flock systemctl journalctl sha256sum python3 jq pgrep stat; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
[[ -c /dev/kvm && -x /usr/local/bin/jailer && -x /usr/local/bin/firecracker ]] || {
  echo 'KVM, the installed jailer and Firecracker binaries are required.' >&2; exit 1;
}
for image in vmlinux rootfs.ext4 data.ext4 SHA256SUMS; do
  [[ -f "$source_root/images/$image" && ! -L "$source_root/images/$image" ]] || {
    echo "Missing or unsafe development image: $image" >&2; exit 1;
  }
done
[[ -f "$source_root/.trinity-development-guest" && ! -L "$source_root/.trinity-development-guest" ]] || {
  echo 'Build the real development guest first.' >&2; exit 1;
}
grep -qx 'TRINITY DEVELOPMENT GUEST; HOST KERNEL; NOT PRODUCTION VALIDATED' "$source_root/.trinity-development-guest"
source "$repo_root/scripts/firecracker-image-check.sh"
verify_firecracker_guest_images "$source_root/images"
[[ -f "$base/.trinity-storage-mode" && ! -L "$base/.trinity-storage-mode" ]] || {
  echo 'Run the explicit Firecracker storage setup first.' >&2; exit 1;
}
[[ $(cat "$base/.trinity-storage-mode") == development-unencrypted ]] || {
  echo 'This acceptance script currently supports only the explicitly configured development storage mode.' >&2; exit 1;
}
[[ -x /usr/local/libexec/trinity-start-vm && -f /etc/systemd/system/trinity-vm@.service ]] || {
  echo 'Install the Firecracker host launcher and systemd unit first.' >&2; exit 1;
}
if systemctl list-units 'trinity-vm@*.service' --state=active --no-legend --plain | grep -q .; then
  echo 'A Trinity VM is already active; run this acceptance check on an idle test host.' >&2; exit 1
fi

[[ -d "$base" && ! -L "$base" && $(stat -c %u "$base") == 0 ]] || {
  echo 'Node storage directory must be a root-owned real directory.' >&2; exit 1;
}
for path in "$base/images" "$base/instances" "$base/volumes" "$base/jailer"; do
  [[ ! -L "$path" ]] || { echo "Refusing symlinked node path: $path" >&2; exit 1; }
done
images_preinstalled=false
if [[ -d "$base/images" && -n "$(find "$base/images" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  verify_firecracker_guest_images "$base/images"
  [[ -f "$base/images/data.ext4" ]] && {
    echo 'The shared node images directory must not contain a writable data disk.' >&2; exit 1;
  }
  unexpected="$(find "$base/images" -mindepth 1 -maxdepth 1 \
    ! -name vmlinux ! -name rootfs.ext4 ! -name SHA256SUMS -print -quit)"
  [[ -z "$unexpected" ]] || { echo 'Unexpected entry in the node images directory.' >&2; exit 1; }
  cmp -s "$source_root/images/vmlinux" "$base/images/vmlinux" &&
    cmp -s "$source_root/images/rootfs.ext4" "$base/images/rootfs.ext4" || {
      echo 'Installed node images differ from this verified development guest.' >&2; exit 1;
    }
  images_preinstalled=true
fi
available_kib="$(df -Pk "$base" | awk 'NR == 2 { print $4 }')"
[[ "$available_kib" =~ ^[0-9]+$ ]] && (( available_kib >= 3 * 1024 * 1024 )) || {
  echo 'At least 3 GiB free on node storage is required for the copied development guest.' >&2; exit 1;
}
install -d -o root -g root -m 0700 "$base" "$base/images" "$base/instances" "$base/volumes" "$base/jailer"
if [[ "$images_preinstalled" != true &&
      -n "$(find "$base/images" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "$base/images is not empty; refusing to replace node images." >&2; exit 1
fi
exec 9>/run/lock/trinity-firecracker-jailer-test.lock
flock -n 9 || { echo 'Another jailer acceptance run is active.' >&2; exit 1; }

id=$(python3 -c 'import uuid; print(uuid.uuid4())')
tenant=$(python3 -c 'import uuid; print(uuid.uuid4())')
user=$(python3 -c 'import uuid; print(uuid.uuid4())')
session=$(python3 -c 'import uuid; print(uuid.uuid4())')
uid="$(python3 -c 'import secrets; print(100000 + secrets.randbelow(100000000))')"
gid="$uid"
if getent passwd "$uid" >/dev/null || getent group "$gid" >/dev/null; then
  echo 'Generated jailer uid/gid conflicts with a host account; retry the test.' >&2; exit 1
fi
namespace="trinity-$id"
volume="$base/volumes/$id"
instance_dir="$base/instances"
image_installed=false
namespace_created=false
current_unit=""
cleanup() {
  status=0
  if [[ -n "$current_unit" ]]; then
    systemctl stop "$current_unit" >/dev/null 2>&1 || status=1
    state="$(systemctl show --property=ActiveState --value "$current_unit" 2>/dev/null || true)"
    if [[ "$state" != inactive && "$state" != failed ]]; then status=1; fi
    journalctl -u "$current_unit" --output=cat --no-pager >"$report/$current_unit.log" 2>/dev/null || true
    systemctl reset-failed "$current_unit" >/dev/null 2>&1 || true
    systemctl revert --runtime "$current_unit" >/dev/null 2>&1 || true
    current_unit=""
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "Could not confirm the test VMM stopped. Preserving host assets under $base for recovery." >&2
    return
  fi
  if [[ "$namespace_created" == true ]]; then
    ip netns delete "$namespace" 2>/dev/null || true
    namespace_created=false
  fi
  if [[ -d "$volume" && ! -L "$volume" ]]; then rm -rf -- "$volume"; fi
  for file in "$instance_dir"/*.json; do
    [[ -f "$file" && ! -L "$file" ]] || continue
    if jq -e --arg id "$id" '.id == $id' "$file" >/dev/null 2>&1; then rm -- "$file"; fi
  done
  if [[ "$image_installed" == true && -d "$base/images" && ! -L "$base/images" ]]; then
    if verify_firecracker_guest_images "$base/images" >/dev/null 2>&1; then
      rm -f -- "$base/images/vmlinux" "$base/images/rootfs.ext4" "$base/images/SHA256SUMS"
    else
      echo "Image checksum changed; preserving test images under $base/images." >&2
    fi
  fi
  if [[ "$image_installed" == true && -z "$(find "$base/images" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    rmdir "$base/images" 2>/dev/null || true
  fi
  if [[ -d "$base/jailer" && ! -L "$base/jailer" ]]; then
    for generation in "${generations[@]:-}"; do
      [[ -n "$generation" ]] && rm -rf -- "$base/jailer/firecracker/$generation"
    done
  fi
}
generations=()
install -d -o "$operator_user" -g "$operator_group" -m 0700 "$report"
trap cleanup EXIT

if [[ "$images_preinstalled" != true ]]; then
  cp --sparse=always "$source_root/images/vmlinux" "$base/images/vmlinux"
  cp --sparse=always "$source_root/images/rootfs.ext4" "$base/images/rootfs.ext4"
  chmod 0644 "$base/images/vmlinux" "$base/images/rootfs.ext4"
  (cd "$base/images" && sha256sum vmlinux rootfs.ext4 > SHA256SUMS)
  chmod 0644 "$base/images/SHA256SUMS"
  image_installed=true
fi
verify_firecracker_guest_images "$base/images"

ip netns add "$namespace"
namespace_created=true
ip tuntap add name tap0 mode tap user "$uid" group "$gid"
ip link set tap0 netns "$namespace"
ip netns exec "$namespace" ip link set lo up
ip netns exec "$namespace" ip link set tap0 up
if [[ "$network_check" == denied ]]; then
  ip netns exec "$namespace" nft -f - <<'NFT'
table inet trinity_acceptance {
  chain input { type filter hook input priority 0; policy drop; iifname "lo" accept; }
  chain output { type filter hook output priority 0; policy drop; oifname "lo" accept; }
  chain forward { type filter hook forward priority 0; policy drop; }
}
NFT
  ip netns exec "$namespace" nft list table inet trinity_acceptance > "$report/network-policy.txt"
else
  systemctl is-active --quiet trinity-firecracker-egress.service &&
    systemctl is-active --quiet trinity-firecracker-egress-dns.service || {
      echo 'Host egress gateway and DNS relay must be active for this acceptance mode.' >&2; exit 1;
    }
fi
printf 'namespace=%s\nuid=%s\ngid=%s\n' "$namespace" "$uid" "$gid" > "$report/host-run.txt"

# Copy the prior disposable test disk; do not attach or modify the user's smoke-test disk.
for phase in write read; do
  generation=$(python3 -c 'import uuid; print(uuid.uuid4())')
  generations+=("$generation")
  unit="trinity-vm@$id-$generation.service"
  current_unit="$unit"
  install -d -o root -g root -m 0700 "$volume"
  if [[ "$phase" == write ]]; then
    cp --sparse=always "$source_root/images/data.ext4" "$volume/data.ext4"
    chown root:root "$volume/data.ext4"
    chmod 0600 "$volume/data.ext4"
    printf '{"uid":%s,"gid":%s}\n' "$uid" "$gid" > "$volume/runtime.json"
    chmod 0600 "$volume/runtime.json"
    if [[ "$network_check" == egress ]]; then
      bash "$repo_root/scripts/configure-firecracker-guest-egress.sh" "$id"
      printf 'network_check=egress\ntest_host=%s\ntest_port=%s\n' "$test_host" "$test_port" >> "$report/host-run.txt"
    fi
  fi
  jq -n --arg id "$id" --arg generation "$generation" --arg tenant "$tenant" --arg user "$user" \
    '{id:$id,generation:$generation,tenantId:$tenant,userId:$user,nodeId:"local-acceptance",state:"starting",vcpus:2,memoryMiB:2048}' \
    > "$instance_dir/$id-$generation.json"
  chmod 0600 "$instance_dir/$id-$generation.json"
  systemctl set-property --runtime "$unit" MemoryMax=2304M CPUQuota=200%
  systemctl start --no-block "$unit"
  ready=false
  for _ in {1..90}; do
    state="$(systemctl show --property=ActiveState --value "$unit" 2>/dev/null || true)"
    if [[ "$state" != activating && "$state" != active ]]; then
      journalctl -u "$unit" --output=cat --no-pager -n 100 >&2 || true
      echo "Jailer VM failed during $phase phase (systemd state: $state)." >&2
      exit 1
    fi
    if [[ "$state" == active ]] && journalctl -u "$unit" --output=cat --no-pager | grep -Fq 'TRINITY_GUEST_RPC_READY' &&
      { [[ "$desktop" != true ]] || journalctl -u "$unit" --output=cat --no-pager | grep -Fq 'TRINITY_GUEST_BROWSER_RPC_READY'; }; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    journalctl -u "$unit" --output=cat --no-pager -n 120 >&2 || true
    echo 'Jailer VM did not report guest RPC readiness within 90 seconds.' >&2
    exit 1
  fi
  if [[ "$network_check" == egress ]]; then
    network_args=(--check-network-egress "$test_host" "$test_port")
  else
    network_args=(--check-network-denied)
  fi
  desktop_args=()
  if [[ "$desktop" == true ]]; then desktop_args=(--desktop); fi
  (cd "$repo_root" && ./node_modules/.bin/tsx scripts/firecracker-guest-check.ts \
    "$base" "$id" "$generation" "$tenant" "$user" "$session" "$phase" \
    "$report/preview-$generation.json" "${network_args[@]}" "${desktop_args[@]}")
  chmod 0644 "$report/preview-$generation.json" "$report/preview-$generation.json.png"
  systemctl stop "$unit"
  state="$(systemctl show --property=ActiveState --value "$unit")"
  [[ "$state" == inactive ]] || { echo "VM stop was not confirmed: $state" >&2; exit 1; }
  journalctl -u "$unit" --output=cat --no-pager >"$report/$unit.log" || true
  # Transient instances may be unloaded as soon as the stopped cgroup is empty.
  systemctl reset-failed "$unit" >/dev/null 2>&1 || true
  systemctl revert --runtime "$unit" >/dev/null 2>&1 || true
  current_unit=""
done

if [[ "$network_check" == egress ]]; then
  echo "Jailer + systemd boot, private vsock RPC, persistent data, Zendriver and guest TCP egress to $test_host:$test_port passed."
else
  echo 'Jailer + systemd boot, private vsock RPC, persistent data, Zendriver and guest egress-deny checks passed.'
fi
echo "Reports and preview PNGs: $report"
echo 'This verifies one local development node; it does not prove production tenant isolation or live Node Agent/PG assignment routing.'
