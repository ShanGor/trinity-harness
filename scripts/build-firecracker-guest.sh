#!/usr/bin/env bash
set -euo pipefail

[[ $(id -u) -eq 0 ]] || { echo 'Run through pkexec or sudo from the operator account.' >&2; exit 1; }
operator_user="${SUDO_USER:-}"
if [[ -z "$operator_user" && "${PKEXEC_UID:-}" =~ ^[1-9][0-9]*$ ]]; then
  operator_user="$(getent passwd "$PKEXEC_UID" | cut -d: -f1)"
fi
[[ -n "$operator_user" && "$operator_user" != root ]] || { echo 'Operator identity is required.' >&2; exit 1; }
restart_incomplete=false
desktop=false
base_override=''
payload_override=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --restart-incomplete) [[ "$restart_incomplete" == false ]] || exit 64; restart_incomplete=true ;;
    --desktop) [[ "$desktop" == false ]] || exit 64; desktop=true ;;
    --output) [[ $# -ge 2 && -z "$base_override" ]] || exit 64; base_override="$2"; shift ;;
    --payload) [[ $# -ge 2 && -z "$payload_override" ]] || exit 64; payload_override="$2"; shift ;;
    *) echo 'Usage: sudo bash scripts/build-firecracker-guest.sh [--restart-incomplete] [--desktop]' >&2; exit 64 ;;
  esac
  shift
done
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
operator_home="$(getent passwd "$operator_user" | cut -d: -f6)"
operator_group="$(id -gn "$operator_user")"
payload="${payload_override:-$operator_home/.local/share/trinity/guest-payload}"
base="${base_override:-$operator_home/.local/share/trinity/firecracker-guest}"
for directory in "$payload" "$base"; do
  [[ "$(dirname "$directory")" == "$operator_home/.local/share/trinity" && "$(basename "$directory")" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]*$ ]] || {
    echo 'Guest paths must be direct children of the operator Trinity directory.' >&2; exit 1;
  }
done
[[ ! -L "$payload" && ! -L "$operator_home/.local/share/trinity" ]] || { echo 'Guest paths must not be symlinks.' >&2; exit 1; }
[[ -d "$payload" ]] || { echo 'Prepare the payload first.' >&2; exit 1; }
if [[ -e "$base" || -L "$base" ]]; then
  if [[ "$restart_incomplete" != true ]]; then
    echo 'Build exists. To preserve and retry an incomplete bootstrap, use --restart-incomplete.' >&2
    exit 1
  fi
  source "$repo_root/scripts/firecracker-guest-recovery.sh"
  preserve_incomplete_guest "$base"
fi
for command in debootstrap mkfs.ext4 e2fsck depmod modinfo tar mount umount mountpoint findmnt; do
  command -v "$command" >/dev/null || { echo "Missing $command" >&2; exit 1; }
done
if [[ "$desktop" == true ]]; then
  command -v cc >/dev/null || { echo 'Desktop builds require a static C compiler.' >&2; exit 1; }
fi
[[ $(uname -m) == x86_64 ]] || exit 1
kernel_version="$(uname -r)"
[[ -f "/boot/vmlinuz-$kernel_version" ]] || exit 1
modinfo -k "$kernel_version" vmw_vsock_virtio_transport >/dev/null
(cd "$payload" && sha256sum --check --strict SHA256SUMS)
available_kib="$(df -Pk "$operator_home" | awk 'NR == 2 { print $4 }')"
[[ "$available_kib" =~ ^[0-9]+$ ]] && (( available_kib >= 12 * 1024 * 1024 )) || {
  echo 'At least 12 GiB of free space is required.' >&2; exit 1;
}
install -d -m 0700 "$base" "$base/rootfs" "$base/images"
rootfs="$base/rootfs"
printf '%s\n' 'TRINITY DEVELOPMENT GUEST; HOST KERNEL; NOT PRODUCTION VALIDATED' > "$base/.trinity-development-guest"
mirror="$(awk '$1 == "URIs:" { print $2; exit }' /etc/apt/sources.list.d/ubuntu.sources)"
mirror="${mirror:-https://archive.ubuntu.com/ubuntu}"
# Bootstrap only the small known-working base. APT resolves the browser's
# larger dependency tree (including virtual D-Bus providers) after this step.
if ! debootstrap --arch=amd64 --variant=minbase \
  --include=systemd-sysv,kmod,python3,ca-certificates,bash \
  --keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg noble "$rootfs" "$mirror"; then
  tail -n 100 "$rootfs/debootstrap/debootstrap.log" >&2
  echo 'Bootstrap failed. Preserve and retry with --restart-incomplete.' >&2
  exit 1
fi

# Suppress service startup while installing into an offline image. No host
# /run or D-Bus socket is exposed to package scripts.
[[ ! -e "$rootfs/usr/sbin/policy-rc.d" ]] || { echo 'Unexpected service policy.' >&2; exit 1; }
printf '#!/bin/sh\nexit 101\n' > "$rootfs/usr/sbin/policy-rc.d"
chmod 0755 "$rootfs/usr/sbin/policy-rc.d"
mountpoint -q "$rootfs/proc" && { echo 'Unexpected existing proc mount.' >&2; exit 1; }
mount -t proc -o nosuid,nodev,noexec proc "$rootfs/proc"
cleanup_packages() {
  umount "$rootfs/proc"
  rm -f "$rootfs/usr/sbin/policy-rc.d"
}
trap cleanup_packages EXIT
if [[ "$desktop" == true ]]; then
  install -d "$rootfs/etc/apt/sources.list.d"
  printf 'deb %s noble universe\n' "$mirror" > "$rootfs/etc/apt/sources.list.d/trinity-desktop.list"
fi
chroot "$rootfs" /usr/bin/env DEBIAN_FRONTEND=noninteractive \
  apt-get -o Acquire::Retries=3 update
desktop_packages=()
if [[ "$desktop" == true ]]; then
  desktop_packages=(xvfb x11vnc openbox xdotool x11-apps xclip nftables util-linux)
fi
chroot "$rootfs" /usr/bin/env DEBIAN_FRONTEND=noninteractive \
  apt-get -o Acquire::Retries=3 --yes --no-install-recommends install \
  dbus-user-session systemd-resolved libstdc++6 libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 \
  libcups2t64 libdbus-1-3 libdrm2 libgbm1 libgtk-3-0t64 libnspr4 libnss3 \
  libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
  libxfixes3 libxkbcommon0 libxrandr2 fontconfig fonts-liberation fonts-noto-cjk udev \
  "${desktop_packages[@]}"
chroot "$rootfs" fc-cache --force
if [[ "$desktop" == true ]]; then
  chroot "$rootfs" dpkg-query -W -f='${Package} ${Version}\n' xvfb x11vnc openbox xdotool x11-apps xclip nftables > "$base/desktop-package-versions.txt"
fi
for codepoint in 4e2d 570b 3042 ac00; do
  [[ -n "$(chroot "$rootfs" fc-list --format='%{file}' ":charset=$codepoint")" ]] || {
    echo "Guest font coverage missing for U+$codepoint." >&2; exit 1;
  }
done
chroot "$rootfs" dpkg --audit > "$base/package-audit.log"
if [[ -s "$base/package-audit.log" ]]; then
  cat "$base/package-audit.log" >&2
  exit 1
fi
cleanup_packages
trap - EXIT
install -d "$rootfs/opt/trinity" "$rootfs/opt/google" "$rootfs/usr/local/bin" "$rootfs/lib/modules"
tar --extract --file="$payload/runtime.tar" --directory="$rootfs/opt/trinity" --no-same-owner
tar --extract --file="$payload/chrome.tar" --directory="$rootfs/opt/google" --no-same-owner
tar --extract --xz --file="$payload/node-v22.22.1-linux-x64.tar.xz" --directory="$rootfs/usr/local" --strip-components=1 --no-same-owner
ln -s /usr/local/bin/node "$rootfs/usr/bin/node"
ln -s /opt/google/chrome/google-chrome "$rootfs/usr/bin/google-chrome"
install -m 0755 "$payload/zendriver-mcp" "$rootfs/usr/local/bin/zendriver-mcp"
cp -a "/lib/modules/$kernel_version" "$rootfs/lib/modules/"
depmod -b "$rootfs" "$kernel_version"
chroot "$rootfs" /usr/sbin/useradd --uid 1000 --create-home --shell /bin/bash trinity
if [[ "$desktop" == true ]]; then
  chroot "$rootfs" /usr/sbin/groupadd --gid 1001 trinity-browser
  chroot "$rootfs" /usr/sbin/groupadd --gid 1002 trinity-chrome
  chroot "$rootfs" /usr/sbin/useradd --uid 1001 --gid 1001 --create-home --shell /usr/sbin/nologin trinity-browser
  chroot "$rootfs" /usr/sbin/useradd --uid 1002 --gid 1002 --create-home --shell /usr/sbin/nologin trinity-chrome
fi
install -d "$rootfs/etc/modules-load.d" "$rootfs/etc/systemd/system/multi-user.target.wants" "$rootfs/etc/systemd/system/sockets.target.wants" "$rootfs/data" "$rootfs/workspace" "$rootfs/var/lib/trinity/browser"
printf '%s\n' vmw_vsock_virtio_transport > "$rootfs/etc/modules-load.d/trinity.conf"
printf '%s\n' trinity-guest > "$rootfs/etc/hostname"
# systemd generates a transient ID with the read-only root.
: > "$rootfs/etc/machine-id"
cat > "$rootfs/etc/fstab" <<'FSTAB'
/dev/vda / ext4 ro 0 1
/dev/vdb /data ext4 nosuid,nodev 0 2
/data/workspace /workspace none bind 0 0
/data/browser /var/lib/trinity/browser none bind 0 0
tmpfs /tmp tmpfs nosuid,nodev,mode=1777,size=512M 0 0
tmpfs /var/log tmpfs nosuid,nodev 0 0
tmpfs /var/tmp tmpfs nosuid,nodev,mode=1777 0 0
tmpfs /home/trinity tmpfs nosuid,nodev,uid=1000,gid=1000,mode=0700 0 0
FSTAB
if [[ "$desktop" == true ]]; then
  printf '%s\n' 'tmpfs /home/trinity-browser tmpfs nosuid,nodev,uid=1001,gid=1001,mode=0700 0 0' >> "$rootfs/etc/fstab"
  printf '%s\n' 'tmpfs /home/trinity-chrome tmpfs nosuid,nodev,uid=1002,gid=1002,mode=0700 0 0' >> "$rootfs/etc/fstab"
fi
for unit in trinity-guest.service trinity-guest-vsock.service trinity-guest-vsock.socket; do
  install -m 0644 "$repo_root/deploy/firecracker/$unit" "$rootfs/etc/systemd/system/$unit"
done
if [[ "$desktop" == true ]]; then
  install -d "$rootfs/usr/local/libexec" "$rootfs/opt/trinity-firecracker"
  cc -std=c11 -Wall -Wextra -Werror -O2 -static \
    "$repo_root/deploy/firecracker/guest/vsock-host-proxy.c" \
    -o "$rootfs/usr/local/libexec/trinity-vsock-host-proxy"
  install -m 0755 "$repo_root/deploy/firecracker/guest/chrome-private-debug.sh" "$rootfs/usr/local/libexec/trinity-private-chrome"
  install -m 0755 "$repo_root/deploy/firecracker/guest/browser-profile-owner.sh" "$rootfs/usr/local/libexec/trinity-browser-profile-owner"
  install -m 0644 "$repo_root/deploy/firecracker/guest/browser-debug-firewall.nft" "$rootfs/opt/trinity-firecracker/browser-debug-firewall.nft"
  install -m 0644 "$base/desktop-package-versions.txt" "$rootfs/opt/trinity-firecracker/desktop-package-versions.txt"
  for unit in trinity-browser.service trinity-browser-firewall.service trinity-browser-profile.service trinity-browser-vsock.socket 'trinity-browser-vsock@.service'; do
    install -m 0644 "$repo_root/deploy/firecracker/$unit" "$rootfs/etc/systemd/system/$unit"
  done
  ln -s ../trinity-browser.service "$rootfs/etc/systemd/system/multi-user.target.wants/trinity-browser.service"
  ln -s ../trinity-browser-vsock.socket "$rootfs/etc/systemd/system/sockets.target.wants/trinity-browser-vsock.socket"
fi
install -d "$rootfs/etc/systemd/system/trinity-guest.service.d"
if [[ "$desktop" == true ]]; then
  cat > "$rootfs/etc/systemd/system/trinity-guest.service.d/desktop.conf" <<'UNIT'
[Unit]
Requires=trinity-browser-profile.service
After=trinity-browser-profile.service
UNIT
fi
cat > "$rootfs/etc/systemd/system/trinity-guest.service.d/development.conf" <<'UNIT'
[Service]
Environment=HOME=/home/trinity
Environment=PATH=/usr/local/bin:/usr/bin:/bin
StandardOutput=journal+console
StandardError=journal+console
UNIT
ln -s ../trinity-guest.service "$rootfs/etc/systemd/system/multi-user.target.wants/trinity-guest.service"
ln -s ../trinity-guest-vsock.socket "$rootfs/etc/systemd/system/sockets.target.wants/trinity-guest-vsock.socket"
ln -s /lib/systemd/system/systemd-networkd.service \
  "$rootfs/etc/systemd/system/multi-user.target.wants/systemd-networkd.service"
ln -s /lib/systemd/system/systemd-resolved.service \
  "$rootfs/etc/systemd/system/multi-user.target.wants/systemd-resolved.service"
cat > "$rootfs/etc/systemd/network/10-trinity-guest.network" <<'NETWORK'
[Match]
Name=eth0

[Network]
Address=172.16.0.2/30
Gateway=172.16.0.1
DNS=172.29.240.1
IPv6AcceptRA=no
LinkLocalAddressing=no
NETWORK
rm -f "$rootfs/etc/resolv.conf"
ln -s ../run/systemd/resolve/stub-resolv.conf "$rootfs/etc/resolv.conf"
# Validate binaries against the guest's libraries before making the filesystem.
chroot "$rootfs" /usr/bin/node --version
chroot "$rootfs" /usr/local/bin/zendriver-mcp --version
chroot "$rootfs" /opt/google/chrome/chrome --version
if [[ "$desktop" == true ]]; then
  for binary in /usr/bin/Xvfb /usr/bin/x11vnc /usr/bin/openbox /usr/bin/xdotool /usr/bin/xwd /usr/bin/xclip /usr/bin/setpriv /usr/sbin/nft /usr/local/libexec/trinity-vsock-host-proxy; do
    [[ -x "$rootfs$binary" ]] || { echo "Missing desktop executable: $binary" >&2; exit 1; }
  done
  (cd "$rootfs" && sha256sum usr/bin/Xvfb usr/bin/x11vnc usr/bin/openbox usr/bin/xdotool usr/bin/xwd usr/bin/xclip usr/sbin/nft usr/local/libexec/trinity-vsock-host-proxy > "$base/desktop-executables.sha256")
fi
[[ -x "$rootfs/lib/systemd/systemd-networkd" && -e "$rootfs/lib/systemd/system/systemd-resolved.service" ]] || {
  echo 'Guest systemd network services are missing from the rootfs.' >&2; exit 1;
}
install -d "$base/data/workspace" "$base/data/browser"
chown -R 1000:1000 "$base/data/workspace" "$base/data/browser"
if [[ "$desktop" == true ]]; then
  chown -R 1001:1001 "$base/data/browser"
fi
cp "/boot/vmlinuz-$kernel_version" "$base/images/vmlinux"
truncate -s 4G "$base/images/rootfs.ext4"
mkfs.ext4 -F -m 0 -L trinity-dev-root -d "$rootfs" "$base/images/rootfs.ext4"
truncate -s 2G "$base/images/data.ext4"
mkfs.ext4 -F -m 0 -L trinity-dev-data -d "$base/data" "$base/images/data.ext4"
e2fsck -fn "$base/images/rootfs.ext4"
e2fsck -fn "$base/images/data.ext4"
(cd "$base/images" && sha256sum vmlinux rootfs.ext4 > SHA256SUMS)
# Preserve the rootfs tree's guest ownership; expose only image artifacts to the operator.
chown "$operator_user:$operator_group" "$base" "$base/images" "$base/.trinity-development-guest" "$base/images/"*
printf 'Development guest built: %s\nNext: bash scripts/run-firecracker-guest-test.sh\n' "$base/images"
