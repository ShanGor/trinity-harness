import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { type BrowserRuntimeRequest, type ManagedBrowserSession } from '@trinity-harness/contracts';
import {
  LocalSandbox,
  LocalBlobStore,
  ZendriverMcpConnection,
  ZendriverBrowserDriver,
  ManagedBrowserSupervisor,
  createBrowserTool,
  isCdpSessionOwner,
  ScryptPasswordHasher,
  ZENDRIVER_VERSION,
  authorizeManagedBrowserCommand,
} from '@trinity-harness/core';
import {
  createPool,
  createDb,
  PgBrowserRuntimeStore,
  PgSessionStore,
  PgSessionMetaStore,
  PgUserStore,
} from '@trinity-harness/db';
import { buildBrowserRuntimeServer } from './server.js';
import { loadBrowserRuntimeEnv } from './env.js';
import { acquireBrowserProfileLease, prepareBrowserProfile } from './profile.js';

async function main(): Promise<void> {
  const env = loadBrowserRuntimeEnv();
  const pool = createPool(env.DATABASE_URL, {
    connectionTimeoutMillis: 5000,
    query_timeout: 10_000,
  });
  const lockPool = createPool(env.DATABASE_URL, { connectionTimeoutMillis: 5000 });
  const db = createDb(pool);
  const journal = new PgBrowserRuntimeStore(pool, lockPool);
  const store = new PgSessionStore(db);
  const metas = new PgSessionMetaStore(db);
  const users = new PgUserStore(db, new ScryptPasswordHasher());
  const blobs = new LocalBlobStore(path.join(env.WORKSPACE_ROOT, '.trinity', 'blobs'));
  const probe = await new LocalSandbox(env.WORKSPACE_ROOT, { envMode: 'minimal' }).execArgv(
    env.ZENDRIVER_BINARY,
    ['--version'],
    { maxOutputBytes: 1024, timeoutMs: 5000 },
  );
  if (
    probe.exitCode !== 0 ||
    probe.outputOverflow ||
    probe.stdout.trim() !== `zendriver-mcp ${ZENDRIVER_VERSION}`
  )
    throw new Error('Unsupported Zendriver executable');
  const authorized = (sessionId: string, signal?: AbortSignal): Promise<boolean> =>
    isCdpSessionOwner(
      sessionId,
      metas,
      users,
      { id: env.BROWSER_CDP_OWNER_ID, email: env.ADMIN_EMAIL },
      signal,
    );
  const supervisor = new ManagedBrowserSupervisor({
    store: journal,
    owner: randomUUID(),
    maxSessions: env.BROWSER_RUNTIME_MAX_SESSIONS,
    idleMs: env.BROWSER_RUNTIME_IDLE_MS,
    authorize: (request, signal) =>
      authorizeManagedBrowserCommand(request, store, authorized, signal),
    create: async (
      request: BrowserRuntimeRequest,
      signal: AbortSignal,
    ): Promise<ManagedBrowserSession> => {
      const meta = await metas.get(request.sessionId);
      if (!meta?.workspaceUri) throw new Error('Browser workspace unavailable');
      const root = path.resolve(meta.workspaceUri);
      const relative = path.relative(path.resolve(env.WORKSPACE_ROOT), root);
      if (relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('Browser workspace outside deployment root');
      const sandbox = new LocalSandbox(root, { envMode: 'minimal' });
      const profile = await prepareBrowserProfile(
        env.BROWSER_PROFILE_DIR,
        meta.tenantId,
        meta.userId,
      );
      const releaseProfile = await acquireBrowserProfileLease(profile.lockPath, request.sessionId);
      let connection: ZendriverMcpConnection | undefined;
      let driver: ZendriverBrowserDriver | undefined;
      let disposing: Promise<void> | undefined;
      const dispose = async (): Promise<void> => {
        disposing ??= (async () => {
          try {
            await connection?.dispose();
          } finally {
            await releaseProfile();
          }
        })();
        await disposing;
      };
      const generation = randomUUID();
      try {
        const process = sandbox.openProcess(
          env.ZENDRIVER_BINARY,
          ['--log', 'off', '--user-data-dir', profile.userDataDir],
          { processGroup: true },
        );
        connection = new ZendriverMcpConnection(process);
        const opener = new ZendriverBrowserDriver(
          connection,
          request.sessionId,
          generation,
          authorized,
        );
        driver = opener;
        await connection.initialize(signal);
        await opener.open(signal, env.ZENDRIVER_CHROME_VERSION);
        await store.append(request.sessionId, [
          {
            type: 'browser/runtime_bound',
            eventId: randomUUID(),
            at: new Date().toISOString(),
            generation,
            engine: 'zendriver',
            upstreamVersion: ZENDRIVER_VERSION,
            securityMode: 'trusted-managed',
          },
        ]);
      } catch (err) {
        await dispose();
        throw err;
      }
      const activeDriver = driver;
      if (!activeDriver) {
        await dispose();
        throw new Error('Zendriver browser driver was not initialized');
      }
      const tool = createBrowserTool({
        store,
        blobs,
        now: () => new Date(),
        driver: activeDriver,
        access: activeDriver,
      });
      return {
        generation,
        execute: (command, active) =>
          tool.execute(command.args, {
            sessionId: command.sessionId,
            callId: command.callId,
            permissionGranted: command.permissionGranted,
            sandbox,
            workspaceRoot: root,
            signal: active,
          }),
        dispose,
      };
    },
  });
  const app = buildBrowserRuntimeServer(supervisor, env.BROWSER_RUNTIME_TOKEN);
  const notifications = await pool.connect();
  let shuttingDown = false;
  notifications.on('notification', (message) => {
    if (message.channel === 'trinity_session_closed' && z.uuid().safeParse(message.payload).success)
      void supervisor.close(message.payload!).catch(() => supervisor.dispose());
  });
  notifications.on('error', () => {
    void shutdown();
  });
  await notifications.query('LISTEN trinity_session_closed');
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    await supervisor.dispose();
    await app.close();
    notifications.release(true);
    await pool.end();
    await lockPool.end();
  }
  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
  await app.listen({ host: env.BROWSER_RUNTIME_HOST, port: env.BROWSER_RUNTIME_PORT });
}

void main().catch(() => {
  console.error('Browser runtime startup failed');
  process.exit(1);
});
