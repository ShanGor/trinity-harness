import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemorySessionStore } from '@trinity-harness/core';
import { parsePermissionPolicy, type TurnTask } from '@trinity-harness/contracts';
import { createTurnFailureHandler } from '../src/worker.js';

const at = '2026-10-22T02:00:00.000Z';
async function fixture(queued = false) {
  const store = new MemorySessionStore();
  const sessionId = randomUUID();
  const promptId = randomUUID();
  const task: TurnTask = {
    sessionId,
    promptSeq: 1,
    prompt: 'Continue the original objective',
    actor: randomUUID(),
    tenantId: randomUUID(),
    policy: parsePermissionPolicy('read-only'),
  };
  await store.append(sessionId, [
    queued
      ? {
          type: 'prompt/queued',
          eventId: randomUUID(),
          at,
          promptId,
          content: [{ kind: 'text', text: task.prompt }],
          actor: task.actor,
          tenantId: task.tenantId,
          policy: task.policy,
        }
      : {
          type: 'message/user',
          eventId: promptId,
          at,
          surfaceOp: 'append',
          content: [{ kind: 'text', text: task.prompt }],
        },
  ]);
  const run = vi.fn();
  const handle = createTurnFailureHandler({
    store,
    sessionRuns: {
      run: async (_session, operation) => {
        run();
        return operation();
      },
    },
  });
  return { store, task, promptId, run, handle };
}

it.each([false, true])(
  'records and replays exhausted queue failure for queued=%s',
  async (queued) => {
    const f = await fixture(queued);
    await f.handle(f.task);
    await f.handle(f.task);
    const events = await f.store.load(f.task.sessionId);
    expect(events.filter((event) => event.type === 'turn/end')).toEqual([
      expect.objectContaining({
        reason: 'error',
        promptId: f.promptId,
        detail: expect.stringContaining('queue recovery was exhausted'),
      }),
    ]);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(
      events.some((event) => event.type === 'message/user' && event.eventId === f.promptId),
    ).toBe(true);
  },
);

it('does not overwrite a turn completed by a recovered worker', async () => {
  const f = await fixture();
  await f.store.append(f.task.sessionId, [
    { type: 'turn/end', eventId: randomUUID(), at, reason: 'completed', promptId: f.promptId },
  ]);
  await f.handle(f.task);
  expect(
    (await f.store.load(f.task.sessionId)).filter((event) => event.type === 'turn/end'),
  ).toHaveLength(1);
});

it('does not attribute a late queue failure to a newer prompt', async () => {
  const f = await fixture();
  const newer = randomUUID();
  await f.store.append(f.task.sessionId, [
    {
      type: 'message/user',
      eventId: newer,
      at,
      surfaceOp: 'append',
      content: [{ kind: 'text', text: 'New task' }],
    },
  ]);
  await f.handle(f.task);
  expect(
    (await f.store.load(f.task.sessionId)).filter((event) => event.type === 'turn/end'),
  ).toEqual([expect.objectContaining({ promptId: f.promptId })]);
});

it('does not mutate sessions when the source watermark is missing', async () => {
  const f = await fixture();
  await f.handle({ ...f.task, promptSeq: 99 });
  expect(await f.store.load(f.task.sessionId)).toHaveLength(1);
});
