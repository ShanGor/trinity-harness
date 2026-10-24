#!/usr/bin/env bash

# Caller chooses the fixed development build path; never deletes existing data.
preserve_incomplete_guest() {
  local base="$1"
  # Recovery is confined to this marked development build before any disk image exists.
  if [[ -L "$base" || ! -d "$base" || -L "$base/.trinity-development-guest" ||
        ! -f "$base/.trinity-development-guest" || ! -d "$base/rootfs" ]] ||
     ! grep -qx 'TRINITY DEVELOPMENT GUEST; HOST KERNEL; NOT PRODUCTION VALIDATED' "$base/.trinity-development-guest"; then
    echo 'Refusing recovery of an unrecognized build.' >&2; return 1
  fi
  if [[ -e "$base/images/rootfs.ext4" || -e "$base/images/data.ext4" || -e "$base/images/vmlinux" ]]; then
    # These images are never overwritten or deleted: the entire marked build is
    # renamed to a sibling backup. Only ensure a VMM is not actively using them.
    if pgrep -af -- "$base/run/api.sock" >/dev/null; then
      echo 'A Firecracker process may still be using this image; stop it before retrying.' >&2; return 1
    fi
  fi
  local mounted_targets
  mounted_targets="$(findmnt --raw --noheadings --output TARGET)" || {
    echo 'Cannot verify build mounts; refusing recovery.' >&2; return 1;
  }
  while IFS= read -r target; do
    if [[ "$target" == "$base" || "$target" == "$base/"* ]]; then
      echo 'Build contains mounted filesystems; unmount them before retrying.' >&2; return 1
    fi
  done <<< "$mounted_targets"
  local backup="$base.failed-$(date -u +%Y%m%dT%H%M%SZ)-$$"
  mv -T -- "$base" "$backup"
  printf 'Preserved incomplete build and its logs: %s\n' "$backup"
}
