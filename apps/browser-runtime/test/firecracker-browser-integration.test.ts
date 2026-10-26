import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  browserErrorSchema,
  browserResultSchema,
  browserRuntimeResultSchema,
  type BrowserArguments,
  type BrowserResult,
  type BrowserRuntimeRequest,
  type BrowserRuntimeResult,
} from '@trinity-harness/contracts';
import {
  EnvironmentController,
  FirecrackerGuestRouter,
  HttpNodeRuntime,
  LocalBlobStore,
  MemorySessionStore,
  ManagedBrowserSupervisor,
  HttpBrowserRuntime,
  authorizeManagedBrowserCommand,
  RemoteSandbox,
  ScryptPasswordHasher,
  ZendriverBrowserDriver,
  ZendriverMcpConnection,
  createBrowserTool,
  isCdpSessionOwner,
} from '@trinity-harness/core';
import {
  createDb,
  createPool,
  PgEnvironmentStore,
  PgBrowserRuntimeStore,
  PgBrowserInteractionStore,
  PgSessionMetaStore,
  PgUserStore,
} from '@trinity-harness/db';
import { loadBrowserRuntimeEnv } from '../src/env.js';
import { buildBrowserRuntimeServer } from '../src/server.js';

describe.skipIf(process.env['FIRECRACKER_BROWSER_INTEGRATION'] !== '1')(
  'assigned Firecracker guest public browser acceptance (opt-in)',
  () => {
    let pool: ReturnType<typeof createPool> | undefined;
    let locks: ReturnType<typeof createPool> | undefined;
    let root: string | undefined;
    let run: (args: BrowserArguments) => Promise<BrowserResult>;
    let managedHandoff: () => Promise<void>;

    beforeAll(async () => {
      const sessionId = z.uuid().parse(process.env['FIRECRACKER_BROWSER_TEST_SESSION_ID']);
      const env = loadBrowserRuntimeEnv();
      if (env.EXECUTION_DRIVER !== 'firecracker')
        throw new Error('This acceptance check requires configured Firecracker execution.');
      pool = createPool(env.DATABASE_URL, {
        connectionTimeoutMillis: 5000,
        query_timeout: 10_000,
      });
      locks = createPool(env.DATABASE_URL, { connectionTimeoutMillis: 5000 });
      const db = createDb(pool);
      const metas = new PgSessionMetaStore(db);
      const users = new PgUserStore(db, new ScryptPasswordHasher());
      const environments = new PgEnvironmentStore(db, locks);
      const authorize = (id: string, signal?: AbortSignal): Promise<boolean> =>
        isCdpSessionOwner(
          id,
          metas,
          users,
          { id: env.BROWSER_CDP_OWNER_ID, email: env.ADMIN_EMAIL },
          signal,
        );
      if (!(await authorize(sessionId))) throw new Error('Configured browser ownership denied.');
      const meta = await metas.get(sessionId);
      const user = meta ? await users.findById(meta.userId) : null;
      if (!meta?.workspaceUri || !user) throw new Error('Authenticated workspace unavailable.');
      const assigned = await environments.get({
        tenantId: meta.tenantId,
        userId: meta.userId,
        role: user.role,
      });
      if (assigned?.state !== 'running')
        throw new Error('Start the assigned guest before running this acceptance check.');
      const router = new FirecrackerGuestRouter(
        new EnvironmentController(
          environments,
          env.FIRECRACKER_NODES,
          new Map(
            env.FIRECRACKER_NODES.map((node) => [
              node.id,
              new HttpNodeRuntime(node.endpoint, env.NODE_RUNTIME_TOKEN!),
            ]),
          ),
        ),
        environments,
        metas,
        users,
        env.FIRECRACKER_NODES,
        env.NODE_RUNTIME_TOKEN!,
        env.WORKSPACE_ROOT,
      );
      root = await mkdtemp(path.join(os.tmpdir(), 'trinity-guest-public-browser-'));
      const blobs = new LocalBlobStore(root);
      run = async (args): Promise<BrowserResult> => {
        const signal = AbortSignal.timeout(50_000);
        const sandbox = new RemoteSandbox(router, sessionId);
        const connection = new ZendriverMcpConnection(sandbox.openBrowser(signal));
        try {
          await connection.initialize(signal);
          const driver = new ZendriverBrowserDriver(connection, sessionId, randomUUID(), authorize);
          await driver.open(signal, env.ZENDRIVER_CHROME_VERSION);
          const store = new MemorySessionStore();
          const tool = createBrowserTool({
            store,
            blobs,
            driver,
            access: driver,
            now: () => new Date(),
          });
          const callId = randomUUID();
          const event = () => ({ eventId: randomUUID(), at: new Date().toISOString() });
          await store.append(sessionId, [
            {
              ...event(),
              type: 'message/user',
              surfaceOp: 'append',
              content: [{ kind: 'text', text: 'Operator-requested public browser acceptance.' }],
            },
            { ...event(), type: 'tool/call', name: 'browser', callId, args },
          ]);
          const result = await tool.execute(args, {
            sessionId,
            callId,
            sandbox,
            workspaceRoot: meta.workspaceUri!,
            signal,
          });
          if (result.isError) {
            const error = browserErrorSchema.parse(result.value);
            throw new Error(`${args.operation}: ${error.code}: ${error.message}`);
          }
          const observed = browserResultSchema.parse(result.value);
          expect(
            observed.receipt.length,
            JSON.stringify({
              title: observed.title,
              readiness: observed.readiness,
              blocks: observed.blocks.length,
              links: observed.links?.length,
              continuation: observed.continuation,
            }),
          ).toBeGreaterThan(0);
          expect(observed.blocks.some((block) => block.text.trim().length > 0)).toBe(true);
          return observed;
        } finally {
          await connection.dispose();
        }
      };
      managedHandoff = async (): Promise<void> => {
        // Isolate journals/controls from the operator session while retaining its
        // authenticated real assignment, owner/profile and guest network route.
        const schema = `browser_handoff_${randomUUID().replaceAll('-', '')}`;
        await pool!.query(`CREATE SCHEMA ${schema}`);
        const isolated = createPool(env.DATABASE_URL, {
          options: `-c search_path=${schema},public`,
          connectionTimeoutMillis: 5000,
        });
        const events = new MemorySessionStore();
        const journal = new PgBrowserRuntimeStore(isolated);
        const controls = new PgBrowserInteractionStore(isolated);
        const sandbox = new RemoteSandbox(router, sessionId);
        const ctx = { sessionId, sandbox, workspaceRoot: meta.workspaceUri! };
        const makeSupervisor = (): ManagedBrowserSupervisor =>
          new ManagedBrowserSupervisor({
            store: journal,
            interactionStore: controls,
            events,
            owner: randomUUID(),
            maxSessions: 1,
            idleMs: 300000,
            authorize: (request, signal) =>
              authorizeManagedBrowserCommand(request, events, authorize, signal),
            authorizePreview: authorize,
            create: async (_request, signal) => {
              const connection = new ZendriverMcpConnection(sandbox.openBrowser(signal));
              try {
                await connection.initialize(signal);
                const generation = randomUUID();
                const driver = new ZendriverBrowserDriver(
                  connection,
                  sessionId,
                  generation,
                  authorize,
                );
                await driver.open(signal, env.ZENDRIVER_CHROME_VERSION);
                const tool = createBrowserTool({
                  store: events,
                  blobs,
                  driver,
                  access: driver,
                  now: () => new Date(),
                });
                return {
                  generation,
                  dispose: () => connection.dispose(),
                  execute: async (
                    request: BrowserRuntimeRequest,
                    active: AbortSignal,
                  ): Promise<BrowserRuntimeResult> =>
                    browserRuntimeResultSchema.parse(
                      await tool.execute(request.args, {
                        ...ctx,
                        callId: request.callId,
                        permissionGranted: request.permissionGranted,
                        signal: active,
                      }),
                    ),
                  humanFrame: (privateView: boolean, active: AbortSignal) =>
                    driver.humanFrame(privateView, { ...ctx, signal: active }),
                  humanInput: (action, target, active) =>
                    driver.humanInput(action, target, { ...ctx, signal: active }),
                };
              } catch (error) {
                await connection.dispose();
                throw error;
              }
            },
          });
        let supervisor = makeSupervisor();
        const token = 'fixture-browser-handoff-token-32-characters';
        const server = buildBrowserRuntimeServer(
          {
            execute: (request, active) => supervisor.execute(request, active),
            interact: (request, active) => supervisor.interact(request, active),
          },
          token,
        );
        try {
          for (const table of [
            'browser_runtimes',
            'browser_commands',
            'browser_controls',
            'browser_user_inputs',
          ])
            await isolated.query(
              `CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`,
            );
          const endpoint = await server.listen({ host: '127.0.0.1', port: 0 });
          const client = new HttpBrowserRuntime(endpoint, token);
          const browser = createBrowserTool({
            store: events,
            blobs,
            runtime: client,
            now: () => new Date(),
          });
          const event = () => ({ eventId: randomUUID(), at: new Date().toISOString() });
          await events.append(sessionId, [
            {
              ...event(),
              type: 'message/user',
              surfaceOp: 'append',
              content: [{ kind: 'text', text: 'Operator-requested browser handoff regression.' }],
            },
          ]);
          const execute = async (args: BrowserArguments): Promise<BrowserResult> => {
            const callId = randomUUID();
            await events.append(sessionId, [
              { ...event(), type: 'tool/call', name: 'browser', callId, args },
            ]);
            const result = await browser.execute(args, {
              ...ctx,
              callId,
              signal: AbortSignal.timeout(50000),
            });
            await events.append(sessionId, [
              { ...event(), type: 'tool/result', callId, ...result },
            ]);
            expect(
              result.isError,
              JSON.stringify(result.isError ? result.value : { operation: args.operation }),
            ).toBe(false);
            const observed = browserResultSchema.parse(result.value);
            expect(observed.receipt.length).toBeGreaterThan(0);
            return observed;
          };
          await execute({ operation: 'navigate', url: 'https://example.com/' });
          const viewId = randomUUID();
          const taken = await client.interact({ sessionId, viewId, operation: 'take' });
          expect(taken.error).toBeUndefined();
          const returned = await client.interact({
            sessionId,
            viewId,
            operation: 'release',
            generation: taken.state.generation!,
            epoch: taken.state.epoch,
          });
          expect(returned.state.mode).toBe('agent');
          expect((await controls.get(sessionId))?.needsObservation).toBe(true);
          await supervisor.dispose();
          supervisor = makeSupervisor();
          for (const query of [
            'pyannote speaker diarization model card license',
            'NeMo Sortformer model license',
          ]) {
            const observed = await execute({ operation: 'web_search', query });
            expect(new URL(observed.url).pathname).toBe('/search');
            expect(new URL(observed.url).searchParams.get('q')).toBe(query);
            expect(observed.links?.length ?? 0).toBeGreaterThan(0);
          }
          expect((await controls.get(sessionId))?.needsObservation).toBe(false);
          expect((await journal.binding(sessionId))?.generation).not.toBe(taken.state.generation);
        } finally {
          try {
            await supervisor.dispose();
          } finally {
            await server.close();
            await isolated.end();
            await pool!.query(`DROP SCHEMA ${schema} CASCADE`);
          }
        }
      };
    });

    afterAll(async () => {
      await Promise.all([pool?.end(), locks?.end()]);
      if (root) await rm(root, { recursive: true, force: true });
    });

    it('reads a public HTTPS page through Node Agent, vsock and guest Chrome', async () => {
      const observed = await run({ operation: 'navigate', url: 'https://example.com/' });
      expect(new URL(observed.url).hostname).toBe('example.com');
      expect(observed.title.trim().length).toBeGreaterThan(0);
    }, 60_000);

    it('executes web_search and reaches a Google search document with delivered evidence', async () => {
      const observed = await run({
        operation: 'web_search',
        query: 'Trinity browser connectivity check',
      });
      const url = new URL(observed.url);
      expect(url.hostname).toBe('www.google.com');
      expect(url.pathname).toBe('/search');
      expect(observed.links?.length ?? 0).toBeGreaterThan(0);
    }, 60_000);
    it('searches both requested topics after human return and browser recreation through HTTP and PG journals', async () => {
      await managedHandoff();
    }, 120000);
  },
);
