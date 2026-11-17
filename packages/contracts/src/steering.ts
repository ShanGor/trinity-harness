import { z } from 'zod';
import type { SessionEvent } from './events.js';

/** Explicitly bind a supplement to the task the user is watching. */
export const steeringInputSchema = z.object({ inputId: z.uuid(), promptId: z.uuid() }).strict();
export type SteeringInput = z.infer<typeof steeringInputSchema>;

/** Applied messages remain reconstructible after consumption and worker recreation. */
export function pendingSteering(
  events: readonly SessionEvent[],
  promptId: string,
): Extract<SessionEvent, { type: 'steering/accepted' }>[] {
  const applied = new Set(
    events.flatMap((event) =>
      event.type === 'steering/applied' && event.promptId === promptId ? event.inputIds : [],
    ),
  );
  return events.filter(
    (event): event is Extract<SessionEvent, { type: 'steering/accepted' }> =>
      event.type === 'steering/accepted' &&
      event.promptId === promptId &&
      !applied.has(event.inputId),
  );
}

/** Enforced under the store append lock, shared by durable and deterministic stores. */
export function assertSteeringAppend(
  history: readonly SessionEvent[],
  incoming: readonly SessionEvent[],
): void {
  for (const event of incoming) {
    if (event.type === 'steering/accepted') {
      if (history.some((item) => item.eventId === event.inputId || item.eventId === event.eventId))
        throw Object.assign(new Error('Input ID already used.'), { code: 'STEERING_CONFLICT' });
      const source = history.findIndex(
        (item) => item.type === 'message/user' && item.eventId === event.promptId,
      );
      const start = history.find(
        (item) => item.type === 'turn/start' && item.promptId === event.promptId,
      );
      if (
        source < 0 ||
        !start ||
        history
          .slice(source + 1)
          .some(
            (item) =>
              (item.type === 'turn/end' && item.promptId === event.promptId) ||
              (item.type === 'turn/cancel_requested' && item.throughPromptSeq >= source + 1) ||
              item.type === 'message/user',
          )
      )
        throw Object.assign(
          new Error('The target task is no longer active. Send this as a new request.'),
          { code: 'STEERING_TASK_ENDED' },
        );
      if (
        history.filter(
          (item) => item.type === 'steering/accepted' && item.promptId === event.promptId,
        ).length >= 32
      )
        throw Object.assign(new Error('This task has reached its supplement limit.'), {
          code: 'STEERING_LIMIT',
        });
    }
    if (event.type === 'turn/end' && event.reason === 'completed' && event.promptId) {
      const source = history.findIndex(
        (item) => item.type === 'message/user' && item.eventId === event.promptId,
      );
      if (
        source >= 0 &&
        history.some(
          (item) => item.type === 'turn/cancel_requested' && item.throughPromptSeq >= source + 1,
        )
      )
        throw new DOMException('The task was cancelled before completion.', 'AbortError');
    }
    if (
      event.type === 'turn/end' &&
      event.reason === 'completed' &&
      event.promptId &&
      pendingSteering(history, event.promptId).length
    )
      throw Object.assign(new Error('Pending supplements must be applied before completion.'), {
        code: 'STEERING_PENDING',
      });
  }
}
