import type { Disposable } from './bus.js';
import type { PermissionPolicy } from './approval.js';
import type { ContentBlock, SessionEvent } from './events.js';
import type { LoopEvent } from './loop.js';

/**
 * Agent task queue contracts (docs/design.md §3 BullMQ, §4 step 3).
 * Server enqueues; agent-worker claims and runs the Loop. PG remains the
 * source of truth — the queue is an at-least-once delivery mechanism.
 */

export interface TurnTask {
  sessionId: string;
  prompt: string;
  /** M4 multimodal: content blocks when the prompt carries attachments. */
  content?: ContentBlock[] | undefined;
  /** Identity of the submitting user, persisted as the event-log actor. */
  actor: string;
  /** M3: session seq of the user message that triggered this turn. */
  promptSeq: number;
  /** M3: session permission policy snapshot for this turn (fail-closed). */
  policy: PermissionPolicy;
}

/** Server-side enqueue port (BullMQ adapter in packages/redis). */
export interface AgentTaskQueue {
  enqueue(task: TurnTask): Promise<void>;
}

/**
 * Per-session event distribution over Redis Stream (docs/design.md §14).
 * Stream ids are aligned with PG `session_events.seq` (§11.3 three-layer
 * alignment), which is what makes SSE `id:`/resume possible.
 */
export interface SessionEventPublisher {
  /** Entries must be appended in seq order; ids are the seq numbers. */
  publish(
    sessionId: string,
    entries: readonly { seq: number; event: SessionEvent }[],
  ): Promise<void>;
}

/**
 * Read side for one session stream, starting strictly after `afterSeq`.
 * Implementations must deliver retained entries in id order, then live ones.
 */
export interface SessionEventReader {
  open(
    sessionId: string,
    afterSeq: number,
    handler: (entry: { seq: number; event: SessionEvent }) => void,
  ): Disposable & { started: Promise<void> };
  /**
   * Smallest seq still retained in the stream, or null when the stream is
   * missing/empty. Lets the SSE relay PG-fill exactly the truncated gap
   * [afterSeq, firstRetained) before attaching the live reader.
   */
  firstRetainedSeq(sessionId: string): Promise<number | null>;
}

/**
 * Ephemeral live-delta fan-out (docs/design.md §14 "Pub/Sub：低延迟信号").
 * Deltas are transient by nature — committed state always travels through the
 * event log / session stream, so missed deltas during reconnect are harmless.
 */
export interface LiveEventPublisher {
  publish(sessionId: string, event: LoopEvent): void;
}

export interface LiveEventSubscriber {
  /** One subscription fans out every session's live events in-process. */
  subscribe(handler: (sessionId: string, event: LoopEvent) => void): Disposable;
}
