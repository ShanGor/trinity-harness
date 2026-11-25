import { memorySearchTerms } from '@trinity-harness/contracts';
import type {
  ConversationIndexPort,
  EmbeddingPort,
  EpisodeVectorPort,
  HistoryQuery,
  Identity,
  SemanticRecallPort,
  HybridRecallPage,
} from '@trinity-harness/contracts';
import { fuseEpisodes } from './ranking.js';

// ILIKE is OR-based: pronouns/auxiliaries can match almost every episode ("do" even
// matches "dog"). Do not let those accidental matches compete with semantic hits.
// Keep this local to hybrid retrieval so the disabled/failure baseline stays exact.
const functionalTerms = new Set([
  'i',
  'me',
  'my',
  'mine',
  'we',
  'us',
  'ours',
  'your',
  'yours',
  'he',
  'him',
  'his',
  'she',
  'her',
  'hers',
  'it',
  'its',
  'they',
  'them',
  'their',
  'theirs',
  'do',
  'does',
  'is',
  'am',
  'are',
  'be',
  'been',
  'being',
  'where',
  'when',
  'how',
  'why',
  'which',
  'now',
  'currently',
]);

export function memoryRecallTerms(query: string): string[] {
  return memorySearchTerms(query).filter((term) => !functionalTerms.has(term));
}

export class SemanticRecall implements SemanticRecallPort {
  constructor(
    private readonly index: ConversationIndexPort,
    private readonly vectors?: EpisodeVectorPort,
    private readonly embedding?: EmbeddingPort,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async searchEpisodes(
    owner: Identity,
    query: HistoryQuery,
    context: Parameters<SemanticRecallPort['searchEpisodes']>[2],
  ): Promise<HybridRecallPage> {
    context.signal?.throwIfAborted();
    // Missing capability, pagination and date-only navigation retain exact baseline bytes/cursors.
    if (!this.embedding || !this.vectors || !query.query?.trim() || query.before)
      return this.index.history(owner, query);
    const terms = memoryRecallTerms(query.query);
    const lexical = terms.length
      ? await this.index.history(owner, { ...query, query: terms.join(' '), limit: 50 })
      : { episodes: [], nextBefore: null };
    try {
      const embedded = await this.embedding.embed([query.query], {
        purpose: 'memory-embedding',
        owner,
        ...context,
      });
      const vector = await this.vectors.search(
        owner,
        { ...query, limit: 50 },
        embedded.vectors[0]!,
        embedded.model,
      );
      context.signal?.throwIfAborted();
      const ranked = fuseEpisodes(lexical.episodes, vector, this.now(), query.limit);
      return {
        episodes: ranked.map((r) => r.episode),
        nextBefore: null,
        recallMode: 'hybrid',
        ranks: ranked.map((r) => ({ episodeId: r.episode.episodeId, source: r.source })),
      };
    } catch {
      context.signal?.throwIfAborted();
      // Re-read the original bounded page: no changed baseline pagination on provider failure.
      return this.index.history(owner, query);
    }
  }
}

export async function reconcileEmbeddings(
  vectors: EpisodeVectorPort,
  embedding: EmbeddingPort,
  signal: AbortSignal,
): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;
  for (const job of await vectors.pending(embedding.model, 20, signal)) {
    signal.throwIfAborted();
    try {
      await vectors.validate(job, signal);
      const result = await embedding.embed([`${job.episode.request}\n${job.episode.outcome}`], {
        purpose: 'memory-embedding',
        owner: job.owner,
        sessionId: job.episode.sessionId,
        promptId: job.episode.promptId,
        signal,
        beforeDispatch: () => vectors.validate(job, signal),
      });
      await vectors.complete(job, result.vectors[0]!, result.model, signal);
      completed++;
    } catch {
      signal.throwIfAborted();
      failed++;
    }
  }
  return { completed, failed };
}
