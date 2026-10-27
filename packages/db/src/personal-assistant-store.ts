import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import {
  episodeChangeSchema as changeSchema,
  memoryCommandSchema,
  validateMemoryCommand,
  memoryPredicateKey,
  savedMemorySchema,
  topicEpisodeSchema,
  type Identity,
  type MemoryCommand,
  type SavedMemory,
  type MemorySnapshot,
  type MemoryStorePort,
  type ConversationIndexPort,
  type TopicEpisode,
  type HistoryQuery,
} from '@trinity-harness/contracts';
import type { Db } from './client.js';
import {
  memoryEvents,
  conversationEpisodes,
  episodeChanges,
  sessions,
  sessionEvents,
} from './schema.js';

type Transaction = Parameters<Parameters<Db['transaction']>[0]>[0];

function conflict(): never {
  throw Object.assign(new Error('Memory changed; refresh before editing.'), {
    code: 'MEMORY_CONFLICT',
  });
}

function memoryFailure(error: unknown): never {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string' &&
    error.code.startsWith('MEMORY_')
  )
    throw error;
  // Driver errors can contain bound JSON values. Keep them out of events/logs.
  throw Object.assign(new Error('Durable memory is unavailable.'), { code: 'MEMORY_UNAVAILABLE' });
}

export class PgMemoryStore implements MemoryStorePort {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}
  async snapshot(identity: Identity): Promise<MemorySnapshot> {
    const where = and(
      eq(memoryEvents.tenantId, identity.tenantId),
      eq(memoryEvents.userId, identity.userId),
    );
    const rows = await this.db
      .selectDistinctOn([memoryEvents.memoryId])
      .from(memoryEvents)
      .where(where)
      .orderBy(memoryEvents.memoryId, desc(memoryEvents.revision))
      .limit(501);
    if (rows.length > 500) throw new Error('Memory scope requires pagination before recall');
    const items = rows.map((row) => savedMemorySchema.parse(row.payload));
    return {
      items,
      revision: Math.max(0, ...rows.map((row) => row.revision)),
      hasSuppression: items.some((item) => item.status === 'forgotten' || item.revision > 1),
    };
  }
  async change(identity: Identity, raw: MemoryCommand): Promise<SavedMemory> {
    const command = memoryCommandSchema.parse(raw);
    validateMemoryCommand(command);
    if (identity.role === 'viewer') throw new Error('Memory is read-only');
    return this.db.transaction((tx) => this.apply(tx, identity, command)).catch(memoryFailure);
  }
  async changeMany(identity: Identity, commands: readonly MemoryCommand[]): Promise<SavedMemory[]> {
    if (identity.role === 'viewer') throw new Error('Memory is read-only');
    const parsed = commands.map((command) => {
      const parsed = memoryCommandSchema.parse(command);
      validateMemoryCommand(parsed);
      return parsed;
    });
    return this.db
      .transaction(async (tx) => {
        const results: SavedMemory[] = [];
        for (const command of parsed) results.push(await this.apply(tx, identity, command));
        return results;
      })
      .catch(memoryFailure);
  }
  private async apply(
    tx: Transaction,
    identity: Identity,
    command: MemoryCommand,
  ): Promise<SavedMemory> {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`memory:${identity.tenantId}:${identity.userId}`}))`,
    );
    const scope = and(
      eq(memoryEvents.tenantId, identity.tenantId),
      eq(memoryEvents.userId, identity.userId),
    );
    const [retry] = await tx
      .select()
      .from(memoryEvents)
      .where(and(scope, eq(memoryEvents.operationId, command.operationId)))
      .limit(1);
    if (retry) return savedMemorySchema.parse(retry.payload);
    const [previous] = await tx
      .select()
      .from(memoryEvents)
      .where(and(scope, eq(memoryEvents.memoryId, command.memoryId)))
      .orderBy(desc(memoryEvents.revision))
      .limit(1);
    const prior = previous ? savedMemorySchema.parse(previous.payload) : null;
    if (!prior) {
      const current = await tx
        .selectDistinctOn([memoryEvents.memoryId])
        .from(memoryEvents)
        .where(scope)
        .orderBy(memoryEvents.memoryId, desc(memoryEvents.revision))
        .limit(500);
      if (current.length >= 500)
        throw Object.assign(new Error('Memory capacity reached; edit an existing item.'), {
          code: 'MEMORY_CAPACITY',
        });
      if (
        current.some((row) => {
          const item = savedMemorySchema.parse(row.payload);
          return (
            item.status === 'active' &&
            item.subject.toLowerCase() === command.subject.toLowerCase() &&
            memoryPredicateKey(item.predicate) === memoryPredicateKey(command.predicate)
          );
        })
      )
        conflict();
    }
    if (
      (prior?.revision ?? 0) !== command.expectedRevision ||
      (command.operation === 'forget' && !prior)
    )
      conflict();
    if (prior?.status === 'forgotten') conflict();
    if (prior && command.source?.at && command.source.at < (prior.source?.at ?? prior.recordedAt))
      conflict();
    const [last] = await tx
      .select({ revision: memoryEvents.revision })
      .from(memoryEvents)
      .where(scope)
      .orderBy(desc(memoryEvents.revision))
      .limit(1);
    const item = savedMemorySchema.parse({
      memoryId: command.memoryId,
      revision: (prior?.revision ?? 0) + 1,
      subject: prior?.subject ?? command.subject,
      predicate: prior?.predicate ?? command.predicate,
      value: command.operation === 'forget' ? prior!.value : command.value,
      status: command.operation === 'forget' ? 'forgotten' : 'active',
      recordedAt: this.now().toISOString(),
      source: command.source ?? prior?.source,
    });
    await tx.insert(memoryEvents).values({
      tenantId: identity.tenantId,
      userId: identity.userId,
      revision: (last?.revision ?? 0) + 1,
      operationId: command.operationId,
      memoryId: item.memoryId,
      payload: item,
    });
    return item;
  }
}

export class PgConversationIndex implements ConversationIndexPort {
  constructor(private readonly db: Db) {}
  async evidence(identity: Identity, episodeId: string): Promise<TopicEpisode | null> {
    const [row] = await this.db
      .select({ payload: conversationEpisodes.payload })
      .from(conversationEpisodes)
      .innerJoin(sessions, eq(sessions.id, conversationEpisodes.sessionId))
      .where(
        and(
          eq(conversationEpisodes.tenantId, identity.tenantId),
          eq(conversationEpisodes.userId, identity.userId),
          eq(sessions.scope, 'personal'),
          sql`${sessions.closedAt} is null`,
          sql`not exists (select 1 from ${sessionEvents} removed where removed.session_id = ${conversationEpisodes.sessionId} and removed.type = 'message/removed' and removed.payload->>'promptId' = ${conversationEpisodes.payload}->>'promptId')`,
          sql`${conversationEpisodes.payload}->>'episodeId' = ${episodeId}`,
        ),
      )
      .limit(1);
    if (!row) return null;
    const episode = topicEpisodeSchema.parse(row.payload);
    const [change] = await this.db
      .select()
      .from(episodeChanges)
      .where(
        and(
          eq(episodeChanges.tenantId, identity.tenantId),
          eq(episodeChanges.userId, identity.userId),
          eq(episodeChanges.episodeId, episodeId),
        ),
      )
      .orderBy(desc(episodeChanges.id))
      .limit(1);
    return change ? { ...episode, ...changeSchema.parse(change.payload) } : episode;
  }
  async history(
    identity: Identity,
    query: HistoryQuery,
  ): Promise<{ episodes: TopicEpisode[]; nextBefore: number | null }> {
    // Date formatting validates the IANA name and handles DST using persisted UTC timestamps.
    const date = new Intl.DateTimeFormat('en-CA', {
      timeZone: query.timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const stop = new Set([
      'the',
      'and',
      'what',
      'was',
      'were',
      'did',
      'this',
      'that',
      'you',
      'can',
      'for',
      'from',
      'with',
      'about',
      'have',
      'our',
      'back',
      'continue',
    ]);
    const terms = (query.query?.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [])
      .filter((term) => !stop.has(term))
      .slice(0, 10);
    const searchable = sql`((${conversationEpisodes.payload}->>'request') || ' ' || (${conversationEpisodes.payload}->>'outcome') || ' ' || coalesce((select payload->>'topic' from episode_changes c where c.tenant_id = ${identity.tenantId} and c.user_id = ${identity.userId} and c.episode_id = ${conversationEpisodes.payload}->>'episodeId' order by c.id desc limit 1), ${conversationEpisodes.payload}->>'topic'))`;
    const rows = await this.db
      .select({ id: conversationEpisodes.id, payload: conversationEpisodes.payload })
      .from(conversationEpisodes)
      .innerJoin(sessions, eq(sessions.id, conversationEpisodes.sessionId))
      .where(
        and(
          eq(conversationEpisodes.tenantId, identity.tenantId),
          eq(conversationEpisodes.userId, identity.userId),
          eq(sessions.scope, 'personal'),
          sql`${sessions.closedAt} is null`,
          sql`not exists (select 1 from ${sessionEvents} removed where removed.session_id = ${conversationEpisodes.sessionId} and removed.type = 'message/removed' and removed.payload->>'promptId' = ${conversationEpisodes.payload}->>'promptId')`,
          query.before ? lt(conversationEpisodes.id, query.before) : undefined,
          terms.length
            ? or(...terms.map((term) => sql`${searchable} ilike ${`%${term}%`}`))
            : undefined,
          query.date
            ? sql`((${conversationEpisodes.payload}->>'at')::timestamptz at time zone ${query.timezone})::date = ${query.date}::date`
            : undefined,
        ),
      )
      .orderBy(desc(conversationEpisodes.id))
      .limit(query.limit + 1);
    const episodes: TopicEpisode[] = [];
    // Query pages stay bounded even if no row matches; caller follows nextBefore.
    for (const row of rows.slice(0, query.limit)) {
      let episode = topicEpisodeSchema.parse(row.payload);
      const changes = await this.db
        .select()
        .from(episodeChanges)
        .where(
          and(
            eq(episodeChanges.tenantId, identity.tenantId),
            eq(episodeChanges.userId, identity.userId),
            eq(episodeChanges.episodeId, episode.episodeId),
          ),
        )
        .orderBy(desc(episodeChanges.id))
        .limit(1);
      if (changes[0]) episode = { ...episode, ...changeSchema.parse(changes[0].payload) };
      if (query.date && date.format(new Date(episode.at)) !== query.date) continue;
      episodes.push(episode);
    }
    return { episodes, nextBefore: rows.length > query.limit ? rows[query.limit - 1]!.id : null };
  }
  async revise(
    identity: Identity,
    episodeId: string,
    raw: { topic?: string; excluded?: boolean },
  ): Promise<void> {
    if (identity.role === 'viewer') throw new Error('History is read-only');
    const change = changeSchema.parse(raw);
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`episode:${identity.tenantId}:${identity.userId}:${episodeId}`}))`,
      );
      const [row] = await tx
        .select()
        .from(conversationEpisodes)
        .where(
          and(
            eq(conversationEpisodes.tenantId, identity.tenantId),
            eq(conversationEpisodes.userId, identity.userId),
            sql`${conversationEpisodes.payload}->>'episodeId' = ${episodeId}`,
          ),
        )
        .limit(1);
      if (!row) throw new Error('Episode not found');
      // Store a complete override so changing a topic never clears an exclusion.
      const [last] = await tx
        .select()
        .from(episodeChanges)
        .where(
          and(
            eq(episodeChanges.tenantId, identity.tenantId),
            eq(episodeChanges.userId, identity.userId),
            eq(episodeChanges.episodeId, episodeId),
          ),
        )
        .orderBy(desc(episodeChanges.id))
        .limit(1);
      await tx.insert(episodeChanges).values({
        tenantId: identity.tenantId,
        userId: identity.userId,
        episodeId,
        payload: { ...(last ? changeSchema.parse(last.payload) : {}), ...change },
      });
    });
  }
}
