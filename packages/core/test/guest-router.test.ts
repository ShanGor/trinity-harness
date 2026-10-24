import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { FirecrackerGuestRouter, RemoteSandbox, validateGuestDeployment } from '../src/index.js';
import type {
  EnvironmentRecord,
  SessionMeta,
  User,
  EnvironmentPort,
} from '@trinity-harness/contracts';

function fixture() {
  const user: User = {
    id: randomUUID(),
    tenantId: randomUUID(),
    role: 'developer',
    email: 'test@example.com',
    createdAt: '2026-01-01T00:00:00Z',
  };
  const meta: SessionMeta = {
    id: randomUUID(),
    tenantId: user.tenantId,
    userId: user.id,
    kind: 'work',
    scope: 'personal',
    title: '',
    workspaceUri: `/workspace/${user.id}`,
    createdAt: user.createdAt,
  };
  const record: EnvironmentRecord = {
    id: randomUUID(),
    tenantId: user.tenantId,
    userId: user.id,
    generation: randomUUID(),
    nodeId: 'node-1',
    vcpus: 2,
    memoryMiB: 2048,
    state: 'running',
  };
  const get = vi.fn(async () => record);
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    const body = JSON.parse(options!.body as string) as {
      request: { requestId: string; generation: string };
    };
    return new Response(
      JSON.stringify({
        requestId: body.request.requestId,
        generation: body.request.generation,
        value: { kind: 'read', content: 'guest', truncated: false },
      }),
    );
  });
  const wake = vi.fn(async () => record);
  const environment: EnvironmentPort = { wake, get, suspend: vi.fn() };
  const router = new FirecrackerGuestRouter(
    environment,
    { get },
    { get: async () => meta },
    { findById: async () => user },
    [{ id: 'node-1', endpoint: 'https://node.example/', vcpus: 8, memoryMiB: 8192 }],
    't'.repeat(32),
    '/workspace',
    fetcher,
  );
  return { router, user, meta, record, get, fetcher, wake };
}
it('uses authenticated metadata and caps routed replies without exposing credentials to the guest', async () => {
  const f = fixture();
  const sandbox = new RemoteSandbox(f.router, f.meta.id);
  expect(await sandbox.readFile('file.txt')).toEqual({ content: 'guest', truncated: false });
  const init = f.fetcher.mock.calls[0]![1]!;
  const body = JSON.parse(init.body as string);
  expect(body.request.workspace).toBe(f.user.id);
  expect(body.request.operation).toEqual({ kind: 'read', path: 'file.txt', maxBytes: 100000 });
  expect(init.body).not.toContain('t'.repeat(32));
  expect(f.fetcher.mock.calls[0]![0]).toEqual(new URL('https://node.example/guest'));
});
it.each(['viewer', 'team', 'closed', 'foreign', 'outside'] as const)(
  'rejects %s authority before transport',
  async (mode) => {
    const f = fixture();
    if (mode === 'viewer') f.user.role = 'viewer';
    if (mode === 'team') f.meta.scope = 'team';
    if (mode === 'closed') f.meta.closedAt = '2026-01-02T00:00:00Z';
    if (mode === 'foreign') f.user.tenantId = randomUUID();
    if (mode === 'outside') f.meta.workspaceUri = '/outside/workspace';
    await expect(f.router.call(f.meta.id, { kind: 'skillsList' })).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  },
);
it('refuses stale response generations and never retries uncertain effects or falls back', async () => {
  const f = fixture();
  f.fetcher.mockImplementationOnce(async () => {
    throw new Error('connection lost');
  });
  await expect(
    f.router.call(f.meta.id, { kind: 'write', path: 'file', content: 'effect' }),
  ).rejects.toThrow('unknown effect');
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  f.fetcher.mockImplementationOnce(
    async () =>
      new Response(
        JSON.stringify({
          requestId: randomUUID(),
          generation: randomUUID(),
          value: { kind: 'ok' },
        }),
      ),
  );
  await expect(
    f.router.call(f.meta.id, { kind: 'write', path: 'file', content: 'effect' }),
  ).rejects.toThrow();
  f.record.state = 'quarantined';
  await expect(f.router.call(f.meta.id, { kind: 'skillsList' })).rejects.toThrow();
  expect(f.wake).not.toHaveBeenCalled();
});
it('requires an explicit complete Firecracker deployment and keeps Zendriver selected', () => {
  expect(() =>
    validateGuestDeployment(
      { EXECUTION_DRIVER: 'firecracker', FIRECRACKER_NODES: [], BROWSER_DRIVER: 'zendriver' },
      true,
    ),
  ).toThrow('requires');
  expect(() =>
    validateGuestDeployment(
      { EXECUTION_DRIVER: 'local', FIRECRACKER_NODES: [], BROWSER_DRIVER: 'agent-browser' },
      false,
    ),
  ).not.toThrow();
});

it('binds cancellation to remote file I/O and never wakes a stopped VM for old process handles', async () => {
  const call = vi.fn(async (_id: string, _operation: unknown, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    return { kind: 'ok' as const };
  });
  const signal = new AbortController();
  const sandbox = new RemoteSandbox({ call }, randomUUID()).withSignal(signal.signal);
  signal.abort();
  await expect(sandbox.writeFile('file', 'content')).rejects.toThrow();
  expect(call.mock.calls[0]![2]?.aborted).toBe(true);
  const f = fixture();
  f.record.state = 'stopped';
  await expect(
    f.router.call(f.meta.id, { kind: 'processKill', processId: randomUUID() }),
  ).rejects.toThrow();
  expect(f.wake).not.toHaveBeenCalled();
});

it('reports unconfirmed remote process termination as a rejected exit instead of successful teardown', async () => {
  const processId = randomUUID();
  const call = vi.fn(async (_session: string, operation: { kind: string }) => {
    if (operation.kind === 'processOpen') return { kind: 'process' as const, processId };
    throw new Error('host lost');
  });
  const child = new RemoteSandbox({ call }, randomUUID()).openProcess('node', []);
  child.kill();
  await expect(child.exited).rejects.toThrow('could not be confirmed');
});

it('keeps managed guest Chrome alive after the allocating tool deadline expires', async () => {
  const processId = randomUUID();
  const call = vi.fn(async (_session: string, operation: { kind: string }) =>
    operation.kind === 'browserOpen'
      ? { kind: 'process' as const, processId }
      : { kind: 'ok' as const },
  );
  const startup = new AbortController();
  const child = new RemoteSandbox({ call }, randomUUID()).openBrowser(startup.signal);
  await Promise.resolve();
  startup.abort();
  expect(call).toHaveBeenCalledTimes(1);
  child.kill();
  await expect(child.exited).resolves.toBeNull();
  expect(call.mock.calls[1]![1].kind).toBe('processKill');
});
