#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) -eq 0 && $# -eq 1 ]] || {
  echo 'Usage: sudo bash scripts/configure-firecracker-guest-egress.sh <environment-uuid>' >&2
  exit 64
}
id="$1"
uuid_pattern='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
[[ "$id" =~ $uuid_pattern ]] || { echo 'Invalid environment UUID.' >&2; exit 64; }

base=/srv/trinity-node
namespace="trinity-$id"
volume="$base/volumes/$id"
network_file="$volume/network.json"
bridge=trinity-egress0
bridge_gateway=172.29.240.1
tap_gateway=172.16.0.1
host_if="tg$(printf '%s' "${id//-/}" | cut -c1-12)"
egress_ip=""
firewall_changed=false
network_written=false
complete=false
tap_address_added=false
default_route_added=false

for command in awk bridge cut flock grep ip jq nft python3 stat systemctl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
[[ -d "$base/volumes" && ! -L "$base/volumes" && -d "$volume" && ! -L "$volume" &&
   -f "$volume/runtime.json" && ! -L "$volume/runtime.json" &&
   -e "/run/netns/$namespace" && ! -L "/run/netns/$namespace" ]] || {
  echo 'The environment volume, runtime metadata, or network namespace is missing or unsafe.' >&2
  exit 1
}
[[ $(stat -c %u "$volume") == 0 && $(stat -c %a "$volume") == 700 &&
   $(stat -c %u "$volume/runtime.json") == 0 && $(stat -c %a "$volume/runtime.json") == 600 ]] || {
  echo 'Environment volume and metadata must be root-owned with mode 0700/0600.' >&2; exit 1;
}
unit_is_active() {
  [[ "$(systemctl show --property=ActiveState --value "$1")" == active ]]
}
unit_is_active trinity-firecracker-egress.service &&
  unit_is_active trinity-firecracker-egress-dns.service || {
    echo 'Install and start the host egress gateway first.' >&2; exit 1;
  }
ip link show dev "$bridge" >/dev/null 2>&1 || { echo 'Host egress bridge is missing.' >&2; exit 1; }
ip -d -o link show dev "$bridge" | grep -Fq 'alias trinity-firecracker-egress' || {
  echo 'Host egress bridge is not the bridge managed by Trinity.' >&2; exit 1;
}
ip -o -4 address show dev "$bridge" | grep -Fq 'inet 172.29.240.1/20 ' || {
  echo 'Host egress bridge gateway address is missing.' >&2; exit 1;
}

for unit in $(systemctl list-units --type=service --state=active --no-legend --plain 'trinity-vm@*.service' | awk '{print $1}'); do
  case "$unit" in
    "trinity-vm@$id-"*) echo 'The environment VMM is active; stop it and confirm shutdown first.' >&2; exit 1 ;;
  esac
done
if ip netns pids "$namespace" | grep -q .; then
  echo 'The environment network namespace still has a process; stop and confirm it before reconfiguration.' >&2
  exit 1
fi
ip -n "$namespace" link show dev tap0 >/dev/null 2>&1 || { echo 'The namespace has no tap0.' >&2; exit 1; }

exec 9>/run/lock/trinity-firecracker-egress.lock
flock -n 9 || { echo 'Another Firecracker egress configuration is active.' >&2; exit 1; }

