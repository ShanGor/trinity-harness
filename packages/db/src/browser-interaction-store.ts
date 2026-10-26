import type pg from 'pg';
import {
  browserControlRecordSchema,
  browserInputRecordSchema,
  type BrowserControlRecord,
  type BrowserInputRecord,
  type BrowserInteractionStore,
} from '@trinity-harness/contracts';

/** All operations run under the supervisor's existing distributed browser lock. */
export class PgBrowserInteractionStore implements BrowserInteractionStore {
  constructor(private readonly pool: pg.Pool) {}
  async get(sessionId: string): Promise<BrowserControlRecord | null> {
    const result = await this.pool.query<{ record: unknown }>(
      'SELECT record FROM browser_controls WHERE session_id=$1',
      [sessionId],
    );
    return result.rows[0] ? browserControlRecordSchema.parse(result.rows[0].record) : null;
  }
  async put(record: BrowserControlRecord): Promise<void> {
    const parsed = browserControlRecordSchema.parse(record);
    await this.pool.query(
      'INSERT INTO browser_controls(session_id,record) VALUES($1,$2) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record',
      [parsed.sessionId, JSON.stringify(parsed)],
    );
  }
  async input(sessionId: string, requestId: string): Promise<BrowserInputRecord | null> {
    const result = await this.pool.query<{ record: unknown; effect: string | null }>(
      'SELECT record,effect FROM browser_user_inputs WHERE session_id=$1 AND request_id=$2',
      [sessionId, requestId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const recorded = browserInputRecordSchema.parse(row.record);
    return browserInputRecordSchema.parse({ ...recorded, effect: row.effect ?? 'unknown' });
  }
  async reserve(record: BrowserControlRecord, requestId: string): Promise<void> {
    const parsed = browserControlRecordSchema.parse(record);
    const input = browserInputRecordSchema.parse({
      generation: parsed.generation,
      epoch: parsed.epoch,
      sequence: parsed.sequence,
      viewId: parsed.controllerId,
      effect: 'unknown',
    });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO browser_user_inputs(session_id,request_id,record) VALUES($1,$2,$3)',
        [parsed.sessionId, requestId, JSON.stringify(input)],
      );
      await client.query(
        'INSERT INTO browser_controls(session_id,record) VALUES($1,$2) ON CONFLICT(session_id) DO UPDATE SET record=excluded.record',
        [parsed.sessionId, JSON.stringify(parsed)],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async finish(
    sessionId: string,
    requestId: string,
    effect: 'applied' | 'none' | 'unknown',
  ): Promise<void> {
    const result = await this.pool.query(
      'UPDATE browser_user_inputs SET effect=$3 WHERE session_id=$1 AND request_id=$2 AND effect IS NULL',
      [sessionId, requestId, effect],
    );
    if (result.rowCount !== 1) throw new Error('Browser input journal outcome conflict');
  }
}
