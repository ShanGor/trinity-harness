# Sourced by the host egress installer only after its active-VM guard.
prepare_host_proxy() {
  local existing_rule
  existing_rule="$(ip -4 rule show | awk '$1 == "4900:" {print}')"
  [[ -z "$existing_rule" || "$existing_rule" == *'from 172.29.240.0/20 iif trinity-egress0 lookup 19013'* ]] || {
    echo 'Routing priority 4900 belongs to another host policy.' >&2; return 1;
  }
  local table
  table="$(ip -4 route show table 19013 2>/dev/null || true)"
  [[ -z "$table" || -f /etc/trinity/sandbox-egress/.managed || -f /etc/operator-guest-proxy/.operator-owned ]] || {
    echo 'Routing table 19013 is already in use.' >&2; return 1;
  }
  if ip link show guest-egress0 >/dev/null 2>&1; then
    local detail
    detail="$(ip -d -o link show guest-egress0)"
    [[ "$detail" == *'alias trinity-sandbox-egress-v1'* || ( "$detail" == *'alias operator-guest-proxy-v1'* && -f /etc/operator-guest-proxy/.operator-owned ) ]] || {
      echo 'Refusing an unowned guest-egress0 interface.' >&2; return 1;
    }
  fi
  host_proxy_stage="$(mktemp -d)"
  host_proxy_mode="$(python3 "$repo_root/scripts/sandbox-egress-config.py" stage "$sandbox_env_file" "$host_proxy_stage")"
}
stop_legacy_proxy() {
  if [[ -e /etc/operator-guest-proxy/.operator-owned ]]; then
    [[ ! -L /etc/operator-guest-proxy/.operator-owned && $(stat -c %u /etc/operator-guest-proxy/.operator-owned) == 0 && $(cat /etc/operator-guest-proxy/.operator-owned) == operator-guest-proxy-v1 ]] || {
      echo 'Legacy egress ownership cannot be verified.' >&2; return 1;
    }
    for unit in operator-guest-proxy.service operator-guest-dns.service; do
      if [[ -e "/etc/systemd/system/$unit" ]]; then
        [[ -f "/etc/systemd/system/$unit" && ! -L "/etc/systemd/system/$unit" && $(stat -c %u "/etc/systemd/system/$unit") == 0 ]] || { echo 'Legacy proxy unit is not root-managed.' >&2; return 1; }
        systemctl disable --now "$unit"
        case "$(systemctl show --property=ActiveState --value "$unit")" in inactive|failed) ;; *) echo 'Legacy proxy stop unconfirmed.' >&2; return 1 ;; esac
      fi
    done
    python3 - <<'PY'
from pathlib import Path
for name in ['/etc/systemd/system/trinity-firecracker-egress-dns.service.d/operator-upstream.conf',
             '/etc/systemd/system/trinity-firecracker-egress-config@.service.d/operator-upstream.conf',
             '/etc/systemd/system/operator-guest-proxy.service', '/etc/systemd/system/operator-guest-dns.service',
             '/usr/local/libexec/operator-guest-clash', '/usr/local/libexec/operator-guest-route']:
    Path(name).unlink(missing_ok=True)
PY
  fi
}
install_host_proxy() {
  install -d -o root -g root -m 0755 /etc/trinity/sandbox-egress \
    /etc/systemd/system/trinity-firecracker-egress-dns.service.d \
    /etc/systemd/system/trinity-firecracker-egress-config@.service.d
  printf '%s\n' trinity-sandbox-egress-v1 > /etc/trinity/sandbox-egress/.managed
  install -o root -g root -m 0600 "$host_proxy_stage/proxy.json" /etc/trinity/sandbox-egress/proxy.json
  if [[ "$host_proxy_mode" == proxy ]]; then
    install -o root -g root -m 0755 "$host_proxy_stage/tun2proxy" /usr/local/libexec/trinity-tun2proxy
    install -o root -g root -m 0750 "$repo_root/scripts/sandbox-egress-config.py" /usr/local/libexec/trinity-sandbox-proxy
    install -o root -g root -m 0750 "$repo_root/deploy/firecracker/trinity-sandbox-route" /usr/local/libexec/trinity-sandbox-route
    for unit in trinity-sandbox-egress.service; do
      install -o root -g root -m 0644 "$repo_root/deploy/firecracker/$unit" "/etc/systemd/system/$unit"
    done
    install -o root -g root -m 0644 "$repo_root/deploy/firecracker/trinity-sandbox-dns-upstream.conf" \
      /etc/systemd/system/trinity-firecracker-egress-dns.service.d/sandbox-upstream.conf
    install -o root -g root -m 0644 "$repo_root/deploy/firecracker/trinity-sandbox-egress-config.conf" \
      /etc/systemd/system/trinity-firecracker-egress-config@.service.d/sandbox-upstream.conf
  elif [[ "$host_proxy_mode" == direct ]]; then
    if [[ -f /etc/systemd/system/trinity-sandbox-egress.service ]]; then
      systemctl disable --now trinity-sandbox-egress.service
    fi
    if ip -4 rule show | grep -Eq '^4900:.*from 172\.29\.240\.0/20 iif trinity-egress0 lookup 19013'; then
      ip -4 rule del priority 4900 from 172.29.240.0/20 iif trinity-egress0 lookup 19013
      ip -4 route flush table 19013
    fi
    python3 - <<'PY'
from pathlib import Path
for name in ['/etc/systemd/system/trinity-firecracker-egress-dns.service.d/sandbox-upstream.conf',
             '/etc/systemd/system/trinity-firecracker-egress-config@.service.d/sandbox-upstream.conf']:
    Path(name).unlink(missing_ok=True)
PY
  else
    echo 'Invalid sandbox egress mode.' >&2; return 1
  fi
  python3 - <<'PY'
from pathlib import Path
Path('/etc/operator-guest-proxy/.operator-owned').unlink(missing_ok=True)
PY
}
