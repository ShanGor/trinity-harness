import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);

async function checkFirewall(table: string): Promise<void> {
  const script = await readFile('scripts/configure-firecracker-guest-egress.sh', 'utf8');
  const check = script.match(/printf '%s\\n' "\$old_table" \| python3 -c '[\s\S]*?\n'/)?.[0];
  if (!check) throw new Error('Missing default firewall validation command');
  // Execute the shell command as deployed, including its quoting and Python stdin.
  await exec('bash', ['-euo', 'pipefail', '-c', check], {
    env: { ...process.env, old_table: table },
  });
}

const defaultTable = (priority: string): string => `table inet trinity_development {
  chain input {
    type filter hook input priority ${priority}; policy drop;
    iifname "lo" accept
  }
  chain output {
    type filter hook output priority ${priority}; policy drop;
    oifname "lo" accept
  }
  chain forward {
    type filter hook forward priority ${priority}; policy drop;
  }
}`;

it.each(['0', 'filter'])(
  'accepts the known default-deny firewall with priority %s',
  async (priority) => {
    await expect(checkFirewall(defaultTable(priority))).resolves.toBeUndefined();
  },
);

it.each([
  defaultTable('filter').replace('iifname "lo" accept', 'iifname "tap0" accept'),
  defaultTable('filter').replace('policy drop;', 'policy accept;'),
  defaultTable('filter').replace('    iifname "lo" accept\n', ''),
])('rejects customized firewall rules before replacement', async (table) => {
  await expect(checkFirewall(table)).rejects.toThrow(
    'Existing namespace firewall is not the known default-deny table',
  );
});

it.each([true, false, undefined])(
  'requires explicit bridge port isolation (%s)',
  async (isolated) => {
    const script = await readFile('scripts/configure-firecracker-guest-egress.sh', 'utf8');
    const check = script.match(
      /bridge -details -json link show dev "\$host_if" \|\n\s+jq[^\n]+(?= \|\|)/,
    )?.[0];
    if (!check) throw new Error('Missing bridge port isolation validation command');
    const command = `bridge() {
    [ "$1" = -details ] && [ "$2" = -json ] || return 1
    printf '%s\\n' "$BRIDGE_DETAILS"
  }
  ${check}`;
    const result = exec('bash', ['-euo', 'pipefail', '-c', command], {
      env: {
        ...process.env,
        host_if: 'tg123456789abc',
        BRIDGE_DETAILS: JSON.stringify([
          { ifname: 'tg123456789abc', master: 'trinity-egress0', isolated },
        ]),
      },
    });
    if (isolated === true) await expect(result).resolves.toBeDefined();
    else await expect(result).rejects.toThrow();
  },
);

it.each([true, false])('enables only the synthetic DNS pool for proxy mode %s', async (enabled) => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'trinity-virtual-dns-'));
  try {
    const config = join(dir, 'proxy.json');
    await writeFile(config, JSON.stringify({ proxyUrl: enabled ? 'http://127.0.0.1:20112' : '' }));
    const script = await readFile('scripts/configure-firecracker-guest-egress.sh', 'utf8');
    const fn = script
      .match(/sync_virtual_dns_rule\(\) \{[\s\S]*?\n\}\n/)![0]
      .replaceAll('/etc/trinity/sandbox-egress/proxy.json', config);
    const result = await exec('bash', [
      '-euo',
      'pipefail',
      '-c',
      `
namespace=fixture
ip() {
 if [[ "$*" == *'nft -a list chain'* ]]; then
  echo 'iifname "tap0" oifname "uplink0" ip saddr 172.16.0.2 ip daddr 198.19.0.0/16 accept comment "trinity-sandbox-dns-map-v1" # handle 42'
 else printf '%s\\n' "$*"; fi
}
${fn}
sync_virtual_dns_rule`,
    ]);
    expect(result.stdout).toContain('delete rule inet trinity_development forward handle 42');
    expect(result.stdout.includes('insert rule')).toBe(enabled);
    if (enabled)
      expect(result.stdout).toContain('ip saddr 172.16.0.2 ip daddr 198.19.0.0/16 accept');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
