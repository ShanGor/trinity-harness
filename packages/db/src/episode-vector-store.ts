import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  topicEpisodeSchema,
  type EmbeddingJob,
  type EpisodeVectorPort,
  type HistoryQuery,
  type Identity,
  type TopicEpisode,
} from '@trinity-harness/contracts';
import type { Db } from './client.js';
import { episodeEmbeddings as vectors } from './schema.js';

const vectorSchema = z
  .array(z.number().finite())
  .min(1)
  .max(16000)
  .refine((v) => v.some((n) => n !== 0));
function hash(episode: TopicEpisode): string {
  return createHash('sha256').update(`${episode.request}\n${episode.outcome}`).digest('hex');
}
/** Exact same ownership/deletion/exclusion/policy fences as lexical retrieval, before ranking. */
function eligibility(owner: Identity, query: HistoryQuery): ReturnType<typeof sql> {
  return sql`e.tenant_id = ${owner.tenantId} and e.user_id = ${owner.userId}
    and s.tenant_id = e.tenant_id and s.user_id = e.user_id and s.scope = 'personal' and s.closed_at is null
    and not coalesce((e.payload->>'excluded')::boolean, false)
    and not coalesce((select (c.payload->>'excluded')::boolean from episode_changes c where c.tenant_id = e.tenant_id and c.user_id = e.user_id and c.episode_id = e.payload->>'episodeId' order by c.id desc limit 1), false)
    and not exists (select 1 from session_events removed where removed.session_id = e.session_id and removed.type = 'message/removed' and removed.payload->>'promptId' = e.payload->>'promptId')
    ${query.minPolicyRevision === undefined ? sql`` : sql`and coalesce((e.payload->>'policyRevision')::bigint, 0) >= ${query.minPolicyRevision}`}
    ${query.date ? sql`and ((e.payload->>'at')::timestamptz at time zone ${query.timezone})::date = ${query.date}::date` : sql``}
    ${query.before ? sql`and e.id < ${query.before}` : sql``}`;
}
export class PgEpisodeVectorStore implements EpisodeVectorPort {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async validate(job: EmbeddingJob, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const rows = await this.db
      .execute(sql`select e.payload from conversation_episodes e join sessions s on s.id = e.session_id
      left join user_personas p on p.tenant_id = e.tenant_id and p.user_id = e.user_id
      where ${eligibility(job.owner, { limit: 1, timezone: 'UTC' })} and e.payload->>'episodeId' = ${job.episode.episodeId}
      and coalesce((e.payload->>'policyRevision')::bigint, 0) >= coalesce(p.suppression_revision,
        (select case when bool_or((m.payload->>'revision')::bigint > 1 or m.payload->>'status' = 'forgotten') then coalesce(max(m.revision),0) else 0 end from memory_events m where m.tenant_id = e.tenant_id and m.user_id = e.user_id))`);
    if (
      rows.rows.length !== 1 ||
      hash(topicEpisodeSchema.parse(rows.rows[0]!.payload)) !== job.contentHash
    )
      throw new Error('Memory embedding source changed');
  }
  async search(
    owner: Identity,
    query: HistoryQuery,
    raw: number[],
    model: string,
  ): Promise<TopicEpisode[]> {
    const vector = vectorSchema.parse(raw);
    // MATERIALIZED ensures protected content never participates in similarity ranking.
    const result = await this.db.execute(sql`with eligible as materialized (
      select e.payload, v.embedding from conversation_episodes e join sessions s on s.id = e.session_id
      join episode_embeddings v on v.episode_id = (e.payload->>'episodeId')::uuid and v.tenant_id = e.tenant_id and v.user_id = e.user_id
      where ${eligibility(owner, query)} and v.embedding_model = ${model} and v.dimensions = ${vector.length}
      and v.policy_revision = coalesce((e.payload->>'policyRevision')::bigint, 0)
      and v.content_sha256 = encode(sha256(convert_to((e.payload->>'request') || E'\n' || (e.payload->>'outcome'), 'UTF8')), 'hex')
      and v.embedding is not null)
      select payload from eligible where embedding <=> ${JSON.stringify(vector)}::vector < 0.5
      order by embedding <=> ${JSON.stringify(vector)}::vector, payload->>'episodeId' limit ${Math.min(50, query.limit)}`);
    return result.rows.map((r) => topicEpisodeSchema.parse(r.payload));
  }
  async pending(model: string, limit: number, signal?: AbortSignal): Promise<EmbeddingJob[]> {
    signal?.throwIfAborted();
    return this.db.transaction(async (tx) => {
      // Serialize claims across control workers; committed five-minute leases survive process crashes.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('memory-embedding-reconciler'))`);
      const rows =
        await tx.execute(sql`select e.payload, e.tenant_id, e.user_id from conversation_episodes e join sessions s on s.id = e.session_id
        left join episode_embeddings v on v.episode_id = (e.payload->>'episodeId')::uuid and v.embedding_model = ${model}
        left join user_personas p on p.tenant_id = e.tenant_id and p.user_id = e.user_id
        where s.tenant_id = e.tenant_id and s.user_id = e.user_id and s.scope = 'personal' and s.closed_at is null
        and not coalesce((e.payload->>'excluded')::boolean, false)
        and not coalesce((select (c.payload->>'excluded')::boolean from episode_changes c where c.tenant_id = e.tenant_id and c.user_id = e.user_id and c.episode_id = e.payload->>'episodeId' order by c.id desc limit 1), false)
        and not exists (select 1 from session_events r where r.session_id = e.session_id and r.type = 'message/removed' and r.payload->>'promptId' = e.payload->>'promptId')
        and coalesce((e.payload->>'policyRevision')::bigint, 0) >= coalesce(p.suppression_revision,
          (select case when bool_or((m.payload->>'revision')::bigint > 1 or m.payload->>'status' = 'forgotten') then coalesce(max(m.revision),0) else 0 end from memory_events m where m.tenant_id = e.tenant_id and m.user_id = e.user_id))
        and (v.episode_id is null or v.content_sha256 <> encode(sha256(convert_to((e.payload->>'request') || E'\n' || (e.payload->>'outcome'), 'UTF8')), 'hex')
          or (v.embedding is null and v.attempts < 3 and v.next_attempt_at <= ${this.now().toISOString()}::timestamptz))
        order by e.id limit ${Math.max(1, Math.min(20, limit))}`);
      const jobs: EmbeddingJob[] = [];
      for (const raw of rows.rows) {
        const owner = z.object({ tenant_id: z.uuid(), user_id: z.uuid() }).parse(raw);
        const episode = topicEpisodeSchema.parse(raw.payload);
        const contentHash = hash(episode);
        await tx
          .insert(vectors)
          .values({
            episodeId: episode.episodeId,
            embeddingModel: model,
            tenantId: owner.tenant_id,
            userId: owner.user_id,
            contentSha256: contentHash,
            policyRevision: episode.policyRevision,
            attempts: 1,
            nextAttemptAt: new Date(this.now().getTime() + 300_000).toISOString(),
          })
          .onConflictDoUpdate({
            target: [vectors.episodeId, vectors.embeddingModel],
            set: {
              contentSha256: contentHash,
              policyRevision: episode.policyRevision,
              embedding: null,
              dimensions: null,
              attempts: sql`case when ${vectors.contentSha256} = ${contentHash} then ${vectors.attempts} + 1 else 1 end`,
              nextAttemptAt: new Date(this.now().getTime() + 300_000).toISOString(),
            },
          });
        jobs.push({
          owner: { tenantId: owner.tenant_id, userId: owner.user_id, role: 'member' },
          episode,
          contentHash,
        });
      }
      signal?.throwIfAborted();
      return jobs;
    });
  }
  async complete(
    job: EmbeddingJob,
    raw: number[],
    model: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const vector = vectorSchema.parse(raw);
    signal?.throwIfAborted();
    // The query path revalidates source, hash and policy; stale projections cannot grant recall.
    const result = await this.db
      .update(vectors)
      .set({ embedding: vector, dimensions: vector.length, nextAttemptAt: null })
      .where(
        and(
          eq(vectors.episodeId, job.episode.episodeId),
          eq(vectors.embeddingModel, model),
          eq(vectors.tenantId, job.owner.tenantId),
          eq(vectors.userId, job.owner.userId),
          eq(vectors.contentSha256, job.contentHash),
        ),
      );
    if (result.rowCount !== 1) throw new Error('Memory embedding source changed');
  }
}
