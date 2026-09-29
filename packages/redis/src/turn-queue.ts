import type { AgentTaskQueue, TurnTask } from '@trinity-harness/contracts';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';

/**
 * BullMQ-backed {@link AgentTaskQueue} (docs/design.md §3, §14 "BullMQ：任务队列").
 * Server enqueues turn jobs; agent-worker claims them. Delivery is
 * at-least-once — the worker side must be idempotent w.r.t. the event log
 * (the PG append is the actual dedup point via the monotonic seq lock).
 */

export const TURN_QUEUE_NAME = 'agent-turns';

export class RedisTurnQueue implements AgentTaskQueue {
  private readonly queue: Queue<TurnTask>;

  constructor(connection: ConnectionOptions, queueName: string = TURN_QUEUE_NAME) {
    this.queue = new Queue<TurnTask>(queueName, {
      connection,
      defaultJobOptions: {
        // A turn that crashes the worker is replayed from the event log
        // (torn-tail repair, design.md §7); retry the job a bounded number
        // of times before parking it.
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: 1000,
      },
    });
  }

  async enqueue(task: TurnTask): Promise<void> {
    await this.queue.add('turn', task, { jobId: crypto.randomUUID() });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export interface TurnWorker {
  /** Resolves when the worker has been asked to close (drains in-flight). */
  close(): Promise<void>;
  /**
   * M3 `session/cancel`: abort the in-flight turn of `sessionId` (no-op when
   * the session is not running on this worker replica).
   */
  cancel(sessionId: string): void;
}

/**
 * Worker side: claim turn jobs and run them through `handler`. The handler
 * receives an AbortSignal scoped to the job so `cancel()` (and worker
 * shutdown via job termination) propagates into the Loop, LLM stream and
 * tool executions (AGENTS.md §4.2).
 * Concurrency 1 per worker process keeps per-session ordering simple; scale
 * by adding worker replicas (design.md §16 HPA).
 */
export function createTurnWorker(
  connection: ConnectionOptions,
  handler: (task: TurnTask, job: Job<TurnTask>, signal: AbortSignal) => Promise<void>,
  queueName: string = TURN_QUEUE_NAME,
): TurnWorker {
  const active = new Map<string, AbortController>();
  const worker = new Worker<TurnTask>(
    queueName,
    async (job) => {
      const controller = new AbortController();
      active.set(job.data.sessionId, controller);
      try {
        await handler(job.data, job, controller.signal);
      } finally {
        active.delete(job.data.sessionId);
      }
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    console.error(`[turn-worker] job ${job?.id} failed (attempt ${job?.attemptsMade})`, err);
  });
  return {
    close: () => worker.close(),
    cancel: (sessionId) => active.get(sessionId)?.abort(),
  };
}
