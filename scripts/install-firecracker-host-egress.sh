#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) -eq 0 ]] || {
  echo 'Run with sudo: sudo bash scripts/install-firecracker-host-egress.sh' >&2
  exit 1
}

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
sandbox_env_file="$repo_root/.env"
if [[ $# -gt 0 ]]; then
  [[ $# == 2 && "$1" == --env-file && "$2" == /* && -f "$2" ]] || {
    echo 'Usage: install-firecracker-host-egress.sh [--env-file /absolute/deployment.env]' >&2; exit 64;
  }
  sandbox_env_file="$2"
fi
host_proxy_stage=''
host_proxy_mode=''
trap 'if [[ -n "$host_proxy_stage" ]]; then rm -rf -- "$host_proxy_stage"; fi' EXIT

for command in awk dnsmasq getent grep install ip nft pgrep python3 stat sysctl systemctl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
getent passwd dnsmasq >/dev/null || {
  echo 'The dnsmasq system account is missing; install the dnsmasq package first.' >&2
  exit 1
}

active_units="$(systemctl list-units --all --type=service --plain --no-legend 'trinity-vm@*.service' | awk '$3 != "inactive" && $3 != "failed" { print }')"
active_vmm="$(pgrep -a firecracker || true)"
if [[ -n "$active_units" || -n "$active_vmm" ]]; then
  echo 'A Firecracker VM is active or its state is uncertain; run this installer through scripts/release-firecracker-node.sh after configuring the maintenance API.' >&2
  [[ -z "$active_units" ]] || printf '%s\n' "$active_units" >&2
  [[ -z "$active_vmm" ]] || printf '%s\n' "$active_vmm" >&2
  exit 1
fi

source "$repo_root/scripts/lib/firecracker-host-proxy.sh"
prepare_host_proxy

node_agent_unit=/etc/systemd/system/trinity-node-agent.service
node_agent_active_before=false
if [[ -e "$node_agent_unit" || -L "$node_agent_unit" ]]; then
  [[ -f "$node_agent_unit" && ! -L "$node_agent_unit" ]] || {
    echo 'The installed Node Agent unit is not a regular root-managed unit file.' >&2
    exit 1
  }
  [[ $(stat -c %u "$node_agent_unit") == 0 ]] || {
    echo 'The installed Node Agent unit is not root-owned; refusing to restart it.' >&2
    exit 1
  }
  if [[ "$(systemctl show --property=ActiveState --value trinity-node-agent.service)" == active ]]; then
    node_agent_active_before=true
  fi
fi

install -d -o root -g root -m 0755 /usr/local/libexec /etc/systemd/system
install -o root -g root -m 0750 "$repo_root/deploy/firecracker/trinity-firecracker-egress-up" \
  /usr/local/libexec/trinity-firecracker-egress
install -o root -g root -m 0750 "$repo_root/scripts/configure-firecracker-guest-egress.sh" \
  /usr/local/libexec/trinity-configure-firecracker-guest-egress
install -o root -g root -m 0644 "$repo_root/deploy/firecracker/trinity-firecracker-egress.service" \
  /etc/systemd/system/trinity-firecracker-egress.service
install -o root -g root -m 0644 "$repo_root/deploy/firecracker/trinity-firecracker-egress-dns.service" \
  /etc/systemd/system/trinity-firecracker-egress-dns.service
install -o root -g root -m 0644 "$repo_root/deploy/firecracker/trinity-firecracker-egress-config@.service" \
  /etc/systemd/system/trinity-firecracker-egress-config@.service
stop_legacy_proxy
install_host_proxy
systemctl daemon-reload
systemctl enable trinity-firecracker-egress.service trinity-firecracker-egress-dns.service
systemctl restart trinity-firecracker-egress.service
if [[ "$host_proxy_mode" == proxy ]]; then
  systemctl enable trinity-sandbox-egress.service
  systemctl reset-failed trinity-sandbox-egress.service
  systemctl restart trinity-sandbox-egress.service
  [[ "$(systemctl show --property=ActiveState --value trinity-sandbox-egress.service)" == active ]]
fi
systemctl reset-failed trinity-firecracker-egress-dns.service
systemctl restart trinity-firecracker-egress-dns.service
[[ "$(systemctl show --property=ActiveState --value trinity-firecracker-egress.service)" == active ]]
[[ "$(systemctl show --property=ActiveState --value trinity-firecracker-egress-dns.service)" == active ]]
if [[ "$node_agent_active_before" == true ]]; then
  systemctl restart trinity-node-agent.service
  [[ "$(systemctl show --property=ActiveState --value trinity-node-agent.service)" == active ]]
  echo 'Restarted the Node Agent to load automatic guest route setup.'
fi

echo 'Installed and started the host NAT/DNS gateway for Firecracker guests.'
echo 'No Firecracker VM was active during installation; apply guest networking on a new generation.'
if [[ "$host_proxy_mode" == proxy ]]; then
  echo 'Configured whole-guest egress through SANDBOX_PROXY_URL.'
else
  echo 'SANDBOX_PROXY_URL is unset; guests use direct host routing.'
fi
