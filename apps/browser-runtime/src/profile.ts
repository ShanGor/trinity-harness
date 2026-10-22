import { chmod, lstat, mkdir, open, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export interface BrowserProfilePaths {
  /** Chrome's user-data directory; Chrome creates the `Default` profile inside it. */
  userDataDir: string;
  lockPath: string;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
}

async function ensurePrivateDirectory(directory: string, recursive = false): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700, recursive });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Browser profile storage contains a non-directory path');
  await chmod(directory, 0o700);
}

export async function prepareBrowserProfile(
  root: string,
  tenantId: string,
  userId: string,
): Promise<BrowserProfilePaths> {
  tenantId = z.uuid().parse(tenantId);
  userId = z.uuid().parse(userId);
  const absoluteRoot = path.resolve(root);
  await ensurePrivateDirectory(absoluteRoot, true);

  const tenantDirectory = path.join(absoluteRoot, tenantId);
  await ensurePrivateDirectory(tenantDirectory);
  const userDataDir = path.join(tenantDirectory, userId);
  await ensurePrivateDirectory(userDataDir);

  const lockDirectory = path.join(absoluteRoot, '.locks');
  await ensurePrivateDirectory(lockDirectory);
  return {
    userDataDir,
    lockPath: path.join(lockDirectory, `${tenantId}-${userId}.lock`),
  };
}

/**
 * Atomically leases a profile across runtime processes sharing the profile volume.
 * A crash leaves the lock in place so an operator can verify Chrome has stopped
 * before clearing it; automatic stale-lock reclamation could corrupt cookies.
 */
export async function acquireBrowserProfileLease(
  lockPath: string,
  sessionId: string,
): Promise<() => Promise<void>> {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (errorCode(error) === 'EEXIST')
      throw new Error('Browser profile is already in use or requires operator recovery');
    throw error;
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, sessionId, startedAt: new Date().toISOString() })}\n`,
    );
    await handle.sync();
    const identity = await handle.stat();
    let released = false;
    return async (): Promise<void> => {
      if (released) return;
      released = true;
      let current: Awaited<ReturnType<typeof lstat>> | null;
      try {
        current = await lstat(lockPath);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          await handle.close();
          throw error;
        }
        current = null;
      }
      await handle.close();
      if (!current) return;
      if (current.dev !== identity.dev || current.ino !== identity.ino)
        throw new Error('Browser profile lock was replaced; refusing to remove it');
      await unlink(lockPath);
    };
  } catch (error) {
    const identity = await handle.stat().catch(() => null);
    await handle.close();
    if (identity) {
      const current = await lstat(lockPath).catch(() => null);
      if (current?.dev === identity.dev && current.ino === identity.ino)
        await unlink(lockPath).catch(() => undefined);
    }
    throw error;
  }
}
