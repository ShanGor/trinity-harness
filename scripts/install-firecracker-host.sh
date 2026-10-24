#!/usr/bin/env bash
set -euo pipefail

# Host prerequisites only. This script never formats disks, creates guest
# images, configures networking, enables a VM, or starts an instance.
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/install-firecracker-host.sh" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
version="v1.17.0"
archive_version="$version"
arch="$(uname -m)"
case "$arch" in
  x86_64|aarch64) ;;
  *) echo "Unsupported Firecracker architecture: $arch" >&2; exit 1 ;;
esac

for command in systemctl curl sha256sum python3 install; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Required command is missing: $command" >&2
    exit 1
  fi
done
if [[ ! -c /dev/kvm ]]; then
  echo "/dev/kvm is unavailable; enable KVM on this host before installing Firecracker" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "jq is missing. Install jq with this distribution's package manager and rerun." >&2
    exit 1
  fi
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y jq
fi

case "$arch" in
  x86_64) expected_sha256="06094a1108ae9e82aa4c23a775aa92758f53f1175d422270d9d6162cb9ade558" ;;
  aarch64) expected_sha256="e351ebe4f7a16b5873bbd51005d2e6767103cff4d5ebc829df2d3f95a93e2256" ;;
esac

temporary_dir="$(mktemp -d)"
trap 'rm -rf "$temporary_dir"' EXIT
archive="$temporary_dir/firecracker-${version}-${arch}.tgz"
url="https://github.com/firecracker-microvm/firecracker/releases/download/${version}/firecracker-${version}-${arch}.tgz"
curl --fail --location --proto '=https' --tlsv1.2 \
  --connect-timeout 20 --max-time 240 --speed-limit 10240 --speed-time 60 \
  --retry 10 --retry-all-errors --retry-delay 3 --retry-max-time 900 \
  "$url" --output "$archive"
printf '%s  %s\n' "$expected_sha256" "$archive" | sha256sum --check --status || {
  echo "Firecracker release archive checksum mismatch" >&2
  exit 1
}

# Extract only the two expected regular files. Do not unpack a privileged
# archive: reject traversal, links, duplicate members and oversize entries.
python3 - "$archive" "$temporary_dir" "$archive_version" "$arch" <<'PY'
import pathlib
import sys
import tarfile

archive, destination, version, architecture = sys.argv[1:]
expected = {
    f"firecracker-{version}-{architecture}": "firecracker",
    f"jailer-{version}-{architecture}": "jailer",
}
found = {}
with tarfile.open(archive, "r:gz") as bundle:
    for member in bundle.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or ".." in path.parts:
            raise SystemExit("Release archive contains an unsafe path")
        name = path.name
        if name not in expected:
            continue
        if name in found or not member.isfile() or member.size <= 0 or member.size > 100_000_000:
            raise SystemExit("Release archive has an invalid Firecracker executable")
        source = bundle.extractfile(member)
        if source is None:
            raise SystemExit("Release executable could not be read")
        output = pathlib.Path(destination, expected[name])
        with output.open("xb") as target:
            target.write(source.read(100_000_001))
        if output.stat().st_size != member.size:
            raise SystemExit("Release executable size mismatch")
        found[name] = output
if len(found) != len(expected):
    raise SystemExit("Release archive does not contain both Firecracker and jailer")
PY

install -d -o root -g root -m 0755 /usr/local/bin /usr/local/libexec /etc/systemd/system
install -o root -g root -m 0755 "$temporary_dir/firecracker" /usr/local/bin/firecracker
install -o root -g root -m 0755 "$temporary_dir/jailer" /usr/local/bin/jailer
install -o root -g root -m 0755 "$repo_root/deploy/firecracker/trinity-start-vm" /usr/local/libexec/trinity-start-vm
install -o root -g root -m 0644 "$repo_root/deploy/firecracker/trinity-vm@.service" /etc/systemd/system/trinity-vm@.service
systemctl daemon-reload

echo "Installed Firecracker ${version} and jailer for ${arch}; SHA-256 verified."
echo "Installed the Trinity VM unit and fixed launcher. No VM was enabled or started."
echo "Next, prepare /srv/trinity-node using an explicit storage mode, then provision guest images, per-user data volumes, and isolated tap/network namespaces."
