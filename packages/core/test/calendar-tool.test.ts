import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  CoreAgentLoop,
  CoreToolRegistry,
  MemorySessionStore,
  createCalendarTool,
} from '../src/index.js';
import { FakeLLM, textChunks, toolCallThenFinish } from '../src/testing/fake-llm.js';
import { FakeSandbox } from '../src/testing/fake-sandbox.js';
import {
  calendarDefinitionSchema,
  defaultCalendarPreferences,
  type CalendarStore,
  type SessionMetaStore,
  type SessionMeta,
  type UserStore,
} from '@trinity-harness/contracts';

async function fixture(scope: 'personal' | 'team' = 'personal') {
  const at = new Date().toISOString();
  const meta: SessionMeta = {
    id: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    title: 'Main',
    kind: 'chat',
    sessionRole: 'main',
    scope,
    workspaceUri: '/workspace',
    createdAt: at,
  };
  const metas: SessionMetaStore = {
    get: async () => meta,
    create: vi.fn(),
    listForIdentity: async () => [meta],
    setTitleIfEmpty: vi.fn(),
    close: vi.fn(),
    setPolicy: vi.fn(),
  };
  const users: Pick<UserStore, 'findById'> = {
    findById: async () => ({
      id: meta.userId,
      tenantId: meta.tenantId,
      role: 'member',
      email: 'test@example.com',
      createdAt: at,
    }),
  };
  const store = new MemorySessionStore();
  const calendar: CalendarStore = {
    snapshot: vi.fn(async () => ({
      available: true,
      items: [],
      reminders: [],
      preferences: defaultCalendarPreferences,
      pushAvailable: false,
      pushPublicKey: null,
    })),
    save: vi.fn(async (_identity, input, now, origin) => ({
      id: input.id,
      definition: input.definition,
      status: input.status,
      revision: 1,
      source: origin?.source ?? null,
      scheduleId: null,
      nextAt: '2027-01-01T01:00:00.000Z',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    })),
    preferences: vi.fn(),
    reminderAction: vi.fn(),
    subscribe: vi.fn(),
    tick: vi.fn(),
  };
  const registry = new CoreToolRegistry(new FakeSandbox());
  registry.register(createCalendarTool({ calendar, metas, users, store }));
  const args = {
    operation: 'save',
    expectedRevision: 0,
    definition: calendarDefinitionSchema.parse({
      title: 'Call Alex',
      kind: 'reminder',
      timing: {
        date: { calendar: 'gregorian', year: 2027, month: 1, day: 1 },
        timezone: 'Asia/Hong_Kong',
        hour: 9,
        minute: 0,
        recurrence: 'once',
      },
    }),
    status: 'active',
    sourceQuote: 'Remind me on January 1 at 9 am to call Alex.',
    capture: 'explicit',
  };
  return { meta, metas, store, calendar, registry, args };
}

it('journals an explicit reminder as its minimal plan and finishes without workspace verification', async () => {
  const f = await fixture();
  const llm = new FakeLLM(
    () => toolCallThenFinish('calendar-save', 'calendar', f.args),
    () => textChunks('Saved your reminder.'),
  );
  await new CoreAgentLoop({
    llm,
    model: 'fake/model',
    tools: f.registry,
    store: f.store,
    workspaceRoot: '/workspace',
    sessionMetas: f.metas,
    verification: true,
  }).run(f.meta.id, f.args.sourceQuote, { emit: () => undefined }, { actor: f.meta.userId });
  const events = await f.store.load(f.meta.id);
  expect(f.calendar.save).toHaveBeenCalledOnce();
  expect(events.find((e) => e.type === 'tool/result')).toMatchObject({
    isError: false,
    value: { saved: true },
  });
  expect(events.filter((e) => e.type === 'task/plan')).toEqual([]);
  expect(events.at(-1)).toMatchObject({ type: 'turn/end', reason: 'completed' });
  expect(llm.requests[0]?.system).toContain('Chinese lunar');
  const second = new FakeLLM(
    () => toolCallThenFinish('calendar-save', 'calendar', f.args),
    () => textChunks('Saved the new request.'),
  );
  await new CoreAgentLoop({
    llm: second,
    model: 'fake/model',
    tools: f.registry,
    store: f.store,
    workspaceRoot: '/workspace',
    sessionMetas: f.metas,
    verification: true,
  }).run(f.meta.id, f.args.sourceQuote, { emit: () => undefined }, { actor: f.meta.userId });
  expect(vi.mocked(f.calendar.save).mock.calls[0]![1].operationId).not.toBe(
    vi.mocked(f.calendar.save).mock.calls[1]![1].operationId,
  );
});

it.each(['team', 'child', 'scheduled', 'unjournaled', 'wrong_quote'] as const)(
  'rejects %s calendar writes before persistence',
  async (mode) => {
    const f = await fixture(mode === 'team' ? 'team' : 'personal');
    const promptId = randomUUID();
    await f.store.append(f.meta.id, [
      {
        type: 'message/user',
        surfaceOp: 'append',
        eventId: promptId,
        at: new Date().toISOString(),
        content: [
          {
            kind: 'text',
            text: mode === 'wrong_quote' ? 'A different request' : f.args.sourceQuote,
          },
        ],
        ...(mode === 'scheduled'
          ? {
              trigger: {
                kind: 'schedule' as const,
                scheduleId: randomUUID(),
                revision: 1,
                occurrenceId: randomUUID(),
                scheduledAt: new Date().toISOString(),
              },
            }
          : {}),
      },
    ]);
    if (mode !== 'unjournaled')
      await f.store.append(f.meta.id, [
        {
          type: 'tool/call',
          eventId: randomUUID(),
          at: new Date().toISOString(),
          callId: 'write',
          name: 'calendar',
          args: f.args,
        },
      ]);
    const result = await f.registry.execute(
      { id: 'write', name: 'calendar', args: f.args },
      {
        sessionId: f.meta.id,
        workspaceRoot: '/workspace',
        userPromptId: promptId,
        callId: 'write',
        personalCalendarAllowed: mode !== 'child',
      },
    );
    expect(result.isError).toBe(true);
    expect(f.calendar.save).not.toHaveBeenCalled();
  },
);
