import { expect, it } from 'vitest';
import { runControlWorker } from '../src/runner.js';
it('reconciles on startup, retries an unavailable datastore and cancels deterministically', async () => {
  const controller = new AbortController();
  const times: string[] = [],
    failures: unknown[] = [];
  const error = new Error('database unavailable');
  await runControlWorker(
    {
      tick: async (at) => {
        times.push(at.toISOString());
        if (times.length === 1) throw error;
        controller.abort();
      },
    },
    controller.signal,
    () => new Date('2026-10-24T00:00:00Z'),
    (e) => failures.push(e),
    async () => {},
  );
  expect(times).toHaveLength(2);
  expect(failures).toEqual([error]);
});

it('keeps scheduling responsive during a slow embedding lane and drains both on cancellation', async () => {
  const controller = new AbortController();
  let started = false;
  let drained = false;
  let ticks = 0;
  const failures: unknown[] = [];
  const memory = runControlWorker(
    {
      tick: async () => {
        started = true;
        await new Promise<void>((resolve) =>
          controller.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        drained = true;
      },
    },
    controller.signal,
    () => new Date(0),
    (error) => failures.push(error),
    async () => undefined,
  );
  const schedules = runControlWorker(
    {
      tick: async () => {
        expect(started).toBe(true);
        expect(drained).toBe(false);
        if (++ticks === 2) controller.abort();
      },
    },
    controller.signal,
    () => new Date(0),
    (error) => failures.push(error),
    async () => undefined,
  );
  await Promise.all([memory, schedules]);
  expect(ticks).toBe(2);
  expect(drained).toBe(true);
  expect(failures).toEqual([]);
});
