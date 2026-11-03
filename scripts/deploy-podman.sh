#!/usr/bin/env bash
# Rootless, single-host deployment; host PostgreSQL/Redis and a provisioned Firecracker Node Agent.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO=$PWD
BIFROST_DIR=${BIFROST_DIR:-/home/sam/sources/Bifrost-Bridge}
ENV_FILE=${ENV_FILE:-$REPO/.env}
API_PORT=${API_PORT:-3100}
WEB_PORT=${WEB_PORT:-8080}
for tool in podman node pnpm cargo curl systemctl; do command -v "$tool" >/dev/null; done
[[ -f "$ENV_FILE" && -f "$BIFROST_DIR/Cargo.toml" ]]
for port in "$API_PORT" "$WEB_PORT"; do [[ "$port" =~ ^[0-9]+$ && "$port" -gt 1024 && "$port" -lt 65536 ]]; done
[[ "$API_PORT" != "$WEB_PORT" ]]
STATE=$(mktemp -d)
trap 'rm -rf "$STATE"' EXIT
chmod 700 "$STATE"
# Parse dotenv rather than executing it as shell code. Keep credentials private.
node --input-type=module - "$ENV_FILE" "$STATE" "$REPO" "$API_PORT" "$WEB_PORT" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runtimeConfig } from './scripts/podman-runtime.mjs';
const [file, state, repo, api, web] = process.argv.slice(2);
const require = createRequire(path.join(repo, 'apps/server/package.json'));
const env = require('dotenv').parse(fs.readFileSync(file));
for (const key of ['DATABASE_URL', 'REDIS_URL', 'TOKEN_SECRET', 'WORKSPACE_ROOT']) {
  if (!env[key]) throw new Error(`${key} is required in ENV_FILE`);
}
if (!path.isAbsolute(env.WORKSPACE_ROOT)) throw new Error('WORKSPACE_ROOT must be absolute');
for (const value of Object.values(env)) if (/[\r\n]/.test(value)) throw new Error('Multiline environment values are unsupported');
const runtime = runtimeConfig(env, api, web);
env.BROWSER_RUNTIME_HOST = '127.0.0.1';
env.BROWSER_RUNTIME_PORT = String(runtime.browserPort);
fs.writeFileSync(path.join(state, 'runtime.json'), JSON.stringify({...runtime, nodeToken: env.NODE_RUNTIME_TOKEN, browserToken: env.BROWSER_RUNTIME_TOKEN}), {mode: 0o600});
env.PORT = api;
env.HOST = '127.0.0.1';
fs.writeFileSync(path.join(state, 'env'), Object.entries(env).map(([k,v]) => `${k}=${v}`).join('\n') + '\n', {mode: 0o600});
fs.writeFileSync(path.join(state, 'workspace'), env.WORKSPACE_ROOT);
fs.writeFileSync(path.join(state, 'gateway.json'), JSON.stringify({
  mode: 'Reverse', listen_addr: `0.0.0.0:${web}`, worker_threads: 4,
  connect_timeout_secs: 10, idle_timeout_secs: 86400, max_connection_lifetime_secs: 86400,
  monitoring: {enabled: false},
  static_files: {mounts: [{path: '/', root_dir: '/srv/web', order: 100}], enable_directory_listing: false, index_files: ['index.html'], spa_mode: true, spa_fallback_file: 'index.html'},
  reverse_proxy_routes: [{id: 'trinity-api', target: `http://127.0.0.1:${api}`, order: 10, predicates: [{type: 'Path', patterns: ['/api', '/api/**', '/acp', '/acp/**'], match_trailing_slash: true}]}]
}));
JS
WORKSPACE=$(cat "$STATE/workspace")
mkdir -p "$WORKSPACE"
pnpm --filter @trinity-harness/web build
podman build --ignorefile deploy/podman/containerignore --network host -t localhost/trinity-app -f deploy/podman/Containerfile .
cargo build --release --locked --manifest-path "$BIFROST_DIR/Cargo.toml"
cp "$BIFROST_DIR/target/release/bifrost-bridge" "$STATE/bifrost-bridge"
# Copy the exact frontend produced by the application image.
BUILD_CONTAINER=$(podman create localhost/trinity-app)
podman cp "$BUILD_CONTAINER:/repo/apps/web/dist" "$STATE/dist"
podman rm "$BUILD_CONTAINER" >/dev/null
podman build --http-proxy=false --network host -t localhost/trinity-gateway -f deploy/podman/Containerfile.gateway "$STATE"
COMMON=(--network host --userns keep-id --user "$(id -u):$(id -g)" --env-file "$STATE/env" -v "$WORKSPACE:$WORKSPACE")
podman run --rm "${COMMON[@]}"  --workdir /repo/packages/db localhost/trinity-app node node_modules/drizzle-kit/bin.cjs migrate
source "$REPO/scripts/lib/podman-services.sh"
ensure_podman_node_agent
curl --retry 30 --retry-connrefused --retry-delay 1 --silent --show-error --output /dev/null "$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).nodeEndpoint' "$STATE/runtime.json")/instances"
node scripts/podman-runtime.mjs "$STATE/runtime.json" node
# Avoid replacing an unmanaged listener at the configured browser endpoint.
if ! podman container exists trinity-browser-runtime && node scripts/podman-runtime.mjs "$STATE/runtime.json" browser 2>/dev/null; then
  printf 'Browser runtime is already managed outside Podman; stop it before migrating to this deployment.\n' >&2
  exit 1
fi
if podman container exists trinity-browser-runtime; then
  podman stop trinity-browser-runtime >/dev/null
  podman rm trinity-browser-runtime >/dev/null
fi
podman run -d --name trinity-browser-runtime --restart unless-stopped "${COMMON[@]}" localhost/trinity-app node apps/browser-runtime/node_modules/tsx/dist/cli.mjs apps/browser-runtime/src/main.ts
# A bounded readiness wait checks auth and request validation, never guest effects.
curl --retry 30 --retry-connrefused --retry-delay 1 --silent --show-error --output /dev/null "http://127.0.0.1:$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1])).browserPort' "$STATE/runtime.json")/execute"
node scripts/podman-runtime.mjs "$STATE/runtime.json" browser
for service in server agent-worker audit-consumer; do
  name="trinity-$service"
  if podman container exists "$name"; then podman stop "$name" >/dev/null; podman rm "$name" >/dev/null; fi
  podman run -d --name "$name" --restart unless-stopped "${COMMON[@]}" localhost/trinity-app node "apps/$service/node_modules/tsx/dist/cli.mjs" "apps/$service/src/main.ts"
done
if podman container exists trinity-gateway; then podman stop trinity-gateway >/dev/null; podman rm trinity-gateway >/dev/null; fi
podman run -d --name trinity-gateway --label "io.trinity.web-port=$WEB_PORT" --restart unless-stopped --network host localhost/trinity-gateway
curl --retry 30 --retry-connrefused --retry-delay 1 --fail --silent --show-error "http://127.0.0.1:$WEB_PORT/api/health"
curl --fail --silent --show-error "http://127.0.0.1:$WEB_PORT/" > /dev/null
for name in trinity-browser-runtime trinity-server trinity-agent-worker trinity-audit-consumer trinity-gateway; do
  [[ "$(podman inspect --format '{{.State.Running}}' "$name")" == true ]]
done
printf '\nTrinity is listening on http://0.0.0.0:%s\n' "$WEB_PORT"
