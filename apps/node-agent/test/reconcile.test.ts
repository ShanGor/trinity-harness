import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { reconcileNodeEnvironments } from '../src/reconcile.js';
import type { EnvironmentRecord, NodeRuntimeResult } from '@trinity-harness/contracts';

function record(state: EnvironmentRecord['state']): EnvironmentRecord {
  return {
    id: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    nodeId: 'node-1',
    generation: randomUUID(),
    state,
    vcpus: 2,
    memoryMiB: 2048,
  };
}

function result(record: EnvironmentRecord, state: EnvironmentRecord['state']): NodeRuntimeResult {
  return { generation: record.generation, state };
}

it('marks a stale running environment stopped when the VMM is gone after a reboot', async () => {
  const stale = record('running');
  const transition = vi.fn(async (r: EnvironmentRecord, state: EnvironmentRecord['state']) => ({
    ...r,
    state,
  }));
  const runtime = { command: vi.fn(async () => result(stale, 'stopped')) };
  const outcome = await reconcileNodeEnvironments(
    { listNodeEnvironments: async () => [stale], transition },
    runtime,
    'node-1',
  );
  expect(outcome).toEqual({ reconciled: 1 });
  expect(runtime.command).toHaveBeenCalledWith('status', stale);
  expect(transition).toHaveBeenCalledWith(stale, 'stopped', 'running');
});

it('keeps a live VM running when only the node agent restarted', async () => {
  const live = record('running');
  const transition = vi.fn(async (r: EnvironmentRecord, state: EnvironmentRecord['state']) => ({
    ...r,
    state,
  }));
  const outcome = await reconcileNodeEnvironments(
    { listNodeEnvironments: async () => [live], transition },
    { command: vi.fn(async () => result(live, 'running')) },
    'node-1',
  );
  expect(outcome).toEqual({ reconciled: 0 });
  expect(transition).toHaveBeenCalledWith(live, 'running', 'running');
});

it('converges a boot-time starting environment to the probed state', async () => {
  const starting = record('starting');
  const transition = vi.fn(async (r: EnvironmentRecord, state: EnvironmentRecord['state']) => ({
    ...r,
    state,
  }));
  const outcome = await reconcileNodeEnvironments(
    { listNodeEnvironments: async () => [starting], transition },
    { command: vi.fn(async () => result(starting, 'starting')) },
    'node-1',
  );
  expect(outcome).toEqual({ reconciled: 0 });
});

it('fails closed into quarantined when the runtime cannot confirm VM state', async () => {
  const lost = record('running');
  const transition = vi.fn(async (r: EnvironmentRecord, state: EnvironmentRecord['state']) => ({
    ...r,
    state,
  }));
  const outcome = await reconcileNodeEnvironments(
    { listNodeEnvironments: async () => [lost], transition },
    { command: vi.fn(async () => Promise.reject(new Error('node operation unavailable'))) },
    'node-1',
  );
  expect(outcome).toEqual({ reconciled: 0 });
  expect(transition).toHaveBeenCalledWith(lost, 'quarantined', 'running');
});

it('skips stopped and quarantined environments without probing them', async () => {
  const stopped = record('stopped');
  const quarantined = record('quarantined');
  const command = vi.fn();
  const transition = vi.fn();
  const outcome = await reconcileNodeEnvironments(
    { listNodeEnvironments: async () => [stopped, quarantined], transition },
    { command },
    'node-1',
  );
  expect(outcome).toEqual({ reconciled: 0 });
  expect(command).not.toHaveBeenCalled();
  expect(transition).not.toHaveBeenCalled();
});

it('scopes reconciliation through the node-scoped store query', async () => {
  const mine = record('running');
  const listNodeEnvironments = vi.fn(async () => [mine]);
  const command = vi.fn(async () => result(mine, 'stopped'));
  const transition = vi.fn(async (r: EnvironmentRecord, state: EnvironmentRecord['state']) => ({
    ...r,
    state,
  }));
  await reconcileNodeEnvironments({ listNodeEnvironments, transition }, { command }, 'node-1');
  expect(listNodeEnvironments).toHaveBeenCalledWith('node-1');
  expect(command).toHaveBeenCalledTimes(1);
  expect(command).toHaveBeenCalledWith('status', mine);
});
