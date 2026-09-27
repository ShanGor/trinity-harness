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
  append(sessionId: string, events: SessionEvent[], opts?: AppendOptions): Promise<SeqRange>;
  load(sessionId: string, opts?: { toSeq?: number }): Promise<SessionEvent[]>;
  projectMessages(sessionId: string): Promise<Message[]>;
}

/**
 * Pure projection of the event log onto the model-visible surface.
 *
 * M0 semantics: `message/user` always appends; `message/assistant` with
 * `surfaceOp: 'replace'` replaces the most recent assistant message (streaming
 * settle). Range-based replace intervals (compaction) land in M4.
 */
export function projectMessages(events: readonly SessionEvent[]): Message[] {
  const surface: Message[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'message/user':
        surface.push({ role: 'user', content: event.content });
        break;
      case 'message/assistant': {
        const last = surface.at(-1);
        if (event.surfaceOp === 'replace' && last?.role === 'assistant') {
          surface[surface.length - 1] = { role: 'assistant', content: event.content };
        } else {
          surface.push({ role: 'assistant', content: event.content });
        }
        break;
      }
      default:
        // Non-message events do not alter the surface.
        break;
    }
  }
  return surface;
}
