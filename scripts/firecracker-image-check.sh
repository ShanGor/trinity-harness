#!/usr/bin/env bash

# Guest rootfs and kernel are immutable build artifacts. The development data
# image is mounted read/write and therefore intentionally excluded from hashes.
verify_firecracker_guest_images() {
  local images="$1"
  [[ -d "$images" && ! -L "$images" && -f "$images/SHA256SUMS" && ! -L "$images/SHA256SUMS" ]] || {
    echo 'Guest image directory or checksum manifest is missing or unsafe.' >&2
    return 1
  }
  for file in vmlinux rootfs.ext4; do
    [[ -f "$images/$file" && ! -L "$images/$file" ]] || {
      echo "Missing or unsafe immutable guest image: $file" >&2
      return 1
    }
  done
  awk '
    NF != 2 || length($1) != 64 || $1 !~ /^[0-9a-f]+$/ { exit 1 }
    $2 != "vmlinux" && $2 != "rootfs.ext4" && $2 != "data.ext4" { exit 1 }
    { count[$2]++ }
    END {
      if (count["vmlinux"] != 1 || count["rootfs.ext4"] != 1 ||
          count["data.ext4"] > 1 || NR < 2 || NR > 3) exit 1
    }
  ' "$images/SHA256SUMS" || {
    echo 'Guest image checksum manifest has unexpected entries.' >&2
    return 1
  }
  awk '$2 == "vmlinux" || $2 == "rootfs.ext4"' "$images/SHA256SUMS" |
    (cd "$images" && sha256sum --check --strict -)
}
