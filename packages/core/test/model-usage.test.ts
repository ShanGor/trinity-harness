import { describe, expect, it } from 'vitest';
import { modelPricingSchema, type TokenUsage, type SessionEvent } from '@trinity-harness/contracts';
import { summarizeUsage } from '@trinity-harness/shared';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  ContextManager,
  createSubagentTool,
} from '../src/index.js';
import { exchangeGroups } from '../src/context/context-manager.js';
import { priceUsage, normalizeTokenUsage } from '../src/llm/usage.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

const pricing = modelPricingSchema.parse({
  'fake/a': [
    {
      currency: 'USD',
      version: 'test-v1',
      input: '2',
      output: '10',
      cacheRead: '0.2',
      cacheWrite: '2.5',
    },
  ],
  'fake/b': [
    {
      currency: 'USD',
      version: 'test-v1',
      input: '4',
      output: '20',
      cacheRead: '0.4',
      cacheWrite: '5',
    },
  ],
});
const sample: TokenUsage = {
  inputTokens: 100,
  uncachedInputTokens: 40,
  cacheReadTokens: 50,
  cacheWriteTokens: 10,
  outputTokens: 20,
  reasoningTokens: 5,
};
const usageEvents = (events: SessionEvent[]) =>
  events.filter((event) => event.type === 'model/usage');
function loop(store: MemorySessionStore, llm: FakeLLM, model = 'fake/a', context?: ContextManager) {
  return new CoreAgentLoop({
    store,
    llm,
    model,
    pricing,
    context,
    tools: new CoreToolRegistry(new FakeSandbox()),
    workspaceRoot: '/ws',
  });
}

