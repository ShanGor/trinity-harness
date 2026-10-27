import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  type BrowserHumanCapture,
  type BrowserRuntimeRequest,
  type ManagedBrowserSession,
} from '@trinity-harness/contracts';
import {
  LocalSandbox,
  LocalBlobStore,
  ZendriverMcpConnection,
  ZendriverOperationGate,
  ZendriverBrowserDriver,
  ManagedBrowserSupervisor,
  createBrowserTool,
  isCdpSessionOwner,
  ScryptPasswordHasher,
  ZENDRIVER_VERSION,
  authorizeManagedBrowserCommand,
  captureBrowserPreview,
  RemoteSandbox,
  FirecrackerGuestRouter,
  EnvironmentController,
  HttpNodeRuntime,
  validateGuestDeployment,
  PersonalBrowserSessionScope,
  browserRuntimeFailure,
} from '@trinity-harness/core';
import {
  createPool,
  createDb,
  PgBrowserRuntimeStore,
  PgBrowserInteractionStore,
  PgSessionStore,
  PgSessionMetaStore,
  PgUserStore,
  PgEnvironmentStore,
} from '@trinity-harness/db';
import { buildBrowserRuntimeServer } from './server.js';
import { loadBrowserRuntimeEnv } from './env.js';
import { startTelemetry } from '@trinity-harness/otel';
import {
  acquireBrowserProfileLease,
  prepareBrowserProfile,
  reclaimStaleBrowserProfileLocks,
} from './profile.js';

