import { expect, it, vi } from 'vitest';
import type { LLMPort, StreamChunk } from '@trinity-harness/contracts';
import { CoreAgentLoop, CoreToolRegistry, MemorySessionStore } from '../src/index.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';
import { modelLatency } from '../src/telemetry.js';

it('distinguishes first reasoning output, first answer text and full model duration', async () => {
  let now = 100;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const record = vi.spyOn(modelLatency, 'record');
  const llm: LLMPort = {
    stream: async () =>
      (async function* (): AsyncGenerator<StreamChunk> {
        yield { kind: 'text-delta', text: '' };
        now = 110;
        yield { kind: 'reasoning-delta', text: 'Thinking' };
        now = 140;
        yield { kind: 'text-delta', text: 'Hello' };
        now = 150;
        yield { kind: 'text-delta', text: ' there' };
        yield { kind: 'finish', reason: 'stop' };
      })(),
  };
  try {
    const loop = new CoreAgentLoop({
      llm,
      model: 'fake/model',
      systemPrompt: 'Test',
      tools: new CoreToolRegistry(new FakeSandbox()),
      store: new MemorySessionStore(),
      workspaceRoot: '/ws',
    });
    expect((await loop.run('s1', 'hello', { emit: () => {} })).reason).toBe('completed');
    // OTel's no-op provider may share histogram instances across instruments.
    expect(record.mock.calls.filter(([, attrs]) => attrs?.['trinity.llm.phase'])).toEqual([
      [
        0,
        {
          'trinity.model': 'fake/model',
          'trinity.llm.purpose': 'assistant',
          'trinity.llm.phase': 'preparation',
        },
      ],
      [
        10,
        {
          'trinity.model': 'fake/model',
          'trinity.llm.purpose': 'assistant',
          'trinity.llm.phase': 'first_output',
        },
      ],
      [
        40,
        {
          'trinity.model': 'fake/model',
          'trinity.llm.purpose': 'assistant',
          'trinity.llm.phase': 'first_text',
        },
      ],
      [
        50,
        {
          'trinity.model': 'fake/model',
          'trinity.llm.purpose': 'assistant',
          'trinity.llm.phase': 'duration',
        },
      ],
    ]);
  } finally {
    record.mockRestore();
    clock.mockRestore();
  }
});
