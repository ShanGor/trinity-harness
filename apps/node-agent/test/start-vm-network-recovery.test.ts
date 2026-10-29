import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const directories: string[] = [];
const environment = '0649b2ab-7fc5-4fcf-ab15-3201ee2d3d79';
const generation = 'be9c7484-337a-4e48-9cc8-9fa200b780b3';
const instance = `${environment}-${generation}`;
const tenant = '11111111-2222-4333-8444-555555555555';
const user = '66666666-7777-4888-9444-000000000000';

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(
  settings: {
    existingNamespace?: boolean;
    staleNamespace?: boolean;
    missingTap?: boolean;
    storageMode?: string | null;
    missingData?: boolean;
  } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trinity-start-vm-'));
  directories.push(dir);
  const base = path.join(dir, 'storage');
  const volume = path.join(base, 'volumes', environment);
  const netns = path.join(dir, 'netns');
  const calls = path.join(dir, 'calls');
  await mkdir(volume, { recursive: true, mode: 0o700 });
  await mkdir(path.join(base, 'images'));
  await mkdir(netns);
  await mkdir(path.join(dir, 'lock'));
  await writeFile(calls, '');
  if (settings.storageMode !== null)
    await writeFile(
      path.join(base, '.trinity-storage-mode'),
      settings.storageMode ?? 'development-unencrypted',
    );
  await writeFile(path.join(volume, 'runtime.json'), '{"uid":100001,"gid":100002}', {
    mode: 0o600,
  });
  await mkdir(path.join(base, 'instances'), { recursive: true });
  await writeFile(
    path.join(base, 'instances', `${instance}.json`),
    JSON.stringify({
      id: environment,
      generation,
      tenantId: tenant,
      userId: user,
      vcpus: 2,
      memoryMiB: 2048,
      state: 'starting',
      nodeId: 'local-kvm-01',
    }),
  );
  await writeFile(path.join(base, 'images', 'vmlinux'), 'kernel');
  await writeFile(path.join(base, 'images', 'rootfs.ext4'), 'rootfs');
  await writeFile(
    path.join(volume, 'network.json'),
    JSON.stringify({ version: 1, environmentId: environment, egressAddress: '172.29.240.42' }),
    { mode: 0o600 },
  );
  if (!settings.missingData) await writeFile(path.join(volume, 'data.ext4'), 'existing-user-data');
  if (settings.existingNamespace)
    await writeFile(path.join(netns, `trinity-${environment}`), 'live tap');
  if (settings.missingTap) await writeFile(path.join(netns, `trinity-${environment}`), 'live');
  if (settings.staleNamespace) await writeFile(path.join(netns, `trinity-${environment}`), 'stale');

  const commands: Record<string, string> = {
    chown: 'exit 0',
    ip: `echo "ip $*" >> "$LAUNCHER_CALLS"
if [ "$1" = -n ] && [ "$3" = link ] && [ "$4" = show ]; then
  nsfile="$LAUNCHER_NETNS/$2"
  dev="$5"
  grep -q live "$nsfile" 2>/dev/null || exit 1
  if [ "$dev" = tap0 ]; then grep -q tap "$nsfile" 2>/dev/null || exit 1; fi
fi
if [ "$1" = netns ] && [ "$2" = del ]; then rm -f "$LAUNCHER_NETNS/$3"; fi
if [ "$1" = netns ] && [ "$2" = add ]; then touch "$LAUNCHER_NETNS/$3"; fi
exit 0`,
    helper: `echo "helper $*" >> "$LAUNCHER_CALLS"`,
    jailer: `echo "jailer $*" >> "$LAUNCHER_CALLS"; exit 0`,
  };
  await Promise.all(
    Object.entries(commands).map(([name, source]) =>
      writeFile(path.join(dir, name), `#!/bin/sh\n${source}\n`, { mode: 0o755 }),
    ),
  );
  const script = path.join(dir, 'start-vm.sh');
  await writeFile(
    script,
    (await readFile('deploy/firecracker/trinity-start-vm', 'utf8'))
      .replaceAll('/srv/trinity-node', base)
      .replaceAll('/run/netns/', `${netns}/`)
      .replaceAll('/run/lock/', `${dir}/lock/`)
      .replaceAll(
        '/usr/local/libexec/trinity-configure-firecracker-guest-egress',
        path.join(dir, 'helper'),
      )
      .replaceAll('/usr/local/bin/jailer', path.join(dir, 'jailer')),
  );
  return {
    volume,
    netns: () => readFile(path.join(netns, `trinity-${environment}`), 'utf8').catch(() => null),
    calls: () => readFile(calls, 'utf8'),
    run: () =>
      exec('bash', [script, instance], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          LAUNCHER_CALLS: calls,
          LAUNCHER_NETNS: netns,
        },
      }),
  };
}

