import { beforeEach, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { TurnTask } from '@trinity-harness/contracts';
import { parsePermissionPolicy } from '@trinity-harness/contracts';
import { createTurnWorker, RedisTurnQueue } from '../src/turn-queue.js';

const state = vi.hoisted(() => ({
  workers: [] as {
    emit: (event: string, ...args: unknown[]) => boolean;
    process: (job: Job<TurnTask>) => Promise<void>;
    running?: Promise<void>;
  }[],
  failed: vi.fn(),
}));
vi.mock('bullmq', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      running?: Promise<void>;
      constructor(
        _name: string,
        readonly process: (job: Job<TurnTask>) => Promise<void>,
      ) {
        super();
        state.workers.push(this);
      }
      async close(): Promise<void> {
        await this.running;
      }
    },
    Queue: class {
      getFailed = state.failed;
      async close(): Promise<void> {}
    },
  };
});
beforeEach(() => {
  state.workers.length = 0;
  vi.clearAllMocks();
});
const task: TurnTask = {
  sessionId: 'session',
  prompt: 'Continue',
  actor: 'owner',
  tenantId: 'tenant',
  promptSeq: 273,
  policy: parsePermissionPolicy('read-only'),
};
function job(status: string): Job<TurnTask> {
  return {
    id: 'job',
    data: task,
    getState: async () => status,
    attemptsMade: 1,
  } as unknown as Job<TurnTask>;
}

it('publishes only terminal queue exhaustion and never logs raw error details', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const terminal = vi.fn(async () => undefined);
    const worker = createTurnWorker({}, async () => undefined, 'test', {
      onTerminalFailure: terminal,
    });
    state.workers[0]!.emit('failed', job('delayed'), new Error('PRIVATE REQUEST BODY'));
    await worker.close();
    expect(terminal).not.toHaveBeenCalled();
    state.workers[0]!.emit('failed', job('failed'), new Error('PRIVATE REQUEST BODY'));
    await worker.close();
    expect(terminal).toHaveBeenCalledExactlyOnceWith(task);
    expect(JSON.stringify(log.mock.calls)).not.toContain('PRIVATE REQUEST BODY');
  } finally {
    log.mockRestore();
  }
});

it('waits for terminal event delivery before shutdown, and contains delivery failure', async () => {
  let finish!: () => void;
  const delivery = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const handler = vi.fn(() => delivery);
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const worker = createTurnWorker({}, async () => undefined, 'test', {
      onTerminalFailure: handler,
    });
    state.workers[0]!.emit('failed', job('failed'), new Error('stalled'));
    let closed = false;
    const closing = worker.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(handler).toHaveBeenCalledOnce();
    handler.mockRejectedValueOnce(new Error('database unavailable'));
    state.workers[0]!.emit('failed', job('failed'), new Error('stalled'));
    await expect(worker.close()).resolves.toBeUndefined();
  } finally {
    log.mockRestore();
  }
});

it('aborts active work before draining on development reload', async () => {
  let received: AbortSignal | undefined;
  const worker = createTurnWorker({}, async (_task, _job, signal) => {
    received = signal;
    await new Promise<void>((resolve) =>
      signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  });
  const fake = state.workers[0]!;
  fake.running = fake.process(job('active'));
  await worker.close({ abortActive: true });
  expect(received?.aborted).toBe(true);
  await fake.running;
});

it('preserves production draining without an unsolicited cancellation', async () => {
  let finish!: () => void;
  let received: AbortSignal | undefined;
  const worker = createTurnWorker({}, async (_task, _job, signal) => {
    received = signal;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const fake = state.workers[0]!;
  fake.running = fake.process(job('active'));
  const closing = worker.close();
  expect(received?.aborted).toBe(false);
  finish();
  await closing;
});

it('reconciles retained failures at startup, covering a crash before notification delivery', async () => {
  state.failed.mockResolvedValue([job('failed')]);
  const handler = vi.fn(async () => undefined);
  const queue = new RedisTurnQueue({});
  await queue.reconcileFailed(handler);
  expect(state.failed).toHaveBeenCalledWith(0, 999);
  expect(handler).toHaveBeenCalledExactlyOnceWith(task);
  await queue.close();
});
