import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { FakeSandbox } from '@trinity-harness/core/testing';
import type { EnvironmentRecord } from '@trinity-harness/contracts';
import { SystemdNodeRuntime } from '../src/runtime.js';
import { buildNodeAgent } from '../src/server.js';

const environment = (): EnvironmentRecord => ({
  id: randomUUID(),
  generation: randomUUID(),
  tenantId: randomUUID(),
  userId: randomUUID(),
  nodeId: 'host-1',
  state: 'starting',
  vcpus: 2,
  memoryMiB: 2048,
});
it('uses bounded literal systemd argv and never launches a client-supplied program', async () => {
  const sandbox = new FakeSandbox();
  const exec = vi
    .spyOn(sandbox, 'execArgv')
    .mockResolvedValue({ exitCode: 0, stdout: 'active', stderr: '', outputOverflow: false });
  const write = vi.spyOn(sandbox, 'writeFile');
  const runtime = new SystemdNodeRuntime(sandbox);
  const record = environment();
  expect(await runtime.command('start', record)).toMatchObject({
    state: 'starting',
    generation: record.generation,
  });
  expect(write.mock.calls[0]![0]).toBe(`instances/${record.id}-${record.generation}.json`);
  expect(JSON.parse(write.mock.calls[0]![1])).toEqual(record);
  expect(exec.mock.calls.map((call) => call[0])).toEqual([
    '/usr/bin/systemctl',
    '/usr/bin/systemctl',
  ]);
  expect(exec.mock.calls[1]![1]).toEqual([
    'start',
    '--no-block',
    `trinity-vm@${record.id}-${record.generation}.service`,
  ]);
  expect((await runtime.command('status', record)).state).toBe('running');
  await expect(runtime.command('start', { ...record, id: '../escape' })).rejects.toThrow();
});
it('confirms a synchronous stop without resetting an already-unloaded transient unit', async () => {
  const sandbox = new FakeSandbox();
  const exec = vi
    .spyOn(sandbox, 'execArgv')
    .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', outputOverflow: false });
  const record = environment();
  const result = await new SystemdNodeRuntime(sandbox).command('stop', record);
  expect(result).toEqual({ generation: record.generation, state: 'stopped' });
  expect(exec.mock.calls.map((call) => call[1])).toEqual([
    ['stop', `trinity-vm@${record.id}-${record.generation}.service`],
  ]);
});
it('requires authentication and the current PG assignment before accessing host resources', async () => {
  const token = 't'.repeat(32);
  const record = environment();
  const command = vi.fn(async () => ({
    generation: record.generation,
    state: 'starting' as const,
  }));
  const authorizeNode = vi.fn(async () => false);
  const app = buildNodeAgent({ command }, { authorizeNode }, 'host-1', token);
  try {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/instances',
          payload: { operation: 'start', environment: record },
        })
      ).statusCode,
    ).toBe(401);
    expect(command).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/instances',
          headers: { authorization: `Bearer ${token}` },
          payload: { operation: 'start', environment: record },
        })
      ).statusCode,
    ).toBe(409);
    authorizeNode.mockResolvedValue(true);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/instances',
          headers: { authorization: `Bearer ${token}` },
          payload: { operation: 'start', environment: { ...record, state: 'stopped' } },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/instances',
          headers: { authorization: `Bearer ${token}` },
          payload: { operation: 'start', environment: { ...record, nodeId: 'other-host' } },
        })
      ).statusCode,
    ).toBe(409);
    expect(command).not.toHaveBeenCalled();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/instances',
          headers: { authorization: `Bearer ${token}` },
          payload: { operation: 'start', environment: record },
        })
      ).statusCode,
    ).toBe(200);
    expect(command).toHaveBeenCalledOnce();
  } finally {
    await app.close();
  }
});
