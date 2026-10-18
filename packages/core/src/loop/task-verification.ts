import type { SessionEvent, ToolCall } from '@trinity-harness/contracts';

const readTools = new Set([
  'read_file',
  'glob',
  'read_blob',
  'skill',
  'research',
  'task',
  'lsp_diagnostics',
  'lsp_hover',
  'lsp_definition',
  'lsp_references',
  'lsp_symbols',
]);
const browserReads = new Set([
  'read_page',
  'get_page_text',
  'read_observation',
  'search_observation',
  'screenshot',
]);

export function verificationToolAllowed(
  events: readonly SessionEvent[],
  promptId: string,
  call: ToolCall,
): boolean {
  if (readTools.has(call.name)) return true;
  const args = call.args as { command?: unknown; operation?: unknown } | null;
  if (call.name === 'browser') return browserReads.has(String(args?.operation));
  const plan = events.findLast(
    (event) => event.type === 'task/plan' && event.promptId === promptId,
  );
  return (
    call.name === 'bash' &&
    plan?.type === 'task/plan' &&
    plan.checks.some((check) => check.kind === 'command' && check.command === args?.command)
  );
}

export function taskVerification(
  events: readonly SessionEvent[],
  promptId: string,
): { status: 'verified' | 'unverified' | 'incomplete'; pending: string[] } {
  const plan = events.findLast(
    (event) => event.type === 'task/plan' && event.promptId === promptId,
  );
  if (plan?.type !== 'task/plan')
    return {
      status: 'unverified',
      pending: ['Declare the requirements and verification checks using task plan.'],
    };
  const promptIndex = events.findIndex((event) => event.eventId === promptId);
  const planIndex = events.findIndex((event) => event.eventId === plan.eventId);
  let lastEffect = promptIndex;
  events.forEach((event, index) => {
    if (index <= promptIndex || event.type !== 'tool/call' || readTools.has(event.name)) return;
    const args = event.args as { command?: unknown; operation?: unknown } | null;
    if (
      event.name === 'bash' &&
      plan.checks.some((check) => check.kind === 'command' && check.command === args?.command)
    )
      return;
    if (event.name === 'browser' && browserReads.has(String(args?.operation))) return;
    const resultIndex = events.findIndex(
      (item, resultIndex) =>
        resultIndex > index && item.type === 'tool/result' && item.callId === event.callId,
    );
    lastEffect = Math.max(lastEffect, resultIndex < 0 ? index : resultIndex);
  });
  const pending = plan.checks
    .filter(
      (check) =>
        !events.some((event) => {
          if (
            event.type !== 'task/check' ||
            event.promptId !== promptId ||
            event.id !== check.id ||
            event.resultSeq <= Math.max(lastEffect, planIndex) + 1
          )
            return false;
          const result = events[event.resultSeq - 1];
          const call = events.find(
            (item, index) =>
              index > Math.max(promptIndex, planIndex, lastEffect) &&
              index < event.resultSeq - 1 &&
              item.type === 'tool/call' &&
              item.callId === event.callId,
          );
          if (
            result?.type !== 'tool/result' ||
            result.isError ||
            result.callId !== event.callId ||
            call?.type !== 'tool/call'
          )
            return false;
          if (check.kind === 'command') {
            const args = call.args as { command?: unknown } | null;
            const value = result.value as { exitCode?: unknown } | null;
            return call.name === 'bash' && args?.command === check.command && value?.exitCode === 0;
          }
          return (
            (readTools.has(call.name) && !['task', 'skill'].includes(call.name)) ||
            (call.name === 'browser' &&
              browserReads.has(String((call.args as { operation?: unknown } | null)?.operation)))
          );
        }),
    )
    .map((check) => `${check.id}: ${check.requirement}`);
  return { status: pending.length ? 'incomplete' : 'verified', pending };
}
