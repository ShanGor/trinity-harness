import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  environmentResponseSchema,
  type EnvironmentRecord,
  type EnvironmentStore,
  type Identity,
} from '@trinity-harness/contracts';
import { EnvironmentController, HttpNodeRuntime } from '../src/index.js';

it('quarantines uncertain starts and never assigns another host on retry', async () => {
  const identity: Identity = { userId: randomUUID(), tenantId: randomUUID(), role: 'developer' };
  let record: EnvironmentRecord = {
    id: randomUUID(),
    generation: randomUUID(),
    ...identity,
    nodeId: 'host',
    state: 'starting',
    vcpus: 2,
    memoryMiB: 2048,
  };
  const store: EnvironmentStore = {
    run: async (_identity, action) => action(new AbortController().signal),
    runShared: async (_identity, action) => action(new AbortController().signal),
    get: async () => record,
    reserve: async () => record,
    authorizeNode: async () => true,
    isNodeDraining: async () => false,
    beginNodeDrain: async () => undefined,
    endNodeDrain: async () => undefined,
    listNodeEnvironments: async () => [record],
    transition: async (_previous, state) => {
      record = { ...record, state };
      return record;
    },
  };
  const command = vi.fn(async () => {
    throw new Error('connection lost');
  });
  const controller = new EnvironmentController(store, [], new Map([['host', { command }]]));
  await expect(controller.wake(identity)).rejects.toThrow('connection lost');
  expect(record.state).toBe('quarantined');
  await expect(controller.wake(identity)).rejects.toThrow('host recovery');
  expect(command).toHaveBeenCalledOnce();
  const result = environmentResponseSchema.parse({ available: true, environment: record });
  expect(result.environment).not.toHaveProperty('nodeId');
  expect(result.environment).not.toHaveProperty('generation');
});

it('drains every assigned environment and leaves the node gated until explicit resume', async () => {
  const records: EnvironmentRecord[] = Array.from({ length: 2 }, () => ({
    id: randomUUID(),
    generation: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    nodeId: 'host',
    state: 'running',
    vcpus: 2,
    memoryMiB: 2048,
  }));
  let draining = false;
  const store: EnvironmentStore = {
    run: async (_identity, action) => action(new AbortController().signal),
    runShared: async (_identity, action) => action(new AbortController().signal),
    get: async (identity) => records.find((record) => record.userId === identity.userId) ?? null,
    reserve: async () => records[0]!,
    authorizeNode: async () => true,
    isNodeDraining: async () => draining,
    beginNodeDrain: async () => {
      draining = true;
    },
    endNodeDrain: async () => {
      draining = false;
    },
    listNodeEnvironments: async () => records,
    transition: async (previous, state) => {
      const updated = { ...previous, state };
      const index = records.findIndex((record) => record.id === previous.id);
      records[index] = updated;
      return updated;
    },
  };
  const command = vi.fn(async (_operation: 'start' | 'stop' | 'status', environment) => ({
    generation: environment.generation,
    state: 'stopped' as const,
  }));
  const controller = new EnvironmentController(
    store,
    [{ id: 'host', endpoint: 'https://host.test/', vcpus: 8, memoryMiB: 8192 }],
    new Map([['host', { command }]]),
  );

  await expect(controller.drainNode('host')).resolves.toEqual({
    nodeId: 'host',
    state: 'draining',
    stopped: 2,
    remaining: 0,
    failed: 0,
  });
  expect(draining).toBe(true);
  expect(records.every((record) => record.state === 'stopped')).toBe(true);
  expect(command).toHaveBeenCalledTimes(2);
  await controller.resumeNode('host');
  expect(draining).toBe(false);
});

it('keeps a node drained when a VM stop cannot be confirmed', async () => {
  const record: EnvironmentRecord = {
    id: randomUUID(),
    generation: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    nodeId: 'host',
    state: 'running',
    vcpus: 2,
    memoryMiB: 2048,
  };
  let draining = false;
  let current = record;
  const store: EnvironmentStore = {
    run: async (_identity, action) => action(new AbortController().signal),
    runShared: async (_identity, action) => action(new AbortController().signal),
    get: async () => current,
    reserve: async () => current,
    authorizeNode: async () => true,
    isNodeDraining: async () => draining,
    beginNodeDrain: async () => {
      draining = true;
    },
    endNodeDrain: async () => {
      draining = false;
    },
    listNodeEnvironments: async () => [current],
    transition: async (_previous, state) => {
      current = { ...current, state };
      return current;
    },
  };
  const controller = new EnvironmentController(
    store,
    [{ id: 'host', endpoint: 'https://host.test/', vcpus: 8, memoryMiB: 8192 }],
    new Map([
      [
        'host',
        {
          command: async () => {
            throw new Error('stop timed out');
          },
        },
      ],
    ]),
  );

  await expect(controller.drainNode('host')).resolves.toMatchObject({
    state: 'draining',
    remaining: 1,
    failed: 1,
  });
  expect(draining).toBe(true);
  expect(current.state).toBe('quarantined');
  await expect(controller.resumeNode('host')).rejects.toMatchObject({ code: 'NODE_ACTIVE' });
});
it('requires HTTPS outside loopback and rejects stale host generations', async () => {
  expect(() => new HttpNodeRuntime('http://host.test/', 't'.repeat(32))).toThrow();
  const record: EnvironmentRecord = {
    id: randomUUID(),
    generation: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    nodeId: 'host',
    state: 'starting',
    vcpus: 2,
    memoryMiB: 2048,
  };
  const runtime = new HttpNodeRuntime('https://host.test/', 't'.repeat(32), async () =>
    Response.json({ state: 'running', generation: randomUUID() }),
  );
  await expect(runtime.command('start', record)).rejects.toThrow('Stale node generation');
});
