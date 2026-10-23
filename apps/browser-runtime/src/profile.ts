import { chmod, lstat, mkdir, open, readFile, readdir, readlink, unlink, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

export interface BrowserProfilePaths {
  /** Chrome's user-data directory; Chrome creates the `Default` profile inside it. */
  userDataDir: string;
  lockPath: string;
}

export type PidAlive = (pid: number) => boolean;

/** pid liveness on this host; EPERM means alive-but-not-ours, ESRCH means dead. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
}

async function defaultProcessCmdlines(): Promise<string[]> {
  if (process.platform !== 'linux') throw new Error('stale-lock verification requires /proc');
  const entries = await readdir('/proc');
  const cmdlines: string[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      cmdlines.push(await readFile(`/proc/${entry}/cmdline`, 'utf8'));
    } catch {
      // The process vanished or is unreadable mid-scan; it cannot hold the profile.
    }
  }
  return cmdlines;
}

export type ProfileLockState =
  | { readonly state: 'absent' }
  | { readonly state: 'reclaimed' }
  | { readonly state: 'held'; readonly reason: string };

/**
 * Chrome's own `Singleton*` entries normally disappear on a graceful exit.
 * After a SIGKILL or host crash they linger and block the next launch.
 * Reclaim them ONLY when staleness is provable: the lock symlink targets
 * `<hostname>-<pid>` on this host, that pid is dead, and no live process
 * references the profile directory. Anything ambiguous stays held and
 * requires operator recovery (fail closed: two Chromes must never share a
 * profile).
 */
export async function reclaimStaleBrowserProfileLocks(
  userDataDir: string,
  options: {
    isPidAlive?: PidAlive;
    hostname?: string;
    processCmdlines?: () => Promise<string[]>;
  } = {},
): Promise<ProfileLockState> {
  const isPidAlive = options.isPidAlive ?? pidAlive;
  const hostname = options.hostname ?? os.hostname();
  const lockPath = path.join(userDataDir, 'SingletonLock');
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(lockPath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { state: 'absent' };
    throw error;
  }
  // Only the symlink form carries a verifiable `<hostname>-<pid>` owner.
  if (!info.isSymbolicLink())
    return { state: 'held', reason: 'SingletonLock is not a Chrome owner symlink' };
  const target = await readlink(lockPath);
  const match = /^(.*)-(\d+)$/.exec(target);
  if (!match) return { state: 'held', reason: `unrecognized SingletonLock owner '${target}'` };
  const [, ownerHost, ownerPid] = match;
  if (ownerHost !== hostname)
    return { state: 'held', reason: `SingletonLock is owned by host '${ownerHost}'` };
  if (isPidAlive(Number(ownerPid)))
    return { state: 'held', reason: `SingletonLock pid ${ownerPid} is still running` };
  try {
    const cmdlines = await (options.processCmdlines ?? defaultProcessCmdlines)();
    if (cmdlines.some((cmdline) => cmdline.includes(userDataDir)))
      return { state: 'held', reason: 'a live process still references the profile directory' };
  } catch (error) {
    return { state: 'held', reason: `cannot verify profile ownership: ${String(error)}` };
  }
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      await unlink(path.join(userDataDir, name));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
  return { state: 'reclaimed' };
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
 * A crash leaves the lock in place; a lease whose recorded pid is dead on this
 * host is reclaimed once (the Chrome-level Singleton* check in
 * reclaimStaleBrowserProfileLocks separately verifies no browser process still
 * references the profile). A live or foreign lease fails closed so two runtime
 * processes can never manage one profile concurrently.
 */
export async function acquireBrowserProfileLease(
  lockPath: string,
  sessionId: string,
  options: { isPidAlive?: PidAlive; hostname?: string } = {},
): Promise<() => Promise<void>> {
  const isPidAlive = options.isPidAlive ?? pidAlive;
  const hostname = options.hostname ?? os.hostname();
  let handle: FileHandle;
  for (let attempt = 0; ; attempt++) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      if (attempt > 0) throw new Error('Browser profile is already in use or requires operator recovery');
      const stale = await staleLeaseOwner(lockPath, isPidAlive, hostname);
      if (!stale) throw new Error('Browser profile is already in use or requires operator recovery');
      // The recorded owner is dead on this host; only remove the identical file.
      const current = await lstat(lockPath).catch(() => null);
      if (!current || current.isSymbolicLink())
        throw new Error('Browser profile is already in use or requires operator recovery');
      await unlink(lockPath);
    }
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, hostname, sessionId, startedAt: new Date().toISOString() })}\n`,
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

/** A lease is reclaimable only when its recorded owner pid is dead on this host. */
async function staleLeaseOwner(
  lockPath: string,
  isPidAlive: PidAlive,
  hostname: string,
): Promise<boolean> {
  let record: { pid?: unknown; hostname?: unknown };
  try {
    record = JSON.parse(await readFile(lockPath, 'utf8')) as typeof record;
  } catch {
    return false;
  }
  if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0)
    return false;
  // Leases written before hostname tracking are treated as this host's; a
  // recorded foreign hostname is never reclaimed automatically.
  if (record.hostname !== undefined && record.hostname !== hostname) return false;
  return !isPidAlive(record.pid);
}
