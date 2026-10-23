import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserRuntimeRequest,
  BrowserRuntimeResult,
  BrowserRuntimeRecord,
  BrowserRuntimeStore,
} from '@trinity-harness/contracts';
import {
  HttpBrowserRuntime,
  ManagedBrowserSupervisor,
  browserRuntimeFailure,
  validateBrowserDeployment,
  createBrowserTool,
  MemorySessionStore,
  LocalBlobStore,
  authorizeManagedBrowserCommand,
} from '../src/index.js';
import { FakeSandbox } from '../src/testing/index.js';

const request = (): BrowserRuntimeRequest => ({
  sessionId: randomUUID(),
  callId: 'call-1',
  args: { operation: 'navigate', url: 'https://example.com/' },
  permissionGranted: false,
});
function success(r: BrowserRuntimeRequest): BrowserRuntimeResult {
  return {
    isError: false,
    value: {
      kind: 'browser-result-v1',
      operation: r.args.operation,
      sessionId: r.sessionId,
      callId: r.callId,
      observationId: 'observation',
      artifactUri: `blob://browser/${r.sessionId}/observation.json`,
      url: 'https://example.com/',
      title: 'Fixture',
      capturedAt: '2026-01-01T00:00:00.000Z',
      bindingId: 'binding',
      tabId: 'tab',
      documentRevision: 'revision',
      readiness: 'ready',
      saved: false,
      securityMode: 'trusted-managed',
      captureTruncated: false,
      representation: 'article',
      scope: 'main',
      exclusions: [],
      publishedAt: null,
      outline: [],
      duplicateSuppressed: false,
      outputTruncated: false,
      blocks: [],
      receipt: [],
      continuation: null,
    },
  };
}
class Journal implements BrowserRuntimeStore {
  records = new Map<string, BrowserRuntimeRecord>();
  commands = new Map<string, { hash: string; result: BrowserRuntimeResult | null }>();
  tails = new Map<string, Promise<void>>();
  async run<T>(
    session: string,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.tails.get(session) ?? Promise.resolve();
    let release!: () => void;
    this.tails.set(
      session,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await previous;
    try {
      signal?.throwIfAborted();
      return await action(signal ?? new AbortController().signal);
    } finally {
      release();
    }
  }
  async binding(id: string): Promise<BrowserRuntimeRecord | null> {
    return this.records.get(id) ?? null;
  }
  async bind(record: BrowserRuntimeRecord): Promise<void> {
    this.records.set(record.sessionId, record);
  }
  async command(
    id: string,
    call: string,
  ): Promise<{ hash: string; result: BrowserRuntimeResult | null } | null> {
    return this.commands.get(`${id}/${call}`) ?? null;
  }
  async begin(id: string, call: string, hash: string): Promise<void> {
    this.commands.set(`${id}/${call}`, { hash, result: null });
  }
  async finish(id: string, call: string, result: BrowserRuntimeResult): Promise<void> {
    this.commands.get(`${id}/${call}`)!.result = structuredClone(result);
  }
}
function fixture(
  execute: (
    r: BrowserRuntimeRequest,
    signal: AbortSignal,
  ) => Promise<BrowserRuntimeResult> = async (r) => success(r),
) {
  const store = new Journal();
  const dispose = vi.fn(async () => {});
  const perform = vi.fn(execute);
  const create = vi.fn(async () => ({ generation: randomUUID(), execute: perform, dispose }));
  const authorize = vi.fn(async () => true);
  const options = {
    store,
    owner: randomUUID(),
    create,
    authorize,
    maxSessions: 2,
    idleMs: 300_000,
  };
  const runtime = new ManagedBrowserSupervisor(options);
  return { runtime, store, dispose, perform, create, authorize, options };
}
describe('managed browser supervisor', () => {
  it.each(['navigate', 'web_search'] as const)(
    'requires owner access and matching active durable %s arguments; cancellation revokes dispatch',
    async (operation) => {
      const r = request();
      if (operation === 'web_search') r.args = { operation, query: 'unfamiliar central term' };
      const store = new MemorySessionStore();
      const signal = new AbortController().signal;
      expect(await authorizeManagedBrowserCommand(r, store, async () => true, signal)).toBe(false);
      const meta = () => ({ eventId: randomUUID(), at: '2026-01-01T00:00:00.000Z' });
      await store.append(r.sessionId, [
        { ...meta(), type: 'tool/call', callId: r.callId, name: 'browser', args: r.args },
      ]);
      expect(await authorizeManagedBrowserCommand(r, store, async () => false, signal)).toBe(false);
      expect(await authorizeManagedBrowserCommand(r, store, async () => true, signal)).toBe(true);
      expect(
        await authorizeManagedBrowserCommand(
          { ...r, args: { operation: 'navigate', url: 'https://wrong.example/' } },
          store,
          async () => true,
          signal,
        ),
      ).toBe(false);
      await store.append(r.sessionId, [
        { ...meta(), type: 'turn/cancel_requested', throughPromptSeq: 1 },
      ]);
      expect(await authorizeManagedBrowserCommand(r, store, async () => true, signal)).toBe(false);
    },
  );
  it('keeps a browser across client calls and returns journaled outcomes without repeating input', async () => {
    const f = fixture();
    const r = request();
    try {
      const first = await f.runtime.execute(r);
      expect(await f.runtime.execute(r)).toEqual(first);
      await f.runtime.execute({ ...r, callId: 'call-2' });
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(f.perform).toHaveBeenCalledTimes(2);
      expect(f.dispose).not.toHaveBeenCalled();
      expect(
        await f.runtime.execute({
          ...r,
          args: { operation: 'navigate', url: 'https://other.example/' },
        }),
      ).toMatchObject({ value: { code: 'NOT_AUTHORIZED' } });
    } finally {
      await f.runtime.dispose();
    }
    expect(f.dispose).toHaveBeenCalledTimes(1);
  });
  it('quarantines an unfinished dispatch after an outcome write fails; crash replay never resends it', async () => {
    const f = fixture();
    const r = request();
    f.store.finish = async () => {
      throw new Error('database unavailable');
    };
    expect(await f.runtime.execute(r)).toMatchObject({ value: { effect: 'unknown' } });
    expect(f.dispose).toHaveBeenCalledTimes(1);
    expect(await f.runtime.execute(r)).toMatchObject({
      value: { code: 'NOT_EXECUTED', effect: 'unknown' },
    });
    expect(f.perform).toHaveBeenCalledTimes(1);
    await f.runtime.dispose();
  });
  it('refuses to take over an unconfirmed active supervisor after process loss', async () => {
    const f = fixture();
    const r = request();
    await f.runtime.execute(r);
    const recovered = new ManagedBrowserSupervisor({ ...f.options, owner: randomUUID() });
    expect(await recovered.execute({ ...r, callId: 'new-call' })).toMatchObject({
      value: { code: 'NOT_EXECUTED', effect: 'unknown' },
    });
    expect(f.create).toHaveBeenCalledTimes(1);
    await f.runtime.dispose();
    expect((await recovered.execute({ ...r, callId: 'new-call' })).isError).toBe(false);
    expect(f.create).toHaveBeenCalledTimes(2);
    await recovered.dispose();
  });
  it('quarantines a runtime when termination cannot be confirmed', async () => {
    const f = fixture();
    const r = request();
    await f.runtime.execute(r);
    f.dispose.mockRejectedValue(new Error('termination failed'));
    await expect(f.runtime.close(r.sessionId)).rejects.toThrow('termination failed');
    expect(await f.runtime.execute({ ...r, callId: 'after-failed-stop' })).toMatchObject({
      value: { code: 'NOT_EXECUTED', effect: 'unknown' },
    });
    expect(f.perform).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1);
    await expect(f.runtime.dispose()).rejects.toThrow('termination failed');
  });
  it('cancels active input and disposes it before releasing session control', async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = fixture(async (_r, signal) => {
      entered();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      );
      throw new Error('unreachable');
    });
    const controller = new AbortController();
    const result = f.runtime.execute(request(), controller.signal);
    await ready;
    controller.abort();
    expect(await result).toMatchObject({ value: { code: 'CANCELLED', effect: 'unknown' } });
    expect(f.dispose).toHaveBeenCalledTimes(1);
    await f.runtime.dispose();
  });
  it('does not allocate or dispatch for unauthorized sessions', async () => {
    const f = fixture();
    f.authorize.mockResolvedValue(false);
    expect(await f.runtime.execute(request())).toMatchObject({
      value: { code: 'NOT_AUTHORIZED', effect: 'none' },
    });
    expect(f.create).not.toHaveBeenCalled();
    await f.runtime.dispose();
  });
  it('stops the browser if dispatch intent cannot be persisted', async () => {
    const f = fixture();
    f.store.begin = async () => {
      throw new Error('journal unavailable');
    };
    expect(await f.runtime.execute(request())).toMatchObject({ value: { effect: 'unknown' } });
    expect(f.perform).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledTimes(1);
    await f.runtime.dispose();
  });
  it('session closure interrupts an active command before waiting for its lock', async () => {
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = fixture(async (_r, signal) => {
      entered();
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('closed')), { once: true }),
      );
      throw new Error('unreachable');
    });
    const r = request();
    const active = f.runtime.execute(r);
    await ready;
    const closed = f.runtime.close(r.sessionId);
    expect(await active).toMatchObject({ isError: true, value: { effect: 'unknown' } });
    await closed;
    expect(f.dispose).toHaveBeenCalledTimes(1);
    await f.runtime.dispose();
  });
  it('reserves capacity during asynchronous allocation', async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.create.mockImplementation(async () => {
      entered();
      await gate;
      return { generation: randomUUID(), execute: f.perform, dispose: f.dispose };
    });
    const runtime = new ManagedBrowserSupervisor({ ...f.options, maxSessions: 1 });
    const first = runtime.execute(request());
    await ready;
    expect(await runtime.execute(request())).toMatchObject({
      value: { code: 'NOT_EXECUTED', effect: 'none' },
    });
    release();
    expect((await first).isError).toBe(false);
    expect(f.create).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });
});
describe('runtime HTTP client and configuration', () => {
  it('validates result identity and caps streamed response bytes before parsing', async () => {
    const r = request();
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(success(r))),
    ) as unknown as typeof fetch;
    const client = new HttpBrowserRuntime('http://127.0.0.1:3010', 'x'.repeat(32), fetcher);
    expect((await client.execute(r)).isError).toBe(false);
    expect(fetcher).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3010/execute'),
      expect.objectContaining({ redirect: 'error' }),
    );
    const wrong = new HttpBrowserRuntime(
      'http://localhost:3010',
      'x'.repeat(32),
      (async () =>
        new Response(JSON.stringify(success({ ...r, sessionId: randomUUID() })))) as typeof fetch,
    );
    await expect(wrong.execute(r)).rejects.toThrow('mismatch');
    const huge = new HttpBrowserRuntime(
      'http://localhost:3010',
      'x'.repeat(32),
      (async () => new Response('x'.repeat(12_000))) as typeof fetch,
    );
    await expect(huge.execute(r)).rejects.toThrow('overflow');
  });
  it('names the unreachable runtime instead of surfacing a raw transport error', async () => {
    const r = request();
    const fetcher = vi.fn(async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 127.0.0.1:3010');
    }) as unknown as typeof fetch;
    const client = new HttpBrowserRuntime('http://127.0.0.1:3010', 'x'.repeat(32), fetcher);
    const result = await client.execute(r);
    expect(result).toMatchObject({
      isError: true,
      value: {
        kind: 'browser-error-v1',
        code: 'DRIVER_FAILED',
        effect: 'unknown',
        recovery: 'conclude',
      },
    });
    if (result.value.kind === 'browser-error-v1') {
      expect(result.value.message).toContain('http://127.0.0.1:3010');
      expect(result.value.message).toContain('unreachable');
      expect(result.value.message).not.toContain('ECONNREFUSED');
      expect(result.value.message.length).toBeLessThanOrEqual(500);
    }
  });
  it('requires explicit, nonconflicting configuration and protected remote origins', () => {
    expect(() => validateBrowserDeployment({ BROWSER_DRIVER: 'zendriver' })).toThrow(
      /Zendriver is selected.*BROWSER_RUNTIME_ENDPOINT and BROWSER_RUNTIME_TOKEN are missing.*pnpm dev:browser-runtime/,
    );
    expect(() =>
      validateBrowserDeployment({
        BROWSER_DRIVER: 'zendriver',
        BROWSER_RUNTIME_ENDPOINT: 'https://runtime.example',
        BROWSER_RUNTIME_TOKEN: 'x'.repeat(32),
        BROWSER_CDP_ENDPOINT: '9222',
      }),
    ).toThrow('Remove BROWSER_CDP_ENDPOINT');
    expect(() => new HttpBrowserRuntime('http://runtime.example', 'x'.repeat(32))).toThrow();
    expect(
      () => new HttpBrowserRuntime('https://user:secret@runtime.example', 'x'.repeat(32)),
    ).toThrow();
  });
  it('forwards original search arguments through the managed runtime and validates response identity', async () => {
    const r = request();
    r.args = { operation: 'web_search', query: 'calibrated decision models' };
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify(success(r))),
    ) as unknown as typeof fetch;
    const client = new HttpBrowserRuntime('http://127.0.0.1:3010', 'x'.repeat(32), fetcher);
    const tool = createBrowserTool({
      store: new MemorySessionStore(),
      blobs: new LocalBlobStore('/unused'),
      now: () => new Date('2026-01-01'),
      runtime: client,
    });
    const signal = new AbortController().signal;
    expect(
      await tool.execute(r.args, {
        sessionId: r.sessionId,
        callId: r.callId,
        sandbox: new FakeSandbox(),
        workspaceRoot: '/unused',
        signal,
      }),
    ).toMatchObject({ isError: false, value: { operation: 'web_search' } });
    expect(fetcher).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:3010/execute'),
      expect.objectContaining({ body: JSON.stringify(r), signal: expect.any(AbortSignal) }),
    );
  });
  it('checks action approval before contacting a remote runtime', async () => {
    const execute = vi.fn(async (r: BrowserRuntimeRequest) =>
      browserRuntimeFailure(r, 'DRIVER_FAILED'),
    );
    const tool = createBrowserTool({
      store: new MemorySessionStore(),
      blobs: new LocalBlobStore('/unused'),
      now: () => new Date('2026-01-01'),
      runtime: { execute },
    });
    const r = request();
    expect(
      await tool.execute(
        { operation: 'click', snapshotId: 'snapshot', ref: 'r0' },
        {
          sessionId: r.sessionId,
          callId: r.callId,
          sandbox: new FakeSandbox(),
          workspaceRoot: '/unused',
        },
      ),
    ).toMatchObject({ value: { code: 'NOT_AUTHORIZED', effect: 'none' } });
    expect(execute).not.toHaveBeenCalled();
  });
});
