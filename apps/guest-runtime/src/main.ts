import { readFile, mkdir, lstat, chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { LocalSandbox, FileSkillCatalog } from '@trinity-harness/core';
import { guestEnvelopeSchema, skillDirectoriesEnvSchema } from '@trinity-harness/contracts';
import { GuestRuntime } from './runtime.js';
import { openGuestBrowser } from './browser-process.js';
import { buildGuestServer } from './server.js';

async function main(): Promise<void> {
  const cmdline = await readFile('/proc/cmdline', 'utf8');
  const environmentId = z.uuid().parse(cmdline.match(/(?:^|\s)trinity.environment=(\S+)/)?.[1]);
  const generation = z.uuid().parse(cmdline.match(/(?:^|\s)trinity.generation=(\S+)/)?.[1]);
  const tenantId = z.uuid().parse(cmdline.match(/(?:^|\s)trinity.tenant=(\S+)/)?.[1]);
  const userId = z.uuid().parse(cmdline.match(/(?:^|\s)trinity.user=(\S+)/)?.[1]);
  const binary = z.string().refine(path.isAbsolute).parse(process.env['ZENDRIVER_BINARY']);
  const profileRoot = z.string().refine(path.isAbsolute).parse(process.env['BROWSER_PROFILE_DIR']);
  const proxy = z
    .url()
    .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
    .optional()
    .parse(process.env['BROWSER_PROXY_URL']);
  const workspaceRoot = z.string().refine(path.isAbsolute).parse(process.env['WORKSPACE_ROOT']);
  const rootFor = (workspace: string): string =>
    path.join(workspaceRoot, guestEnvelopeSchema.shape.workspace.parse(workspace));
  const runtime = new GuestRuntime(
    environmentId,
    generation,
    async (workspace) => {
      let current = workspaceRoot;
      const root = await lstat(current);
      if (!root.isDirectory() || root.isSymbolicLink())
        throw new Error('Guest data mount is unavailable');
      for (const segment of guestEnvelopeSchema.shape.workspace.parse(workspace).split('/')) {
        current = path.join(current, segment);
        await mkdir(current, { mode: 0o700 }).catch((error: unknown) => {
          if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
        });
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error('Guest workspace path is unsafe');
      }
      return new LocalSandbox(rootFor(workspace), { envMode: 'minimal' });
    },
    new FileSkillCatalog({
      bundledDirectories: [fileURLToPath(new URL('../../../skills/', import.meta.url))],
      configuredDirectories: skillDirectoriesEnvSchema
        .parse(process.env['SKILL_DIRS'])
        .map((directory) => path.resolve(directory)),
    }),
    rootFor,
    120_000,
    (sessionId, signal) =>
      openGuestBrowser(
        new LocalSandbox(workspaceRoot, { envMode: 'minimal' }),
        { binary, profileRoot, tenantId, userId, ...(proxy ? { proxy } : {}) },
        sessionId,
        signal,
      ),
  );
  const app = buildGuestServer(runtime);
  await app.listen({ path: '/run/trinity-guest/rpc.sock' });
  await chmod('/run/trinity-guest/rpc.sock', 0o600);
  console.info('TRINITY_GUEST_RPC_READY');
  let closing: Promise<void> | undefined;
  const shutdown = (): void => {
    closing ??= (async () => {
      try {
        await runtime.dispose();
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
  console.error('Guest runtime startup failed');
  process.exitCode = 1;
});
