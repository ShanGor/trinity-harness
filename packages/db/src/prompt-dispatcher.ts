import type pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import { and, desc, eq, sql } from 'drizzle-orm';
import { queuedPromptEventSchema, type AgentTaskQueue } from '@trinity-harness/contracts';
import type { Db } from './client.js';
import { sessionEvents, sessions } from './schema.js';

/** PG log is the outbox. Notifications wake dispatch; startup/retry scans recover lost wakeups. */
export class PgPromptDispatcher {
  private readonly abort = new AbortController();
  private client: pg.PoolClient | undefined;
  private flushing: Promise<void> | undefined;
  private requested = false;
  private reconnecting: Promise<void> | undefined;
  private detach: (() => void) | undefined;
  constructor(
    private readonly pool: pg.Pool,
    private readonly db: Db,
    private readonly queue: AgentTaskQueue,
  ) {}
  async start(): Promise<void> {
    await this.connect();
  }
  private async connect(): Promise<void> {
    const client = await this.pool.connect();
    if (this.abort.signal.aborted) {
      client.release();
      return;
    }
    this.client = client;
    const notify = (): void => this.wake();
    const failed = (): void => {
      this.detach?.();
      this.detach = undefined;
      if (this.client === client) this.client = undefined;
      client.release(true);
      if (!this.abort.signal.aborted)
        this.reconnecting ??= this.reconnect().finally(() => {
          this.reconnecting = undefined;
        });
    };
    this.detach = () => {
      client.removeListener('notification', notify);
      client.removeListener('error', failed);
    };
    client.on('notification', notify);
    client.once('error', failed);
    try {
      await client.query('LISTEN assistant_prompt_dispatch');
    } catch (error) {
      if (this.client === client) {
        this.detach();
        this.detach = undefined;
        this.client = undefined;
        client.release(true);
      }
      throw error;
    }
    this.wake();
  }
  private async reconnect(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await delay(1000, undefined, { signal: this.abort.signal });
        await this.connect();
        return;
      } catch {
        if (this.abort.signal.aborted) return;
      }
    }
  }

  private wake(): void {
    this.requested = true;
    this.flushing ??= this.flush().finally(() => {
      this.flushing = undefined;
      if (this.requested && !this.abort.signal.aborted) this.wake();
    });
  }
  private async flush(): Promise<void> {
    while (this.requested && !this.abort.signal.aborted) {
      this.requested = false;
      try {
        const rows = await this.db
          .selectDistinctOn([sessionEvents.sessionId])
          .from(sessionEvents)
          .innerJoin(sessions, eq(sessions.id, sessionEvents.sessionId))
          .where(
            and(
              eq(sessionEvents.type, 'prompt/queued'),
              sql`${sessions.closedAt} is null`,
              sql`not exists (select 1 from session_events terminal where terminal.session_id = ${sessionEvents.sessionId} and terminal.type in ('turn/end','prompt/discarded') and terminal.payload->>'promptId' = ${sessionEvents.payload}->>'promptId')`,
            ),
          )
          .orderBy(sessionEvents.sessionId, desc(sessionEvents.seq))
          .limit(100);
        for (const row of rows) {
          this.abort.signal.throwIfAborted();
          const event = queuedPromptEventSchema.parse(row.session_events.payload);
          await this.queue.enqueue({
            sessionId: row.session_events.sessionId,
            promptSeq: Number(row.session_events.seq),
            prompt: event.content
              .filter((block) => block.kind === 'text')
              .map((block) => (block.kind === 'text' ? block.text : ''))
              .join('\n'),
            content: event.content,
            actor: event.actor,
            tenantId: event.tenantId,
            policy: event.policy,
          });
        }
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.requested = true;
        // Retry distribution failures, not ordinary log polling.
        console.error(
          '[assistant-dispatch] delivery unavailable',
          (error as { code?: string }).code ?? 'unknown',
        );
        try {
          await delay(1000, undefined, { signal: this.abort.signal });
        } catch {
          return;
        }
      }
    }
  }
  async dispose(): Promise<void> {
    this.abort.abort();
    await this.flushing;
    await this.reconnecting;
    if (this.client) {
      this.detach?.();
      this.detach = undefined;
      try {
        await this.client.query('UNLISTEN assistant_prompt_dispatch');
      } finally {
        this.client.release();
      }
    }
  }
}
