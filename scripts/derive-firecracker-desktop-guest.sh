#!/usr/bin/env bash
set -euo pipefail

# Rebuild an immutable desktop image from a previously built development tree.
[[ $(id -u) -eq 0 && "${PKEXEC_UID:-}" =~ ^[1-9][0-9]*$ && $# -eq 2 ]] || {
  echo 'Run through pkexec with a source development guest and a new output directory.' >&2; exit 1;
}
operator="$(getent passwd "$PKEXEC_UID" | cut -d: -f1)"
operator_home="$(getent passwd "$PKEXEC_UID" | cut -d: -f6)"
operator_group="$(id -gn "$operator")"
[[ -n "$operator" && "$operator" != root ]] || exit 1
source_guest="$1"
output="$2"
for directory in "$source_guest" "$output"; do
  [[ "$(dirname "$directory")" == "$operator_home/.local/share/trinity" && "$(basename "$directory")" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || exit 1
done
[[ "$source_guest" != "$output" && ! -e "$output" && ! -L "$output" && ! -L "$source_guest" && ! -L "$operator_home/.local/share/trinity" ]] || exit 1
[[ -d "$source_guest/rootfs" && ! -L "$source_guest/rootfs" && $(stat -c %u "$source_guest/rootfs") == 0 && -d "$source_guest/data" && ! -L "$source_guest/data" && $(stat -c %u "$source_guest/data") == 0 ]] || exit 1
[[ -f "$source_guest/.trinity-development-guest" && ! -L "$source_guest/.trinity-development-guest" ]] || exit 1
grep -qx 'TRINITY DEVELOPMENT GUEST; HOST KERNEL; NOT PRODUCTION VALIDATED' "$source_guest/.trinity-development-guest"
repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
source "$repo_root/scripts/firecracker-image-check.sh"
verify_firecracker_guest_images "$source_guest/images"
for file in desktop.ts desktop-rfb.ts; do
  [[ -f "$repo_root/apps/guest-runtime/src/$file" && ! -L "$repo_root/apps/guest-runtime/src/$file" ]] || exit 1
done
install -d -m 0700 "$output" "$output/images"
cp -a --reflink=auto "$source_guest/rootfs" "$output/rootfs"
cp -a --reflink=auto "$source_guest/data" "$output/data"
[[ -d "$output/rootfs/opt/trinity/apps/guest-runtime/src" && ! -L "$output/rootfs/opt/trinity/apps/guest-runtime/src" ]] || exit 1
for file in desktop.ts desktop-rfb.ts; do
  install -m 0644 "$repo_root/apps/guest-runtime/src/$file" "$output/rootfs/opt/trinity/apps/guest-runtime/src/$file"
done
(cd "$output/rootfs/opt/trinity/apps/guest-runtime/src" && sha256sum desktop.ts desktop-rfb.ts > "$output/guest-runtime-patch.sha256")
cp "$source_guest/.trinity-development-guest" "$output/.trinity-development-guest"
for file in desktop-package-versions.txt desktop-executables.sha256; do
  [[ -f "$source_guest/$file" && ! -L "$source_guest/$file" ]] || exit 1
  cp "$source_guest/$file" "$output/$file"
done
cp --reflink=auto "$source_guest/images/vmlinux" "$output/images/vmlinux"
truncate -s 4G "$output/images/rootfs.ext4"
mkfs.ext4 -q -F -m 0 -L trinity-dev-root -d "$output/rootfs" "$output/images/rootfs.ext4"
truncate -s 2G "$output/images/data.ext4"
mkfs.ext4 -q -F -m 0 -L trinity-dev-data -d "$output/data" "$output/images/data.ext4"
e2fsck -fn "$output/images/rootfs.ext4"
e2fsck -fn "$output/images/data.ext4"
(cd "$output/images" && sha256sum vmlinux rootfs.ext4 > SHA256SUMS)
verify_firecracker_guest_images "$output/images"
chown "$operator:$operator_group" "$output" "$output/images" "$output/.trinity-development-guest" "$output/images/"*
echo "Derived desktop development guest: $output/images"
