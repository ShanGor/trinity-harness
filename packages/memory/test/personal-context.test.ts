import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type {
  MemoryEvolutionStorePort,
  MemoryFact,
  SessionMeta,
  PersonalContextPort,
} from '@trinity-harness/contracts';
import { EvolutionPersonalContext } from '../src/index.js';

const meta: SessionMeta = {
  id: randomUUID(),
  tenantId: randomUUID(),
  userId: randomUUID(),
  scope: 'personal',
  kind: 'chat',
  sessionRole: 'side',
  title: 'Test',
  workspaceUri: null,
  createdAt: new Date().toISOString(),
};
function fact(text: string, revision: number): MemoryFact {
  return {
    factId: randomUUID(),
    kind: 'preference',
    text,
    revision,
    validFrom: meta.createdAt,
    validTo: null,
    source: {
      sourceEpisodeId: randomUUID(),
      sourceEventId: randomUUID(),
      sourceSessionId: randomUUID(),
      sourceQuote: text,
    },
  };
}
function fixture(items: MemoryFact[]) {
  const baseline: PersonalContextPort = {
    select: async (_meta, promptId) => ({
      version: 2,
      promptId,
      policyRevision: 0,
      memories: [],
      episodes: [],
      omitted: false,
    }),
    validate: vi.fn(async () => undefined),
  };
  const memory: Pick<MemoryEvolutionStorePort, 'contextRevision' | 'activeFacts'> = {
    contextRevision: vi.fn(async () => 10),
    activeFacts: vi.fn(async (_owner, query) =>
      items.filter((item) => item.text.toLowerCase().includes(query.query!.toLowerCase())),
    ),
  };
  // Selection does not read session history; no implementation package dependency.
  const store = { load: async () => [] } as unknown as ConstructorParameters<
    typeof EvolutionPersonalContext
  >[2];
  return {
    memory,
    context: new EvolutionPersonalContext(baseline, memory as MemoryEvolutionStorePort, store),
  };
}
it('automatically selects only related active references, bounded to five facts and 8 KiB', async () => {
  const relevant = Array.from({ length: 8 }, (_, index) =>
    fact(`Tea preference ${index}`, index + 1),
  );
  const retired = { ...fact('Tea retired', 9), validTo: meta.createdAt };
  const f = fixture([...relevant, retired, fact('Coffee only', 10)]);
  const receipt = await f.context.select(meta, randomUUID(), 'What tea do I prefer?');
  expect(receipt.injectedFacts).toHaveLength(5);
  expect(receipt.injectedFacts?.[0]?.revision).toBe(8);
  expect(receipt.facts).toEqual(receipt.injectedFacts);
  expect(receipt.evolutionRevision).toBe(10);
  expect(receipt.omitted).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(receipt.injectedFacts))).toBeLessThanOrEqual(8000);
});
it('does not read personal facts for team scopes or functional-word-only queries', async () => {
  const f = fixture([fact('Tea', 1)]);
  expect(
    (await f.context.select({ ...meta, scope: 'team' }, randomUUID(), 'Tea')).injectedFacts,
  ).toBeUndefined();
  expect(
    (await f.context.select(meta, randomUUID(), 'Where am I now?')).injectedFacts,
  ).toBeUndefined();
  expect(f.memory.activeFacts).not.toHaveBeenCalled();
});
it('retains the baseline if discovery fails or changes, and propagates cancellation', async () => {
  const f = fixture([fact('Tea', 1)]);
  vi.mocked(f.memory.contextRevision).mockResolvedValueOnce(1).mockResolvedValueOnce(2);
  expect((await f.context.select(meta, randomUUID(), 'Tea')).injectedFacts).toBeUndefined();
  vi.mocked(f.memory.activeFacts).mockRejectedValueOnce(new Error('offline'));
  expect((await f.context.select(meta, randomUUID(), 'Tea')).injectedFacts).toBeUndefined();
  await expect(f.context.select(meta, randomUUID(), 'Tea', AbortSignal.abort())).rejects.toThrow();
});
