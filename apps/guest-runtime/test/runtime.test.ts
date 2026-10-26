import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  GuestEnvelope,
  LongRunningProcess,
  SkillCatalogPort,
} from '@trinity-harness/contracts';
import { guestOperationSchema } from '@trinity-harness/contracts';
import { FakeSandbox } from '@trinity-harness/core/testing';
import { GuestRuntime } from '../src/runtime.js';
import { buildGuestServer } from '../src/server.js';

const skills: SkillCatalogPort = {
  list: async () => ({ skills: [], diagnostics: [] }),
  load: vi.fn(),
  readResource: vi.fn(),
};
function fixture() {
  const environmentId = randomUUID(),
    generation = randomUUID(),
    sessionId = randomUUID();
  const sandbox = new FakeSandbox();
  const runtime = new GuestRuntime(
    environmentId,
    generation,
    async () => sandbox,
    skills,
    (workspace) => `/workspace/${workspace}`,
  );
  const call = (operation: GuestEnvelope['operation'], override?: Partial<GuestEnvelope>) =>
    runtime.execute({
      requestId: randomUUID(),
      environmentId,
      generation,
      sessionId,
      workspace: `sessions/${sessionId}`,
      operation,
      ...override,
    });
  return { runtime, sandbox, call, environmentId, generation, sessionId };
}
afterEach(() => vi.useRealTimers());
it('dispatches typed sandbox operations and refuses stale generations before effects', async () => {
  const f = fixture();
  try {
    await f.call({ kind: 'write', path: 'hello.txt', content: 'hello' });
    expect(await f.call({ kind: 'read', path: 'hello.txt', maxBytes: 100 })).toEqual({
      kind: 'read',
      content: 'hello',
      truncated: false,
    });
    expect(await f.call({ kind: 'skillsList' })).toEqual({
      kind: 'skills',
      catalog: { skills: [], diagnostics: [] },
    });
    const write = vi.spyOn(f.sandbox, 'writeFile');
    await expect(
      f.call({ kind: 'write', path: 'escape.txt', content: 'x' }, { generation: randomUUID() }),
    ).rejects.toThrow('Stale');
    expect(write).not.toHaveBeenCalled();
  } finally {
    await f.runtime.dispose();
  }
});

it('rejects browser proxy settings from the strict guest operation schema', () => {
  expect(
    guestOperationSchema.safeParse({ kind: 'browserOpen', proxyUrl: 'http://proxy:7890' }).success,
  ).toBe(false);
});

it.each([
  ['ENOENT', 'FILE_NOT_FOUND'],
  ['EACCES', 'ACCESS_DENIED'],
  ['EPERM', 'ACCESS_DENIED'],
  ['ENOTDIR', 'NOT_A_DIRECTORY'],
  ['EISDIR', 'IS_A_DIRECTORY'],
] as const)(
  'returns a bounded typed read failure for %s without raw paths',
  async (errno, code) => {
    const f = fixture();
    const raw = Object.assign(new Error('private host path and contents'), { code: errno });
    vi.spyOn(f.sandbox, 'readFile').mockRejectedValue(raw);
    vi.spyOn(f.sandbox, 'readBytes').mockRejectedValue(raw);
    try {
      for (const kind of ['read', 'readBytes'] as const) {
        expect(await f.call({ kind, path: 'missing.txt', maxBytes: 100 })).toEqual({
          kind: 'operationError',
          operation: kind,
          code,
          effect: 'none',
        });
      }
      // The same errno during a mutation is not a proven harmless read failure.
      vi.spyOn(f.sandbox, 'writeFile').mockRejectedValue(raw);
      await expect(f.call({ kind: 'write', path: 'file', content: 'effect' })).rejects.toBe(raw);
      vi.spyOn(f.sandbox, 'readFile').mockRejectedValue(new Error('unknown read failure'));
      await expect(f.call({ kind: 'read', path: 'file', maxBytes: 100 })).rejects.toThrow(
        'unknown read failure',
      );
    } finally {
      await f.runtime.dispose();
    }
  },
);

