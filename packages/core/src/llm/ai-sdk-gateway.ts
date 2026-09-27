import type {
  ConversationMessage,
  LLMPort,
  LLMRequest,
  StreamChunk,
} from '@trinity-harness/contracts';
import type { LanguageModel, ModelMessage } from 'ai';
import { jsonSchema, streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

export type ModelFactory = (modelId: string) => LanguageModel;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Fail-closed misconfiguration path: surface a clean error inside the
    // loop instead of the SDK's noisy internal logging.
    throw new Error(`${name} is not set (server-side secret, never sent to the frontend)`);
  }
  return value;
}

/**
 * Built-in provider routing: "anthropic/<model-id>" | "openai/<model-id>".
 * Keys/base URLs come from server-side env vars (ANTHROPIC_API_KEY,
 * ANTHROPIC_BASE_URL, …) — never from the frontend.
 */
export function defaultProviders(): Record<string, ModelFactory> {
  return {
    anthropic: (modelId) =>
      createAnthropic({
        apiKey: requireEnv('ANTHROPIC_API_KEY'),
        ...(process.env['ANTHROPIC_BASE_URL']
          ? { baseURL: process.env['ANTHROPIC_BASE_URL'] }
          : {}),
      }).languageModel(modelId),
    openai: (modelId) =>
      createOpenAI({
        apiKey: requireEnv('OPENAI_API_KEY'),
        ...(process.env['OPENAI_BASE_URL'] ? { baseURL: process.env['OPENAI_BASE_URL'] } : {}),
      }).languageModel(modelId),
  };
}

function toAiMessages(messages: ConversationMessage[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    if (m.role === 'user') {
      return { role: 'user', content: m.content };
    }
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: [
          // Reasoning blocks precede text/tool calls; the AI SDK re-sends them
          // as thinking blocks only when the provider signature rides along.
          ...(m.reasoning?.map((r) => ({
            type: 'reasoning' as const,
            text: r.text,
            ...(r.signature !== undefined
              ? { providerOptions: { anthropic: { signature: r.signature } } }
              : {}),
          })) ?? []),
          ...(m.content.length > 0 ? [{ type: 'text' as const, text: m.content }] : []),
          ...(m.toolCalls?.map((tc) => ({
            type: 'tool-call' as const,
            toolCallId: tc.id,
            toolName: tc.name,
            input: tc.args,
          })) ?? []),
        ],
      };
    }
    return {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: m.toolCallId ?? '',
          toolName: m.toolName ?? '',
          output: { type: 'text', value: m.content },
        },
      ],
    };
  });
}

function mapFinishReason(
  finishReason: 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other' | 'unknown',
): Extract<StreamChunk, { kind: 'finish' }>['reason'] {
  if (finishReason === 'length') return 'length';
  if (finishReason === 'stop' || finishReason === 'tool-calls') return 'stop';
  return 'error';
}

export interface GatewayOptions {
  /**
   * Anthropic-format thinking control (provider: anthropic). `adaptive` is
   * what MiniMax-M3 expects (`thinking: {"type": "adaptive"}`); `enabled`
   * pairs with `reasoningBudgetTokens` for Claude-style budgeted thinking.
   */
  thinkingType?: 'adaptive' | 'enabled' | 'disabled' | undefined;
  /** Anthropic extended thinking budget in tokens (provider: anthropic). */
  reasoningBudgetTokens?: number | undefined;
  /** OpenAI reasoning effort level (provider: openai). */
  reasoningEffort?: string | undefined;
}

/**
 * LLMPort adapter over the Vercel AI SDK (docs/design.md §5.2). This is the
 * ONLY module allowed to call AI SDK / provider APIs.
 *
 * Tools are declared without `execute`, so the SDK never runs them itself —
 * execution stays in our ToolRegistry/Loop (approval hooks land in M3).
 */
