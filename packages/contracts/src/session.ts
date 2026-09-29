import type { ContentBlock, SessionEvent } from './events.js';
/** A message on the model-visible surface (projection of the event log). */
export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
}

export interface SeqRange {
  from: number;
  to: number;
}

export interface AppendOptions {
  /** Who/what produced the events (e.g. user id, 'agent-worker'). Default 'system'. */
  actor?: string;
}

/**
 * Event-sourced session log (docs/design.md §7).
 * Implementations must guarantee monotonic `(sessionId, seq)` and fsync-like
 * durability semantics for append.
 */
export interface SessionStore {
  append(
    sessionId: string,
    events: readonly SessionEvent[],
    opts?: AppendOptions,
  ): Promise<SeqRange>;
  load(sessionId: string, opts?: { toSeq?: number }): Promise<SessionEvent[]>;
  /**
   * Range replay for SSE resume (docs/design.md §11.3): entries with
   * `afterSeq < seq <= (toSeq ?? latest)`, in seq order, WITH their seqs so
   * callers can emit seq-aligned SSE `id:` fields.
   */
  loadRange(
    sessionId: string,
    opts: { afterSeq: number; toSeq?: number },
  ): Promise<{ seq: number; event: SessionEvent }[]>;
  projectMessages(sessionId: string): Promise<Message[]>;
  /**
   * M3: best-effort removal of one just-appended event, used ONLY when the
   * permission policy rejects a user prompt before the turn starts (the log
   * must not show a prompt that never ran, §12 留痕). This is the single
   * sanctioned exception to append-only (enforced at the PG layer via
   * `session_replication_role`, see PgSessionStore). Stores without removal
   * support (in-memory fakes) may implement it as a no-op.
   */
  remove?(sessionId: string, seq: number): Promise<void>;
}

/**
 * One applied compaction interval: every event with `fromSeq <= seq <= toSeq`
 * is replaced on the model-visible surface by the summary (the
 * `compaction/summary` log event itself sits at `seq`).
 */
export interface CompactionRange {
  fromSeq: number;
  toSeq: number;
  summary: string;
  seq: number;
}

/** All compaction intervals in the log, in application order (M4). */
export function compactionRanges(events: readonly SessionEvent[]): CompactionRange[] {
  const ranges: CompactionRange[] = [];
  events.forEach((event, i) => {
    if (event.type === 'compaction/summary') {
      ranges.push({
        fromSeq: event.fromSeq,
        toSeq: event.toSeq,
        summary: event.summary,
        seq: i + 1,
      });
    }
  });
  return ranges;
}

export function isCompacted(seq: number, ranges: readonly CompactionRange[]): boolean {
  return ranges.some((r) => seq >= r.fromSeq && seq <= r.toSeq);
}

interface SurfaceEntry {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  fromSeq: number;
  toSeq: number;
}

export function compactionSummaryText(summary: string): string {
  return `[compaction summary — earlier conversation condensed]\n${summary}`;
}

/**
 * Seq-aware fold of the event log onto the model-visible surface (docs/design.md
 * §7): `message/*` events append; streaming `replace` settles the last
 * assistant message; M4 `compaction/summary` replaces the covered range
 * IN PLACE — the synthetic summary message takes the position of the first
 * covered event, so surface order stays chronological even though the log is
 * append-only (the compaction event itself sits after the range).
 */
export function foldSurface(events: readonly SessionEvent[]): SurfaceEntry[] {
  const surface: SurfaceEntry[] = [];
  const ranges = compactionRanges(events);
  let emitIdx = 0;
  let activeIdx = -1; // range currently covering events
  const pushSummary = (range: CompactionRange): void => {
    surface.push({
      role: 'user',
      content: [{ kind: 'text', text: compactionSummaryText(range.summary) }],
      fromSeq: range.seq,
      toSeq: range.seq,
    });
  };
  events.forEach((event, i) => {
    const seq = i + 1;
    // In-place summary insertion at the start of each covered range; the
    // range becomes active so its own events (starting at fromSeq) are
    // skipped below.
    while (emitIdx < ranges.length && ranges[emitIdx]!.fromSeq === seq) {
      pushSummary(ranges[emitIdx]!);
      activeIdx = emitIdx;
      emitIdx += 1;
    }
    if (activeIdx >= 0 && seq >= ranges[activeIdx]!.fromSeq && seq <= ranges[activeIdx]!.toSeq) {
      return; // covered by the current compaction range
    }
    if (event.type === 'compaction/summary') {
      return; // consumed as a range marker
    }
    switch (event.type) {
      case 'message/user':
        surface.push({ role: 'user', content: event.content, fromSeq: seq, toSeq: seq });
        break;
      case 'message/assistant': {
        const last = surface.at(-1);
        if (event.surfaceOp === 'replace' && last?.role === 'assistant') {
          last.content = event.content;
          last.toSeq = seq;
        } else {
          surface.push({ role: 'assistant', content: event.content, fromSeq: seq, toSeq: seq });
        }
        break;
      }
      default:
        // Non-message events do not alter the surface.
        break;
    }
  });
  // Trailing ranges (defensive: compaction normally never covers the tail).
  while (emitIdx < ranges.length) {
    pushSummary(ranges[emitIdx]!);
    emitIdx += 1;
  }
  return surface;
}

/**
 * Pure projection of the event log onto the model-visible surface.
 * M4: `compaction/summary` events replace the covered surface range with a
 * synthetic summary message (docs/design.md §7 "compaction 只追加日志事件并
 * replace 表面区间").
 */
export function projectMessages(events: readonly SessionEvent[]): Message[] {
  return foldSurface(events).map(({ role, content }) => ({ role, content }));
}
