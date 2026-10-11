import { describe, expect, it } from 'vitest';
import { sumTokenUsage, summarizeUsage, type ModelUsage } from '../src/usage.js';

it('keeps unknown buckets unknown and preserves exact mixed-currency subtotals', () => {
  const base = {
    requestId: '1',
    promptId: 'p',
    model: 'a',
    purpose: 'assistant' as const,
    tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
    cost: { currency: 'USD', amount: '0.00000000000001' },
  };
  const records: ModelUsage[] = [
    base,
    {
      ...base,
      requestId: '2',
      tokens: { inputTokens: 20, outputTokens: 5 },
      cost: { currency: 'EUR', amount: '0.01000000000000' },
    },
    { ...base, requestId: '3', cost: undefined },
  ];
  expect(sumTokenUsage(records.map((record) => record.tokens))).toEqual({
    inputTokens: 40,
    outputTokens: 15,
  });
  expect(summarizeUsage(records).costs).toEqual([
    { currency: 'USD', amount: '0.00000000000001' },
    { currency: 'EUR', amount: '0.01000000000000' },
  ]);
  expect(summarizeUsage(records).unpricedRequests).toBe(1);
});

describe('safe token aggregation', () => {
  it('does not publish an inexact token sum', () => {
    expect(sumTokenUsage([{ inputTokens: Number.MAX_SAFE_INTEGER }, { inputTokens: 1 }])).toEqual(
      {},
    );
  });
});
