/**
 * LLM port (docs/design.md §5.2). Deliberately independent of the Vercel AI
 * SDK so tests can drive the Loop with scripted fakes; the AI SDK adapter
 * lives in packages/core and is the only place that touches provider APIs.
 */

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
