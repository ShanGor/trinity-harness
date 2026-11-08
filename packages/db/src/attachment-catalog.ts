import { and, eq } from 'drizzle-orm';
import {
  attachmentRecordSchema,
  type AttachmentCatalog,
  type AttachmentRecord,
} from '@trinity-harness/contracts';
import type { Db } from './client.js';
import { attachmentContents, attachmentIngestions } from './schema.js';
import type pg from 'pg';

export class PgAttachmentCatalog implements AttachmentCatalog {
  constructor(
    private readonly db: Db,
    private readonly pool: pg.Pool,
  ) {}
  async run<T>(
    sessionId: string,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const client = await this.pool.connect();
    const lost = new AbortController();
    let locked = false;
    let destroyed = false;
    const disconnect = (): void => lost.abort();
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
      await client.query('select pg_advisory_lock(hashtextextended($1, 473))', [
        `attachments/${sessionId}`,
      ]);
      locked = true;
      lost.signal.throwIfAborted();
      return await action(AbortSignal.any([lost.signal, ...(signal ? [signal] : [])]));
    } finally {
      signal?.removeEventListener('abort', abort);
      client.removeListener('error', disconnect);
      if (!destroyed) {
        try {
          if (locked && !lost.signal.aborted)
            await client.query('select pg_advisory_unlock(hashtextextended($1, 473))', [
              `attachments/${sessionId}`,
            ]);
        } finally {
          client.release(lost.signal.aborted);
        }
      }
    }
  }
  async find(sessionId: string, operationId: string): Promise<AttachmentRecord | null> {
    const [row] = await this.db
      .select()
      .from(attachmentIngestions)
      .where(
        and(
          eq(attachmentIngestions.sessionId, sessionId),
          eq(attachmentIngestions.operationId, operationId),
        ),
      );
    return row ? attachmentRecordSchema.parse(row.record) : null;
  }
  async get(id: string): Promise<AttachmentRecord | null> {
    const [row] = await this.db
      .select()
      .from(attachmentIngestions)
      .where(eq(attachmentIngestions.id, id));
    return row ? attachmentRecordSchema.parse(row.record) : null;
  }
  async save(raw: AttachmentRecord): Promise<void> {
    const record = attachmentRecordSchema.parse(raw);
    await this.db
      .insert(attachmentIngestions)
      .values({
        id: record.id,
        sessionId: record.sessionId,
        operationId: record.operationId,
        record,
      })
      .onConflictDoUpdate({ target: attachmentIngestions.id, set: { record } });
  }
  async ready(sha256: string, size: number): Promise<void> {
    await this.db.insert(attachmentContents).values({ sha256, size }).onConflictDoNothing();
  }
}
