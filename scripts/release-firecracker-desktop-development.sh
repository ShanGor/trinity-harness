#!/usr/bin/env bash
set -euo pipefail

# Run as the release command of release-firecracker-node.sh after its drain.
[[ $(id -u) -eq 0 && "${PKEXEC_UID:-}" =~ ^[1-9][0-9]*$ && $# -eq 2 ]] || {
  echo 'Run through pkexec as the drained-node release command, with a candidate and environment ID.' >&2; exit 1;
}
operator="$(getent passwd "$PKEXEC_UID" | cut -d: -f1)"
operator_home="$(getent passwd "$PKEXEC_UID" | cut -d: -f6)"
[[ -n "$operator" && "$operator" != root ]] || exit 1
candidate="$1"
environment_id="$2"
[[ "$environment_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || exit 1
[[ "$(dirname "$candidate")" == "$operator_home/.local/share/trinity" && "$(basename "$candidate")" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ && ! -L "$candidate" && ! -L "$operator_home/.local/share/trinity" ]] || {
  echo 'Invalid development candidate directory.' >&2; exit 1;
}
repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
base=/srv/trinity-node
target="$base/images"
[[ -d "$base" && ! -L "$base" && $(stat -c %u "$base") == 0 && -d "$target" && ! -L "$target" ]] || exit 1
[[ -f "$base/.trinity-storage-mode" && ! -L "$base/.trinity-storage-mode" && $(cat "$base/.trinity-storage-mode") == development-unencrypted ]] || exit 1
[[ -f /etc/trinity/node-agent.env && ! -L /etc/trinity/node-agent.env ]] &&
  grep -qxE 'NODE_GUEST_ROUTING=(true|"true")' /etc/trinity/node-agent.env || {
  echo 'The installed Node Agent must have guest routing enabled.' >&2; exit 1;
}
[[ -f "$candidate/.trinity-development-guest" && ! -L "$candidate/.trinity-development-guest" ]] || exit 1
grep -qx 'TRINITY DEVELOPMENT GUEST; HOST KERNEL; NOT PRODUCTION VALIDATED' "$candidate/.trinity-development-guest"
source "$repo_root/scripts/firecracker-image-check.sh"
verify_firecracker_guest_images "$candidate/images"
verify_firecracker_guest_images "$target"
[[ ! -e "$target/data.ext4" ]] || { echo 'Shared images contain a data disk.' >&2; exit 1; }
[[ -z "$(find "$target" -mindepth 1 -maxdepth 1 ! -name vmlinux ! -name rootfs.ext4 ! -name SHA256SUMS -print -quit)" ]] || exit 1
if systemctl list-units 'trinity-vm@*.service' --state=active --no-legend --plain | grep -q . || pgrep -x firecracker >/dev/null; then
  echo 'A VM is still active; refusing image replacement.' >&2; exit 1
fi

suffix="$(date -u +%Y%m%dT%H%M%SZ)-$$"
volume="$base/volumes/$environment_id"
volume_backup="$base/desktop-volume-backup-$suffix"
[[ -d "$base/volumes" && ! -L "$base/volumes" && -d "$volume" && ! -L "$volume" && $(stat -c %u "$volume") == 0 && -f "$volume/data.ext4" && ! -L "$volume/data.ext4" && -f "$volume/runtime.json" && ! -L "$volume/runtime.json" && ! -e "$volume_backup" ]] || {
  echo 'The assigned environment volume is missing or unsafe.' >&2; exit 1;
}
install -d -o root -g root -m 0700 "$volume_backup"
cp --reflink=auto --sparse=always "$volume/data.ext4" "$volume_backup/data.ext4"
cp --preserve=mode "$volume/runtime.json" "$volume_backup/runtime.json"
chmod 0600 "$volume_backup/data.ext4" "$volume_backup/runtime.json"
cmp -s "$volume/data.ext4" "$volume_backup/data.ext4"
echo "Saved an offline copy of the assigned data volume at $volume_backup."
stage="$base/images.desktop-stage-$suffix"
backup="$base/images.pre-desktop-$suffix"
failed="$base/images.failed-desktop-$suffix"
[[ ! -e "$stage" && ! -e "$backup" && ! -e "$failed" ]] || exit 1
install -d -o root -g root -m 0700 "$stage"
cp --sparse=always "$candidate/images/vmlinux" "$stage/vmlinux"
cp --sparse=always "$candidate/images/rootfs.ext4" "$stage/rootfs.ext4"
chmod 0644 "$stage/vmlinux" "$stage/rootfs.ext4"
(cd "$stage" && sha256sum vmlinux rootfs.ext4 > SHA256SUMS)
chmod 0644 "$stage/SHA256SUMS"
verify_firecracker_guest_images "$stage"
cmp -s "$candidate/images/vmlinux" "$stage/vmlinux"
cmp -s "$candidate/images/rootfs.ext4" "$stage/rootfs.ext4"
committed=false
switch_state=staged
rollback() {
  status=$?
  if [[ "$committed" != true ]]; then
    if [[ "$switch_state" == staged ]]; then
      echo "Previous image unchanged; retained the staged candidate at $stage. Node remains drained." >&2
    elif systemctl list-units 'trinity-vm@*.service' --state=active --no-legend --plain | grep -q . || pgrep -x firecracker >/dev/null; then
      echo "VM shutdown is unconfirmed; keeping candidate and backup at $target and $backup. Node must remain drained." >&2
    elif [[ "$switch_state" == archived ]]; then
      mv "$backup" "$target"
      echo "Restored the previous image; retained the staged candidate at $stage. Node remains drained." >&2
    else
      mv "$target" "$failed"
      mv "$backup" "$target"
      echo "Restored the previous image; retained the failed candidate at $failed. Node remains drained." >&2
    fi
  fi
  exit "$status"
}
trap rollback EXIT
mv "$target" "$backup"
switch_state=archived
mv "$stage" "$target"
switch_state=installed
bash "$repo_root/scripts/run-firecracker-jailer-test.sh" --desktop --guest-root "$candidate"
systemctl restart trinity-node-agent.service
systemctl is-active --quiet trinity-node-agent.service
committed=true
trap - EXIT
echo "Desktop development image installed and jailer-validated. Previous image retained at $backup."
