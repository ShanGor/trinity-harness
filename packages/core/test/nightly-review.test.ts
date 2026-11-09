import type { SessionMetaStore } from '@trinity-harness/contracts';
import { expect, it } from 'vitest';
import {
  historyPreferencesSchema,
  scheduledRequest,
  reviewWithinCatchupWindow,
  scheduleCreateSchema,
  suggestTopic,
  type ScheduleDefinition,
} from '@trinity-harness/contracts';

const base: ScheduleDefinition = {
  title: 'Nightly review',
  request: 'Prepare a digest',
  sourceSessionId: '00000000-0000-7000-8000-000000000001',
  timezone: 'Asia/Hong_Kong',
  timing: { kind: 'daily', hour: 3, minute: 0, weekdays: [0, 1, 2, 3, 4, 5, 6] },
  consolidation: 'review',
};
it.each([
  ['Asia/Hong_Kong', '2026-11-08T19:00:00Z', '2026-11-08'],
  ['America/New_York', '2026-03-09T07:00:00Z', '2026-03-08'],
  ['America/New_York', '2026-11-02T08:00:00Z', '2026-11-01'],
  ['Pacific/Auckland', '2026-12-31T14:00:00Z', '2026-12-31'],
])('binds the preceding calendar date in %s', (timezone, at, date) => {
  const request = scheduledRequest({ ...base, timezone }, new Date(at));
  expect(request).toContain(`Review date: ${date}; IANA timezone: ${timezone}`);
  expect(request).toContain(`date="${date}"`);
  expect(request).toContain('Do not call persona');
  expect(request).toContain('Report any pagination or source truncation');
});
it('preserves ordinary schedule requests and rejects unsupported consolidation modes', () => {
  const ordinary = { ...base, consolidation: undefined };
  expect(scheduledRequest(ordinary, new Date())).toBe(base.request);
  expect(
    scheduleCreateSchema.safeParse({
      ...base,
      operationId: base.sourceSessionId,
      consolidation: 'automatic',
    }).success,
  ).toBe(false);
});
it('validates account zones and matches returning Chinese topics', () => {
  expect(historyPreferencesSchema.safeParse({ timezone: 'invalid' }).success).toBe(false);
  expect(historyPreferencesSchema.safeParse({ timezone: 'Asia/Hong_Kong' }).success).toBe(true);
  expect(
    suggestTopic('继续讨论浏览器部署', [{ topic: '浏览器部署', request: '浏览器部署方案' }]),
  ).toBe('浏览器部署');
});

it('forwards calendar filters and the current suppression floor to recall search', async () => {
  const { createRecallTool, CoreToolRegistry } = await import('../src/index.js');
  const { FakeSandbox } = await import('../src/testing/fake-sandbox.js');
  const { vi } = await import('vitest');
  const history = vi.fn(async () => ({ episodes: [], nextBefore: 123 }));
  const tools = new CoreToolRegistry(new FakeSandbox());
  tools.register(
    createRecallTool({
      memory: {
        snapshot: async () => ({
          revision: 5,
          suppressionRevision: 3,
          hasSuppression: true,
          items: [],
        }),
        change: vi.fn(),
      },
      index: { history, revise: vi.fn() },
      metas: {
        create: vi.fn(),
        listForIdentity: async () => [],
        setTitleIfEmpty: vi.fn(),
        close: vi.fn(),
        setPolicy: vi.fn(),
        get: async () => ({
          id: base.sourceSessionId,
          tenantId: base.sourceSessionId,
          userId: base.sourceSessionId,
          title: 'Personal',
          workspaceUri: null,
          scope: 'personal',
          createdAt: '2026-11-09T00:00:00Z',
        }),
      } satisfies SessionMetaStore,
      store: new (await import('../src/index.js')).MemorySessionStore(),
    }),
  );
  const result = await tools.execute(
    {
      name: 'recall',
      id: 'date-read',
      args: { date: '2026-11-08', timezone: 'Asia/Hong_Kong', before: 456 },
    },
    { sessionId: base.sourceSessionId, workspaceRoot: '/workspace' },
  );
  expect(result.isError).toBe(false);
  expect(result.value).toMatchObject({ nextBefore: 123, policyRevision: 5 });
  expect(history).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      date: '2026-11-08',
      timezone: 'Asia/Hong_Kong',
      before: 456,
      minPolicyRevision: 3,
      recallOnly: true,
    }),
  );
});

it('bounds catch-up by local calendar dates across DST and year changes', () => {
  const definition = { ...base, timezone: 'America/New_York' };
  const now = new Date('2026-11-07T09:00:00Z');
  expect(reviewWithinCatchupWindow(definition, new Date('2026-11-01T08:00:00Z'), now)).toBe(true);
  expect(reviewWithinCatchupWindow(definition, new Date('2026-10-31T07:00:00Z'), now)).toBe(false);
  expect(reviewWithinCatchupWindow(definition, new Date('2026-11-08T08:00:00Z'), now)).toBe(false);
  expect(
    reviewWithinCatchupWindow(
      base,
      new Date('2025-12-31T19:00:00Z'),
      new Date('2026-01-07T00:00:00Z'),
    ),
  ).toBe(true);
});