restore_default_deny() {
  ip netns exec "$namespace" nft -f - <<'NFT' >/dev/null 2>&1 || true
table inet trinity_development {
  chain input { type filter hook input priority 0; policy drop; iifname "lo" accept; }
  chain output { type filter hook output priority 0; policy drop; oifname "lo" accept; }
  chain forward { type filter hook forward priority 0; policy drop; }
}
NFT
}
previous_ip_forward="$(ip netns exec "$namespace" sysctl -n net.ipv4.ip_forward)"
[[ "$previous_ip_forward" == 0 || "$previous_ip_forward" == 1 ]] || {
  echo 'The namespace has an invalid IPv4 forwarding setting.' >&2; exit 1;
}
cleanup() {
  if [[ "$complete" != true ]]; then
    ip -n "$namespace" link del dev uplink0 >/dev/null 2>&1 || true
    ip link del dev "$host_if" >/dev/null 2>&1 || true
    if [[ "$firewall_changed" == true ]]; then
      ip netns exec "$namespace" nft delete table ip trinity_development_nat >/dev/null 2>&1 || true
      ip netns exec "$namespace" nft delete table inet trinity_development >/dev/null 2>&1 || true
      restore_default_deny
    fi
    if [[ "$default_route_added" == true ]]; then
      ip -n "$namespace" route del default >/dev/null 2>&1 || true
    fi
    if [[ "$tap_address_added" == true ]]; then
      ip -n "$namespace" address del "$tap_gateway/30" dev tap0 >/dev/null 2>&1 || true
    fi
    ip netns exec "$namespace" sysctl -w "net.ipv4.ip_forward=$previous_ip_forward" >/dev/null 2>&1 || true
    if [[ "$network_written" == true ]]; then rm -f -- "$network_file"; fi
  fi
}
sync_virtual_dns_rule() {
  local handles enabled=False
  if [[ -f /etc/trinity/sandbox-egress/proxy.json ]]; then
    enabled="$(python3 -c 'import json; print(bool(json.load(open("/etc/trinity/sandbox-egress/proxy.json"))["proxyUrl"]))')"
  fi
  handles="$(ip netns exec "$namespace" nft -a list chain inet trinity_development forward | python3 -c '
import re, sys
for line in sys.stdin:
    if "trinity-sandbox-dns-map-v1" not in line:
        continue
    match = re.fullmatch(r"\s*iifname \"tap0\" oifname \"uplink0\" ip saddr 172\.16\.0\.2 ip daddr 198\.19\.0\.0/16 accept comment \"trinity-sandbox-dns-map-v1\" # handle ([0-9]+)\s*", line)
    if not match:
        raise SystemExit("Unexpected virtual DNS mapping rule; preserve it for operator recovery")
    print(match[1])
')"
  for handle in $handles; do
    ip netns exec "$namespace" nft delete rule inet trinity_development forward handle "$handle"
  done
  if [[ "$enabled" == True ]]; then
    ip netns exec "$namespace" nft insert rule inet trinity_development forward \
      iifname '"tap0"' oifname '"uplink0"' ip saddr 172.16.0.2 ip daddr 198.19.0.0/16 accept comment '"trinity-sandbox-dns-map-v1"'
  fi
}

if [[ -f "$network_file" && ! -L "$network_file" ]]; then
  [[ $(stat -c %u "$network_file") == 0 && $(stat -c %a "$network_file") == 600 ]] || {
    echo 'Existing guest network metadata has unsafe ownership or permissions; preserve it for operator recovery.' >&2
    exit 1
  }
  egress_ip="$(jq -er --arg id "$id" --arg hostIf "$host_if" '
    select(.version == 1 and .environmentId == $id and .bridge == "trinity-egress0" and
      .bridgeGateway == "172.29.240.1" and .tapAddress == "172.16.0.2" and
      .hostInterface == $hostIf) | .egressAddress
    | select(type == "string")' "$network_file")" || {
      echo 'Existing guest network metadata is invalid; preserve it for operator recovery.' >&2
      exit 1
    }
  if ip -n "$namespace" link show dev uplink0 >/dev/null 2>&1; then
    ip link show dev "$host_if" >/dev/null 2>&1 || {
      echo 'Existing guest egress host interface is missing; preserve it for operator recovery.' >&2; exit 1;
    }
    ip -d -o link show dev "$host_if" | grep -Fq "master $bridge" || {
      echo 'Existing guest egress host interface is not attached to the owned bridge.' >&2; exit 1;
    }
    bridge -details -json link show dev "$host_if" |
      jq -e --arg hostIf "$host_if" 'length == 1 and .[0].ifname == $hostIf and .[0].master == "trinity-egress0" and .[0].isolated == true' >/dev/null || {
      echo 'Existing guest egress bridge port is not isolated from other guests.' >&2; exit 1;
    }
    ip netns exec "$namespace" nft list table inet trinity_development |
      grep -Fq 'managed-by-Trinity-Firecracker-guest-egress-v1' || {
        echo 'Existing guest egress firewall is missing its ownership marker.' >&2; exit 1;
      }
    ip netns exec "$namespace" nft list table ip trinity_development_nat |
      grep -Fq 'managed-by-Trinity-Firecracker-guest-egress-v1' || {
        echo 'Existing guest egress NAT table is missing its ownership marker.' >&2; exit 1;
      }
    nft list table inet trinity_firecracker_egress |
      grep -Fq 'managed-by-Trinity-Firecracker-egress-v1' || {
        echo 'Host egress firewall is missing its ownership marker.' >&2; exit 1;
      }
    nft list table ip trinity_firecracker_egress_nat |
      grep -Fq 'managed-by-Trinity-Firecracker-egress-v1' || {
        echo 'Host egress NAT table is missing its ownership marker.' >&2; exit 1;
      }
    ip -n "$namespace" -4 address show dev uplink0 | grep -Fq "inet $egress_ip/20 " || {
      echo 'Existing guest egress interface does not match network metadata.' >&2; exit 1;
    }
    ip -n "$namespace" route show default | grep -Fq "via $bridge_gateway dev uplink0" || {
      echo 'Existing guest default route does not match network metadata.' >&2; exit 1;
    }
    ip -n "$namespace" -4 address show dev tap0 | grep -Fq "inet $tap_gateway/30 " || {
      echo 'Existing guest TAP gateway does not match the configured guest image.' >&2; exit 1;
    }
    sync_virtual_dns_rule
    echo "Guest egress is already configured for $id ($egress_ip)."
    complete=true
    exit 0
  fi
  echo 'Network metadata exists without its veth interface; preserve it for operator recovery.' >&2
  exit 1
