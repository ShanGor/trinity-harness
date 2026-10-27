import type {
  AppendOptions,
  SeqRange,
  SessionEvent,
  SessionStore,
} from '@trinity-harness/contracts';
import { projectMessages } from '@trinity-harness/contracts';

/**
 * M1 in-memory SessionStore (docs/design.md §18 M1: 内存版会话). Single-process
 * only; swap for PgSessionStore (packages/db) at the composition root in M2.
 * Unlike the PG store this fake does not zod-validate — callers own that.
 */
export class MemorySessionStore implements SessionStore {
  private readonly logs = new Map<string, SessionEvent[]>();

  async append(
    sessionId: string,
    events: readonly SessionEvent[],
    opts?: AppendOptions,
  ): Promise<SeqRange> {
    void opts; // M1 in-memory fake: actor metadata is a PG-store concern
    const log = this.logs.get(sessionId) ?? [];
    if (opts?.expectedLastSeq !== undefined && opts.expectedLastSeq !== log.length)
      throw Object.assign(new Error('Conversation changed; refresh and retry.'), {
        code: 'SESSION_CONFLICT',
      });
    log.push(...events);
    this.logs.set(sessionId, log);
    return { from: log.length - events.length + 1, to: log.length };
  }

  async load(sessionId: string, opts?: { toSeq?: number }): Promise<SessionEvent[]> {
    const log = this.logs.get(sessionId) ?? [];
    return opts?.toSeq !== undefined ? log.slice(0, opts.toSeq) : [...log];
  }

  async loadRange(
    sessionId: string,
    opts: { afterSeq: number; toSeq?: number },
  ): Promise<{ seq: number; event: SessionEvent }[]> {
    const log = this.logs.get(sessionId) ?? [];
    const end = opts.toSeq ?? log.length;
    return log.slice(opts.afterSeq, end).map((event, i) => ({ seq: opts.afterSeq + i + 1, event }));
  }

  async loadPage(
    sessionId: string,
    opts: { beforeSeq?: number; limit: number },
  ): Promise<{
    entries: { seq: number; event: SessionEvent }[];
    nextBefore: number | null;
    lastSeq: number;
  }> {
    const log = this.logs.get(sessionId) ?? [];
    const end = Math.min(log.length, (opts.beforeSeq ?? log.length + 1) - 1);
    const start = Math.max(0, end - opts.limit);
    return {
      entries: log.slice(start, end).map((event, index) => ({ event, seq: start + index + 1 })),
      nextBefore: start > 0 ? start + 1 : null,
      lastSeq: log.length,
    };
  }

  async projectMessages(sessionId: string) {
    return projectMessages(await this.load(sessionId));
  }

  async remove(sessionId: string, seq: number): Promise<void> {
    const log = this.logs.get(sessionId);
    if (log && seq >= 1 && seq <= log.length) {
      log.splice(seq - 1, 1);
    }
  }
}
