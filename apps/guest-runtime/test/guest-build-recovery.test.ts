import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalSandbox } from '@trinity-harness/core';

const helper = fileURLToPath(
  new URL('../../../scripts/firecracker-guest-recovery.sh', import.meta.url),
);
const imageCheck = fileURLToPath(
  new URL('../../../scripts/firecracker-image-check.sh', import.meta.url),
);
let root: string;
let base: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'trinity-build-recovery-'));
  base = path.join(root, 'firecracker-guest');
  await mkdir(path.join(base, 'rootfs/debootstrap'), { recursive: true });
  await writeFile(
    path.join(base, '.trinity-development-guest'),
    'TRINITY DEVELOPMENT GUEST; HOST KERNEL; NOT PRODUCTION VALIDATED\n',
  );
  await writeFile(path.join(base, 'rootfs/debootstrap/debootstrap.log'), 'original failure');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const recover = (env?: Record<string, string>) =>
  new LocalSandbox(root).execArgv(
    '/bin/bash',
    ['-euc', 'source "$1"; preserve_incomplete_guest "$2"', 'recovery', helper, base],
    { maxOutputBytes: 4096, ...(env ? { env } : {}) },
  );

it('preserves the incomplete build and its original log without deleting anything', async () => {
  expect((await recover()).exitCode).toBe(0);
  const [archived] = await readdir(root);
  expect(archived).toMatch(/^firecracker-guest.failed-/);
  expect(
    await readFile(path.join(root, archived!, 'rootfs/debootstrap/debootstrap.log'), 'utf8'),
  ).toBe('original failure');
});
it('preserves existing unverified images by archiving the whole build', async () => {
  await mkdir(path.join(base, 'images'));
  await writeFile(path.join(base, 'images/data.ext4'), 'existing data');
  expect((await recover()).exitCode).toBe(0);
  const archived = (await readdir(root)).find((entry) =>
    entry.startsWith('firecracker-guest.failed-'),
  )!;
  expect(await readFile(path.join(root, archived, 'images/data.ext4'), 'utf8')).toBe(
    'existing data',
  );
});

it('archives a complete checksum-verified development image before rebuilding it', async () => {
  await mkdir(path.join(base, 'images'));
  await writeFile(path.join(base, 'images/vmlinux'), 'kernel');
  await writeFile(path.join(base, 'images/rootfs.ext4'), 'rootfs');
  await writeFile(path.join(base, 'images/data.ext4'), 'data');
  const checksum = await new LocalSandbox(root).execArgv(
    '/usr/bin/sha256sum',
    [
      path.join(base, 'images/vmlinux'),
      path.join(base, 'images/rootfs.ext4'),
      path.join(base, 'images/data.ext4'),
    ],
    { maxOutputBytes: 4096 },
  );
  expect(checksum.exitCode).toBe(0);
  await writeFile(
    path.join(base, 'images/SHA256SUMS'),
    checksum.stdout.replaceAll(`${base}/images/`, ''),
  );
  expect((await recover()).exitCode).toBe(0);
  const archived = (await readdir(root)).find((entry) =>
    entry.startsWith('firecracker-guest.failed-'),
  )!;
  expect(await readFile(path.join(root, archived, 'images/data.ext4'), 'utf8')).toBe('data');
});
it('rejects an unrecognized marker', async () => {
  await writeFile(path.join(base, '.trinity-development-guest'), 'unrecognized');
  expect((await recover()).exitCode).not.toBe(0);
});
it('rejects a symlink build path', async () => {
  const target = base;
  base = path.join(root, 'alias');
  await symlink(target, base);
  expect((await recover()).exitCode).not.toBe(0);
});
it.each(['mounted', 'unverifiable'])(
  'rejects %s filesystems before moving the build',
  async (state) => {
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await writeFile(
      path.join(bin, 'findmnt'),
      state === 'mounted'
        ? '#!/bin/sh\nprintf "%s\\n" "$BUILD_MOUNT/proc"\n'
        : '#!/bin/sh\nexit 1\n',
      { mode: 0o755 },
    );
    expect((await recover({ PATH: `${bin}:/usr/bin:/bin`, BUILD_MOUNT: base })).exitCode).not.toBe(
      0,
    );
    expect(await readFile(path.join(base, 'rootfs/debootstrap/debootstrap.log'), 'utf8')).toBe(
      'original failure',
    );
  },
);

describe('guest image checksum verification', () => {
  let images: string;
  beforeEach(async () => {
    images = path.join(root, 'images');
    await mkdir(images);
    await writeFile(path.join(images, 'vmlinux'), 'kernel');
    await writeFile(path.join(images, 'rootfs.ext4'), 'immutable rootfs');
    await writeFile(path.join(images, 'data.ext4'), 'initial mutable data');
    const sums = await new LocalSandbox(root).execArgv(
      '/usr/bin/sha256sum',
      ['vmlinux', 'rootfs.ext4', 'data.ext4'],
      { cwd: 'images', maxOutputBytes: 4096 },
    );
    expect(sums.exitCode).toBe(0);
    await writeFile(path.join(images, 'SHA256SUMS'), sums.stdout);
  });

  it('checks the kernel and rootfs while allowing the guest to change its data disk', async () => {
    await writeFile(path.join(images, 'data.ext4'), 'guest wrote persistent files');
    const result = await new LocalSandbox(root).execArgv(
      '/bin/bash',
      [
        '-euc',
        'source "$1"; verify_firecracker_guest_images "$2"',
        'image-check',
        imageCheck,
        images,
      ],
      { maxOutputBytes: 4096 },
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain('vmlinux: OK');
    expect(result.stdout).toContain('rootfs.ext4: OK');
  });

  it('rejects a changed kernel or rootfs', async () => {
    await writeFile(path.join(images, 'rootfs.ext4'), 'modified rootfs');
    const result = await new LocalSandbox(root).execArgv(
      '/bin/bash',
      [
        '-euc',
        'source "$1"; verify_firecracker_guest_images "$2"',
        'image-check',
        imageCheck,
        images,
      ],
      { maxOutputBytes: 4096 },
    );
    expect(result.exitCode).not.toBe(0);
  });
});