async function main(): Promise<void> {
  const env = loadBrowserRuntimeEnv();
  validateGuestDeployment({ ...env, BROWSER_DRIVER: 'zendriver' }, true);
  const telemetry = startTelemetry({ serviceName: 'trinity-browser-runtime' });
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
  const browserScope = new PersonalBrowserSessionScope(metas);
  const blobs = new LocalBlobStore(path.join(env.WORKSPACE_ROOT, '.trinity', 'blobs'));
  if (env.EXECUTION_DRIVER !== 'firecracker') {
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
  }
  const environmentStore = new PgEnvironmentStore(db, lockPool);
  const guestRouter =
    env.EXECUTION_DRIVER === 'firecracker'
      ? new FirecrackerGuestRouter(
          new EnvironmentController(
            environmentStore,
            env.FIRECRACKER_NODES,
            new Map(
              env.FIRECRACKER_NODES.map((node) => [
                node.id,
                new HttpNodeRuntime(node.endpoint, env.NODE_RUNTIME_TOKEN!),
              ]),
            ),
          ),
          environmentStore,
          metas,
          users,
          env.FIRECRACKER_NODES,
          env.NODE_RUNTIME_TOKEN!,
          env.WORKSPACE_ROOT,
        )
      : undefined;
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
    scope: browserScope,
    interactionStore: new PgBrowserInteractionStore(pool),
    events: {
      append: async (sessionId, events) => {
        const meta = await metas.get(sessionId);
        if (!meta) throw new Error('Browser owner unavailable');
        return store.append(
          sessionId,
          events.map((event) => ({ ...event, actor: meta.userId })),
        );
      },
    },
    owner: randomUUID(),
    maxSessions: env.BROWSER_RUNTIME_MAX_SESSIONS,
    idleMs: env.BROWSER_RUNTIME_IDLE_MS,
    authorize: (request, signal) =>
      authorizeManagedBrowserCommand(request, store, authorized, signal),
    authorizePreview: authorized,
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
      const browserGuest = env.GUEST_DESKTOP_ENABLED ? guestRouter?.browser() : undefined;
      const sandbox = guestRouter
        ? new RemoteSandbox(browserGuest ?? guestRouter, request.sessionId)
        : new LocalSandbox(root, { envMode: 'minimal' });
      let releaseProfile: () => Promise<void> = async () => {};
      let profile: Awaited<ReturnType<typeof prepareBrowserProfile>> | undefined;
      if (!guestRouter) {
        profile = await prepareBrowserProfile(env.BROWSER_PROFILE_DIR!, meta.tenantId, meta.userId);
        // Chrome's own Singleton* entries survive a SIGKILL/crash; reclaim them
        // only when the previous owner is provably gone (dead pid, no live
        // process referencing the profile). Anything ambiguous fails closed here.
        const locks = await reclaimStaleBrowserProfileLocks(profile.userDataDir);
        if (locks.state === 'held')
          throw new Error(
            `Browser profile is in use or requires operator recovery (${locks.reason})`,
          );
        releaseProfile = await acquireBrowserProfileLease(profile.lockPath, request.sessionId);
      }
      let connection: ZendriverMcpConnection | undefined;
      let driver: ZendriverBrowserDriver | undefined;
      let agentGate: ZendriverOperationGate | undefined;
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
        const process =
          sandbox instanceof RemoteSandbox
            ? sandbox.openBrowser(signal)
            : sandbox.openProcess(
                env.ZENDRIVER_BINARY,
                ['--log', 'off', '--user-data-dir', profile!.userDataDir],
                {
                  processGroup: true,
                  // Explicit operator-configured egress only; the sandbox env is
                  // scrubbed, so managed Chrome sees no proxy unless configured.
                  ...(env.SANDBOX_PROXY_URL
                    ? {
                        env: {
                          http_proxy: env.SANDBOX_PROXY_URL,
                          https_proxy: env.SANDBOX_PROXY_URL,
                          no_proxy: env.BROWSER_NO_PROXY,
                        },
                      }
                    : {}),
                },
              );
        connection = new ZendriverMcpConnection(process, browserGuest ? 100_000 : 30_000);
        const opener = new ZendriverBrowserDriver(
          connection,
          request.sessionId,
          generation,
          authorized,
        );
        driver = opener;
        await connection.initialize(signal);
        await opener.open(signal, env.ZENDRIVER_CHROME_VERSION, !browserGuest);
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
      const desktopFrame = browserGuest
        ? async (active: AbortSignal): Promise<BrowserHumanCapture> => {
            const capturedAt = new Date().toISOString();
            const desktop = await browserGuest.call(
              request.sessionId,
              { kind: 'desktopFrame' },
              active,
            );
            if (desktop.kind !== 'desktopFrame') throw new Error('Unexpected desktop response');
            return {
              surface: 'desktop',
              preview: {
                state: 'frame',
                generation,
                capturedAt,
                securityMode: 'trusted-managed',
                width: desktop.width,
                height: desktop.height,
                png: desktop.png,
              },
              target: {
                tabId: 'desktop',
                documentRevision: generation,
                fingerprint: randomBytes(32).toString('hex'),
                width: desktop.width,
                height: desktop.height,
                capturedAt,
                ...(desktop.focusRevision ? { focusRevision: desktop.focusRevision } : {}),
              },
            };
          }
        : undefined;
      return {
        generation,
        ...(browserGuest
          ? {
              fenceAgent: (): boolean => {
                if (!agentGate) return false;
                agentGate.fence();
                return true;
              },
            }
          : {}),
        ...(desktopFrame
          ? { readOnlyFrame: async (active: AbortSignal) => (await desktopFrame(active)).preview }
          : {}),
        humanFrame: async (privateView, active) => {
          if (desktopFrame) {
            if (!privateView) return { preview: { state: 'privacy_blocked' } };
            return desktopFrame(active);
          }
          return activeDriver.humanFrame(privateView, {
            sessionId: request.sessionId,
            callId: `human-frame-${randomUUID()}`,
            sandbox,
            workspaceRoot: root,
            signal: active,
          });
        },
        ...(browserGuest
          ? {
              humanHandoff: async () => ({
                preview: { state: 'unavailable' as const },
                handoff: 'navigation_only' as const,
              }),
            }
          : {}),
        humanInput: async (action, target, active) => {
          if (browserGuest && 'frameId' in target && target.tabId === 'desktop') {
            if (!['click', 'drag', 'scroll', 'key', 'text'].includes(action.type))
              return { effect: 'none' };
            const result = await browserGuest.call(
              request.sessionId,
              {
                kind: 'desktopInput',
                action,
                target: {
                  width: target.width,
                  height: target.height,
                  ...(target.focusRevision ? { focusRevision: target.focusRevision } : {}),
                },
              },
              active,
            );
            if (result.kind !== 'desktopInput')
              throw new Error('Unexpected desktop input response');
            return { effect: result.effect };
          }
          if (browserGuest) return { effect: 'none' };
          return activeDriver.humanInput(action, target, {
            sessionId: request.sessionId,
            callId: `human-input-${randomUUID()}`,
            sandbox,
            workspaceRoot: root,
            signal: active,
          });
        },
        preview: (active) =>
          browserGuest
            ? Promise.resolve({ state: 'privacy_blocked' as const })
            : captureBrowserPreview(
                activeDriver,
                activeDriver,
                {
                  sessionId: request.sessionId,
                  callId: `preview-${randomUUID()}`,
                  sandbox,
                  workspaceRoot: root,
                  signal: active,
                },
                generation,
                () => new Date(),
              ),
        execute: async (command, active) => {
          if (
            !(await authorized(command.sessionId, active)) ||
            (await browserScope.resolve(command.sessionId, active)) !== request.sessionId
          )
            return browserRuntimeFailure(command, 'NOT_AUTHORIZED');
          const source = await metas.get(command.sessionId);
          if (!source?.workspaceUri) return browserRuntimeFailure(command, 'NOT_AUTHORIZED');
          const sourceRoot = path.resolve(source.workspaceUri);
          const relativeSource = path.relative(path.resolve(env.WORKSPACE_ROOT), sourceRoot);
          if (relativeSource.startsWith('..') || path.isAbsolute(relativeSource))
            return browserRuntimeFailure(command, 'NOT_AUTHORIZED');
          const gate = new ZendriverOperationGate(connection!);
          agentGate = gate;
          const sourceDriver = new ZendriverBrowserDriver(
            gate,
            command.sessionId,
            generation,
            async (id, signal) =>
              (await authorized(id, signal)) &&
              (await browserScope.resolve(id, signal)) === request.sessionId,
          );
          const tool = createBrowserTool({
            store,
            blobs,
            now: () => new Date(),
            driver: sourceDriver,
            access: sourceDriver,
          });
          try {
            return await tool.execute(command.args, {
              sessionId: command.sessionId,
              callId: command.callId,
              permissionGranted: command.permissionGranted,
              sandbox: guestRouter
                ? new RemoteSandbox(guestRouter, command.sessionId)
                : new LocalSandbox(sourceRoot, { envMode: 'minimal' }),
              workspaceRoot: sourceRoot,
              signal: active,
            });
          } finally {
            if (agentGate === gate) agentGate = undefined;
          }
        },
        dispose,
      };
    },
  });
  const app = buildBrowserRuntimeServer(supervisor, env.BROWSER_RUNTIME_TOKEN);
  const notifications = await pool.connect();
  notifications.on('notification', (message) => {
    if (message.channel === 'trinity_session_closed' && z.uuid().safeParse(message.payload).success)
      void supervisor.close(message.payload!).catch(() => supervisor.dispose());
  });
  notifications.on('error', () => {
    void shutdown(1);
  });
  await notifications.query('LISTEN trinity_session_closed');
  let shutdownPromise: Promise<void> | undefined;
  function shutdown(exitCode: number): Promise<void> {
    // Dispose once; a second signal falls through to Node's default handler
    // and force-quits. Exiting deterministically guarantees the graceful
    // Chrome shutdown (which removes profile locks) always runs to completion.
    shutdownPromise ??= (async () => {
      try {
        await supervisor.dispose();
        await app.close();
        notifications.release(true);
        await pool.end();
        await lockPool.end();
      } finally {
        await telemetry?.shutdown();
      }
    })();
    return shutdownPromise.then(
      () => process.exit(exitCode),
      () => process.exit(1),
    );
  }
  process.once('SIGINT', () => {
    void shutdown(130);
  });
  process.once('SIGTERM', () => {
    void shutdown(143);
  });
  await app.listen({ host: env.BROWSER_RUNTIME_HOST, port: env.BROWSER_RUNTIME_PORT });
}

void main().catch(() => {
  console.error('Browser runtime startup failed');
  process.exit(1);
});
