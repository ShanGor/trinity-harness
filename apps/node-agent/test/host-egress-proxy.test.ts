import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trinity-egress-proxy-'));
  directories.push(dir);
  return dir;
}
async function route(interfaces: string[], existing = false, foreignPolicy = false) {
  const dir = await directory();
  const proc = path.join(dir, 'proc/4242/fdinfo');
  const bin = path.join(dir, 'bin');
  await mkdir(proc, { recursive: true });
  await mkdir(bin);
  await Promise.all(
    interfaces.map((name, i) => writeFile(path.join(proc, String(i)), `pos:\t0\niff:\t${name}\n`)),
  );
  await writeFile(
    path.join(bin, 'ip'),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$PROXY_CALLS"
if [[ "$*" == 'link show guest-egress0' ]]; then exit ${existing ? 0 : 1}; fi
if [[ "$*" == '-4 rule show' && '${foreignPolicy}' == true ]]; then echo '4900: from all lookup 123'; fi
`,
    { mode: 0o755 },
  );
  await writeFile(path.join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const source = await readFile(path.resolve('deploy/firecracker/trinity-sandbox-route'), 'utf8');
  const script = path.join(dir, 'route');
  await writeFile(script, source.replaceAll('/proc/', `${dir}/proc/`));
  let failed = false;
  try {
    await exec('bash', [script, 'up'], {
      env: {
        ...process.env,
        MAINPID: '4242',
        PATH: `${bin}:${process.env['PATH']}`,
        PROXY_CALLS: path.join(dir, 'calls'),
      },
    });
  } catch {
    failed = true;
  }
  return { failed, calls: (await readFile(path.join(dir, 'calls'), 'utf8')).trim().split('\n') };
}
it('configures only the service-owned TUN and installs only a guest ingress route', async () => {
  const result = await route(['utun']);
  expect(result.failed).toBe(false);
  expect(result.calls).toContain('link set dev utun name guest-egress0');
  expect(result.calls).toContain(
    '-4 rule add priority 4900 from 172.29.240.0/20 iif trinity-egress0 lookup 19013',
  );
  expect(result.calls.filter((call) => call.startsWith('-4 route replace'))).toEqual([
    '-4 route replace unreachable default table 19013 metric 32767',
    '-4 route replace 192.0.2.53/32 dev guest-egress0 src 192.0.2.1',
    '-4 route replace default dev guest-egress0 table 19013 metric 10',
  ]);
});
it.each([
  { interfaces: ['utun'], existing: true, reason: 'a foreign guest interface exists' },
  { interfaces: ['utun', 'another'], existing: false, reason: 'multiple owned TUNs are ambiguous' },
  { interfaces: [], existing: false, reason: 'no owned TUN exists' },
])('does not rename or route when $reason', async ({ interfaces, existing }) => {
  const result = await route(interfaces, existing);
  expect(result.failed).toBe(true);
  expect(result.calls.some((call) => call.includes('name guest-egress0'))).toBe(false);
  expect(result.calls.some((call) => call.startsWith('-4 rule add'))).toBe(false);
});
it('reads only SANDBOX_PROXY_URL, stages generic HTTP egress, and never evaluates the env file', async () => {
  const dir = await directory();
  const envFile = path.join(dir, 'deployment.env');
  const marker = path.join(dir, 'never-created');
  await writeFile(
    envFile,
    `DATABASE_URL=private\nIGNORED=$(touch ${marker})\nSANDBOX_PROXY_URL="http://127.0.0.1:20112" # configured upstream\n`,
  );
  const tun = path.join(dir, 'tun2proxy');
  await writeFile(tun, '#!/bin/sh\necho "tun2proxy 0.8.6 (fixture)"\n', { mode: 0o755 });
  const output = path.join(dir, 'stage');
  const env = {
    ...process.env,
    SANDBOX_PROXY_URL: undefined,
    TUN2PROXY_BINARY: tun,
  };
  await exec(
    'python3',
    [path.resolve('scripts/sandbox-egress-config.py'), 'stage', envFile, output],
    { env },
  );
  expect(JSON.parse(await readFile(path.join(output, 'proxy.json'), 'utf8'))).toEqual({
    proxyUrl: 'http://127.0.0.1:20112',
  });
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  for (const value of [
    'not-a-url',
    'https://127.0.0.1:20112',
    'http://user:password@127.0.0.1:20112',
    'http://127.0.0.1:99999',
  ]) {
    await expect(
      exec(
        'python3',
        [path.resolve('scripts/sandbox-egress-config.py'), 'stage', envFile, output],
        { env: { ...env, SANDBOX_PROXY_URL: value } },
      ),
    ).rejects.toThrow();
  }
  await exec(
    'python3',
    [path.resolve('scripts/sandbox-egress-config.py'), 'stage', envFile, output],
    { env: { ...env, SANDBOX_PROXY_URL: '' } },
  );
  expect(JSON.parse(await readFile(path.join(output, 'proxy.json'), 'utf8'))).toEqual({
    proxyUrl: '',
  });
});
it('refuses a foreign policy priority on service restart before modifying routes', async () => {
  const result = await route(['utun'], false, true);
  expect(result.failed).toBe(true);
  expect(result.calls.some((call) => call.startsWith('-4 route replace'))).toBe(false);
  expect(result.calls.some((call) => call.includes('name guest-egress0'))).toBe(false);
});
