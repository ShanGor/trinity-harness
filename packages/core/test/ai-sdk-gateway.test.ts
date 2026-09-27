import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LLMRequest } from '@trinity-harness/contracts';

import { AiSdkGateway, defaultProviders } from '../src/index.js';

const baseRequest: LLMRequest = {
  model: 'unknown/model',
  messages: [],
  tools: [],
};

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