it('reconstructs a missing namespace/TAP and configures egress before launching the VMM', async () => {
  const f = await fixture();
  await f.run();
  const calls = await f.calls();
  expect(calls).toContain(`netns add trinity-${environment}`);
  expect(calls).toContain(
    `netns exec trinity-${environment} ip tuntap add name tap0 mode tap user 100001 group 100002`,
  );
  expect(calls).toContain(`helper ${environment} ${generation}`);
  expect(calls).toContain(`jailer --id ${generation}`);
  expect(await readFile(path.join(f.volume, 'data.ext4'), 'utf8')).toBe('existing-user-data');
  const backup = (await readdir(f.volume)).find((name) => name.startsWith('network.pre-reboot.'))!;
  expect(JSON.parse(await readFile(path.join(f.volume, backup), 'utf8'))).toMatchObject({
    version: 1,
    environmentId: environment,
    egressAddress: '172.29.240.42',
  });
});

it('drops a stale namespace file and rebuilds instead of joining a dead namespace', async () => {
  const f = await fixture({ staleNamespace: true });
  await f.run();
  const calls = await f.calls();
  expect(calls).toContain(`netns del trinity-${environment}`);
  expect(calls).toContain(`netns add trinity-${environment}`);
  expect(await f.netns()).toBe('');
});

it('launches directly when the namespace is healthy', async () => {
  const f = await fixture({ existingNamespace: true });
  await f.run();
  const calls = await f.calls();
  expect(calls).not.toContain(`netns add trinity-${environment}`);
  expect(calls).not.toContain('netns del');
  expect(calls).not.toContain('tuntap add');
  expect(calls).toContain(`helper ${environment} ${generation}`);
  expect(calls).toContain(`jailer --id ${generation}`);
});

it('tops up a lost TAP inside a live namespace without rebuilding it', async () => {
  const f = await fixture({ missingTap: true });
  await f.run();
  const calls = await f.calls();
  expect(calls).not.toContain(`netns add trinity-${environment}`);
  expect(calls).not.toContain('netns del');
  expect(calls).toContain(
    `netns exec trinity-${environment} ip tuntap add name tap0 mode tap user 100001 group 100002`,
  );
  expect(calls).toContain(`jailer --id ${generation}`);
});

it.each([
  { storageMode: null, case: 'unprovisioned host storage' },
  { missingData: true, case: 'missing user data disk' },
])('refuses to start with $case instead of reconstructing anything', async (settings) => {
  const f = await fixture(settings);
  await expect(f.run()).rejects.toThrow();
  const calls = await f.calls();
  expect(calls).not.toContain(`netns add trinity-${environment}`);
  expect(calls).not.toContain('tuntap add');
  expect(calls).not.toContain('helper ');
  expect(calls).not.toContain('jailer ');
  if (!settings.missingData)
    expect(await readFile(path.join(f.volume, 'data.ext4'), 'utf8')).toBe('existing-user-data');
});
