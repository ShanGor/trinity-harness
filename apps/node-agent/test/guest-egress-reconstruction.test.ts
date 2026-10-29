import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile);
const directories: string[] = [];
const id = '0649b2ab-7fc5-4fcf-ab15-3201ee2d3d79';
const metadata = JSON.stringify({
  version: 1,
  environmentId: id,
  hostInterface: 'tg0649b2ab7fc5',
  bridge: 'trinity-egress0',
  bridgeGateway: '172.29.240.1',
  tapGateway: '172.16.0.1',
  tapAddress: '172.16.0.2',
  dns: '172.29.240.1',
});

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(
  settings: {
    existingNamespace?: boolean;
    keepNetworkMetadata?: boolean;
    storageMode?: string | null;
    missingData?: boolean;
    invalidUid?: boolean;
    activeVm?: boolean;
    isolatedMountNamespace?: boolean;
    launcherGeneration?: string;
  } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trinity-egress-reconstruction-'));
  directories.push(dir);
  const base = path.join(dir, 'storage');
  const volume = path.join(base, 'volumes', id);
  const netns = path.join(dir, 'netns');
  const interfaces = path.join(dir, 'interfaces');
  const calls = path.join(dir, 'calls');
  await mkdir(volume, { recursive: true, mode: 0o700 });
  await mkdir(netns);
  await mkdir(interfaces);
  await mkdir(path.join(dir, 'lock'));
  await writeFile(calls, '');
  if (settings.storageMode !== null)
    await writeFile(
      path.join(base, '.trinity-storage-mode'),
      settings.storageMode ?? 'development-unencrypted',
    );
  await writeFile(
    path.join(volume, 'runtime.json'),
    settings.invalidUid ? '{"uid":"not-a-number","gid":100002}' : '{"uid":100001,"gid":100002}',
    { mode: 0o600 },
  );
  if (settings.keepNetworkMetadata !== false)
    await writeFile(path.join(volume, 'network.json'), metadata, { mode: 0o600 });
  if (!settings.missingData) await writeFile(path.join(volume, 'data.ext4'), 'existing-user-data');
  if (settings.existingNamespace) await writeFile(path.join(netns, `trinity-${id}`), 'existing');

  const commands: Record<string, string> = {
    ip: `echo "ip $*" >> "$FIXTURE_CALLS"
case "$*" in
  *'address show dev trinity-egress0'*) echo '    inet 172.29.240.1/20 brd 172.29.255.255 scope global trinity-egress0' ;;
  *'link show dev trinity-egress0'*) echo 'trinity-egress0: alias trinity-firecracker-egress' ;;
  *'link show dev uplink0'*) exit 1 ;;
  *'link show dev tap0'*) : ;;
  *'address show dev tap0'*) : ;;
  *'route show default'*) : ;;
  *'nft -a list chain'*) : ;;
  *'nft list table'*) exit 1 ;;
  *'nft -f -') cat >/dev/null ;;
  *'sysctl -n net.ipv4.ip_forward'*) echo 0 ;;
esac
if [ "$1" = netns ]; then
  case "$2" in
    add) touch "$FIXTURE_NETNS/$3" ;;
    pids) : ;;
  esac
fi
exit 0`,
    systemctl: `echo "systemctl $*" >> "$FIXTURE_CALLS"
if [ "$1" = list-units ] && [ "$FIXTURE_ACTIVE_VM" = true ]; then
  echo 'trinity-vm@0649b2ab-7fc5-4fcf-ab15-3201ee2d3d79-deadbeef-337a-4e48-9cc8-9fa200b780b3.service loaded active running'
fi
if [ "$1" = show ]; then echo active; fi
exit 0`,
    bridge: 'exit 0',
    chown: 'exit 0',
    id: 'echo 0',
    readlink:
      'if [ "$FIXTURE_ISOLATED_MNT" = true ]; then if [ "$1" = /proc/self/ns/mnt ]; then echo mnt:self; else echo mnt:other; fi; else echo mnt:same; fi',
    stat: 'if [ "$2" = %u ]; then echo 0; else exec /usr/bin/stat "$@"; fi',
  };
  await Promise.all(
    Object.entries(commands).map(([name, source]) =>
      writeFile(path.join(dir, name), `#!/bin/sh\n${source}\n`, { mode: 0o755 }),
    ),
  );
  const script = path.join(dir, 'configure.sh');
  await writeFile(
    script,
    (await readFile('scripts/configure-firecracker-guest-egress.sh', 'utf8'))
      .replaceAll('/srv/trinity-node', base)
      .replaceAll('/run/netns/', `${netns}/`)
      .replaceAll('/run/lock/', `${dir}/lock/`)
      .replaceAll('/sys/class/net/', `${interfaces}/`)
      .replaceAll('/etc/trinity/sandbox-egress/proxy.json', path.join(dir, 'proxy.json')),
  );
  return {
    volume,
    calls: () => readFile(calls, 'utf8'),
    run: () =>
      exec(
        'bash',
        settings.launcherGeneration ? [script, id, settings.launcherGeneration] : [script, id],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env['PATH'] ?? ''}`,
            FIXTURE_CALLS: calls,
            FIXTURE_NETNS: netns,
            FIXTURE_ACTIVE_VM: String(settings.activeVm ?? false),
            FIXTURE_ISOLATED_MNT: String(settings.isolatedMountNamespace ?? false),
          },
        },
      ),
  };
}

it('reconstructs the ephemeral namespace and tap when missing, preserving user data and archiving metadata', async () => {
  const f = await fixture();
  await f.run();
  const calls = await f.calls();
  expect(calls).toContain(`netns add trinity-${id}`);
  expect(calls).toContain(
    `netns exec trinity-${id} ip tuntap add name tap0 mode tap user 100001 group 100002`,
  );
  expect(await readFile(path.join(f.volume, 'data.ext4'), 'utf8')).toBe('existing-user-data');
  expect(await readFile(path.join(f.volume, 'runtime.json'), 'utf8')).toBe(
    '{"uid":100001,"gid":100002}',
  );
  const backup = (await readdir(f.volume)).find((name) => name.startsWith('network.pre-reboot.'))!;
  expect(await readFile(path.join(f.volume, backup), 'utf8')).toBe(metadata);
  expect(JSON.parse(await readFile(path.join(f.volume, 'network.json'), 'utf8'))).toMatchObject({
    version: 1,
    environmentId: id,
  });
});

it('reconstructs networking for any provisioned storage mode, not only development', async () => {
  const f = await fixture({ storageMode: 'host-managed' });
  await f.run();
  expect(await f.calls()).toContain(`netns add trinity-${id}`);
});

it('configures a present namespace without reconstructing it', async () => {
  const f = await fixture({ existingNamespace: true, keepNetworkMetadata: false });
  await f.run();
  const calls = await f.calls();
  expect(calls).not.toContain(`netns add trinity-${id}`);
  expect(calls).toContain(`link add tg0649b2ab7fc5 type veth peer name uplink0`);
  expect(JSON.parse(await readFile(path.join(f.volume, 'network.json'), 'utf8'))).toMatchObject({
    version: 1,
    environmentId: id,
  });
});

it.each([
  { storageMode: null, case: 'unprovisioned host storage' },
  { missingData: true, case: 'missing user data disk' },
  { invalidUid: true, case: 'invalid runtime identity' },
  { activeVm: true, case: 'an active environment VMM' },
])('refuses reconstruction with $case before touching the network', async (settings) => {
  const f = await fixture(settings);
  await expect(f.run()).rejects.toThrow();
  const calls = await f.calls();
  expect(calls).not.toContain(`netns add trinity-${id}`);
  expect(calls).not.toContain('tuntap add');
  expect(await readFile(path.join(f.volume, 'network.json'), 'utf8')).toBe(metadata);
  expect(await readFile(path.join(f.volume, 'runtime.json'), 'utf8')).toBe(
    settings.invalidUid ? '{"uid":"not-a-number","gid":100002}' : '{"uid":100001,"gid":100002}',
  );
  if (!settings.missingData)
    expect(await readFile(path.join(f.volume, 'data.ext4'), 'utf8')).toBe('existing-user-data');
});

it('defers reconstruction to the VM launcher inside an isolated mount namespace', async () => {
  const f = await fixture({ isolatedMountNamespace: true });
  await f.run();
  const calls = await f.calls();
  expect(calls).not.toContain(`netns add trinity-${id}`);
  expect(calls).not.toContain('tuntap add');
  expect(await readFile(path.join(f.volume, 'network.json'), 'utf8')).toBe(metadata);
  expect(await readFile(path.join(f.volume, 'data.ext4'), 'utf8')).toBe('existing-user-data');
});

it('allows the VM launcher to configure egress while its own instance starts', async () => {
  const f = await fixture({
    activeVm: true,
    launcherGeneration: 'deadbeef-337a-4e48-9cc8-9fa200b780b3',
  });
  await f.run();
  const calls = await f.calls();
  expect(calls).toContain(`netns add trinity-${id}`);
  expect(await readFile(path.join(f.volume, 'data.ext4'), 'utf8')).toBe('existing-user-data');
});

it('preserves the operator-recovery path for a namespace that exists without its egress', async () => {
  const f = await fixture({ existingNamespace: true, keepNetworkMetadata: true });
  await expect(f.run()).rejects.toThrow('preserve it for operator recovery');
  const calls = await f.calls();
  expect(calls).not.toContain(`netns add trinity-${id}`);
  expect(await readFile(path.join(f.volume, 'network.json'), 'utf8')).toBe(metadata);
});
