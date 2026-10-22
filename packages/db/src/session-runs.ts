import type pg from 'pg';
import {
  queuedPromptEventSchema,
  type TurnTask,
  type SessionRunPort,
} from '@trinity-harness/contracts';

/** Connection lifetime is the lock lifetime, including crash recovery. */
export class PgSessionRuns implements SessionRunPort {
  constructor(private readonly pool: pg.Pool) {}
  async pending(afterSessionId?: string): Promise<TurnTask[]> {
    const rows = await this.pool.query<{ session_id: string; seq: string; payload: unknown }>(
      `select distinct on (q.session_id) q.session_id, q.seq, q.payload from session_events q join sessions s on s.id=q.session_id where q.type='prompt/queued' and s.closed_at is null and ($1::uuid is null or q.session_id > $1::uuid) and not exists (select 1 from session_events t where t.session_id=q.session_id and t.type in ('turn/end','prompt/discarded') and t.payload->>'promptId'=q.payload->>'promptId') order by q.session_id, q.seq desc limit 100`,
      [afterSessionId ?? null],
    );
    return rows.rows.map((row) => {
      const event = queuedPromptEventSchema.parse(row.payload);
      return {
        sessionId: row.session_id,
        promptSeq: Number(row.seq),
        prompt: event.content
          .filter((block) => block.kind === 'text')
          .map((block) => (block.kind === 'text' ? block.text : ''))
          .join('\n'),
        content: event.content,
        actor: event.actor,
        tenantId: event.tenantId,
        policy: event.policy,
      };
    });
  }
  async run<T>(sessionId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const client = await this.pool.connect();
    if (signal?.aborted) {
      client.release();
      signal.throwIfAborted();
    }
    let locked = false;
    let destroyed = false;
    const abortWait = (): void => {
      if (!locked && !destroyed) {
        destroyed = true;
        client.release(true);
      }
    };
    signal?.addEventListener('abort', abortWait, { once: true });
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 42))', [sessionId]);
      locked = true;
      signal?.removeEventListener('abort', abortWait);
      signal?.throwIfAborted();
      return await operation();
    } finally {
      signal?.removeEventListener('abort', abortWait);
      if (!destroyed) {
        try {
          if (locked)
            await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 42))', [sessionId]);
        } finally {
          client.release();
        }
      }
    }
  }
}
