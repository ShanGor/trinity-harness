import type { ReactElement } from 'react';

import type { ChatItem, ToolCallView } from './chat-items';

const toolStatuses: Record<ToolCallView['status'], string> = {
  pending: 'Queued',
  in_progress: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

function ToolProgress({ tool }: { tool: ToolCallView }): ReactElement {
  return (
    <li className="task-progress-tool">
      <span className={`task-progress-tool-status task-progress-tool-status--${tool.status}`}>
        {toolStatuses[tool.status]}
      </span>
      <span>{tool.title}</span>
    </li>
  );
}

/** A bounded overview of observed ACP activity; tool counts are not task completion estimates. */
export function TurnProgress({ item }: { item: ChatItem }): ReactElement | null {
  const terminal = item.final || item.stopped || item.error;
  const activeTools = terminal
    ? []
    : item.tools.filter((tool) => tool.status === 'pending' || tool.status === 'in_progress');
  const active = !terminal && (item.streaming || item.awaitingApproval || activeTools.length > 0);
  const latest = item.activity?.at(-1)?.content;
  const failed = item.tools.filter((tool) => tool.status === 'failed').length;
  if (!active && !terminal && !latest && item.tools.length === 0) return null;
  if (item.final && !latest && item.tools.length === 0) return null;

  const status = item.stopped
    ? 'Task stopped'
    : item.error
      ? 'The task could not finish'
      : item.final
        ? 'Completed'
        : item.awaitingApproval
          ? 'Waiting for your approval'
          : active
            ? 'Working'
            : 'Activity recorded';
  const recentTool = item.tools.at(-1);
  const visibleTools = activeTools.length > 0 ? activeTools : recentTool ? [recentTool] : [];

  return (
    <section className="task-progress" aria-label="Task progress">
      <div className="task-progress-heading">
        <span className={active ? 'response-streaming' : undefined} role="status">
          {status}
        </span>
        {item.tools.length > 0 && (
          <span className="task-progress-count">
            {item.tools.length} tool {item.tools.length === 1 ? 'call' : 'calls'}
          </span>
        )}
      </div>
      {item.error && item.errorDetail && (
        <p className="task-progress-warning">{item.errorDetail}</p>
      )}
      {active && failed > 0 && (
        <p className="task-progress-warning">
          {failed} tool {failed === 1 ? 'call failed' : 'calls failed'} · Agent is continuing
        </p>
      )}
      {!terminal && (
        <>
          {latest && (
            <div className="task-progress-latest">
              <span className="task-progress-label">Latest update</span>
              <p>{latest}</p>
            </div>
          )}
          {visibleTools.length > 0 && (
            <ul className="task-progress-tools" aria-label="Current tool activity">
              {visibleTools.slice(0, 4).map((tool) => (
                <ToolProgress key={tool.toolCallId} tool={tool} />
              ))}
            </ul>
          )}
          {visibleTools.length > 4 && (
            <details className="task-progress-more">
              <summary>Show {visibleTools.length - 4} more active tool calls</summary>
              <ul className="task-progress-tools">
                {visibleTools.slice(4).map((tool) => (
                  <ToolProgress key={tool.toolCallId} tool={tool} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}
