import { describe, expect, it, vi } from 'vitest';
import { fuseEpisodes, SemanticRecall, reconcileEmbeddings } from '../../src/index.js';
import {
  evaluationClock,
  evaluationEpisodes,
  evaluationQuestions,
  lexicalFixture,
} from './fixtures.js';
import {
  recallReceiptSchema,
  type ConversationIndexPort,
  type EmbeddingPort,
  type EpisodeVectorPort,
} from '@trinity-harness/contracts';

const owner = { tenantId: 'tenant', userId: 'owner', role: 'member' as const };
const context = { sessionId: 'session', promptId: 'prompt' };
const index: ConversationIndexPort = {
  history: async (_owner, q) => ({
    episodes: lexicalFixture(q.query ?? '').slice(0, q.limit),
    nextBefore: null,
  }),
  revise: async () => undefined,
};
describe('memory retrieval evaluation gate', () => {
  it('records the deterministic lexical baseline', async () => {
    const score = evaluationQuestions.filter((q) => {
      const actual = lexicalFixture(q.query)[0];
      return q.expected === null
        ? !actual
        : actual?.episodeId === evaluationEpisodes[q.expected]!.episodeId;
    }).length;
    expect(score).toBe(3);
  });
  it('fuses fake semantic retrieval at least as well as the lexical fixture', () => {
    let correct = 0;
    for (const question of evaluationQuestions) {
      const vector = question.expected === null ? [] : [evaluationEpisodes[question.expected]!];
      const ranked = fuseEpisodes(lexicalFixture(question.query), vector, evaluationClock, 1);
      if (
        question.expected === null
          ? !ranked.length
          : ranked[0]?.episode.episodeId === evaluationEpisodes[question.expected]!.episodeId
      )
        correct++;
    }
    expect(correct).toBe(6);
  });
  it('deduplicates each rank list and deterministically decays old evidence', () => {
    const [old, recent] = evaluationEpisodes;
    const result = fuseEpisodes([old!, recent!, old!], [recent!], evaluationClock, 10);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ episode: recent, source: 'both' });
    expect(() => fuseEpisodes([], [], evaluationClock, 5, 0)).toThrow();
  });
  it('preserves baseline responses exactly with no embedding capability', async () => {
    const recall = new SemanticRecall(index);
    const query = { query: 'launch', timezone: 'UTC', limit: 1 };
    expect(await recall.searchEpisodes(owner, query, context)).toEqual(
      await index.history(owner, query),
    );
  });
  it('falls back on provider failure and propagates cancellation', async () => {
    const embedding: EmbeddingPort = {
      model: 'fake/test',
      embed: async () => {
        throw new Error('offline');
      },
    };
    const vectors = {} as EpisodeVectorPort;
    const recall = new SemanticRecall(index, vectors, embedding);
    const query = { query: 'launch', timezone: 'UTC', limit: 1 };
    expect(await recall.searchEpisodes(owner, query, context)).toEqual(
      await index.history(owner, query),
    );
    await expect(
      recall.searchEpisodes(owner, query, { ...context, signal: AbortSignal.abort() }),
    ).rejects.toThrow();
  });
  it('keeps functional-word ILIKE matches out of hybrid ranks without changing the embedding query', async () => {
    const history = vi.fn(async () => ({ episodes: [], nextBefore: null }));
    const embed = vi.fn(async () => ({ vectors: [[1, 0]], dimensions: 2, model: 'fake/test' }));
    const vectors: EpisodeVectorPort = {
      validate: async () => undefined,
      pending: async () => [],
      complete: async () => undefined,
      search: async () => [evaluationEpisodes[2]!],
    };
    const recall = new SemanticRecall({ ...index, history }, vectors, {
      model: 'fake/test',
      embed,
    });
    const query = { query: 'What food do I prefer?', timezone: 'UTC', limit: 10 };
    const result = await recall.searchEpisodes(owner, query, context);
    expect(history).toHaveBeenCalledWith(owner, { ...query, query: 'food prefer', limit: 50 });
    expect(embed).toHaveBeenCalledWith([query.query], expect.objectContaining({ owner }));
    expect(result.episodes).toEqual([evaluationEpisodes[2]]);

    history.mockClear();
    await recall.searchEpisodes(owner, { ...query, query: 'Where am I now?' }, context);
    expect(history).not.toHaveBeenCalled();
    embed.mockRejectedValueOnce(new Error('offline'));
    await recall.searchEpisodes(owner, query, context);
    expect(history).toHaveBeenLastCalledWith(owner, query);
  });
  it('interruption before publication leaves the job pending for a later tick', async () => {
    let complete = false;
    const vectors: EpisodeVectorPort = {
      validate: async () => undefined,
      pending: async () =>
        complete ? [] : [{ owner, episode: evaluationEpisodes[0]!, contentHash: 'hash' }],
      complete: async () => {
        complete = true;
      },
      search: async () => [],
    };
    const interrupted: EmbeddingPort = {
      model: 'fake/test',
      embed: async () => {
        throw new Error('interrupted');
      },
    };
    expect(await reconcileEmbeddings(vectors, interrupted, new AbortController().signal)).toEqual({
      completed: 0,
      failed: 1,
    });
    expect(complete).toBe(false);
    await reconcileEmbeddings(
      vectors,
      {
        model: 'fake/test',
        embed: async () => ({ vectors: [[1, 0]], dimensions: 2, model: 'fake/test' }),
      },
      new AbortController().signal,
    );
    expect(await vectors.pending('fake/test', 20)).toEqual([]);
  });
  it('replays legacy v2 and additive v3 receipts together', () => {
    const legacy = {
      version: 2,
      promptId: evaluationEpisodes[0]!.promptId,
      policyRevision: 0,
      memories: [],
      episodes: [],
      omitted: false,
    };
    expect(recallReceiptSchema.parse(legacy).version).toBe(2);
    expect(
      recallReceiptSchema.parse({
        ...legacy,
        version: 3,
        recallMode: 'hybrid',
        evolutionRevision: 0,
      }).version,
    ).toBe(3);
  });
});
