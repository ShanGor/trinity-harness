import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { FirecrackerGuestRouter, RemoteSandbox, validateGuestDeployment } from '../src/index.js';
import type {
  EnvironmentRecord,
  SessionMeta,
  User,
  EnvironmentPort,
} from '@trinity-harness/contracts';
import { guestOperationSchema } from '@trinity-harness/contracts';

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
  const environmentGet = vi.fn(async () => record);
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
  const environment: EnvironmentPort = { wake, get: environmentGet, suspend: vi.fn() };
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
  return { router, user, meta, record, get, environmentGet, fetcher, wake };
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
it('routes only browser operations to the isolated guest browser service', async () => {
  const f = fixture();
  await expect(f.router.call(f.meta.id, { kind: 'desktopFrame' })).rejects.toThrow();
  await expect(
    f.router.browser().call(f.meta.id, { kind: 'read', path: 'private', maxBytes: 10 }),
  ).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
  await f.router.browser().call(f.meta.id, { kind: 'desktopFrame' });
  expect(f.fetcher.mock.calls[0]![0]).toEqual(new URL('https://node.example/guest-browser'));
  f.record.state = 'stopped';
  await expect(f.router.browser().call(f.meta.id, { kind: 'desktopFrame' })).rejects.toThrow();
  expect(f.wake).not.toHaveBeenCalled();
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

it('opens guest browser without passing host proxy configuration', async () => {
  const processId = randomUUID();
  const f = fixture();
  f.fetcher.mockImplementation(async (_url, options) => {
    const body = JSON.parse(options!.body as string) as {
      request: {
        requestId: string;
        generation: string;
        operation: { kind: string; proxyUrl?: string };
      };
    };
    const value =
      body.request.operation.kind === 'browserOpen'
        ? { kind: 'process', processId }
        : { kind: 'ok' };
    return new Response(
      JSON.stringify({
        requestId: body.request.requestId,
        generation: body.request.generation,
        value,
      }),
    );
  });
  const child = new RemoteSandbox(f.router, f.meta.id).openBrowser();
  child.kill();
  await expect(child.exited).resolves.toBeNull();
  const firstBody = JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string);
  expect(firstBody.request.operation).toEqual({ kind: 'browserOpen' });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(
    guestOperationSchema.safeParse({ kind: 'browserOpen', proxyUrl: 'http://proxy:7890' }).success,
  ).toBe(false);
});

it('records bounded RPC phase timings on success and uncertain failure', async () => {
  const { guestRpcDuration } = await import('../src/telemetry.js');
  const record = vi.spyOn(guestRpcDuration, 'record');
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  try {
    const f = fixture();
    await f.router.call(f.meta.id, { kind: 'skillsList' });
    expect(record.mock.calls.map(([, attrs]) => attrs?.['trinity.guest.phase'])).toEqual([
      'metadata',
      'environment',
      'transport',
      'total',
    ]);
    expect(record.mock.calls.at(-1)).toEqual([
      0,
      {
        'trinity.guest.operation': 'skillsList',
        'trinity.guest.phase': 'total',
        'trinity.guest.status': 'ok',
      },
    ]);
    record.mockClear();
    f.fetcher.mockRejectedValueOnce(new Error('private transport details'));
    await expect(f.router.call(f.meta.id, { kind: 'skillsList' })).rejects.toThrow(
      'unknown effect',
    );
    expect(record.mock.calls.at(-1)?.[1]?.['trinity.guest.status']).toBe('error');
    expect(JSON.stringify(record.mock.calls)).not.toContain('private transport details');
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  } finally {
    record.mockRestore();
    clock.mockRestore();
  }
});

it.each(['read', 'readBytes'] as const)(
  'preserves a verified %s operation error without reporting a VM outage',
  async (kind) => {
    const f = fixture();
    f.fetcher.mockImplementationOnce(async (_url, options) => {
      const { request } = JSON.parse(options!.body as string);
      return new Response(
        JSON.stringify({
          requestId: request.requestId,
          generation: request.generation,
          value: {
            kind: 'operationError',
            operation: kind,
            code: 'FILE_NOT_FOUND',
            effect: 'none',
          },
        }),
      );
    });
    await expect(
      f.router.call(f.meta.id, { kind, path: 'missing', maxBytes: 100 }),
    ).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
      effect: 'none',
      message: expect.stringContaining('File not found'),
    });
    expect(f.fetcher).toHaveBeenCalledOnce();
    expect(f.wake).not.toHaveBeenCalled();
  },
);

it.each(['operation', 'generation', 'request', 'effect', 'extra', 'http'] as const)(
  'rejects a typed failure with mismatched or invalid %s without retry',
  async (mode) => {
    const f = fixture();
    f.fetcher.mockImplementationOnce(async (_url, options) => {
      const { request } = JSON.parse(options!.body as string);
      return new Response(
        JSON.stringify({
          requestId: mode === 'request' ? randomUUID() : request.requestId,
          generation: mode === 'generation' ? randomUUID() : request.generation,
          value: {
            kind: 'operationError',
            operation: mode === 'operation' ? 'readBytes' : 'read',
            code: 'FILE_NOT_FOUND',
            effect: mode === 'effect' ? 'unknown' : 'none',
            ...(mode === 'extra' ? { rawMessage: 'private syscall details' } : {}),
          },
        }),
        { status: mode === 'http' ? 503 : 200 },
      );
    });
    await expect(
      f.router.call(f.meta.id, { kind: 'read', path: 'missing', maxBytes: 100 }),
    ).rejects.toMatchObject({
      code: 'GUEST_UNAVAILABLE',
      message: expect.stringContaining('unknown effect'),
    });
    expect(f.fetcher).toHaveBeenCalledOnce();
  },
);

it('never accepts a read failure as acknowledgement of a mutation', async () => {
  const f = fixture();
  f.fetcher.mockImplementationOnce(async (_url, options) => {
    const { request } = JSON.parse(options!.body as string);
    return new Response(
      JSON.stringify({
        requestId: request.requestId,
        generation: request.generation,
        value: {
          kind: 'operationError',
          operation: 'read',
          code: 'FILE_NOT_FOUND',
          effect: 'none',
        },
      }),
    );
  });
  await expect(
    f.router.call(f.meta.id, { kind: 'write', path: 'file', content: 'effect' }),
  ).rejects.toMatchObject({ code: 'GUEST_UNAVAILABLE' });
  expect(f.fetcher).toHaveBeenCalledOnce();
});

it('reconciles with the owning node after a transport failure without retrying the operation', async () => {
  const f = fixture();
  f.fetcher.mockRejectedValueOnce(new Error('vsock disappeared after host reboot'));
  await expect(f.router.call(f.meta.id, { kind: 'skillsList' })).rejects.toThrow(
    'unknown effect',
  );
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  // The router asks the node for the real unit state so a dead VM lands on
  // 'stopped' (next call wakes a fresh generation) instead of failing forever.
  expect(f.environmentGet).toHaveBeenCalledTimes(1);
});

it('still reports guest unavailability when the reconciling probe fails too', async () => {
  const f = fixture();
  f.fetcher.mockRejectedValueOnce(new Error('vsock disappeared'));
  f.environmentGet.mockRejectedValueOnce(new Error('node operation unavailable'));
  await expect(f.router.call(f.meta.id, { kind: 'skillsList' })).rejects.toMatchObject({
    code: 'GUEST_UNAVAILABLE',
    message: expect.stringContaining('unknown effect'),
  });
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.environmentGet).toHaveBeenCalledTimes(1);
});
