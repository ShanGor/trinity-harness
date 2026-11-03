#!/usr/bin/env bash
# Shared by deployment and service-only startup.
ensure_podman_node_agent() {
  # Node Agent owns privileged VM lifecycle; never restart an active agent or VM.
  if ! systemctl is-active --quiet trinity-node-agent.service; then
    if ! systemctl cat trinity-node-agent.service >/dev/null 2>&1; then
      printf 'Provision the host Node Agent first (deploy/firecracker/README.md).\n' >&2
      exit 1
    fi
    printf 'Starting the installed Node Agent; polkit may request authentication.\n'
    pkexec /usr/bin/systemctl start trinity-node-agent.service
  fi
}
