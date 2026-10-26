import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const directories: string[] = [];
const id = '0649b2ab-7fc5-4fcf-ab15-3201ee2d3d79';
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(
  settings: {
    activeVm?: boolean;
    processStatus?: number;
    existingNamespace?: boolean;
    missingData?: boolean;
    invalidMetadata?: boolean;
    helperFails?: boolean;
    unsafeHelper?: boolean;
  } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trinity-network-recovery-'));
  directories.push(dir);
  const base = path.join(dir, 'storage');
  const volume = path.join(base, 'volumes', id);
  const netns = path.join(dir, 'netns');
  const calls = path.join(dir, 'calls');
  await mkdir(volume, { recursive: true, mode: 0o700 });
  await mkdir(netns);
  await mkdir(path.join(dir, 'lock'));
  await writeFile(calls, '');
  await writeFile(path.join(base, '.trinity-storage-mode'), 'development-unencrypted');
  await writeFile(path.join(volume, 'runtime.json'), '{"uid":100001,"gid":100002}', {
    mode: 0o600,
  });
  const metadata = JSON.stringify({
    version: 1,
    environmentId: settings.invalidMetadata ? 'another-environment' : id,
    hostInterface: 'tg0649b2ab7fc5',
    bridge: 'trinity-egress0',
    bridgeGateway: '172.29.240.1',
    tapGateway: '172.16.0.1',
    tapAddress: '172.16.0.2',
    dns: '172.29.240.1',
  });
  await writeFile(path.join(volume, 'network.json'), metadata, { mode: 0o600 });
  if (!settings.missingData) await writeFile(path.join(volume, 'data.ext4'), 'existing-user-data');
  if (settings.existingNamespace) await writeFile(path.join(netns, `trinity-${id}`), 'existing');
  const helper = path.join(dir, 'configure');
  const commands: Record<string, string> = {
    id: 'echo 0',
    stat: 'if [ "$2" = %u ]; then echo 0; else exec /usr/bin/stat "$@"; fi',
    systemctl: `echo "systemctl $*" >> "$RECOVERY_CALLS"
if [ "$1" = list-units ] && [ "$RECOVERY_ACTIVE_VM" = true ]; then echo 'trinity-vm@test.service loaded active running'; fi`,
    pgrep: 'exit "$RECOVERY_PROCESS_STATUS"',
    ip: `echo "ip $*" >> "$RECOVERY_CALLS"
if [ "$1 $2" = 'netns add' ]; then touch "$RECOVERY_NETNS/$3"; fi`,
    configure: `echo "configure $*" >> "$RECOVERY_CALLS"
if [ "$RECOVERY_HELPER_FAILS" = true ]; then exit 1; fi
echo '{"restored":true}' > "$RECOVERY_VOLUME/network.json"`,
  };
  await Promise.all(
    Object.entries(commands).map(([name, source]) =>
      writeFile(path.join(dir, name), `#!/bin/sh\n${source}\n`, {
        mode: name === 'configure' ? (settings.unsafeHelper ? 0o770 : 0o750) : 0o755,
      }),
    ),
  );
  const script = path.join(dir, 'recover.sh');
  await writeFile(
    script,
    (await readFile('scripts/recover-firecracker-development-network.sh', 'utf8'))
      .replaceAll('/srv/trinity-node', base)
      .replaceAll('/run/netns/', `${netns}/`)
      .replaceAll('/sys/class/net/', `${dir}/interfaces/`)
      .replaceAll('/run/lock/', `${dir}/lock/`)
      .replaceAll('/usr/local/libexec/trinity-configure-firecracker-guest-egress', helper),
  );
  return {
    volume,
    metadata,
    calls: () => readFile(calls, 'utf8'),
    run: () =>
      exec('bash', [script, id], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          RECOVERY_CALLS: calls,
          RECOVERY_NETNS: netns,
          RECOVERY_VOLUME: volume,
          RECOVERY_ACTIVE_VM: String(settings.activeVm ?? false),
          RECOVERY_PROCESS_STATUS: String(settings.processStatus ?? 1),
          RECOVERY_HELPER_FAILS: String(settings.helperFails ?? false),
        },
      }),
  };
}

it('restores missing networking through the installed helper while retaining user data and old metadata', async () => {
  const f = await fixture();
  await f.run();
  expect(await readFile(path.join(f.volume, 'data.ext4'), 'utf8')).toBe('existing-user-data');
  expect(await readFile(path.join(f.volume, 'runtime.json'), 'utf8')).toBe(
    '{"uid":100001,"gid":100002}',
  );
  const backup = (await readdir(f.volume)).find((name) => name.startsWith('network.pre-reboot.'))!;
  expect(await readFile(path.join(f.volume, backup), 'utf8')).toBe(f.metadata);
  expect(JSON.parse(await readFile(path.join(f.volume, 'network.json'), 'utf8'))).toEqual({
    restored: true,
  });
  expect(await f.calls()).toContain(
    `netns exec trinity-${id} ip tuntap add name tap0 mode tap user 100001 group 100002`,
  );
  expect(await f.calls()).toContain(`configure ${id}`);
});

it.each([
  { activeVm: true },
  { processStatus: 0 },
  { processStatus: 2 },
  { existingNamespace: true },
  { missingData: true },
  { invalidMetadata: true },
  { unsafeHelper: true },
])('refuses unsafe recovery before making network changes: %j', async (settings) => {
  const f = await fixture(settings);
  await expect(f.run()).rejects.toThrow();
  expect(await f.calls()).not.toContain('ip ');
  expect(await f.calls()).not.toContain('configure ');
  expect(await readFile(path.join(f.volume, 'network.json'), 'utf8')).toBe(f.metadata);
});

it('retains the archived metadata and data disk when network configuration fails', async () => {
  const f = await fixture({ helperFails: true });
  await expect(f.run()).rejects.toThrow();
  const backup = (await readdir(f.volume)).find((name) => name.startsWith('network.pre-reboot.'))!;
  expect(await readFile(path.join(f.volume, backup), 'utf8')).toBe(f.metadata);
  expect(await readFile(path.join(f.volume, 'data.ext4'), 'utf8')).toBe('existing-user-data');
});
