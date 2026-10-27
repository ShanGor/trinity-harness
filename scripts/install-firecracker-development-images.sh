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

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
operator_home="$(getent passwd "$operator_user" | cut -d: -f6)"
source_root="$operator_home/.local/share/trinity/firecracker-guest"
if [[ $# -gt 0 ]]; then
  [[ $# -eq 2 && "$1" == --guest-root ]] || { echo 'Usage: install-firecracker-development-images.sh [--guest-root PATH]' >&2; exit 64; }
  source_root="$2"
fi
[[ "$(dirname "$source_root")" == "$operator_home/.local/share/trinity" && "$(basename "$source_root")" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ && ! -L "$source_root" && ! -L "$operator_home/.local/share/trinity" ]] || {
  echo 'Guest root must be a direct, non-symlinked operator Trinity directory.' >&2; exit 1;
}
images="$source_root/images"
target=/srv/trinity-node/images
base=/srv/trinity-node

for command in cat cmp cp find grep install sha256sum stat systemctl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
[[ -f "$source_root/.trinity-development-guest" && ! -L "$source_root/.trinity-development-guest" ]] || {
  echo 'The marked development guest is required.' >&2; exit 1;
}
grep -qx 'TRINITY DEVELOPMENT GUEST; HOST KERNEL; NOT PRODUCTION VALIDATED' "$source_root/.trinity-development-guest"
source "$repo_root/scripts/firecracker-image-check.sh"
verify_firecracker_guest_images "$images"
[[ -f "$base/.trinity-storage-mode" && ! -L "$base/.trinity-storage-mode" &&
   $(cat "$base/.trinity-storage-mode") == development-unencrypted ]] || {
  echo 'Only the explicitly marked development-unencrypted node accepts these images.' >&2; exit 1;
}
[[ -d "$base" && ! -L "$base" && $(stat -c %u "$base") == 0 ]] || {
  echo 'Node storage must be a root-owned real directory.' >&2; exit 1;
}
[[ ! -L "$target" ]] || { echo 'Refusing a symlinked node images directory.' >&2; exit 1; }
if systemctl list-units 'trinity-vm@*.service' --state=active --no-legend --plain | grep -q .; then
  echo 'A Trinity VM is active; install base images on an idle host.' >&2; exit 1
fi

install -d -o root -g root -m 0700 "$target"
if [[ -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  verify_firecracker_guest_images "$target"
  [[ -f "$target/data.ext4" ]] && {
    echo 'Refusing a data disk in the shared base images directory.' >&2; exit 1;
  }
  unexpected="$(find "$target" -mindepth 1 -maxdepth 1 \
    ! -name vmlinux ! -name rootfs.ext4 ! -name SHA256SUMS -print -quit)"
  [[ -z "$unexpected" ]] || { echo 'Unexpected entry in the node images directory.' >&2; exit 1; }
  cmp -s "$images/vmlinux" "$target/vmlinux" &&
    cmp -s "$images/rootfs.ext4" "$target/rootfs.ext4" || {
      echo 'Installed node images differ from the verified development guest; refusing replacement.' >&2
      exit 1
    }
  echo "Verified existing development images at $target; left them unchanged."
  exit 0
fi

cp --sparse=always "$images/vmlinux" "$target/vmlinux"
cp --sparse=always "$images/rootfs.ext4" "$target/rootfs.ext4"
chmod 0644 "$target/vmlinux" "$target/rootfs.ext4"
(cd "$target" && sha256sum vmlinux rootfs.ext4 > SHA256SUMS)
chmod 0644 "$target/SHA256SUMS"
chown root:root "$target" "$target/vmlinux" "$target/rootfs.ext4" "$target/SHA256SUMS"
verify_firecracker_guest_images "$target"
echo "Installed verified development kernel and read-only rootfs at $target."
echo 'No user data disk, environment, VM, or network namespace was created.'
