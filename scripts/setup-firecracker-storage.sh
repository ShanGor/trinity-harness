#!/usr/bin/env bash
set -euo pipefail

# Prepare the Firecracker state directory in an explicit storage mode.
if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/setup-firecracker-storage.sh --development-unencrypted|--encrypted" >&2
  exit 1
fi

storage_mode="${1:-}"
if [[ "$storage_mode" != --development-unencrypted && "$storage_mode" != --encrypted ]]; then
  echo "Choose an explicit mode: --development-unencrypted or --encrypted" >&2
  exit 2
fi
mountpoint="/srv/trinity-node"

if [[ "$storage_mode" == --development-unencrypted ]]; then
  if mountpoint -q "$mountpoint"; then
    echo "$mountpoint is already a mount point; refusing to change its storage policy." >&2
    exit 1
  fi
  if [[ -e "$mountpoint" && ! -d "$mountpoint" ]]; then
    echo "$mountpoint exists but is not a directory." >&2
    exit 1
  fi
  install -d -o root -g root -m 0700 "$mountpoint"
  marker="$mountpoint/.trinity-storage-mode"
  if [[ -e "$marker" || -L "$marker" ]]; then
    if [[ -L "$marker" || "$(cat "$marker")" != development-unencrypted ]]; then
      echo "Unexpected storage mode marker at $marker; refusing to overwrite it." >&2
      exit 1
    fi
  else
    if [[ -n "$(find "$mountpoint" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
      echo "$mountpoint is not empty and has no development marker; refusing to adopt existing data." >&2
      exit 1
    fi
    install -o root -g root -m 0600 /dev/null "$marker"
    printf '%s\n' development-unencrypted > "$marker"
  fi
  chown root:root "$mountpoint" "$marker"
  chmod 0700 "$mountpoint"
  chmod 0600 "$marker"
  echo "Development storage is ready at $mountpoint (unencrypted, root-owned, mode 0700)."
  echo "Set NODE_DEPLOYMENT_MODE=development and NODE_STORAGE_ENCRYPTION=none."
  exit 0
fi

operator_user="${SUDO_USER:-}"
if [[ -z "$operator_user" || "$operator_user" == root ]]; then
  echo "Run this through sudo from the operator account so the container is placed under that account's /home." >&2
  exit 1
fi
operator_home="$(getent passwd "$operator_user" | cut -d: -f6)"
if [[ -z "$operator_home" || ! -d "$operator_home" ]]; then
  echo "Could not find the operator home directory." >&2
  exit 1
fi

home_fs="$(findmnt -n -o FSTYPE -T "$operator_home")"
if [[ "$home_fs" != ext4 ]]; then
  echo "Expected the operator home directory on ext4; found '$home_fs'. Refusing to create the encrypted container." >&2
  exit 1
fi

container_dir="$operator_home/.local/share/trinity"
container="$container_dir/firecracker-node-64g.luks"
init_marker="$container_dir/firecracker-node-64g.initialize-filesystem"
container_tmp="$container_dir/.firecracker-node-64g.luks.tmp"
mapper_name="trinity-node-storage"
mapper="/dev/mapper/$mapper_name"

if ! command -v cryptsetup >/dev/null 2>&1; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "cryptsetup is missing; install it with the host's package manager, then rerun." >&2
    exit 1
  fi
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y cryptsetup-bin
fi

if [[ ! -e "$container" ]]; then
  available_kib="$(df -Pk "$operator_home" | awk 'NR == 2 { print $4 }')"
  if [[ ! "$available_kib" =~ ^[0-9]+$ ]] || (( available_kib < 70 * 1024 * 1024 )); then
    echo "At least 70 GiB must be free under $operator_home to create the 64 GiB encrypted container." >&2
    exit 1
  fi
  install -d -o root -g root -m 0700 "$container_dir"
  if [[ -e "$container_tmp" || -L "$container_tmp" ]]; then
    echo "Temporary container path already exists; inspect it before retrying: $container_tmp" >&2
    exit 1
  fi
  fallocate -l 64G "$container_tmp"
  chmod 0600 "$container_tmp"
  mv -- "$container_tmp" "$container"
  chown root:root "$container"
  cryptsetup luksFormat --type luks2 --verify-passphrase "$container"
  install -o root -g root -m 0600 /dev/null "$init_marker"
elif [[ -L "$container" ]] || ! cryptsetup isLuks "$container"; then
  echo "Container path exists but is not a valid LUKS device; refusing to overwrite it: $container" >&2
  exit 1
fi

if [[ ! -e "$mapper" ]]; then
  cryptsetup open "$container" "$mapper_name"
fi

filesystem="$(blkid -s TYPE -o value "$mapper" || true)"
if [[ -z "$filesystem" ]]; then
  if [[ ! -f "$init_marker" || -L "$init_marker" ]]; then
    echo "The existing LUKS container has no filesystem; refusing to format it automatically." >&2
    exit 1
  fi
  mkfs.ext4 -F -m 0 -L trinity-node "$mapper"
  rm -- "$init_marker"
elif [[ "$filesystem" != ext4 ]]; then
  echo "Expected ext4 inside the LUKS container; found '$filesystem'. Refusing to format it." >&2
  exit 1
fi
if [[ "$filesystem" == ext4 && -f "$init_marker" && ! -L "$init_marker" ]]; then
  rm -- "$init_marker"
fi

install -d -o root -g root -m 0700 "$mountpoint"
if mountpoint -q "$mountpoint"; then
  mounted_source="$(findmnt -n -o SOURCE -T "$mountpoint")"
  if [[ "$mounted_source" != "$mapper" ]]; then
    echo "$mountpoint is already mounted from an unexpected source: $mounted_source" >&2
    exit 1
  fi
else
  if [[ -n "$(find "$mountpoint" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    echo "$mountpoint is not empty and not mounted; refusing to hide its contents." >&2
    exit 1
  fi
  mount -o nodev,nosuid,noexec "$mapper" "$mountpoint"
fi
chown root:root "$mountpoint"
chmod 0700 "$mountpoint"

echo "Encrypted storage is mounted at $mountpoint (LUKS2 + ext4, nodev,nosuid,noexec)."
echo "Container: $container"
echo "Set NODE_DEPLOYMENT_MODE=production and NODE_STORAGE_ENCRYPTION=host-managed, or use development mode explicitly."
echo "After reboot, rerun this command and enter the same LUKS passphrase to unlock and mount it."
