import type { ContentBlock } from './events.js';
import type { PermissionPolicy } from './approval.js';
import type { ToolCall, ToolResult } from './tools.js';

/** Real-time events emitted by the Agent Loop while a turn runs (design.md §6). */
export type LoopEvent =
  | { type: 'turn/start'; turn: number }
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning-delta'; text: string }
  | { type: 'message/assistant'; content: string }
  | { type: 'tool/call'; call: ToolCall }
  | { type: 'tool/result'; callId: string; name: string; result: ToolResult }
  | {
      type: 'approval-requested';
      approvalId: string;
      call: ToolCall;
      argsPreview: string;
    }
  | {
      type: 'approval-resolved';
      approvalId: string;
      callId: string;
      outcome: 'allowed' | 'rejected';
      decidedBy: string;
    }
  /**
   * M4: the context manager compacted a surface range mid-turn (the log
   * gained a `compaction/summary` event). UIs may surface a notice.
   */
  | { type: 'context/compacted'; fromSeq: number; toSeq: number }
  | { type: 'turn/end'; reason: 'completed' | 'aborted' | 'error'; detail?: string };

/** Sink for Loop real-time events (SSE fan-out adapts this in apps/server). */
export interface EventSink {
  emit(event: LoopEvent): void;
}

export interface RunTurnOptions {
  signal?: AbortSignal | undefined;
  /** Recorded as the actor of every event this turn appends (M2 audit trail). */
  actor?: string | undefined;
  /** M3: per-session permission policy; omitted ⇒ everything allowed (M1 path). */
  policy?: PermissionPolicy | undefined;
  /**
   * M3: exact seq of the `message/user` event that triggered this turn. The
   * loop deletes-and-appends the user message when a policy gate REJECTS it,
   * so the committed log never shows a prompt that never ran (§12 留痕).
   */
  promptSeq?: number | undefined;
  /**
   * M4 multimodal: full content blocks for this turn's user message. When
   * present they replace the plain-text `prompt` in the appended
   * `message/user` event (images/files ride along as `blob://` references,
   * docs/design.md §10).
   */
  content?: ContentBlock[] | undefined;
}

export interface TurnOutcome {
  reason: 'completed' | 'aborted' | 'error';
  steps: number;
}

export interface AgentLoop {
  /** Appends the user message, drives steps until the model stops calling tools. */
  run(
    sessionId: string,
    prompt: string,
    sink: EventSink,
    opts?: RunTurnOptions,
  ): Promise<TurnOutcome>;
}
