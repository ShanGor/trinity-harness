import type {
  AgentLoop,
  AuditEmitter,
  EventSink,
  LiveEventPublisher,
  SessionMetaStore,
  SessionStore,
  TurnTask,
} from '@trinity-harness/contracts';

/**
 * agent-worker turn handler (docs/design.md §4 step 3–5): claim a turn task,
 * run the Loop against the PG-backed (publishing) session store, stream live
 * deltas over Pub/Sub and emit audit records for tool invocations.
 */

export interface TurnHandlerDeps {
  store: SessionStore;
  metas: SessionMetaStore;
  createLoop: (sessionId: string) => AgentLoop;
  live: LiveEventPublisher;
  audit: AuditEmitter;
}

export function createTurnHandler(
  deps: TurnHandlerDeps,
): (task: TurnTask, signal?: AbortSignal) => Promise<void> {
  return async (task, signal) => {
    const meta = await deps.metas.get(task.sessionId);
    const auditContext = {
      tenantId: meta?.tenantId ?? '00000000-0000-0000-0000-000000000000',
      userId: meta?.userId ?? task.actor,
      sessionId: task.sessionId,
    };

    const sink: EventSink = {
      emit: (loopEvent) => {
        // Ephemeral deltas: connected UIs render them in real time; committed
        // state reaches clients through the event log / session stream.
        deps.live.publish(task.sessionId, loopEvent);
        if (loopEvent.type === 'tool/call') {
          deps.audit.emit({
            id: crypto.randomUUID(),
            at: new Date().toISOString(),
            ...auditContext,
            action: 'tool/call',
            target: loopEvent.call.name,
            result: 'ok',
            detail: { argsPreview: JSON.stringify(loopEvent.call.args).slice(0, 500) },
          });
        } else if (loopEvent.type === 'tool/result') {
          deps.audit.emit({
            id: crypto.randomUUID(),
            at: new Date().toISOString(),
            ...auditContext,
            action: 'tool/result',
            result: loopEvent.result.isError ? 'error' : 'ok',
          });
        }
      },
    };

    await deps.createLoop(task.sessionId).run(task.sessionId, task.prompt, sink, {
      actor: task.actor,
      signal,
      // M3: permission policy + prompt seq travel with the task (fail-closed
      // snapshot taken by the server when the prompt was accepted).
      policy: task.policy,
      promptSeq: task.promptSeq,
      // M4 multimodal: attachment content blocks ride with the task.
      ...(task.content !== undefined ? { content: task.content } : {}),
    });
  };
}
