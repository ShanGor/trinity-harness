#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 INSTALL_ROOT" >&2
  exit 2
fi

install_root="$1"
if [[ ! "$install_root" = /* ]]; then
  echo "INSTALL_ROOT must be an absolute path" >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
zendriver_version="0.16.37"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
fetch_root="$(mktemp -d)"
trap 'rm -rf "$fetch_root"' EXIT

mkdir -p "$fetch_root/src"
cat > "$fetch_root/Cargo.toml" <<'TOML'
[package]
name = "trinity-zendriver-fetch"
version = "0.1.0"
edition = "2024"

[dependencies]
zendriver-mcp = { version = "=0.16.37", default-features = false }
TOML
printf 'fn main() {}\n' > "$fetch_root/src/main.rs"
cargo fetch --manifest-path "$fetch_root/Cargo.toml"

source_dir="$(find "$cargo_home/registry/src" -mindepth 2 -maxdepth 2 -type d -name "zendriver-mcp-$zendriver_version" -print -quit)"
if [[ -z "$source_dir" ]]; then
  echo "could not locate the pinned zendriver-mcp source" >&2
  exit 1
fi
patched_source="$fetch_root/zendriver-mcp"
cp -a "$source_dir" "$patched_source"
chmod -R u+w "$patched_source"
for patch_name in zendriver-mcp-user-data-dir.patch zendriver-mcp-human-input.patch; do
  patch_file="$repo_root/apps/browser-runtime/patches/$patch_name"
  if [[ ! -f "$patch_file" ]]; then
    patch_file="$(dirname "$0")/$patch_name"
  fi
  patch --batch --forward -p1 -d "$patched_source" < "$patch_file"
done

cargo install --path "$patched_source" --locked --no-default-features --root "$install_root" --force
