import { readFile, chmod, chown } from 'node:fs/promises';
import { z } from 'zod';
import { LocalSandbox } from '@trinity-harness/core';
import type { LongRunningProcess, SkillCatalogPort } from '@trinity-harness/contracts';
import { GuestRuntime } from './runtime.js';
import { BrowserGuestRuntime } from './browser-runtime.js';
import { GuestDesktop } from './desktop.js';
import { openGuestBrowser } from './browser-process.js';
import { buildGuestServer } from './server.js';

async function main(): Promise<void> {
  if (process.getuid?.() !== 1001) throw new Error('Browser service must use its isolated UID');
  await chown('/run/trinity-browser', 1001, 1002);
  await chmod('/run/trinity-browser', 0o710);
  const cmdline = await readFile('/proc/cmdline', 'utf8');
  const value = (key: string): string =>
    z.uuid().parse(cmdline.match(new RegExp(`(?:^|\\s)trinity\\.${key}=(\\S+)`))?.[1]);
  const environmentId = value('environment');
  const generation = value('generation');
  const tenantId = value('tenant');
  const userId = value('user');
  const sandbox = new LocalSandbox('/run/trinity-browser', { envMode: 'minimal' });
  // Browser-only requests are filtered before reaching this process runtime.
  const skills: SkillCatalogPort = {
    list: async () => {
      throw new Error('Browser endpoint does not expose skills');
    },
    load: async () => {
      throw new Error('Browser endpoint does not expose skills');
    },
    readResource: async () => {
      throw new Error('Browser endpoint does not expose skills');
    },
  };
  const processes: GuestRuntime = new GuestRuntime(
    environmentId,
    generation,
    async () => sandbox,
    skills,
    () => '/run/trinity-browser',
    120_000,
    (sessionId, signal): Promise<LongRunningProcess> => browser.openProcess(sessionId, signal),
  );
  const browser: BrowserGuestRuntime = new BrowserGuestRuntime(
    environmentId,
    generation,
    processes,
    (signal) =>
      GuestDesktop.launch(
        sandbox,
        {
          runtimeDirectory: '/run/trinity-browser',
          xvfb: '/usr/bin/Xvfb',
          x11vnc: '/usr/bin/x11vnc',
          windowManager: '/usr/bin/openbox',
          xdotool: '/usr/bin/xdotool',
          xwd: '/usr/bin/xwd',
          xclip: '/usr/bin/xclip',
          chromeGid: 1002,
        },
        signal,
      ),
    (sessionId, env, signal) =>
      openGuestBrowser(
        sandbox,
        {
          binary: '/usr/local/bin/zendriver-mcp',
          profileRoot: '/var/lib/trinity/browser',
          tenantId,
          userId,
          env: { ...env, CHROME_BIN: '/usr/local/libexec/trinity-private-chrome' },
          chromeUid: 1002,
        },
        sessionId,
        signal,
      ),
  );
  const app = buildGuestServer(browser);
  await app.listen({ path: '/run/trinity-browser/rpc.sock' });
  await chmod('/run/trinity-browser/rpc.sock', 0o600);
  console.info('TRINITY_GUEST_BROWSER_RPC_READY');
  let closing: Promise<void> | undefined;
  const shutdown = (): void => {
    closing ??= (async () => {
      try {
        await browser.dispose();
      } finally {
        await app.close();
      }
    })();
    void closing.catch(() => {
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
void main().catch(() => {
  console.error('Guest browser runtime startup failed');
  process.exitCode = 1;
});
