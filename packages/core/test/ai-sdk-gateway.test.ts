import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LLMRequest } from '@trinity-harness/contracts';
import type { LanguageModel } from 'ai';
import { APICallError } from 'ai';

import {
  AiSdkGateway,
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  defaultProviders,
} from '../src/index.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

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
  it('explicitly disables provider tool selection when no tools are available', async () => {
    const captured: CapturedCall = {};
    const gateway = new AiSdkGateway({ fake: () => fakeModel(MINIMAL_OUTPUT, captured) });
    for await (const chunk of await gateway.stream({
      ...baseRequest,
      model: 'fake/model',
      messages: [{ role: 'user', content: 'Conclude' }],
    }))
      void chunk;
    expect(captured.options?.toolChoice).toEqual({ type: 'none' });
  });
  it('passes the fitted output limit to the provider', async () => {
    const captured: CapturedCall = {};
    const gateway = new AiSdkGateway({ fake: () => fakeModel(MINIMAL_OUTPUT, captured) });
    for await (const chunk of await gateway.stream({
      ...baseRequest,
      model: 'fake/model',
      messages: [{ role: 'user', content: 'test' }],
      maxOutputTokens: 321,
    }))
      void chunk;
    expect(captured.options?.maxOutputTokens).toBe(321);
  });

  it('leaves transient retries to the durable loop instead of retrying invisibly', async () => {
    let attempts = 0;
    const model = fakeModel([], {});
    if (typeof model === 'string') throw new Error('Expected an in-memory provider model');
    model.doStream = async () => {
      attempts++;
      throw new APICallError({
        message: 'temporarily unavailable',
        url: 'https://provider.invalid',
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: true,
      });
    };
    const gateway = new AiSdkGateway({ fake: () => model });
    await expect(async () => {
      for await (const chunk of await gateway.stream({
        ...baseRequest,
        model: 'fake/model',
        messages: [{ role: 'user', content: 'test' }],
      }))
        void chunk;
    }).rejects.toThrow();
    expect(attempts).toBe(1);
  });
  it.each([401, 429, 529])(
    'preserves the original HTTP %i failure without logging request bodies',
    async (statusCode) => {
      const failure = new APICallError({
        message: 'provider rejected request',
        url: 'https://provider.invalid',
        requestBodyValues: { messages: ['private user input'] },
        statusCode,
        isRetryable: statusCode !== 401,
      });
      const model = fakeModel([], {});
      if (typeof model === 'string') throw new Error('Expected an in-memory provider model');
      model.doStream = async () => {
        throw failure;
      };
      const logging = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const gateway = new AiSdkGateway({ fake: () => model });
        await expect(async () => {
          for await (const chunk of await gateway.stream({
            ...baseRequest,
            model: 'fake/model',
            messages: [{ role: 'user', content: 'test' }],
          }))
            void chunk;
        }).rejects.toBe(failure);
        expect(logging).not.toHaveBeenCalled();
      } finally {
        logging.mockRestore();
      }
    },
  );
  it('preserves a provider error delivered inside the stream', async () => {
    const failure = Object.assign(new Error('provider stream overloaded'), { isRetryable: true });
    const gateway = new AiSdkGateway({
      fake: () => fakeModel([{ type: 'error', error: failure }], {}),
    });
    await expect(async () => {
      for await (const chunk of await gateway.stream({
        ...baseRequest,
        model: 'fake/model',
        messages: [{ role: 'user', content: 'test' }],
      }))
        void chunk;
    }).rejects.toBe(failure);
  });
  it.each([false, true])(
    'lets the durable loop recover from HTTP 529 (persistent overload: %s)',
    async (persistent) => {
      let attempts = 0;
      let now = Date.parse('2026-10-22T03:00:00Z');
      const waits: number[] = [];
      const model = fakeModel(MINIMAL_OUTPUT, {});
      if (typeof model === 'string' || model.specificationVersion !== 'v4')
        throw new Error('Expected an in-memory v4 provider model');
      const succeed = model.doStream.bind(model);
      model.doStream = async (options) => {
        attempts++;
        if (persistent || attempts === 1)
          throw new APICallError({
            message: 'service overloaded (529)',
            url: 'https://provider.invalid',
            requestBodyValues: {},
            statusCode: 529,
            responseHeaders: { 'Retry-After': '20' },
            isRetryable: true,
          });
        return succeed(options);
      };
      const store = new MemorySessionStore();
      const loop = new CoreAgentLoop({
        llm: new AiSdkGateway({ fake: () => model }),
        model: 'fake/model',
        workspaceRoot: '/ws',
        store,
        tools: new CoreToolRegistry(new FakeSandbox()),
        now: () => now,
        wait: async (ms) => {
          waits.push(ms);
          now += ms;
        },
        maxRetries: 2,
      });
      const outcome = await loop.run('s', 'Reply', { emit: () => undefined });
      expect(outcome.reason).toBe(persistent ? 'error' : 'completed');
      expect(attempts).toBe(persistent ? 3 : 2);
      expect(waits).toEqual(persistent ? [20_000, 20_000] : [20_000]);
      const events = await store.load('s');
      expect(events.filter((event) => event.type === 'task/recovery')).toHaveLength(
        persistent ? 2 : 1,
      );
      expect(events.at(-1)).toMatchObject(
        persistent
          ? { type: 'turn/end', reason: 'error', detail: 'service overloaded (529)' }
          : { type: 'turn/end', reason: 'completed' },
      );
    },
  );
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
      {
        kind: 'usage',
        inputTokens: 1,
        outputTokens: 2,
        uncachedInputTokens: 1,
        reasoningTokens: 1,
      },
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

