#!/usr/bin/env bash
set -euo pipefail

[[ $# -eq 3 && "$2" =~ ^[0-9a-f-]{36}$ && "$3" =~ ^[1-9][0-9]*$ ]] || exit 64
candidate="$1"
environment_id="$2"
watch_pid="$3"
repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$repo_root"
[[ -f .env && ! -L .env && $(stat -c %u .env) == "$UID" ]] || exit 1
ps -p "$watch_pid" -o args= | grep -Fq 'watch src/main.ts' || {
  echo 'The existing Browser Runtime watcher is unavailable.' >&2; exit 1;
}
node --env-file=.env - "$environment_id" <<'NODE'
const { createRequire } = require('node:module');
const { Pool } = createRequire(process.cwd() + '/packages/db/package.json')('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
(async () => {
  try {
    const environments = await pool.query('select id,node_id,state from assistant_environments');
    const maintenance = await pool.query("select state from firecracker_node_maintenance where node_id='local-kvm-01'");
    if (environments.rows.length !== 1 || environments.rows[0].id !== process.argv[2] ||
        environments.rows[0].node_id !== 'local-kvm-01' || environments.rows[0].state !== 'stopped' ||
        maintenance.rows[0]?.state !== 'draining') throw new Error('The drained assignment changed');
  } finally { await pool.end(); }
})().catch(() => { process.stderr.write('The drained assignment could not be verified.\n'); process.exitCode = 1; });
NODE
node - <<'NODE'
const fs = require('node:fs');
const value = fs.readFileSync('.env', 'utf8');
const matches = value.split(/\r?\n/).filter((line) => /^[ \t]*(?:export[ \t]+)?GUEST_DESKTOP_ENABLED[ \t]*=/.test(line));
if (matches.length > 1 || (matches.length === 1 && !/^[ \t]*(?:export[ \t]+)?GUEST_DESKTOP_ENABLED[ \t]*=[ \t]*(?:1|"1"|'1')[ \t]*(?:#.*)?$/.test(matches[0]))) {
  process.stderr.write('Desktop configuration is ambiguous or disabled.\n');
  process.exit(1);
}
NODE
pkexec /usr/bin/bash "$repo_root/scripts/release-firecracker-desktop-development.sh" "$candidate" "$environment_id"
node - <<'NODE'
const fs = require('node:fs');
const value = fs.readFileSync('.env', 'utf8');
const matches = value.split(/\r?\n/).filter((line) => /^[ \t]*(?:export[ \t]+)?GUEST_DESKTOP_ENABLED[ \t]*=/.test(line));
if (matches.length > 1 || (matches.length === 1 && !/^[ \t]*(?:export[ \t]+)?GUEST_DESKTOP_ENABLED[ \t]*=[ \t]*(?:1|"1"|'1')[ \t]*(?:#.*)?$/.test(matches[0]))) throw new Error('Desktop configuration changed during release');
if (!matches.length) fs.appendFileSync('.env', '\nGUEST_DESKTOP_ENABLED=1\n', { mode: 0o600 });
NODE
touch "$repo_root/apps/browser-runtime/src/main.ts"
ready=false
for _ in {1..30}; do
  if pgrep -P "$watch_pid" >/dev/null && [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 http://127.0.0.1:3010/)" == 401 ]]; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo 'Browser Runtime restart was not confirmed; node remains drained.' >&2; exit 1; }
echo 'Browser Runtime restarted with desktop capture enabled.'
