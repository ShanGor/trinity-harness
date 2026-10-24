import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  GuestEnvelope,
  LongRunningProcess,
  SkillCatalogPort,
} from '@trinity-harness/contracts';
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
