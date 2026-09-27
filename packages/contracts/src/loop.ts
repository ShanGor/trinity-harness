import type { ToolCall, ToolResult } from './tools.js';

/** Real-time events emitted by the Agent Loop while a turn runs (design.md §6). */
export type LoopEvent =
  | { type: 'turn/start'; turn: number }
  | { type: 'text-delta'; text: string }
  | { type: 'message/assistant'; content: string }
  | { type: 'tool/call'; call: ToolCall }
  | { type: 'tool/result'; callId: string; name: string; result: ToolResult }
  | { type: 'turn/end'; reason: 'completed' | 'aborted' | 'error'; detail?: string };

/** Sink for Loop real-time events (SSE fan-out adapts this in apps/server). */
export interface EventSink {
  emit(event: LoopEvent): void;
}

export interface RunTurnOptions {
  signal?: AbortSignal | undefined;
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