export class AiSdkGateway implements LLMPort {
  constructor(
    private readonly providers: Record<string, ModelFactory> = defaultProviders(),
    private readonly opts: GatewayOptions = {},
  ) {}

  async stream(req: LLMRequest): Promise<AsyncIterable<StreamChunk>> {
    const slash = req.model.indexOf('/');
    if (slash <= 0) {
      throw new Error(`model must be "provider/model-id", got: ${req.model}`);
    }
    const providerName = req.model.slice(0, slash);
    const modelId = req.model.slice(slash + 1);
    const factory = this.providers[providerName];
    if (!factory) {
      throw new Error(
        `unknown model provider "${providerName}" (known: ${Object.keys(this.providers).join(', ')})`,
      );
    }

    // Reasoning configuration is provider-specific (design.md §17: OTel usage
    // metering rides along in the gateway in later milestones).
    const providerOptions: Record<string, Record<string, unknown>> = {};
    if (
      providerName === 'anthropic' &&
      (this.opts.thinkingType || this.opts.reasoningBudgetTokens)
    ) {
      const thinkingType = this.opts.thinkingType ?? 'enabled';
      providerOptions['anthropic'] = {
        thinking: {
          type: thinkingType,
          ...(thinkingType === 'enabled' && this.opts.reasoningBudgetTokens
            ? { budgetTokens: this.opts.reasoningBudgetTokens }
            : {}),
        },
      };
    }
    if (providerName === 'openai' && this.opts.reasoningEffort) {
      providerOptions['openai'] = { reasoningEffort: this.opts.reasoningEffort };
    }

    const result = streamText({
      model: factory(modelId),
      ...(req.system !== undefined ? { system: req.system } : {}),
      messages: toAiMessages(req.messages),
      tools: Object.fromEntries(
        req.tools.map((t) => [
          t.name,
          {
            description: t.description,
            inputSchema: jsonSchema(t.parameters as Parameters<typeof jsonSchema>[0]),
          },
        ]),
      ),
      ...(Object.keys(providerOptions).length > 0
        ? {
            providerOptions: providerOptions as Parameters<typeof streamText>[0]['providerOptions'],
          }
        : {}),
      abortSignal: req.signal,
    });

    // v7 aggregates (steps/usage/finishReason) are promises that consume the
    // stream. If the stream errors before we await them, a missing handler
    // would surface as an unhandled rejection — attach no-op catches now.
    const stepsPromise = result.steps;
    const usagePromise = result.usage;
    const finishReasonPromise = result.finishReason;
    void Promise.resolve(stepsPromise).catch(() => {});
    void Promise.resolve(usagePromise).catch(() => {});
    void Promise.resolve(finishReasonPromise).catch(() => {});

    return (async function* (): AsyncIterable<StreamChunk> {
      for await (const chunk of result.stream) {
        if (chunk.type === 'text-delta') {
          yield { kind: 'text-delta', text: chunk.text };
        } else if (chunk.type === 'reasoning-delta') {
          // The Anthropic provider delivers the thinking-block signature as
          // providerMetadata on a separate (empty-text) reasoning-delta.
          const signature = (
            chunk.providerMetadata as { anthropic?: { signature?: string } } | undefined
          )?.anthropic?.signature;
          yield {
            kind: 'reasoning-delta',
            // v7 stream chunks carry reasoning text in `text` (v3 used `delta`).
            text: chunk.text ?? '',
            ...(signature !== undefined ? { signature } : {}),
          };
        }
      }
      const [steps, usage, finishReason] = await Promise.all([
        stepsPromise,
        usagePromise,
        finishReasonPromise,
      ]);
      for (const step of steps) {
        for (const tc of step.toolCalls) {
          yield {
            kind: 'tool-call',
            call: { id: tc.toolCallId, name: tc.toolName, args: tc.input },
          };
        }
      }
      yield {
        kind: 'usage',
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      };
      yield { kind: 'finish', reason: mapFinishReason(finishReason) };
    })();
  }
}
