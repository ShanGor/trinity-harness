import { lstat, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import {
  acquireBrowserProfileLease,
  prepareBrowserProfile,
  reclaimStaleBrowserProfileLocks,
} from '../src/profile.js';

it('uses tenant/user paths and preserves the Chrome profile after releasing its lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trinity-browser-profile-'));
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const sessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  try {
    const profile = await prepareBrowserProfile(root, tenantId, userId);
    expect(profile.userDataDir).toBe(path.join(root, tenantId, userId));
    expect(profile.lockPath).toBe(path.join(root, '.locks', `${tenantId}-${userId}.lock`));

    const defaultProfile = path.join(profile.userDataDir, 'Default');
    await mkdir(defaultProfile);
    const release = await acquireBrowserProfileLease(profile.lockPath, sessionId);
    await expect(acquireBrowserProfileLease(profile.lockPath, sessionId)).rejects.toThrow(
      'already in use',
    );
    const lock = JSON.parse(await readFile(profile.lockPath, 'utf8')) as {
      sessionId: string;
    };
    expect(lock.sessionId).toBe(sessionId);
    await release();

    const nextRelease = await acquireBrowserProfileLease(profile.lockPath, sessionId);
    await nextRelease();
    expect((await stat(defaultProfile)).isDirectory()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects path-like identity components and symlinked tenant directories', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trinity-browser-profile-'));
  const external = await mkdtemp(path.join(os.tmpdir(), 'trinity-browser-profile-target-'));
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  try {
    await expect(prepareBrowserProfile(root, '../outside', tenantId)).rejects.toThrow();
    await symlink(external, path.join(root, tenantId));
    await expect(prepareBrowserProfile(root, tenantId, tenantId)).rejects.toThrow(
      'non-directory path',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const noCmdlines = async () => [];

it('reclaims Chrome singleton locks only when the previous owner is provably gone', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trinity-browser-profile-'));
  try {
    const profile = await prepareBrowserProfile(root, tenantId, userId);
    expect(
      (await reclaimStaleBrowserProfileLocks(profile.userDataDir)).state,
    ).toBe('absent');

    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie'])
      await symlink(`testhost-424242`, path.join(profile.userDataDir, name));
    const reclaimed = await reclaimStaleBrowserProfileLocks(profile.userDataDir, {
      isPidAlive: () => false,
      hostname: 'testhost',
      processCmdlines: noCmdlines,
    });
    expect(reclaimed.state).toBe('reclaimed');
    await expect(stat(path.join(profile.userDataDir, 'SingletonLock'))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ['live owner pid', { isPidAlive: () => true, hostname: 'testhost' }, 'testhost-424242'],
  ['foreign owner host', { isPidAlive: () => false, hostname: 'other-host' }, 'testhost-424242'],
  ['unrecognized owner', { isPidAlive: () => false, hostname: 'testhost' }, 'not-a-pid-target'],
])('keeps %s held (fail closed)', async (_label, options, target) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trinity-browser-profile-'));
  try {
    const profile = await prepareBrowserProfile(root, tenantId, userId);
    await symlink(target, path.join(profile.userDataDir, 'SingletonLock'));
    const locks = await reclaimStaleBrowserProfileLocks(profile.userDataDir, {
      ...options,
      processCmdlines: noCmdlines,
    });
    expect(locks.state).toBe('held');
    await expect(lstat(path.join(profile.userDataDir, 'SingletonLock'))).resolves.toBeDefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps the profile held while any live process references it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trinity-browser-profile-'));
  try {
    const profile = await prepareBrowserProfile(root, tenantId, userId);
    await symlink('testhost-424242', path.join(profile.userDataDir, 'SingletonLock'));
    const locks = await reclaimStaleBrowserProfileLocks(profile.userDataDir, {
      isPidAlive: () => false,
      hostname: 'testhost',
      processCmdlines: async () => [`chrome\0--user-data-dir=${profile.userDataDir}\0`],
    });
    expect(locks.state).toBe('held');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('refuses to reclaim a non-symlink SingletonLock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trinity-browser-profile-'));
  try {
    const profile = await prepareBrowserProfile(root, tenantId, userId);
    await writeFile(path.join(profile.userDataDir, 'SingletonLock'), 'opaque');
    const locks = await reclaimStaleBrowserProfileLocks(profile.userDataDir, {
      isPidAlive: () => false,
      hostname: 'testhost',
      processCmdlines: noCmdlines,
    });
    expect(locks.state).toBe('held');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('reclaims a lease left by a dead runtime process and refuses live or foreign owners', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'trinity-browser-profile-'));
  try {
    const profile = await prepareBrowserProfile(root, tenantId, userId);

    // Dead pid, no hostname (legacy format written before hostname tracking).
    await writeFile(
      profile.lockPath,
      `${JSON.stringify({ pid: 424242, sessionId: 'legacy', startedAt: new Date(0).toISOString() })}\n`,
    );
    const release = await acquireBrowserProfileLease(profile.lockPath, 'session-1', {
      isPidAlive: () => false,
      hostname: 'testhost',
    });
    const lease = JSON.parse(await readFile(profile.lockPath, 'utf8')) as { hostname: string };
    expect(lease.hostname).toBe('testhost');
    await release();

    // Live pid: fail closed.
    await writeFile(
      profile.lockPath,
      `${JSON.stringify({ pid: 424242, hostname: 'testhost', sessionId: 'other', startedAt: new Date(0).toISOString() })}\n`,
    );
    await expect(
      acquireBrowserProfileLease(profile.lockPath, 'session-2', {
        isPidAlive: () => true,
        hostname: 'testhost',
      }),
    ).rejects.toThrow('already in use');

    // Foreign hostname: fail closed even with a dead pid.
    await writeFile(
      profile.lockPath,
      `${JSON.stringify({ pid: 424242, hostname: 'other-host', sessionId: 'other', startedAt: new Date(0).toISOString() })}\n`,
    );
    await expect(
      acquireBrowserProfileLease(profile.lockPath, 'session-3', {
        isPidAlive: () => false,
        hostname: 'testhost',
      }),
    ).rejects.toThrow('already in use');

    // Unparseable content: fail closed.
    await writeFile(profile.lockPath, 'garbage');
    await expect(
      acquireBrowserProfileLease(profile.lockPath, 'session-4', {
        isPidAlive: () => false,
        hostname: 'testhost',
      }),
    ).rejects.toThrow('already in use');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
