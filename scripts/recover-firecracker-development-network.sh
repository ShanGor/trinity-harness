#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) -eq 0 && $# -eq 1 && "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
  echo 'Usage: pkexec /usr/bin/bash scripts/recover-firecracker-development-network.sh <environment-uuid>' >&2
  exit 64
}
environment_id="$1"
base=/srv/trinity-node
volume="$base/volumes/$environment_id"
namespace="trinity-$environment_id"
network_file="$volume/network.json"
host_if="tg${environment_id//-/}"
host_if="${host_if:0:14}"
helper=/usr/local/libexec/trinity-configure-firecracker-guest-egress

for command in awk cat cp flock ip jq mktemp pgrep rm stat systemctl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
[[ -f "$base/.trinity-storage-mode" && ! -L "$base/.trinity-storage-mode" &&
   $(cat "$base/.trinity-storage-mode") == development-unencrypted ]] || {
  echo 'This repair supports only the existing development-unencrypted deployment.' >&2; exit 1;
}
for directory in "$base" "$base/volumes" "$volume"; do
  [[ -d "$directory" && ! -L "$directory" && $(stat -c %u "$directory") == 0 ]] || {
    echo 'Existing root-owned environment storage is required; no volume will be created.' >&2; exit 1;
  }
done
[[ $(stat -c %a "$volume") == 700 ]] || exit 1
for metadata in "$volume/runtime.json" "$network_file"; do
  [[ -f "$metadata" && ! -L "$metadata" && $(stat -c %u "$metadata") == 0 &&
     $(stat -c %a "$metadata") == 600 ]] || {
    echo 'Existing protected runtime and network metadata are required.' >&2; exit 1;
  }
done
[[ -f "$volume/data.ext4" && ! -L "$volume/data.ext4" &&
   -f "$helper" && ! -L "$helper" && $(stat -c %u "$helper") == 0 &&
   ( $(stat -c %a "$helper") == 750 || $(stat -c %a "$helper") == 755 ) ]] || {
  echo 'The existing data disk and installed root-owned network helper are required.' >&2; exit 1;
}
jq -e --arg id "$environment_id" --arg hostIf "$host_if" '
  .version == 1 and .environmentId == $id and .hostInterface == $hostIf and
  .bridge == "trinity-egress0" and .bridgeGateway == "172.29.240.1" and
  .tapGateway == "172.16.0.1" and .tapAddress == "172.16.0.2" and .dns == "172.29.240.1"
' "$network_file" >/dev/null
guest_uid="$(jq -er '.uid | select(type == "number" and . >= 100000 and . <= 2147483647 and floor == .)' "$volume/runtime.json")"
guest_gid="$(jq -er '.gid | select(type == "number" and . >= 100000 and . <= 2147483647 and floor == .)' "$volume/runtime.json")"

# The maintenance wrapper prevents new admissions; independently fail closed on
# any physical VMM or ambiguous/partial network state before changing anything.
exec 9>/run/lock/trinity-firecracker-provision.lock
flock -n 9 || { echo 'Another provisioning or recovery operation is active.' >&2; exit 1; }
active_units="$(systemctl list-units --all --type=service --plain --no-legend 'trinity-vm@*.service' | awk '$3 != "inactive" && $3 != "failed" { print }')"
[[ -z "$active_units" ]] || { echo 'Confirm all VMM units stopped before network recovery.' >&2; exit 1; }
process_status=0
pgrep -x firecracker >/dev/null || process_status=$?
[[ "$process_status" == 1 ]] || { echo 'VMM absence could not be confirmed.' >&2; exit 1; }
[[ ! -e "/run/netns/$namespace" && ! -L "/run/netns/$namespace" &&
   ! -e "/sys/class/net/$host_if" && ! -L "/sys/class/net/$host_if" ]] || {
  echo 'A namespace or host interface already exists; preserve it for operator inspection.' >&2; exit 1;
}
systemctl is-active --quiet trinity-firecracker-egress.service
systemctl is-active --quiet trinity-firecracker-egress-dns.service

backup="$(mktemp "$volume/network.pre-reboot.XXXXXXXX.json")"
cp -p -- "$network_file" "$backup"
complete=false
trap 'if [[ "$complete" != true ]]; then echo "Network repair was not confirmed; preserve namespace and metadata for inspection. Backup: $backup" >&2; fi' EXIT
ip netns add "$namespace"
ip -n "$namespace" link set lo up
ip netns exec "$namespace" ip tuntap add name tap0 mode tap user "$guest_uid" group "$guest_gid"
ip -n "$namespace" link set tap0 up
# The existing helper refuses stale metadata without a live interface. Archive
# only that network metadata, then let the same bounded allocator/firewall run.
rm -- "$network_file"
"$helper" "$environment_id"
complete=true
echo "Restored development networking for $environment_id. Existing data disk and runtime identity were preserved."
echo "Previous network metadata: $backup"
