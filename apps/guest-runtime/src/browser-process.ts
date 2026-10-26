import type { LongRunningProcess, SandboxPort } from '@trinity-harness/contracts';
import {
  prepareBrowserProfile,
  reclaimStaleBrowserProfileLocks,
  acquireBrowserProfileLease,
  ZENDRIVER_VERSION,
} from '@trinity-harness/core';

/** Operator-owned executable and authenticated boot identity select the durable profile. */
export async function openGuestBrowser(
  sandbox: SandboxPort,
  config: { binary: string; profileRoot: string; tenantId: string; userId: string },
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
    const child = sandbox.openProcess(
      config.binary,
      ['--log', 'off', '--user-data-dir', profile.userDataDir],
      {
        processGroup: true,
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