it('sends typed read failures in a generation-bound successful RPC envelope', async () => {
  const f = fixture();
  vi.spyOn(f.sandbox, 'readFile').mockRejectedValue(
    Object.assign(new Error('secret path'), { code: 'ENOENT' }),
  );
  const app = buildGuestServer(f.runtime);
  const requestId = randomUUID();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: {
        requestId,
        environmentId: f.environmentId,
        generation: f.generation,
        sessionId: f.sessionId,
        workspace: 'personal',
        operation: { kind: 'read', path: 'missing', maxBytes: 100 },
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      requestId,
      generation: f.generation,
      value: {
        kind: 'operationError',
        operation: 'read',
        code: 'FILE_NOT_FOUND',
        effect: 'none',
      },
    });
    expect(response.body).not.toContain('secret path');
  } finally {
    await app.close();
    await f.runtime.dispose();
  }
});
it('bounds and sequences process stdio, replays delivered output and keeps process ownership scoped', async () => {
  const f = fixture();
  let finish!: (code: number | null) => void;
  const ended = new Promise<number | null>((resolve) => {
    finish = resolve;
  });
  const write = vi.fn(),
    kill = vi.fn(() => finish(0));
  const child: LongRunningProcess = {
    write,
    kill,
    exited: ended,
    async *chunks() {
      yield Buffer.from('hello');
      await ended;
    },
  };
  vi.spyOn(f.sandbox, 'openProcess').mockReturnValue(child);
  try {
    const opened = await f.call({
      kind: 'processOpen',
      command: 'node',
      args: ['server.js'],
      options: {},
    });
    if (opened.kind !== 'process') throw new Error('No process');
    const processId = opened.processId;
    const input = {
      kind: 'processWrite' as const,
      processId,
      seq: 1,
      data: Buffer.from('input').toString('base64'),
    };
    await f.call(input);
    await f.call(input);
    expect(write).toHaveBeenCalledTimes(1);
    await expect(f.call({ ...input, data: 'eA==' })).rejects.toThrow('sequence');
    const output = await f.call({ kind: 'processRead', processId, cursor: 0 });
    expect(output).toMatchObject({
      kind: 'processOutput',
      data: 'aGVsbG8=',
      cursor: 5,
      exited: false,
    });
    expect(await f.call({ kind: 'processRead', processId, cursor: 0 })).toEqual(output);
    await expect(
      f.call({ kind: 'processWrite', processId, seq: 2, data: '' }, { sessionId: randomUUID() }),
    ).rejects.toThrow('ownership');
    await expect(f.call({ kind: 'processRead', processId, cursor: 6 })).rejects.toThrow('cursor');
    await f.call({ kind: 'processKill', processId });
    expect(kill).toHaveBeenCalled();
    await expect(f.call({ kind: 'processRead', processId, cursor: 5 })).rejects.toThrow(
      'ownership',
    );
  } finally {
    await f.runtime.dispose();
  }
});
it('validates the guest boundary and never returns raw exception contents', async () => {
  const f = fixture();
  const app = buildGuestServer(f.runtime);
  try {
    const payload = {
      requestId: randomUUID(),
      environmentId: f.environmentId,
      generation: f.generation,
      sessionId: f.sessionId,
      workspace: '../other',
      operation: { kind: 'read', path: 'file', maxBytes: 100 },
    };
    expect((await app.inject({ method: 'POST', url: '/rpc', payload })).statusCode).toBe(400);
    const denied = await app.inject({
      method: 'POST',
      url: '/rpc',
      payload: { ...payload, workspace: 'personal', generation: randomUUID() },
    });
    expect(denied.statusCode).toBe(503);
    expect(denied.body).not.toContain(f.generation);
  } finally {
    await app.close();
    await f.runtime.dispose();
  }
});
