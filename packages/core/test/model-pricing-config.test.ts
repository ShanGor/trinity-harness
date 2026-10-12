import { describe, expect, it } from 'vitest';

import { loadModelPricingConfig } from '../src/llm/model-pricing-config.js';

describe('loadModelPricingConfig', () => {
  it('loads the bundled default price catalog', () => {
    const catalog = loadModelPricingConfig(new URL('../../../config/models.yaml', import.meta.url));
    expect(catalog).toMatchObject({
      'openai/kimi-k3': [
        {
          currency: 'CNY',
          input: '20',
          output: '100',
          cacheRead: '2',
          cacheWrite: '20',
        },
      ],
      'anthropic/MiniMax-M3': [
        { currency: 'USD', input: '0.3', output: '1.2', cacheRead: '0.06', minInputTokens: 0 },
        {
          currency: 'USD',
          input: '0.6',
          output: '2.4',
          cacheRead: '0.12',
          minInputTokens: 512001,
        },
      ],
      'openai/deepseek-flash': [
        { currency: 'USD', input: '0.3', output: '1.2', cacheRead: '0.006' },
      ],
    });
  });

  it('loads validated rates by exact provider/model key', () => {
    expect(
      loadModelPricingConfig(new URL('./fixtures/model-pricing.yaml', import.meta.url)),
    ).toEqual({
      'fake-provider/fake-model': [
        {
          currency: 'USD',
          version: 'test-contract-v1',
          input: '1.25',
          output: '4.5',
          cacheRead: '0.125',
          cacheWrite: '1.5',
          cacheWrite1h: '2',
          minInputTokens: 100,
        },
      ],
    });
  });

  it('rejects invalid rates instead of silently disabling cost estimates', () => {
    expect(() =>
      loadModelPricingConfig(new URL('./fixtures/model-pricing-invalid.yaml', import.meta.url)),
    ).toThrow(/models\.fake-provider\/fake-model\.0\.input/);
  });
});
