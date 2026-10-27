import type { LongRunningProcess, SandboxPort } from '@trinity-harness/contracts';
import { chmod } from 'node:fs/promises';
import path from 'node:path';
import {
  prepareBrowserProfile,
  reclaimStaleBrowserProfileLocks,
  acquireBrowserProfileLease,
  ZENDRIVER_VERSION,
} from '@trinity-harness/core';

/** Operator-owned executable and authenticated boot identity select the durable profile. */
export async function openGuestBrowser(
  sandbox: SandboxPort,
  config: {
    binary: string;
    profileRoot: string;
    tenantId: string;
    userId: string;
    /** Operator-selected display settings; never supplied in a guest request. */
    env?: Record<string, string>;
    /** Separate Chrome UID selected by the guest image, not by a request. */
    chromeUid?: number;
  },
  sessionId: string,
  signal: AbortSignal,
): Promise<LongRunningProcess> {
  if (!sandbox.execArgv) throw new Error('Guest bounded process launch unavailable');
  const probe = await sandbox.execArgv(config.binary, ['--version'], {
    maxOutputBytes: 1024,
    timeoutMs: 5000,
    signal,
  });
  if (
    probe.exitCode !== 0 ||
    probe.outputOverflow ||
    probe.stdout.trim() !== `zendriver-mcp ${ZENDRIVER_VERSION}`
  )
    throw new Error('Unsupported guest Zendriver');
  const profile = await prepareBrowserProfile(config.profileRoot, config.tenantId, config.userId);
  const locks = await reclaimStaleBrowserProfileLocks(profile.userDataDir);
  if (locks.state === 'held') throw new Error('Guest browser profile requires recovery');
  const release = await acquireBrowserProfileLease(profile.lockPath, sessionId);
  try {
    if (config.chromeUid !== undefined) {
      if (config.chromeUid !== 1002) throw new Error('Unsupported guest Chrome identity');
      const links = await sandbox.execArgv(
        '/usr/bin/find',
        ['-P', profile.userDataDir, '-xdev', '-type', 'f', '-links', '+1', '-print', '-quit'],
        { signal, timeoutMs: 30_000, maxOutputBytes: 4096 },
      );
      if (links.exitCode !== 0 || links.outputOverflow || links.stdout.length)
        throw new Error('Browser profile ownership requires recovery');
      const ownership = await sandbox.execArgv(
        '/usr/bin/find',
        [
          '-P',
          profile.userDataDir,
          '-xdev',
          '-exec',
          '/usr/bin/chown',
          '-h',
          '1002:1002',
          '--',
          '{}',
          '+',
        ],
        { signal, timeoutMs: 30_000, maxOutputBytes: 4096 },
      );
      if (ownership.exitCode !== 0 || ownership.outputOverflow)
        throw new Error('Browser profile ownership could not be assigned');
      // Chrome can traverse its fixed profile path; only its private user-data
      // directory is readable by the separate Chrome UID.
      await chmod(config.profileRoot, 0o711);
      await chmod(path.dirname(profile.userDataDir), 0o711);
    }
    const child = sandbox.openProcess(
      config.binary,
      ['--log', 'off', '--user-data-dir', profile.userDataDir],
      {
        processGroup: true,
        ...(config.env ? { env: config.env } : {}),
      },
    );
    return {
      write: (data) => child.write(data),
      chunks: () => child.chunks(),
      kill: () => child.kill(),
      exited: child.exited.finally(release),
    };
  } catch (error) {
    await release();
    throw error;
  }
}
