import { setTimeout as delay } from 'node:timers/promises';
import type { ScheduleStore } from '@trinity-harness/contracts';

/** No in-memory schedule authority: every wake reconciles committed PG records. */
export async function runControlWorker(
  store: Pick<ScheduleStore, 'tick'>,
  signal: AbortSignal,
  now: () => Date,
  onError: (error: unknown) => void,
  wait: (signal: AbortSignal) => Promise<void> = (active) =>
    delay(1000, undefined, { signal: active }),
): Promise<void> {
  while (!signal.aborted) {
    try {
      await store.tick(now(), signal);
    } catch (error) {
      if (!signal.aborted) onError(error);
    }
    try {
      await wait(signal);
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
