import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { Identity, MemoryStorePort } from '@trinity-harness/contracts';
import { registerMemoryEvolutionApi } from '../src/memory-evolution-api.js';
// Local fake instead of importing another test file (which would register its tests twice).
import type { MemoryEvolutionStorePort } from '@trinity-harness/contracts';
const owner: Identity = { tenantId: randomUUID(), userId: randomUUID(), role: 'member' };
function fake(): MemoryEvolutionStorePort {
  return {
    revision: vi.fn(async () => 0),
    contextRevision: vi.fn(async () => 0),
    propose: vi.fn(),
    invalidate: vi.fn(),
    submit: vi.fn(),
    decide: vi.fn(),
    activeFacts: vi.fn(async () => []),
    list: vi.fn(async () => []),
    history: vi.fn(async () => ({
      revision: 0,
      facts: [],
      candidates: [],
      playbooks: [],
      nextBefore: null,
    })),
    pending: vi.fn(async () => ({
      revision: 0,
      facts: [],
      candidates: [],
      playbooks: [],
      nextBefore: null,
    })),
  };
}
it('reports dormancy with the switch off and requires authentication', async () => {
  const app = Fastify();
  registerMemoryEvolutionApi(app, {});
  expect((await app.inject('/api/memory/evolution')).statusCode).toBe(401);
  await app.close();
  const authenticated = Fastify();
  authenticated.addHook('onRequest', async (req) => {
    req.identity = owner;
  });
  registerMemoryEvolutionApi(authenticated, {});
  expect((await authenticated.inject('/api/memory/evolution')).json()).toEqual({
    available: false,
  });
  expect(
    (
      await authenticated.inject({
        method: 'POST',
        url: '/api/memory/evolution/candidates/decide',
        payload: {},
      })
    ).statusCode,
  ).toBe(503);
  await authenticated.close();
});
it('uses authenticated ownership, bounded schemas and revision fences for adjudication', async () => {
  const evolution = fake();
  const app = Fastify();
  app.addHook('onRequest', async (req) => {
    req.identity = owner;
  });
  registerMemoryEvolutionApi(app, {
    evolution,
    memory: {
      change: vi.fn(),
      snapshot: async () => ({ revision: 3, items: [], hasSuppression: false }),
    } as MemoryStorePort,
  });
  expect((await app.inject('/api/memory/evolution?limit=1000')).statusCode).toBe(400);
  const command = {
    candidateId: randomUUID(),
    operationId: randomUUID(),
    expectedRevision: 0,
    expectedPolicyRevision: 3,
    decision: 'accept',
  };
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/memory/evolution/candidates/decide',
        payload: command,
      })
    ).statusCode,
  ).toBe(200);
  expect(evolution.decide).toHaveBeenCalledWith(owner, command);
  expect(
    (
      await app.inject({
        method: 'POST',
        url: '/api/memory/evolution/candidates/decide',
        payload: { ...command, userId: randomUUID() },
      })
    ).statusCode,
  ).toBe(400);
  await app.close();
});