fi
[[ ! -e "$network_file" && ! -L "$network_file" && ! -e "/sys/class/net/$host_if" ]] || {
  echo 'A partial egress setup exists; preserve it for operator recovery.' >&2
  exit 1
}
trap cleanup EXIT

egress_ip="$(python3 - "$base/volumes" "$id" <<'PY'
import hashlib
import ipaddress
import json
import pathlib
import sys

volumes, environment_id = pathlib.Path(sys.argv[1]), sys.argv[2]
network = ipaddress.ip_network("172.29.240.0/20")
gateway = ipaddress.ip_address("172.29.240.1")
used = {gateway}
for metadata in volumes.glob("*/network.json"):
    if metadata.is_symlink() or not metadata.is_file():
        raise SystemExit("Unsafe network metadata exists under the volumes directory")
    try:
        value = json.loads(metadata.read_text())
        candidate = ipaddress.ip_address(value["egressAddress"])
    except (OSError, ValueError, KeyError, TypeError):
        raise SystemExit(f"Invalid guest network metadata: {metadata}")
    if candidate not in network or candidate in {network.network_address, network.broadcast_address}:
        raise SystemExit(f"Out-of-range guest network address in {metadata}")
    used.add(candidate)
hosts = list(network.hosts())
start = int.from_bytes(hashlib.sha256(environment_id.encode()).digest()[:4], "big") % len(hosts)
for offset in range(len(hosts)):
    candidate = hosts[(start + offset) % len(hosts)]
    if candidate != gateway and candidate not in used:
        print(candidate)
        break
else:
    raise SystemExit("The Firecracker egress address pool is exhausted")
PY
)"

tap_ipv4="$(ip -n "$namespace" -o -4 address show dev tap0 | awk '$3 == "inet" { print $4 }')"
[[ -z "$tap_ipv4" || "$tap_ipv4" == "$tap_gateway/30" ]] || {
  echo 'TAP device has an unexpected IPv4 address; preserve it for operator recovery.' >&2
  exit 1
}
[[ -z "$(ip -n "$namespace" route show default)" ]] || {
  echo 'Network namespace already has a default route; preserve it for operator recovery.' >&2
  exit 1
}

ip link add "$host_if" type veth peer name uplink0
ip link set dev "$host_if" master "$bridge"
bridge link set dev "$host_if" isolated on
ip link set dev uplink0 netns "$namespace"
ip -n "$namespace" address add "$egress_ip/20" dev uplink0
if [[ -z "$tap_ipv4" ]]; then
  ip -n "$namespace" address add "$tap_gateway/30" dev tap0
  tap_address_added=true
