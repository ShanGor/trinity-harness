import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LLMRequest } from '@trinity-harness/contracts';
import type { LanguageModel } from 'ai';

import { AiSdkGateway, defaultProviders } from '../src/index.js';

const baseRequest: LLMRequest = {
  model: 'unknown/model',
  messages: [],
  tools: [],
};

interface CapturedCall {
  options?: Record<string, unknown>;
}

/**
 * Minimal in-memory fake of a v4 LanguageModel: records the call options and
 * replays a fixed stream of provider parts (integration test, no network).
 */
function fakeModel(parts: object[], captured: CapturedCall): LanguageModel {
  return {
    specificationVersion: 'v4',
    provider: 'fake',
    modelId: 'fake-model',
    supportedUrls: {},
    doGenerate: () => {
      throw new Error('fake model: doGenerate not supported');
    },
    doStream: async (options: Record<string, unknown>) => {
      captured.options = options;
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) {
              controller.enqueue(part);
            }
            controller.close();
          },
        }),
      };
    },
  } as unknown as LanguageModel;
}

const FINISH_STOP = {
  type: 'finish',
  // LanguageModelV4FinishReason / LanguageModelV4Usage shapes.
  finishReason: { unified: 'stop', raw: 'stop' },
  usage: {
    inputTokens: { total: 1, noCache: 1 },
    outputTokens: { total: 2, reasoning: 1 },
  },
};

/** stream-text rejects streams with no output; config-only tests emit this. */
const MINIMAL_OUTPUT = [
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: 'ok' },
  { type: 'text-end', id: '0' },
  FINISH_STOP,
];

describe('AiSdkGateway configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('fails closed when the provider API key is missing', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    const gateway = new AiSdkGateway();
    return expect(gateway.stream({ ...baseRequest, model: 'anthropic/x' })).rejects.toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('constructs providers from env credentials (apiKey + baseURL)', () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://proxy.example.com');
    const factory = defaultProviders()['anthropic'];
    expect(factory).toBeDefined();
    expect(factory!('claude-x')).toBeDefined();
  });

  it('rejects unknown providers and malformed model ids', async () => {
    const gateway = new AiSdkGateway();
    await expect(gateway.stream(baseRequest)).rejects.toThrow(/unknown model provider/);
    await expect(gateway.stream({ ...baseRequest, model: 'no-slash' })).rejects.toThrow(
      /provider\/model-id/,
    );
  });
});

describe('AiSdkGateway reasoning support', () => {
  it('streams reasoning deltas (with provider signature) as StreamChunks', async () => {
    const captured: CapturedCall = {};
    const parts = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: '0' },
      { type: 'reasoning-delta', id: '0', delta: 'Let me think. ' },
      // Anthropic delivers the thinking signature as providerMetadata on a
      // separate empty-text reasoning delta.
      {
        type: 'reasoning-delta',
        id: '0',
        delta: '',
        providerMetadata: { anthropic: { signature: 'sig-1' } },
      },
      { type: 'reasoning-end', id: '0' },
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', delta: 'Hi!' },
      { type: 'text-end', id: '1' },
      FINISH_STOP,
    ];
    const gateway = new AiSdkGateway({ fake: () => fakeModel(parts, captured) });

    const chunks = [];
    for await (const chunk of await gateway.stream({
      ...baseRequest,
      model: 'fake/mini',
      messages: [{ role: 'user', content: 'hello' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      { kind: 'reasoning-delta', text: 'Let me think. ' },
      { kind: 'reasoning-delta', text: '', signature: 'sig-1' },
      { kind: 'text-delta', text: 'Hi!' },
      { kind: 'usage', inputTokens: 1, outputTokens: 2 },
      { kind: 'finish', reason: 'stop' },
    ]);
  });

  it('replays assistant reasoning blocks (with signature) into the model prompt', async () => {
    const captured: CapturedCall = {};
    const parts = [{ type: 'stream-start', warnings: [] }, ...MINIMAL_OUTPUT];
    const gateway = new AiSdkGateway({ fake: () => fakeModel(parts, captured) });

    for await (const chunk of await gateway.stream({
      ...baseRequest,
      model: 'fake/mini',
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a', reasoning: [{ text: 'rt', signature: 'sig-1' }] },
      ],
    })) {
      void chunk; // drain
    }

    const prompt = captured.options?.['prompt'] as {
      role: string;
      content: { type: string; text?: string; providerOptions?: unknown }[];
    }[];
    const assistant = prompt.find((m) => m.role === 'assistant');
    expect(assistant?.content[0]).toEqual({
      type: 'reasoning',
      text: 'rt',
      providerOptions: { anthropic: { signature: 'sig-1' } },
    });
  });

  it('sends adaptive thinking config when routing via the anthropic provider (MiniMax-M3)', async () => {
    const captured: CapturedCall = {};
    const parts = [{ type: 'stream-start', warnings: [] }, ...MINIMAL_OUTPUT];
    const gateway = new AiSdkGateway(
      { anthropic: () => fakeModel(parts, captured) },
      { thinkingType: 'adaptive' },
    );

    for await (const chunk of await gateway.stream({
      ...baseRequest,
      model: 'anthropic/MiniMax-M3',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      void chunk; // drain
    }

    const providerOptions = captured.options?.['providerOptions'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(providerOptions?.['anthropic']).toEqual({ thinking: { type: 'adaptive' } });
  });

  it('passes thinking budget for anthropic provider routing', async () => {
    const captured: CapturedCall = {};
    const parts = [{ type: 'stream-start', warnings: [] }, ...MINIMAL_OUTPUT];
    const gateway = new AiSdkGateway(
      { anthropic: () => fakeModel(parts, captured) },
      { reasoningBudgetTokens: 1024 },
    );

    for await (const chunk of await gateway.stream({
      ...baseRequest,
      model: 'anthropic/claude-x',
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      void chunk; // drain
    }

    const providerOptions = captured.options?.['providerOptions'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(providerOptions?.['anthropic']).toEqual({
      thinking: { type: 'enabled', budgetTokens: 1024 },
    });
  });
});