describe('request accounting and pricing', () => {
  it('prices disjoint buckets exactly without double-counting reasoning or cache tokens', () => {
    expect(priceUsage('fake/a', sample, pricing).cost?.amount).toBe('0.00031500000000');
    expect(
      priceUsage('fake/a', { inputTokens: 1, uncachedInputTokens: 1, outputTokens: 0 }, pricing)
        .cost?.amount,
    ).toBe('0.00000200000000');
    const tiny = modelPricingSchema.parse({
      tiny: [{ currency: 'USD', version: 'v1', input: '0.00000001', output: '0' }],
    });
    expect(
      priceUsage('tiny', { inputTokens: 1, uncachedInputTokens: 1, outputTokens: 0 }, tiny).cost
        ?.amount,
    ).toBe('0.00000000000001');
  });

  it('preserves missing usage/pricing and derives only forced buckets', () => {
    expect(normalizeTokenUsage({ inputTokens: 100, cacheReadTokens: 50 })).toEqual({
      inputTokens: 100,
      cacheReadTokens: 50,
    });
    expect(
      normalizeTokenUsage({ inputTokens: 100, uncachedInputTokens: 40, cacheReadTokens: 50 })
        .cacheWriteTokens,
    ).toBe(10);
    expect(
      priceUsage('fake/a', { inputTokens: 100, outputTokens: 20 }, pricing).cost,
    ).toBeUndefined();
    expect(priceUsage('unknown', sample, pricing)).toEqual({});
    expect(priceUsage('fake/a', { ...sample, inputTokens: 99 }, pricing).cost).toBeUndefined();
    const configured = modelPricingSchema.parse(pricing);
    const snapshot = priceUsage('fake/a', sample, configured);
    configured['fake/a']![0]!.input = '999';
    expect(snapshot.pricing?.input).toBe('2');
  });

  it('selects context tiers and distinguishes one-hour cache writes', () => {
    const rates = modelPricingSchema.parse({
      'fake/a': [
        pricing['fake/a']![0],
        { ...pricing['fake/a']![0], minInputTokens: 100, input: '4', cacheWrite1h: '5' },
      ],
    });
    expect(priceUsage('fake/a', sample, rates).cost).toBeUndefined();
    expect(priceUsage('fake/a', { ...sample, cacheWrite1hTokens: 5 }, rates).cost?.amount).toBe(
      '0.00040750000000',
    );
    expect(priceUsage('fake/a', { ...sample, cacheWrite1hTokens: 5 }, pricing).cost?.amount).toBe(
      '0.00031500000000',
    );
  });

  it('replays model switches, deduplicates requests and retains old price snapshots', async () => {
    const store = new MemorySessionStore();
    const response = () => [{ kind: 'usage' as const, ...sample }, ...textChunks('answer')];
    await loop(store, new FakeLLM(response)).run('s', 'one', { emit() {} });
    await loop(store, new FakeLLM(response), 'fake/b').run('s', 'two', { emit() {} });
    const log = await store.load('s');
    const records = usageEvents(log).map((event) => event.usage);
    const summary = summarizeUsage([...records, records[0]!]);
    expect(summary.requests).toBe(2);
    expect(summary.tokens).toEqual({
      ...sample,
      inputTokens: 200,
      outputTokens: 40,
      uncachedInputTokens: 80,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      reasoningTokens: 10,
    });
    expect(summary.costs).toEqual([{ currency: 'USD', amount: '0.00094500000000' }]);
    expect(summary.models.map((row) => row.model)).toEqual(['fake/a', 'fake/b']);
    expect(records[0]!.pricing?.input).toBe('2');
    expect(exchangeGroups(log).map((group) => group.approxTokens)).toEqual(
      exchangeGroups(log.filter((event) => event.type !== 'model/usage')).map(
        (group) => group.approxTokens,
      ),
    );
    expect(records.map((record) => record.promptId)).toEqual(
      log.filter((event) => event.type === 'message/user').map((event) => event.eventId),
    );
    // Rebuilding a store from the immutable log retains exactly the same accounting.
    const replay = new MemorySessionStore();
    await replay.append('s', log);
    expect(summarizeUsage(usageEvents(await replay.load('s')).map((event) => event.usage))).toEqual(
      summary,
    );
  });

  it('retains reported usage when a stream fails, cancels, or leaves a torn tail', async () => {
    for (const cancel of [false, true]) {
      const store = new MemorySessionStore();
      const controller = new AbortController();
      const llm = {
        stream: async () =>
          (async function* () {
            yield { kind: 'usage' as const, ...sample };
            if (cancel) controller.abort();
            throw new Error('stream failed');
          })(),
      };
      const agent = new CoreAgentLoop({
        store,
        llm,
        pricing,
        model: 'fake/a',
        tools: new CoreToolRegistry(new FakeSandbox()),
        workspaceRoot: '/ws',
      });
      const outcome = await agent.run('s', 'go', { emit() {} }, { signal: controller.signal });
      expect(outcome.reason).toBe(cancel ? 'aborted' : 'error');
      const log = await store.load('s');
      const torn = log.slice(0, -1);
      const replay = new MemorySessionStore();
      await replay.append('s', torn);
      await loop(replay, new FakeLLM(() => textChunks('recovered'))).run('s', 'continue', {
        emit() {},
      });
      const records = usageEvents(await replay.load('s')).map((event) => event.usage);
      expect(records[0]!.cost?.amount).toBe('0.00031500000000');
      expect(summarizeUsage(records).unpricedRequests).toBe(1);
    }
  });

  it('includes compaction with its own model and current prompt attribution', async () => {
    const store = new MemorySessionStore();
    await loop(store, new FakeLLM(() => textChunks('old '.repeat(200)))).run(
      's',
      'old '.repeat(200),
      { emit() {} },
    );
    const summarizer = new FakeLLM(() => [{ kind: 'usage', ...sample }, ...textChunks('summary')]);
    const context = new ContextManager({
      store,
      llm: summarizer,
      model: 'fake/b',
      maxTokens: 1,
      keepTokens: 0,
      estimate: () => 10000,
    });
    await loop(
      store,
      new FakeLLM(() => [{ kind: 'usage', ...sample }, ...textChunks('done')]),
      'fake/a',
      context,
    ).run('s', 'next', { emit() {} });
    const events = await store.load('s');
    const compact = usageEvents(events).find((event) => event.usage.purpose === 'compaction');
    expect(compact?.usage.model).toBe('fake/b');
    expect(compact?.usage.cost?.amount).toBe('0.00063000000000');
    expect(compact?.usage.promptId).toBe(
      events.filter((event) => event.type === 'message/user').at(-1)?.eventId,
    );
  });

  it('forwards subagent usage once into the parent session', async () => {
    const store = new MemorySessionStore();
    const registry = new CoreToolRegistry(new FakeSandbox());
    registry.register(
      createSubagentTool({
        createLoop: () =>
          loop(
            new MemorySessionStore(),
            new FakeLLM(() => [{ kind: 'usage', ...sample }, ...textChunks('child')]),
            'fake/b',
          ),
      }),
    );
    const parent = new CoreAgentLoop({
      store,
      tools: registry,
      llm: new FakeLLM(
        () => toolCallThenFinish('child', 'subagent', { task: 'go' }),
        () => textChunks('done'),
      ),
      model: 'fake/a',
      pricing,
      workspaceRoot: '/ws',
    });
    await parent.run('s', 'delegate', { emit() {} });
    const events = await store.load('s');
    const child = usageEvents(events).filter((event) => event.usage.purpose === 'subagent');
    expect(child).toHaveLength(1);
    expect(child[0]!.usage.cost?.amount).toBe('0.00063000000000');
    expect(child[0]!.usage.promptId).toBe(events[0]!.eventId);
  });
});
