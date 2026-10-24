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