it('encodes persisted screenshot blocks as native tool image content, outside text JSON', async () => {
  const captured: CapturedCall = {};
  const gateway = new AiSdkGateway({ fake: () => fakeModel(MINIMAL_OUTPUT, captured) });
  for await (const chunk of await gateway.stream({
    ...baseRequest,
    model: 'fake/image',
    messages: [
      { role: 'user', content: 'Read image' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'shot', name: 'browser', args: { operation: 'screenshot' } }],
      },
      {
        role: 'tool',
        toolCallId: 'shot',
        toolName: 'browser',
        content: '{"image":{"uri":"blob://browser/s/shot.png"}}',
        blocks: [{ kind: 'image', uri: 'blob://browser/s/shot.png', mimeType: 'image/png' }],
      },
    ],
    resolveBlob: async () => new Uint8Array([137, 80, 78, 71]),
  }))
    void chunk;
  const prompt = captured.options?.['prompt'] as {
    role: string;
    content: { output?: unknown }[];
  }[];
  const result = prompt.find((m) => m.role === 'tool')?.content[0]?.output;
  expect(result).toMatchObject({
    type: 'content',
    value: [{ type: 'text' }, { type: 'file', mediaType: 'image/png', data: { type: 'data' } }],
  });
});

it('deduplicates identical user/tool image bytes within each request and retains the latest pixels', async () => {
  const captured: CapturedCall = {};
  const gateway = new AiSdkGateway({ fake: () => fakeModel(MINIMAL_OUTPUT, captured) });
  const resolveBlob = vi.fn(async () => new Uint8Array([137, 80, 78, 71]));
  const request: LLMRequest = {
    ...baseRequest,
    model: 'fake/image',
    resolveBlob,
    messages: [
      {
        role: 'user',
        content: 'Original image',
        blocks: [{ kind: 'image', uri: 'blob://original', mimeType: 'image/png' }],
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'shot', name: 'browser', args: { operation: 'screenshot' } }],
      },
      {
        role: 'tool',
        toolCallId: 'shot',
        toolName: 'browser',
        content: '{"image":{"uri":"blob://browser/s/shot.png"}}',
        blocks: [{ kind: 'image', uri: 'blob://browser/s/shot.png', mimeType: 'image/png' }],
      },
      {
        role: 'user',
        content: 'Compare with this image',
        blocks: [{ kind: 'image', uri: 'blob://latest', mimeType: 'image/png' }],
      },
    ],
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for await (const chunk of await gateway.stream(request)) void chunk;
    const prompt = captured.options?.prompt as {
      role: string;
      content: {
        type: string;
        text?: string;
        output?: { type: string; value: { type: string; text?: string }[] };
      }[];
    }[];
    expect(
      prompt.flatMap((message) => message.content).filter((part) => part.type === 'file'),
    ).toHaveLength(1);
    expect(prompt.at(-1)?.content.some((part) => part.type === 'file')).toBe(true);
    expect(prompt[0]?.content).toContainEqual({
      type: 'text',
      text: expect.stringContaining('Duplicate image'),
    });
    const tool = prompt.find((message) => message.role === 'tool')!.content[0]!.output!;
    expect(tool.value.map((part) => part.type)).toEqual(['text', 'text']);
    expect(tool.value[0]?.text).toContain('blob://browser/s/shot.png');
    expect(tool.value[1]?.text).toContain('Duplicate image');
  }
  expect(resolveBlob).toHaveBeenCalledTimes(6);
  expect(request.messages[0]?.blocks).toHaveLength(1);
  expect(request.messages[2]?.blocks).toHaveLength(1);
});

it('keeps more than four distinct images available in one provider request', async () => {
  const captured: CapturedCall = {};
  const gateway = new AiSdkGateway({ fake: () => fakeModel(MINIMAL_OUTPUT, captured) });
  for await (const chunk of await gateway.stream({
    ...baseRequest,
    model: 'fake/image',
    messages: [
      {
        role: 'user',
        content: 'Compare six diagrams',
        blocks: Array.from({ length: 6 }, (_, index) => ({
          kind: 'image' as const,
          uri: `blob://image${index}`,
          mimeType: 'image/png',
        })),
      },
    ],
    resolveBlob: async (uri) => new Uint8Array([137, 80, 78, 71, Number(uri.at(-1))]),
  }))
    void chunk;
  const prompt = captured.options?.prompt as { content: { type: string }[] }[];
  expect(
    prompt.flatMap((message) => message.content).filter((part) => part.type === 'file'),
  ).toHaveLength(6);
});

it('retains exact cache, output and reasoning counts from the SDK', async () => {
  const gateway = new AiSdkGateway({
    fake: () =>
      fakeModel(
        [
          ...MINIMAL_OUTPUT.slice(0, -1),
          {
            ...FINISH_STOP,
            usage: {
              inputTokens: { total: 100, noCache: 40, cacheRead: 50, cacheWrite: 10 },
              outputTokens: { total: 20, text: 15, reasoning: 5 },
              raw: { cache_creation: { ephemeral_1h_input_tokens: 5 } },
            },
          },
        ],
        {},
      ),
  });
  const chunks = [];
  for await (const chunk of await gateway.stream({
    ...baseRequest,
    model: 'fake/a',
    messages: [{ role: 'user', content: 'hello' }],
  }))
    chunks.push(chunk);
  expect(chunks.find((chunk) => chunk.kind === 'usage')).toEqual({
    kind: 'usage',
    inputTokens: 100,
    outputTokens: 20,
    uncachedInputTokens: 40,
    cacheReadTokens: 50,
    cacheWriteTokens: 10,
    cacheWrite1hTokens: 5,
    reasoningTokens: 5,
  });
});
