#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) -eq 0 && -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]] || {
  echo 'Run from the operator account with the Node 22 executable: sudo bash scripts/install-firecracker-node-agent.sh "$(command -v node)"' >&2
  exit 1
}

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
node_bin="${1:-}"
[[ "$node_bin" == /* && -x "$node_bin" ]] || {
  echo 'Pass an absolute, executable Node.js path (for example, "$(command -v node)").' >&2
  exit 1
}
node_bin="$(readlink -f "$node_bin")"
[[ -f "$repo_root/apps/node-agent/node_modules/tsx/dist/cli.mjs" && -f "$repo_root/apps/node-agent/src/main.ts" ]] || {
  echo 'Install repository dependencies before installing the Node Agent unit.' >&2
  exit 1
}
"$node_bin" -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 12)) process.exit(1)' || {
  echo 'Node.js 22.12 or newer is required.' >&2
  exit 1
}
[[ -c /dev/kvm && -x /usr/local/bin/jailer && -x /usr/local/libexec/trinity-start-vm ]] || {
  echo 'Install and verify the Firecracker host prerequisites first.' >&2
  exit 1
}
[[ -f /srv/trinity-node/.trinity-storage-mode && ! -L /srv/trinity-node/.trinity-storage-mode ]] || {
  echo 'Prepare /srv/trinity-node with an explicit storage mode first.' >&2
  exit 1
}
if systemctl is-active --quiet trinity-node-agent.service; then
  echo 'The Node Agent is already active; stop it before reinstalling its unit.' >&2
  exit 1
fi

install -d -o root -g root -m 0755 /etc/trinity /etc/systemd/system /usr/local/libexec
env_file=/etc/trinity/node-agent.env
if [[ ! -e "$env_file" && ! -L "$env_file" ]]; then
  install -o root -g root -m 0600 "$repo_root/deploy/firecracker/node-agent.env.example" "$env_file"
elif [[ -L "$env_file" || ! -f "$env_file" || $(stat -c %u "$env_file") != 0 ]]; then
  echo 'Refusing an unsafe existing Node Agent environment file.' >&2
  exit 1
else
  chmod 0600 "$env_file"
fi

wrapper_tmp="$(mktemp /run/trinity-node-agent.XXXXXX)"
trap 'rm -f -- "$wrapper_tmp"' EXIT
printf '#!/usr/bin/env bash\nset -euo pipefail\ncd %q\nexec %q %q %q\n' \
  "$repo_root" \
  "$node_bin" \
  "$repo_root/apps/node-agent/node_modules/tsx/dist/cli.mjs" \
  "$repo_root/apps/node-agent/src/main.ts" > "$wrapper_tmp"
install -o root -g root -m 0755 "$wrapper_tmp" /usr/local/libexec/trinity-node-agent
install -o root -g root -m 0644 \
  "$repo_root/deploy/firecracker/trinity-node-agent.service" \
  /etc/systemd/system/trinity-node-agent.service
systemctl daemon-reload

echo 'Installed the root-managed Node Agent service; it is not enabled or started.'
echo "Edit $env_file with the control DATABASE_URL and a dedicated 32+ character NODE_RUNTIME_TOKEN."
echo 'Use the same NODE_ID and NODE_RUNTIME_TOKEN in the control-plane FIRECRACKER_NODES inventory.'
echo 'For this local unencrypted test host, keep NODE_DEPLOYMENT_MODE=development and NODE_STORAGE_ENCRYPTION=none.'
echo 'After configuration, run: sudo systemctl enable --now trinity-node-agent.service'
