/**
 * LLM port (docs/design.md §5.2). Deliberately independent of the Vercel AI
 * SDK so tests can drive the Loop with scripted fakes; the AI SDK adapter
 * lives in packages/core and is the only place that touches provider APIs.
 */

import type { ContentBlock } from './events.js';

export interface ModelToolCall {
  id: string;
  name: string;
  args: unknown;
}

/**
 * One reasoning ("thinking") block of an assistant message. `signature` is the
 * provider round-trip token (Anthropic thinking-block signature); required by
 * the AI SDK to echo the block back to Anthropic-compatible endpoints.
 */
export interface ReasoningBlock {
  text: string;
  signature?: string | undefined;
}

/** One message in model-conversation form (user/assistant text + tool calls). */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * M4 multimodal (docs/design.md §10): user messages may carry image/file
   * content blocks in addition to (or instead of) plain `content` text. The
   * gateway maps them to AI SDK ImagePart/FileParts; `content` remains the
   * text fallback for providers/blocks without multimodal support.
   */
  blocks?: ContentBlock[] | undefined;
  /**
   * Present on assistant messages produced by a reasoning model; replayed
   * verbatim on subsequent turns (MiniMax-M3: "原样保留这些内容块").
   */
  reasoning?: ReasoningBlock[] | undefined;
  /** Present on assistant messages that requested tool calls. */
  toolCalls?: ModelToolCall[];
  /** Present on role 'tool' messages: which call this result answers. */
  toolCallId?: string;
  /** Tool name, mirrored on role 'tool' messages for convenience. */
  toolName?: string;
}

export interface LLMRequest {
  /** e.g. "anthropic/claude-sonnet-4-20250514" — routed by the gateway. */
  model: string;
  system?: string | undefined;
  messages: ConversationMessage[];
  tools: ToolSchema[];
  signal?: AbortSignal | undefined;
  /**
   * M4: resolves `blob://` URIs (multimodal blocks, spilled content) to bytes
   * so the gateway can encode provider-native image/file parts. Provided by
   * the composition root (BlobStore); absent ⇒ blob URIs are a clean error
   * (fail-closed, AGENTS.md §3.4).
   */
  resolveBlob?: ((uri: string) => Promise<Uint8Array>) | undefined;
}

/** JSON-Schema-shaped tool description (design.md §5.2). */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type StreamChunk =
  | { kind: 'text-delta'; text: string }
  | { kind: 'reasoning-delta'; text: string; signature?: string | undefined }
  | { kind: 'tool-call'; call: ModelToolCall }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  | { kind: 'finish'; reason: 'stop' | 'length' | 'error' };

export interface LLMPort {
  stream(req: LLMRequest): Promise<AsyncIterable<StreamChunk>>;
}
