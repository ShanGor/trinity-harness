import type { SessionRunPort, SessionStore, TurnTask } from '@trinity-harness/contracts';
import { newId } from '@trinity-harness/shared';

/** Drain through the requested watermark, independent of queue delivery order. */
export async function runOrderedPrompts(
  runs: SessionRunPort,
  store: SessionStore,
  task: TurnTask,
  execute: (task: TurnTask) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  await runs.run(
    task.sessionId,
    async () => {
      const entries = await store.loadRange(task.sessionId, { afterSeq: 0 });
      const target = entries.find((entry) => entry.seq === task.promptSeq)?.event;
      if (target?.type !== 'prompt/queued') {
        await execute(task);
        return;
      }
      const pending = entries.filter(
        (entry) => entry.seq <= task.promptSeq && entry.event.type === 'prompt/queued',
      );
      for (const entry of pending) {
        signal?.throwIfAborted();
        const event = entry.event;
        if (event.type !== 'prompt/queued') continue;
        const history = await store.load(task.sessionId);
        if (
          history.some(
            (item) =>
              (item.type === 'turn/end' || item.type === 'prompt/discarded') &&
              item.promptId === event.promptId,
          )
        )
          continue;
        if (
          history.some(
            (item) => item.type === 'turn/cancel_requested' && item.throughPromptSeq >= entry.seq,
          )
        ) {
          await store.append(
            task.sessionId,
            [
              {
                type: 'prompt/discarded',
                eventId: newId(),
                at: new Date().toISOString(),
                promptId: event.promptId,
                reason: 'cancelled',
              },
            ],
            { actor: event.actor },
          );
          continue;
        }
        const promoted = history.findIndex(
          (item) => item.type === 'message/user' && item.eventId === event.promptId,
        );
        const promptSeq =
          promoted >= 0
            ? promoted + 1
            : (
                await store.append(
                  task.sessionId,
                  [
                    {
                      type: 'message/user',
                      eventId: event.promptId,
                      at: event.at,
                      surfaceOp: 'append',
                      content: event.content,
                      ...(event.trigger ? { trigger: event.trigger } : {}),
                    },
                  ],
                  { actor: event.actor },
                )
              ).from;
        await execute({
          sessionId: task.sessionId,
          promptSeq,
          prompt: event.content
            .filter((block) => block.kind === 'text')
            .map((block) => (block.kind === 'text' ? block.text : ''))
            .join('\n'),
          content: event.content,
          actor: event.actor,
          tenantId: event.tenantId,
          policy: event.policy,
        });
      }
    },
    signal,
  );
}
