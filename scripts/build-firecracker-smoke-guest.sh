#!/usr/bin/env bash
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/build-firecracker-smoke-guest.sh" >&2
  exit 1
fi

operator_user="${SUDO_USER:-}"
if [[ -z "$operator_user" || "$operator_user" == root ]]; then
  echo "Run through sudo from the operator account." >&2
  exit 1
fi
operator_home="$(getent passwd "$operator_user" | cut -d: -f6)"
operator_group="$(id -gn "$operator_user")"
if [[ -z "$operator_home" || ! -d "$operator_home" ]]; then
  echo "Could not find the operator home directory." >&2
  exit 1
fi

for command in debootstrap mkfs.ext4 e2fsck depmod modinfo install; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done
[[ "$(uname -m)" == x86_64 ]] || {
  echo "This local smoke image recipe currently supports x86_64 only." >&2
  exit 1
}

kernel_version="$(uname -r)"
kernel="/boot/vmlinuz-$kernel_version"
modules="/lib/modules/$kernel_version"
vsock_module="$(modinfo -k "$kernel_version" -n vmw_vsock_virtio_transport 2>/dev/null || true)"
if [[ ! -f "$kernel" || ! -d "$modules" || ! -f "$vsock_module" ]]; then
  echo "The running kernel image or its matching virtio-vsock module is unavailable." >&2
  exit 1
fi

smoke_root="$operator_home/.local/share/trinity/firecracker-smoke"
rootfs="$smoke_root/rootfs"
images="$smoke_root/images"
marker="$smoke_root/.trinity-smoke-only"
if [[ -e "$smoke_root" ]]; then
  if [[ ! -f "$marker" || -L "$marker" ]]; then
    echo "Smoke output already exists without its marker; refusing to adopt or overwrite: $smoke_root" >&2
    exit 1
  fi
  if [[ -f "$images/vmlinux" && -f "$images/rootfs.ext4" ]]; then
    echo "Smoke guest already exists at $images; refusing to overwrite it." >&2
    exit 1
  fi
  echo "An incomplete marked smoke build exists; inspect it before retrying: $smoke_root" >&2
  exit 1
fi

available_kib="$(df -Pk "$operator_home" | awk 'NR == 2 { print $4 }')"
if [[ ! "$available_kib" =~ ^[0-9]+$ ]] || (( available_kib < 8 * 1024 * 1024 )); then
  echo "At least 8 GiB must be free under $operator_home to build the smoke guest." >&2
  exit 1
fi

install -d -o root -g root -m 0700 "$smoke_root" "$rootfs" "$images"
printf '%s\n' 'DISPOSABLE TRANSPORT SMOKE IMAGE ONLY; NOT A TRINITY GUEST OR PRODUCTION IMAGE' > "$marker"
chmod 0600 "$marker"

suite=noble
mirror="$(awk '$1 == "URIs:" { print $2; exit }' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null || true)"
mirror="${mirror:-https://archive.ubuntu.com/ubuntu}"
keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg
[[ -r "$keyring" ]] || {
  echo "Ubuntu archive keyring is missing: $keyring" >&2
  exit 1
}

debootstrap --arch=amd64 --variant=minbase --include=systemd-sysv,kmod,python3 \
  --keyring="$keyring" "$suite" "$rootfs" "$mirror"

install -d -o root -g root -m 0755 "$rootfs/lib/modules"
cp -a "$modules" "$rootfs/lib/modules/"
depmod -b "$rootfs" "$kernel_version"
install -d -o root -g root -m 0755 "$rootfs/etc/modules-load.d" "$rootfs/etc/systemd/system/multi-user.target.wants" "$rootfs/opt"
printf '%s\n' vmw_vsock_virtio_transport > "$rootfs/etc/modules-load.d/trinity-smoke.conf"
printf '%s\n' trinity-smoke > "$rootfs/etc/hostname"
printf '%s\n' '0123456789abcdef0123456789abcdef' > "$rootfs/etc/machine-id"
cat > "$rootfs/etc/fstab" <<'EOF'
/dev/vda / ext4 ro 0 1
tmpfs /tmp tmpfs nosuid,nodev,mode=1777 0 0
tmpfs /var/log tmpfs nosuid,nodev 0 0
tmpfs /var/tmp tmpfs nosuid,nodev 0 0
EOF

cat > "$rootfs/opt/trinity-smoke-vsock.py" <<'PY'
#!/usr/bin/python3
import json
import socket
import socketserver
from http.server import BaseHTTPRequestHandler


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):
        if self.path != "/rpc":
            self.send_error(404)
            return
        try:
            request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            response = {
                "requestId": request["requestId"],
                "generation": request["generation"],
                "value": {"kind": "ok"},
            }
            body = json.dumps(response, separators=(",", ":")).encode()
        except Exception:
            self.send_error(400)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def log_message(self, _format, *_args):
        return


class VsockServer(socketserver.TCPServer):
    address_family = socket.AF_VSOCK
    allow_reuse_address = True

    def server_bind(self):
        self.socket.bind((socket.VMADDR_CID_ANY, 4050))
        self.server_address = self.socket.getsockname()


with VsockServer((socket.VMADDR_CID_ANY, 4050), Handler) as server:
    print("TRINITY_SMOKE_VSOCK_READY", flush=True)
    server.serve_forever()
PY
chmod 0755 "$rootfs/opt/trinity-smoke-vsock.py"

cat > "$rootfs/etc/systemd/system/trinity-smoke-vsock.service" <<'EOF'
[Unit]
Description=Disposable Trinity Firecracker vsock probe
After=systemd-modules-load.service
Wants=systemd-modules-load.service

[Service]
Type=simple
ExecStartPre=/usr/sbin/modprobe vmw_vsock_virtio_transport
ExecStart=/usr/bin/python3 /opt/trinity-smoke-vsock.py
Restart=on-failure
StandardOutput=journal+console
StandardError=journal+console

[Install]
WantedBy=multi-user.target
EOF
ln -s ../trinity-smoke-vsock.service "$rootfs/etc/systemd/system/multi-user.target.wants/trinity-smoke-vsock.service"

cp -- "$kernel" "$images/vmlinux"
truncate -s 2G "$images/rootfs.ext4"
mkfs.ext4 -F -m 0 -L trinity-smoke-rootfs -d "$rootfs" "$images/rootfs.ext4"
e2fsck -fn "$images/rootfs.ext4"
chown -R "$operator_user:$operator_group" "$smoke_root"
chmod 0700 "$smoke_root"
chmod 0644 "$images/vmlinux" "$images/rootfs.ext4"
chmod 0600 "$marker"

printf 'Built disposable guest image: %s\n' "$images"
printf 'Kernel: %s (host kernel %s; local smoke test only)\n' "$images/vmlinux" "$kernel_version"
printf 'Rootfs SHA-256: '
sha256sum "$images/rootfs.ext4" | awk '{ print $1 }'
echo "This image only probes boot and vsock transport; it does not execute Trinity tools or Zendriver."
