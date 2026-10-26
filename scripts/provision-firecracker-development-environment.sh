#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) -eq 0 && -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]] || {
  echo 'Run from the operator account: sudo bash scripts/provision-firecracker-development-environment.sh /srv/trinity-node/instances/<environment>-<generation>.json' >&2
  exit 1
}
manifest="${1:-}"
[[ $# -eq 1 && "$manifest" == /srv/trinity-node/instances/*.json &&
   -f "$manifest" && ! -L "$manifest" ]] || {
  echo 'Pass one root-owned manifest from /srv/trinity-node/instances.' >&2
  exit 1
}

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
operator_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
source_root="$operator_home/.local/share/trinity/firecracker-guest"
base=/srv/trinity-node
images="$base/images"
instance_dir="$base/instances"
volume=""
namespace=""
created_volume=false
created_namespace=false
completed=false
seed=""

for command in awk cat chmod cmp df e2fsck find flock getent grep install ip jq mkfs.ext4 mktemp nft python3 rm sha256sum stat systemctl truncate; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
[[ "$manifest" == "$instance_dir/"* && $(stat -c %u "$manifest") == 0 ]] || {
  echo 'Manifest must be a root-owned regular file under the node instance directory.' >&2
  exit 1
}
[[ -f "$base/.trinity-storage-mode" && ! -L "$base/.trinity-storage-mode" &&
   $(cat "$base/.trinity-storage-mode") == development-unencrypted ]] || {
  echo 'This provisioning script supports only development-unencrypted storage.' >&2
  exit 1
}
[[ -d "$base" && ! -L "$base" && $(stat -c %u "$base") == 0 &&
   -d "$base/instances" && ! -L "$base/instances" &&
   -d "$base/volumes" && ! -L "$base/volumes" ]] || {
  echo 'Node storage paths must be root-owned real directories.' >&2
  exit 1
}
[[ -f "$source_root/.trinity-development-guest" && ! -L "$source_root/.trinity-development-guest" ]] || {
  echo 'The marked development guest is required.' >&2; exit 1;
}
grep -qx 'TRINITY DEVELOPMENT GUEST; HOST KERNEL; NOT PRODUCTION VALIDATED' "$source_root/.trinity-development-guest"
source "$repo_root/scripts/firecracker-image-check.sh"
verify_firecracker_guest_images "$source_root/images" >/dev/null
verify_firecracker_guest_images "$images" >/dev/null
[[ ! -e "$images/data.ext4" && ! -L "$images/data.ext4" ]] || {
  echo 'Shared base images must not contain a writable data disk.' >&2; exit 1;
}
cmp -s "$source_root/images/vmlinux" "$images/vmlinux" &&
  cmp -s "$source_root/images/rootfs.ext4" "$images/rootfs.ext4" || {
    echo 'Node base images do not match the verified development guest.' >&2; exit 1;
  }

uuid_pattern='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
id="$(jq -er --arg pattern "$uuid_pattern" '.id | select(type == "string" and test($pattern))' "$manifest")"
generation="$(jq -er --arg pattern "$uuid_pattern" '.generation | select(type == "string" and test($pattern))' "$manifest")"
jq -e '.state == "starting" or .state == "quarantined"' "$manifest" >/dev/null || {
  echo 'Manifest must describe a pending or quarantined development start.' >&2; exit 1;
}
[[ "$manifest" == "$instance_dir/$id-$generation.json" ]] || {
  echo 'Manifest filename does not match its environment and generation.' >&2; exit 1;
}
[[ $(jq -r '.nodeId' "$manifest") =~ ^[a-z0-9-]{1,63}$ &&
   $(jq -r '.vcpus' "$manifest") =~ ^[0-9]+$ &&
   $(jq -r '.memoryMiB' "$manifest") =~ ^[0-9]+$ ]] || {
  echo 'Manifest has invalid node or resource fields.' >&2; exit 1;
}
unit="trinity-vm@$id-$generation.service"
unit_state="$(systemctl show --property=ActiveState --value "$unit" 2>/dev/null || true)"
[[ "$unit_state" != active && "$unit_state" != activating && "$unit_state" != deactivating ]] || {
  echo 'The target VM is active; stop and confirm it before provisioning.' >&2; exit 1;
}

install -d -o root -g root -m 0700 "$base/volumes"
volume="$base/volumes/$id"
namespace="trinity-$id"
[[ ! -e "$volume" && ! -L "$volume" && ! -e "/run/netns/$namespace" &&
   ! -L "/run/netns/$namespace" ]] || {
  echo 'A volume or network namespace already exists for this environment; refusing replacement.' >&2
  exit 1
}
available_kib="$(df -Pk "$base" | awk 'NR == 2 { print $4 }')"
[[ "$available_kib" =~ ^[0-9]+$ ]] && (( available_kib >= 3 * 1024 * 1024 )) || {
  echo 'At least 3 GiB free on node storage is required for the development data disk.' >&2; exit 1;
}
exec 9>/run/lock/trinity-firecracker-provision.lock
flock -n 9 || { echo 'Another Firecracker provisioning operation is active.' >&2; exit 1; }
trap 'if [[ -n "$seed" && "$seed" == /run/trinity-user-data-seed.* ]]; then rm -rf -- "$seed"; fi; if [[ "$completed" != true ]]; then if [[ "$created_namespace" == true ]]; then ip netns delete "$namespace" 2>/dev/null || true; fi; if [[ "$created_volume" == true && "$volume" == /srv/trinity-node/volumes/* ]]; then rm -rf -- "$volume"; fi; fi' EXIT

uid=""
gid=""
for _ in {1..20}; do
  uid="$(python3 -c 'import secrets; print(100000 + secrets.randbelow(100000000))')"
  gid="$uid"
  if ! getent passwd "$uid" >/dev/null && ! getent group "$gid" >/dev/null; then break; fi
  uid=""
done
[[ -n "$uid" ]] || { echo 'Could not allocate a unique guest uid/gid.' >&2; exit 1; }

install -d -o root -g root -m 0700 "$volume"
created_volume=true
seed="$(mktemp -d /run/trinity-user-data-seed.XXXXXX)"
install -d -o 1000 -g 1000 -m 0700 "$seed/workspace" "$seed/browser"
truncate -s 2G "$volume/data.ext4"
mkfs.ext4 -F -m 0 -L trinity-user -d "$seed" "$volume/data.ext4" >/dev/null
e2fsck -fn "$volume/data.ext4" >/dev/null
chown root:root "$volume/data.ext4"
chmod 0600 "$volume/data.ext4"
printf '{"uid":%s,"gid":%s}\n' "$uid" "$gid" > "$volume/runtime.json"
chown root:root "$volume/runtime.json"
chmod 0600 "$volume/runtime.json"

ip netns add "$namespace"
created_namespace=true
ip -n "$namespace" link set lo up
ip netns exec "$namespace" ip tuntap add name tap0 mode tap user "$uid" group "$gid"
ip -n "$namespace" link set tap0 up
bash "$repo_root/scripts/configure-firecracker-guest-egress.sh" "$id"

completed=true
echo "Provisioned development environment $id from generation $generation."
echo "Data volume: $volume/data.ext4 (fresh, writable, development-only)"
echo "Network namespace: $namespace (host-routed IPv4 egress; private/LAN destinations remain blocked)"
echo 'Next, use the authenticated suspend operation to reconcile the failed first start, then wake for a fresh generation.'
