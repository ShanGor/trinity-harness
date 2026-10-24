import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  nextScheduleInstant,
  scheduleCreateSchema,
  type ScheduleDefinition,
} from '@trinity-harness/contracts';
import { MemorySessionStore, runOrderedPrompts } from '../src/index.js';
import {
  parsePermissionPolicy,
  type TurnTask,
  type SessionRunPort,
} from '@trinity-harness/contracts';
import { toModelMessages } from '../src/loop/to-model-messages.js';
const base: ScheduleDefinition = {
  title: 'Daily',
  request: 'Prepare my report',
  sourceSessionId: '00000000-0000-7000-8000-000000000001',
  timezone: 'Asia/Hong_Kong',
  timing: { kind: 'daily', hour: 9, minute: 0, weekdays: [1, 2, 3, 4, 5] },
};
it('uses local calendar days, skips weekends and preserves strict after semantics', () => {
  expect(nextScheduleInstant(base, new Date('2026-10-23T01:00:00Z'))?.toISOString()).toBe(
    '2026-10-26T01:00:00.000Z',
  );
  expect(nextScheduleInstant(base, new Date('2026-10-23T00:59:59Z'))?.toISOString()).toBe(
    '2026-10-23T01:00:00.000Z',
  );
});
it('skips the spring gap and executes only once across the fall fold', () => {
  const daily: ScheduleDefinition = {
    ...base,
    timezone: 'America/New_York',
    timing: { kind: 'daily', hour: 2, minute: 30, weekdays: [0, 1, 2, 3, 4, 5, 6] },
  };
  expect(nextScheduleInstant(daily, new Date('2026-03-08T05:00:00Z'))?.toISOString()).toBe(
    '2026-03-09T06:30:00.000Z',
  );
  const fold: ScheduleDefinition = {
    ...daily,
    timing: {
      ...daily.timing,
      kind: 'daily',
      hour: 1,
      minute: 30,
      weekdays: [0, 1, 2, 3, 4, 5, 6],
    },
  };
  expect(nextScheduleInstant(fold, new Date('2026-11-01T04:00:00Z'))?.toISOString()).toBe(
    '2026-11-01T05:30:00.000Z',
  );
  expect(nextScheduleInstant(fold, new Date('2026-11-01T05:30:00Z'))?.toISOString()).toBe(
    '2026-11-02T06:30:00.000Z',
  );
  expect(nextScheduleInstant(fold, new Date('2026-11-01T06:00:00Z'))?.toISOString()).toBe(
    '2026-11-02T06:30:00.000Z',
  );
});
it('expires one-off schedules and rejects unknown timezones or model-controlled owner fields', () => {
  expect(
    nextScheduleInstant(
      { ...base, timing: { kind: 'once', at: '2026-10-24T00:00:00Z' } },
      new Date('2026-10-24T00:00:00Z'),
    ),
  ).toBeNull();
  expect(
    scheduleCreateSchema.safeParse({
      ...base,
      operationId: base.sourceSessionId,
      timezone: 'Invalid/Zone',
    }).success,
  ).toBe(false);
  expect(
    scheduleCreateSchema.safeParse({
      ...base,
      operationId: base.sourceSessionId,
      owner: 'another-user',
    }).success,
  ).toBe(false);
});
it('preserves the delegated request and trigger when a promoted scheduled run is recovered', async () => {
  const store = new MemorySessionStore();
  const sessionId = randomUUID(),
    promptId = randomUUID();
  const trigger = {
    kind: 'schedule' as const,
    scheduleId: randomUUID(),
    revision: 1,
    occurrenceId: randomUUID(),
    scheduledAt: '2026-10-24T00:00:00Z',
  };
  const task: TurnTask = {
    sessionId,
    promptSeq: 1,
    actor: randomUUID(),
    tenantId: randomUUID(),
    prompt: 'Do the saved request',
    policy: parsePermissionPolicy('read-only'),
  };
  await store.append(sessionId, [
    {
      type: 'prompt/queued',
      eventId: randomUUID(),
      at: trigger.scheduledAt,
      promptId,
      content: [{ kind: 'text', text: task.prompt }],
      actor: task.actor,
      tenantId: task.tenantId,
      policy: task.policy,
      trigger,
    },
  ]);
  const runs: SessionRunPort = {
    run: async (id, action) => {
      expect(id).toBe(sessionId);
      return action();
    },
  };
  await expect(
    runOrderedPrompts(runs, store, task, async () => {
      throw new Error('worker lost');
    }),
  ).rejects.toThrow('worker lost');
  await runOrderedPrompts(runs, store, task, async () => {
    await store.append(sessionId, [
      {
        type: 'turn/end',
        eventId: randomUUID(),
        at: trigger.scheduledAt,
        reason: 'completed',
        promptId,
      },
    ]);
  });
  const history = await store.load(sessionId);
  expect(history.filter((event) => event.type === 'message/user')).toHaveLength(1);
  expect(history.find((event) => event.type === 'message/user')).toMatchObject({
    content: [{ kind: 'text', text: task.prompt }],
    trigger,
  });
  expect(toModelMessages(history).find((message) => message.role === 'user')?.content).toContain(
    'saved scheduled delegation',
  );
});
