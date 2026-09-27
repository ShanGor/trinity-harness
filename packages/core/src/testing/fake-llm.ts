import type { LLMPort, LLMRequest, StreamChunk } from '@trinity-harness/contracts';

export type ScriptedResponse = (request: LLMRequest) => StreamChunk[];

/**
 * Scripted LLMPort: queues one response generator per model request, in
 * call order. Asserts every queued script is consumed (determinism).
 */
export class FakeLLM implements LLMPort {
  readonly requests: LLMRequest[] = [];
  private scripts: ScriptedResponse[];

  constructor(...scripts: ScriptedResponse[]) {
    this.scripts = scripts;
  }

  async stream(req: LLMRequest): Promise<AsyncIterable<StreamChunk>> {
    this.requests.push(req);
    const script = this.scripts.shift();
    if (!script) {
      throw new Error('FakeLLM: no scripted response left');
    }
    const chunks = script(req);
    return (async function* () {
      yield* chunks;
    })();
  }

  assertExhausted(): void {
    if (this.scripts.length !== 0) {
      throw new Error(`FakeLLM: ${this.scripts.length} scripted responses unused`);
    }
  }
}

export function textChunks(...texts: string[]): StreamChunk[] {
  return [
    ...texts.map((text): StreamChunk => ({ kind: 'text-delta', text })),
    { kind: 'finish', reason: 'stop' },
  ];
}

export function toolCallChunk(id: string, name: string, args: unknown): StreamChunk {
  return { kind: 'tool-call', call: { id, name, args } };
}

/** tool-call followed by a stop finish — the common "call this tool" script. */
export function toolCallThenFinish(id: string, name: string, args: unknown): StreamChunk[] {
  return [toolCallChunk(id, name, args), { kind: 'finish', reason: 'stop' }];
}
