import type pg from 'pg';
import {
  browserRuntimeRecordSchema,
  browserRuntimeResultSchema,
  browserCommandRecordSchema,
  type BrowserRuntimeStore,
  type BrowserRuntimeRecord,
  type BrowserRuntimeResult,
} from '@trinity-harness/contracts';

export class PgBrowserRuntimeStore implements BrowserRuntimeStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly lockPool: pg.Pool = pool,
  ) {}
  async run<T>(
    sessionId: string,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const client = await this.lockPool.connect();
    const lost = new AbortController();
    let locked = false;
    let destroyed = false;
    const disconnect = (): void => {
      lost.abort();
    };
    const abort = (): void => {
      lost.abort();
      if (!locked && !destroyed) {
        destroyed = true;
        client.release(true);
      }
    };
    client.on('error', disconnect);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      lost.signal.throwIfAborted();
      await client.query('SELECT pg_advisory_lock(hashtextextended($1, 7843))', [sessionId]);
      locked = true;
      lost.signal.throwIfAborted();
      return await action(lost.signal);
    } finally {
      signal?.removeEventListener('abort', abort);
      client.removeListener('error', disconnect);
      if (!destroyed) {
        try {
          if (locked && !lost.signal.aborted)
            await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 7843))', [
              sessionId,
            ]);
        } finally {
          client.release(lost.signal.aborted);
        }
      }
    }
  }
  async binding(sessionId: string): Promise<BrowserRuntimeRecord | null> {
    const result = await this.pool.query<{
      session_id: string;
      generation: string;
      owner: string;
      status: string;
    }>('SELECT * FROM browser_runtimes WHERE session_id=$1', [sessionId]);
    const row = result.rows[0];
    return row
      ? browserRuntimeRecordSchema.parse({
          sessionId: row.session_id,
          generation: row.generation,
          owner: row.owner,
          status: row.status,
        })
      : null;
  }
  async bind(input: BrowserRuntimeRecord): Promise<void> {
    const record = browserRuntimeRecordSchema.parse(input);
    await this.pool.query(
      'INSERT INTO browser_runtimes(session_id,generation,owner,status) VALUES($1,$2,$3,$4) ON CONFLICT(session_id) DO UPDATE SET generation=excluded.generation,owner=excluded.owner,status=excluded.status',
      [record.sessionId, record.generation, record.owner, record.status],
    );
  }
  async command(
    sessionId: string,
    callId: string,
  ): Promise<{ hash: string; result: BrowserRuntimeResult | null } | null> {
    const result = await this.pool.query<{ request_hash: string; result: unknown }>(
      'SELECT request_hash,result FROM browser_commands WHERE session_id=$1 AND call_id=$2',
      [sessionId, callId],
    );
    const row = result.rows[0];
    return row
      ? browserCommandRecordSchema.parse({
          hash: row.request_hash,
          result: row.result === null ? null : browserRuntimeResultSchema.parse(row.result),
        })
      : null;
  }
  async begin(sessionId: string, callId: string, hash: string, generation: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO browser_commands(session_id,call_id,request_hash,generation) VALUES($1,$2,$3,$4)',
      [sessionId, callId, hash, generation],
    );
  }
  async finish(sessionId: string, callId: string, result: BrowserRuntimeResult): Promise<void> {
    const parsed = browserRuntimeResultSchema.parse(result);
    const written = await this.pool.query(
      'UPDATE browser_commands SET result=$3 WHERE session_id=$1 AND call_id=$2 AND result IS NULL',
      [sessionId, callId, JSON.stringify(parsed)],
    );
    if (written.rowCount !== 1) throw new Error('Browser journal outcome conflict');
  }
}