fi
ip netns exec "$namespace" sysctl -w net.ipv4.ip_forward=1 >/dev/null

old_table="$(ip netns exec "$namespace" nft list table inet trinity_development 2>/dev/null || true)"
old_nat_table="$(ip netns exec "$namespace" nft list table ip trinity_development_nat 2>/dev/null || true)"
if [[ -n "$old_table" ]]; then
  if [[ "$old_table" != *'managed-by-Trinity-Firecracker-guest-egress-v1'* ]]; then
    printf '%s\n' "$old_table" | python3 -c '
import re, sys
text = re.sub(r"priority\s+0(?=;)", "priority filter", sys.stdin.read())
lines = [line.strip() for line in text.splitlines() if line.strip() and line.strip() not in {"}", "};"}]
allowed = {
    "table inet trinity_development {",
    "chain input {", "type filter hook input priority filter; policy drop;", "iifname \"lo\" accept",
    "chain output {", "type filter hook output priority filter; policy drop;", "oifname \"lo\" accept",
    "chain forward {", "type filter hook forward priority filter; policy drop;",
}
if any(line not in allowed for line in lines) or set(lines) != allowed:
    raise SystemExit("Existing namespace firewall is not the known default-deny table")
' || {
      echo 'Existing namespace firewall is customized; refusing to replace it.' >&2
      exit 1
    }
  fi
fi
if [[ -n "$old_nat_table" && "$old_nat_table" != *'managed-by-Trinity-Firecracker-guest-egress-v1'* ]]; then
  echo 'Existing namespace NAT table is customized; refusing to replace it.' >&2
  exit 1
fi
firewall_changed=true
if [[ -n "$old_table" ]]; then
  ip netns exec "$namespace" nft delete table inet trinity_development
fi
if [[ -n "$old_nat_table" ]]; then
  ip netns exec "$namespace" nft delete table ip trinity_development_nat
fi

ip netns exec "$namespace" nft -f - <<'NFT'
table inet trinity_development {
  comment "managed-by-Trinity-Firecracker-guest-egress-v1"
  chain input {
    type filter hook input priority filter; policy drop;
    iifname "lo" accept
    ct state established,related accept
  }
  chain output {
    type filter hook output priority filter; policy drop;
    oifname "lo" accept
    ct state established,related accept
  }
  chain forward {
    type filter hook forward priority filter; policy drop;
    ct state established,related accept
    iifname "tap0" oifname "uplink0" ip saddr 172.16.0.2 ip daddr 172.29.240.1 udp dport 53 accept
    iifname "tap0" oifname "uplink0" ip saddr 172.16.0.2 ip daddr 172.29.240.1 tcp dport 53 accept
    iifname "tap0" meta nfproto ipv6 drop
    iifname "tap0" ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4 } drop
    iifname "tap0" udp dport 53 drop
    iifname "tap0" oifname "uplink0" ip saddr 172.16.0.2 accept
  }
}
table ip trinity_development_nat {
  comment "managed-by-Trinity-Firecracker-guest-egress-v1"
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr 172.16.0.2 oifname "uplink0" masquerade
  }
}
NFT

sync_virtual_dns_rule

ip link set dev "$host_if" up
ip -n "$namespace" link set dev tap0 up
ip -n "$namespace" link set dev uplink0 up
default_route_added=true
ip -n "$namespace" route replace default via "$bridge_gateway" dev uplink0
network_written=true
jq -n --arg id "$id" --arg hostIf "$host_if" --arg egress "$egress_ip" \
  '{version:1,environmentId:$id,bridge:"trinity-egress0",bridgeGateway:"172.29.240.1",hostInterface:$hostIf,egressAddress:$egress,tapGateway:"172.16.0.1",tapAddress:"172.16.0.2",dns:"172.29.240.1"}' \
  > "$network_file"
chown root:root "$network_file"
chmod 0600 "$network_file"
complete=true
trap - EXIT

echo "Configured host-routed IPv4 egress for $id ($egress_ip)."
echo 'Guest traffic uses host NAT and host DNS; no proxy URL or credentials are sent to the guest.'
