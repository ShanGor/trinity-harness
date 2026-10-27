#!/usr/bin/env bash
set -euo pipefail

# Prepare a credential-free source/dependency snapshot as the ordinary operator.
[[ $(id -u) -ne 0 ]] || { echo 'Run without sudo.' >&2; exit 1; }
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
destination="$HOME/.local/share/trinity/guest-payload"
zendriver="$HOME/.local/share/trinity/zendriver/bin/zendriver-mcp"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) [[ $# -ge 2 ]] || exit 64; destination="$2"; shift ;;
    --zendriver) [[ $# -ge 2 ]] || exit 64; zendriver="$2"; shift ;;
    *) echo 'Usage: bash scripts/prepare-firecracker-guest.sh [--output PATH] [--zendriver PATH]' >&2; exit 64 ;;
  esac
  shift
done
[[ "$destination" == "$HOME/.local/share/trinity/"* && "$(dirname "$destination")" == "$HOME/.local/share/trinity" ]] || {
  echo 'Payload must be a direct child of the operator Trinity directory.' >&2; exit 1;
}
[[ "$zendriver" == "$HOME/.local/share/trinity/"* && "$zendriver" != *'/../'* ]] || {
  echo 'Zendriver must be an operator-owned Trinity executable.' >&2; exit 1;
}
output="$destination"
[[ ! -e "$output" && ! -L "$output" ]] || { echo "Refusing to overwrite $output" >&2; exit 1; }
[[ $(uname -m) == x86_64 ]] || { echo 'Development guest currently requires x86_64.' >&2; exit 1; }
[[ -x "$zendriver" && -d /opt/google/chrome && -d "$repo_root/node_modules/.pnpm" ]] || {
  echo 'Install repository dependencies, patched Zendriver and Google Chrome first.' >&2; exit 1;
}
[[ $("$zendriver" --version) == 'zendriver-mcp 0.16.37' ]] || { echo 'Unsupported Zendriver.' >&2; exit 1; }
"$zendriver" --help | rg -q -- '--user-data-dir' || { echo 'Zendriver profile patch missing.' >&2; exit 1; }
install -d -m 0700 "$(dirname "$destination")"
output="$(mktemp -d "$destination.preparing.XXXXXX")"
trap 'rm -rf -- "$output"' EXIT
node_version=22.22.1
archive="node-v$node_version-linux-x64.tar.xz"
# Upstream standalone Node avoids depending on the host distribution's libnode ABI.
for name in SHASUMS256.txt "$archive"; do
  curl --fail --location --retry 5 --retry-all-errors --connect-timeout 20 --max-time 600 \
    "https://nodejs.org/dist/v$node_version/$name" -o "$output/$name"
done
(cd "$output" && awk -v name="$archive" '$2 == name { print; found=1 } END { if (!found) exit 1 }' SHASUMS256.txt | sha256sum --check --strict -)
python3 - "$repo_root" "$output" "$zendriver" <<'PY'
import pathlib
import shutil
import sys
import tarfile
repo, output, zendriver = map(pathlib.Path, sys.argv[1:])
# Explicit source allowlist: never copy .env, workspaces, profiles or repository history.
paths = [pathlib.Path('package.json'), pathlib.Path('node_modules'), pathlib.Path('skills')]
for name in ('contracts', 'shared', 'core'):
    base = pathlib.Path('packages') / name
    paths.extend([base / 'src', base / 'package.json', base / 'node_modules'])
paths.extend(map(pathlib.Path, ['apps/guest-runtime/src', 'apps/guest-runtime/package.json', 'apps/guest-runtime/node_modules']))
with tarfile.open(output / 'runtime.tar', 'w') as archive:
    for relative in paths:
        source = repo / relative
        if source.exists():
            archive.add(source, arcname=str(relative), recursive=True)
shutil.copy2(zendriver, output / 'zendriver-mcp')
with tarfile.open(output / 'chrome.tar', 'w') as archive:
    archive.add('/opt/google/chrome', arcname='chrome')
PY
(cd "$output" && sha256sum runtime.tar chrome.tar zendriver-mcp "$archive" > SHA256SUMS)
mv -- "$output" "$destination"
trap - EXIT
output="$destination"
printf 'Prepared development guest payload: %s\nNext: sudo bash scripts/build-firecracker-guest.sh\n' "$output"
