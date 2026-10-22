import { runOrderedPrompts, sessionWorkspaceRoot } from '@trinity-harness/core';
import type { SessionRunPort } from '@trinity-harness/contracts';
import type {
  AgentLoop,
  AuditEmitter,
  EventSink,
  LiveEventPublisher,
  SessionMetaStore,
  TeamStore,
  UserStore,
  SessionStore,
  TurnTask,
} from '@trinity-harness/contracts';
import { newId } from '@trinity-harness/shared';

/**
 * agent-worker turn handler (docs/design.md §4 step 3–5): claim a turn task,
 * run the Loop against the PG-backed (publishing) session store, stream live
 * deltas over Pub/Sub and emit audit records for tool invocations.
 */

export interface TurnHandlerDeps {
  store: SessionStore;
  metas: SessionMetaStore;
  teams?: TeamStore;
  users?: UserStore;
  sessionRuns?: SessionRunPort;
  /**
   * Builds the Loop for a turn, sandboxed to the session's workspace root
   * (`meta.workspaceUri`; legacy Chat is bound durably before execution).
   */
  createLoop: (sessionId: string, workspaceRoot: string) => AgentLoop;
  /** Fallback workspace root when the session has no meta row. */
  defaultWorkspaceRoot: string;
  live: LiveEventPublisher;
  audit: AuditEmitter;
}

/** Persist queue exhaustion through the same ordered execution lock as turns. */
export function createTurnFailureHandler(deps: {
  store: SessionStore;
  sessionRuns: SessionRunPort;
  signal?: AbortSignal;
}): (task: TurnTask) => Promise<void> {
  return (task) =>
    runOrderedPrompts(
      deps.sessionRuns,
      deps.store,
      task,
      async (ordered) => {
        const events = await deps.store.load(ordered.sessionId);
        const prompt = events[ordered.promptSeq - 1];
        if (prompt?.type !== 'message/user') return;
        if (events.some((event) => event.type === 'turn/end' && event.promptId === prompt.eventId))
          return;
        await deps.store.append(
          ordered.sessionId,
          [
            {
              type: 'turn/end',
              eventId: newId(),
              at: new Date().toISOString(),
              promptId: prompt.eventId,
              reason: 'error',
              detail:
                'Worker execution stopped and queue recovery was exhausted. The task is unfinished; send a follow-up to resume the original objective. Tool outcomes may be unknown; inspect state before repeating effects.',
            },
          ],
          { actor: 'agent-worker' },
        );
      },
      deps.signal,
    );
}

export function createTurnHandler(
  deps: TurnHandlerDeps,
): (task: TurnTask, signal?: AbortSignal) => Promise<void> {
  return async (task, signal) => {
    const meta = await deps.metas.get(task.sessionId);
    if (meta?.closedAt) throw new Error('session closed');
    if (
      meta?.scope === 'team' &&
      (!meta.scopeId || !deps.teams || !(await deps.teams.isMember(meta.scopeId, task.actor)))
    )
      throw new Error('Team access revoked');
    const auditContext = {
      tenantId: meta?.tenantId ?? '00000000-0000-0000-0000-000000000000',
      userId: meta?.userId ?? task.actor,
      sessionId: task.sessionId,
    };

    const sink: EventSink = {
      emit: (loopEvent) => {
        // Ephemeral deltas: connected UIs render them in real time; committed
        // state reaches clients through the event log / session stream.
        if (loopEvent.type === 'text-delta' || loopEvent.type === 'reasoning-delta') {
          deps.live.publish(task.sessionId, loopEvent);
        }
        if (loopEvent.type === 'tool/call') {
          deps.audit.emit({
            id: newId(),
            at: new Date().toISOString(),
            ...auditContext,
            action: 'tool/call',
            target: loopEvent.call.name,
            result: 'ok',
            detail: { argsPreview: JSON.stringify(loopEvent.call.args).slice(0, 500) },
          });
        } else if (loopEvent.type === 'tool/result') {
          deps.audit.emit({
            id: newId(),
            at: new Date().toISOString(),
            ...auditContext,
            action: 'tool/result',
            result: loopEvent.result.isError ? 'error' : 'ok',
          });
        }
      },
    };

    const execute = async (ordered: TurnTask): Promise<void> => {
      const contextGuard = async (): Promise<void> => {
        const current = await deps.metas.get(ordered.sessionId);
        if (current?.closedAt || (deps.users && !current))
          throw new Error('Session access revoked');
        if (
          current?.scope === 'team' &&
          (!current.scopeId ||
            !deps.teams ||
            !(await deps.teams.isMember(current.scopeId, ordered.actor)))
        )
          throw new Error('Team access revoked');
        if (deps.users) {
          const user = await deps.users.findById(ordered.actor);
          if (!user || user.tenantId !== ordered.tenantId || user.role === 'viewer')
            throw new Error('Execution access revoked');
        }
      };
      await deps
        .createLoop(
          ordered.sessionId,
          await sessionWorkspaceRoot(meta, deps.defaultWorkspaceRoot, deps.metas),
        )
        .run(ordered.sessionId, ordered.prompt, sink, {
          contextGuard,
          actor: ordered.actor,
          tenantId: ordered.tenantId,
          signal,
          // M3: permission policy + prompt seq travel with the task (fail-closed
          // snapshot taken by the server when the prompt was accepted).
          policy: ordered.policy,
          promptSeq: ordered.promptSeq,
          cancellationSeq: ordered.cancellationSeq,
          // M4 multimodal: attachment content blocks ride with the ordered.
          ...(ordered.content !== undefined ? { content: ordered.content } : {}),
        });
    };
    if (deps.sessionRuns)
      await runOrderedPrompts(deps.sessionRuns, deps.store, task, execute, signal);
    else await execute(task);
  };
}
