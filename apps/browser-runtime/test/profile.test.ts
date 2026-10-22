import { mkdtemp, mkdir, readFile, rm, stat, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { acquireBrowserProfileLease, prepareBrowserProfile } from '../src/profile.js';

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
