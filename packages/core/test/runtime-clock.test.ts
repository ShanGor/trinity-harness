import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { sessionEventSchema, type SessionEvent } from '@trinity-harness/contracts';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  readFileTool,
  toModelMessages,
} from '../src/index.js';
import { runtimeClock, runtimeClockMessage } from '../src/loop/runtime-clock.js';
import { estimateRequestTokens } from '../src/context/estimate-tokens.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';

it('renders an explicit UTC instant, local calendar date and IANA timezone across midnight and DST', async () => {
  const clock = await runtimeClock(
    Date.parse('2026-11-14T16:30:00Z'),
    async () => 'Asia/Hong_Kong',
  );
  const message = runtimeClockMessage(clock);
  expect(message).toMatchObject({ role: 'user', context: 'control' });
  expect(message.content).toContain('UTC: 2026-11-14T16:30:00.000Z');
  expect(message.content).toContain('2026-11-15');
  expect(message.content).toContain('00:30:00 GMT+08:00');
  expect(message.content).toContain('IANA timezone: Asia/Hong_Kong');
  for (const [instant, offset] of [
    ['2026-11-01T05:30:00Z', 'GMT-04:00'],
    ['2026-11-01T06:30:00Z', 'GMT-05:00'],
  ]) {
    const value = await runtimeClock(Date.parse(instant!), async () => 'America/New_York');
    expect(runtimeClockMessage(value).content).toContain(`01:30:00 ${offset}`);
  }
});

it.each([undefined, null, '', 'invalid/timezone'])(
  'explicitly falls back to UTC for an absent or invalid timezone: %s',
  async (timezone) => {
    expect(await runtimeClock(0, async () => timezone)).toEqual({
      timestamp: '1970-01-01T00:00:00.000Z',
      timezone: 'UTC',
    });
  },
);

it('uses explicit UTC on preference read failure', async () => {
  expect(
    (
      await runtimeClock(0, async () => {
        throw new Error('unavailable');
      })
    ).timezone,
  ).toBe('UTC');
});

it('appends fresh clocks after complete tool pairs without rewriting the prior input prefix or system', async () => {
  const store = new MemorySessionStore();
  const sandbox = new FakeSandbox();
  sandbox.files.set('note.txt', 'Existing evidence');
  const tools = new CoreToolRegistry(sandbox);
  tools.register(readFileTool);
  let now = Date.parse('2026-11-15T00:00:00Z');
  const llm = new FakeLLM(
    () => {
      now += 60_000;
      return toolCallThenFinish('read', 'read_file', { path: 'note.txt' });
    },
    () => textChunks('Done'),
  );
  const loop = new CoreAgentLoop({
    llm,
    model: 'fake/model',
    tools,
    store,
    workspaceRoot: '/ws',
    now: () => now,
    resolveClockTimezone: async () => 'Asia/Hong_Kong',
  });
  expect((await loop.run('s', 'Read the note', { emit: () => undefined })).reason).toBe(
    'completed',
  );
  const [first, second] = llm.requests;
  expect(second!.system).toBe(first!.system);
  expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
  expect(first!.messages.at(-1)?.content).toContain('2026-11-15T00:00:00.000Z');
  expect(second!.messages.at(-1)?.content).toContain('2026-11-15T00:01:00.000Z');
  expect(second!.messages.at(-2)?.role).toBe('tool');
  expect(second!.estimatedInputTokens).toBeGreaterThanOrEqual(
    estimateRequestTokens({ ...second!, estimatedInputTokens: undefined }),
  );
  const events = await store.load('s');
  const clocks = events.filter((event) => event.type === 'model/clock');
  expect(clocks).toHaveLength(2);
  for (const event of clocks) {
    expect(
      events.findIndex(
        (value) => value.type === 'model/context' && value.requestId === event.requestId,
      ),
    ).toBeGreaterThan(events.indexOf(event));
  }
  expect(
    toModelMessages(events).some((message) => message.content.includes('[Runtime clock snapshot;')),
  ).toBe(false);
  expect(toModelMessages(events)).toEqual([
    { role: 'user', content: 'Read the note' },
    { role: 'assistant', content: expect.stringContaining('Done') },
  ]);
});

it('replays an interrupted request clock verbatim and appends a new snapshot when resumed', async () => {
  const promptId = randomUUID();
  const events: SessionEvent[] = [
    {
      eventId: promptId,
      at: '2026-11-15T00:00:00.000Z',
      type: 'message/user',
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'What time is it?' }],
    },
    {
      eventId: randomUUID(),
      at: '2026-11-15T00:00:00.000Z',
      type: 'model/clock',
      promptId,
      requestId: randomUUID(),
      clock: { timestamp: '2026-11-15T00:00:00.000Z', timezone: 'UTC' },
    },
  ];
  const store = new MemorySessionStore();
  await store.append(
    's',
    events.map((event) => sessionEventSchema.parse(JSON.parse(JSON.stringify(event)))),
  );
  const prefix = toModelMessages(await store.load('s'));
  const llm = new FakeLLM(() => textChunks('The current snapshot is later.'));
  const loop = new CoreAgentLoop({
    llm,
    model: 'fake/model',
    tools: new CoreToolRegistry(new FakeSandbox()),
    store,
    workspaceRoot: '/ws',
    now: () => Date.parse('2026-11-15T01:00:00Z'),
  });
  expect(
    (await loop.run('s', 'ignored retry text', { emit: () => undefined }, { promptSeq: 1 })).reason,
  ).toBe('completed');
  expect(llm.requests[0]!.messages.slice(0, prefix.length)).toEqual(prefix);
  expect(llm.requests[0]!.messages.at(-1)?.content).toContain('2026-11-15T01:00:00.000Z');
  expect((await store.load('s'))[1]).toEqual(events[1]);
});

it('does not dispatch an unjournaled clock if persistence fails', async () => {
  const store = new MemorySessionStore();
  const append = store.append.bind(store);
  vi.spyOn(store, 'append').mockImplementation(async (...args) => {
    if (args[1].some((event) => event.type === 'model/clock'))
      throw new Error('Clock persistence failed');
    return append(...args);
  });
  const llm = new FakeLLM(() => textChunks('Must not dispatch'));
  const loop = new CoreAgentLoop({
    llm,
    model: 'fake/model',
    tools: new CoreToolRegistry(new FakeSandbox()),
    store,
    workspaceRoot: '/ws',
  });
  expect((await loop.run('s', 'Hello', { emit: () => undefined })).reason).toBe('error');
  expect(llm.requests).toHaveLength(0);
});
