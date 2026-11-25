import { expect, it, vi } from 'vitest';

it('disables raw SDK warnings by default and retains an explicit operator logger', async () => {
  vi.resetModules();
  vi.stubGlobal('AI_SDK_LOG_WARNINGS', undefined);
  try {
    await import('../src/llm/provider-log-policy.js');
    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(false);
    const logger = vi.fn();
    vi.stubGlobal('AI_SDK_LOG_WARNINGS', logger);
    vi.resetModules();
    await import('../src/llm/provider-log-policy.js');
    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(logger);
  } finally {
    vi.unstubAllGlobals();
  }
});
