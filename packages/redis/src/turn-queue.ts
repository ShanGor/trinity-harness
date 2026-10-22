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
    const jobId = `${task.sessionId}-${task.promptSeq}`;
    const previous = await this.queue.getJob(jobId);
    if (previous && (await previous.isFailed())) {
      await previous.retry();
      return;
    }
    await this.queue.add('turn', task, { jobId });
  }

  /**
   * M5 queue-depth metric feed (docs/design.md §17): BullMQ job counts, used
   * by an ObservableGauge callback (event-driven per scrape — no polling).
   */
  async counts(): Promise<Record<string, number>> {
    const raw = await this.queue.getJobCounts(
      'waiting',
      'active',
      'delayed',
      'failed',
      'completed',
    );
    return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v)]));
  }

  /** Recover terminal notifications lost when a worker exited. Retention is bounded to 1000. */
  async reconcileFailed(handler: (task: TurnTask) => Promise<void>): Promise<void> {
    for (const job of await this.queue.getFailed(0, 999)) await handler(job.data);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export interface TurnWorker {
  /** Resolves when the worker has been asked to close (drains in-flight). */
  close(options?: { abortActive?: boolean }): Promise<void>;
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
  options: {
    concurrency?: number;
    onTerminalFailure?: (task: TurnTask) => Promise<void>;
  } = {},
): TurnWorker {
  const active = new Map<string, Set<AbortController>>();
  const failureNotifications = new Set<Promise<void>>();
  const worker = new Worker<TurnTask>(
    queueName,
    async (job) => {
      const controller = new AbortController();
      const controllers = active.get(job.data.sessionId) ?? new Set<AbortController>();
      controllers.add(controller);
      active.set(job.data.sessionId, controllers);
      try {
        await handler(job.data, job, controller.signal);
      } finally {
        controllers.delete(controller);
        if (!controllers.size) active.delete(job.data.sessionId);
      }
    },
    { connection, concurrency: options.concurrency ?? 1 },
  );
  worker.on('failed', (job, err) => {
    // Provider/driver error objects can contain secrets or full input.
    console.error(`[turn-worker] job ${job?.id} failed (attempt ${job?.attemptsMade})`, err.name);
    if (!job || !options.onTerminalFailure) return;
    const notify = (async (): Promise<void> => {
      // Automatic retries are not terminal and must not close the turn.
      if ((await job.getState()) === 'failed') await options.onTerminalFailure!(job.data);
    })().catch(() => {
      // PG remains authoritative; startup reconciliation retries this delivery.
      console.error(`[turn-worker] terminal notification failed for job ${job.id}`);
    });
    failureNotifications.add(notify);
    void notify.finally(() => failureNotifications.delete(notify));
  });
  return {
    close: async (closeOptions) => {
      // Development watchers have a short kill deadline. Abort before draining
      // so the loop can persist its terminal state before the process exits.
      const closing = worker.close();
      if (closeOptions?.abortActive)
        for (const controllers of active.values())
          for (const controller of controllers) controller.abort();
      await closing;
      await Promise.all(failureNotifications);
    },
    cancel: (sessionId) => {
      for (const controller of active.get(sessionId) ?? []) controller.abort();
    },
  };
}
