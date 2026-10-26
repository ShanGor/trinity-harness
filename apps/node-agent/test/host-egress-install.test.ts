import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
const exec = promisify(execFile);
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function install(
  settings: {
    proxy?: boolean;
    failDns?: boolean;
    failGateway?: boolean;
    failProxy?: boolean;
    repeat?: boolean;
    disable?: boolean;
    activeVm?: boolean;
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'trinity-egress-install-'));
  directories.push(directory);
  const calls = path.join(directory, 'calls');
  const commands: Record<string, string> = {
    id: 'echo 0',
    getent: 'exit 0',
    stat: 'echo 0',
    install: `args=(); while (( $# )); do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; /usr/bin/install "\${args[@]}"`,
    pgrep: settings.activeVm ? 'echo firecracker; exit 0' : 'exit 1',
    dnsmasq: 'exit 0',
    ip: 'if [[ "$*" == "link show guest-egress0" ]]; then exit 1; fi',
    nft: 'exit 0',
    tun2proxy: 'echo "tun2proxy 0.8.6 (fixture)"',
    'dnscrypt-proxy': 'exit 0',
    systemctl: `printf '%s\\n' "$*" >> "$INSTALL_CALLS"
case "$1" in
 show) echo active ;;
 reset-failed) touch "$INSTALL_RESET" ;;
 restart)
  if [[ "$2" == trinity-firecracker-egress.service && "$FAIL_GATEWAY" == true ]]; then echo 'Gateway startup failed' >&2; exit 1; fi
  if [[ "$2" == trinity-sandbox-egress.service && "$FAIL_PROXY" == true ]]; then echo 'Proxy startup failed' >&2; exit 1; fi
  if [[ "$2" == trinity-firecracker-egress-dns.service ]]; then
    [[ -f "$INSTALL_RESET" ]] || exit 1
    if [[ "$FAIL_DNS" == true ]]; then echo 'DNS startup failed' >&2; exit 1; fi
  fi ;;
esac`,
  };
  await Promise.all(
    Object.entries(commands).map(([name, body]) =>
      writeFile(path.join(directory, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 }),
    ),
  );
  const repo = path.join(directory, 'repo');
  await mkdir(path.join(repo, 'scripts/lib'), { recursive: true });
  await mkdir(path.join(repo, 'deploy/firecracker'), { recursive: true });
  const rewrite = (text: string) =>
    text
      .replaceAll('/etc/', `${directory}/etc/`)
      .replaceAll('/usr/local/', `${directory}/usr/local/`)
      .replaceAll('/var/lib/', `${directory}/var/lib/`);
  for (const file of [
    'scripts/install-firecracker-host-egress.sh',
    'scripts/lib/firecracker-host-proxy.sh',
  ])
    await writeFile(path.join(repo, file), rewrite(await readFile(path.resolve(file), 'utf8')));
  for (const file of [
    'scripts/sandbox-egress-config.py',
    'deploy/firecracker/trinity-firecracker-egress-up',
    'scripts/configure-firecracker-guest-egress.sh',
    'deploy/firecracker/trinity-firecracker-egress.service',
    'deploy/firecracker/trinity-firecracker-egress-dns.service',
    'deploy/firecracker/trinity-firecracker-egress-config@.service',
    'deploy/firecracker/trinity-sandbox-egress.service',
    'deploy/firecracker/trinity-sandbox-route',
    'deploy/firecracker/trinity-sandbox-dns-upstream.conf',
    'deploy/firecracker/trinity-sandbox-egress-config.conf',
  ])
    await writeFile(path.join(repo, file), await readFile(path.resolve(file)));
  const envFile = path.join(repo, '.env');
  await writeFile(envFile, `SANDBOX_PROXY_URL=${settings.proxy ? 'http://127.0.0.1:20112' : ''}\n`);
  const env = {
    ...process.env,
    SANDBOX_PROXY_URL: undefined,
    PATH: `${directory}:${process.env['PATH'] ?? ''}`,
    INSTALL_CALLS: calls,
    INSTALL_RESET: path.join(directory, 'reset'),
    FAIL_DNS: String(settings.failDns ?? false),
    FAIL_GATEWAY: String(settings.failGateway ?? false),
    FAIL_PROXY: String(settings.failProxy ?? false),
  };
  let output = '',
    failed = false;
  try {
    output = (
      await exec('bash', [path.join(repo, 'scripts/install-firecracker-host-egress.sh')], { env })
    ).stdout;
    if (settings.repeat || settings.disable) {
      if (settings.disable) await writeFile(envFile, 'SANDBOX_PROXY_URL=\n');
      output += (
        await exec('bash', [path.join(repo, 'scripts/install-firecracker-host-egress.sh')], { env })
      ).stdout;
    }
  } catch (error) {
    if (!(error instanceof Error) || !('stderr' in error)) throw error;
    output = String(error.stderr);
    failed = true;
  }
  return {
    failed,
    output,
    calls: (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n'),
  };
}
it('starts direct host routing when SANDBOX_PROXY_URL is unset and recovers DNS start limits', async () => {
  const r = await install();
  expect(r.failed, r.output).toBe(false);
  expect(r.calls).toContain('restart trinity-firecracker-egress.service');
  expect(r.calls.indexOf('restart trinity-firecracker-egress-dns.service')).toBeGreaterThan(
    r.calls.indexOf('reset-failed trinity-firecracker-egress-dns.service'),
  );
  expect(r.output).toContain('SANDBOX_PROXY_URL is unset');
  expect(r.calls.some((c) => c.startsWith('enable trinity-sandbox'))).toBe(false);
});
it.each([
  { failDns: true, message: 'DNS startup failed' },
  { failGateway: true, message: 'Gateway startup failed' },
  { proxy: true, failProxy: true, message: 'Proxy startup failed' },
])('fails installation on $message', async ({ message, ...settings }) => {
  const r = await install(settings);
  expect(r.failed).toBe(true);
  expect(r.output).toContain(message);
  expect(r.calls).not.toContain('restart trinity-node-agent.service');
});
it('uses the .env proxy for the whole guest and retains it on normal upgrades', async () => {
  const r = await install({ proxy: true, repeat: true });
  expect(r.failed, r.output).toBe(false);
  expect(r.calls.filter((c) => c === 'restart trinity-sandbox-egress.service')).toHaveLength(2);
  expect(r.output).toContain('Configured whole-guest egress through SANDBOX_PROXY_URL');
  expect(r.calls.some((c) => c.includes('clash'))).toBe(false);
});
it('disables proxy services when the configured variable is removed', async () => {
  const r = await install({ proxy: true, disable: true });
  expect(r.failed, r.output).toBe(false);
  expect(r.calls).toContain('disable --now trinity-sandbox-egress.service');
  expect(r.output).toContain('SANDBOX_PROXY_URL is unset');
});
it('keeps the active-VM guard before proxy installation', async () => {
  const r = await install({ proxy: true, activeVm: true });
  expect(r.failed).toBe(true);
  expect(r.output).toContain('A Firecracker VM is active');
  expect(r.calls.some((c) => c.startsWith('restart'))).toBe(false);
});
