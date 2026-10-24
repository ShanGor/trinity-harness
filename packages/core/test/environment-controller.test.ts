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
    get: async () => record,
    reserve: async () => record,
    authorizeNode: async () => true,
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
