import type { ConversationMessage, SessionEvent } from '@trinity-harness/contracts';

function textFromContent(
  content: Extract<SessionEvent, { type: 'message/user' }>['content'],
): string {
  return content
    .map((block) => {
      switch (block.kind) {
        case 'text':
          return block.text;
        case 'image':
          return `[image: ${block.uri}]`;
        case 'file':
          return `[file: ${block.uri}]`;
      }
    })
    .join('\n');
}

/**
 * Pure fold of the session event log into model-conversation messages
 * (docs/design.md §7): message events become user/assistant turns; tool/call
 * attaches to the preceding assistant message; tool/result becomes a
 * role:'tool' message. Deterministic — unit tested without any IO.
 */
export function toModelMessages(events: readonly SessionEvent[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const toolNames = new Map<string, string>();
  for (const event of events) {
    switch (event.type) {
      case 'message/user':
        messages.push({ role: 'user', content: textFromContent(event.content) });
        break;
      case 'message/assistant':
        messages.push({ role: 'assistant', content: textFromContent(event.content) });
        break;
      case 'tool/call': {
        toolNames.set(event.callId, event.name);
        let last = messages.at(-1);
        if (last?.role !== 'assistant') {
          // Assistant turn carried no text (pure tool-call step).
          messages.push({ role: 'assistant', content: '' });
          last = messages.at(-1)!;
        }
        last.toolCalls = [
          ...(last.toolCalls ?? []),
          { id: event.callId, name: event.name, args: event.args },
        ];
        break;
      }
      case 'tool/result':
        messages.push({
          role: 'tool',
          content: JSON.stringify(event.value),
          toolCallId: event.callId,
          toolName: toolNames.get(event.callId),
        });
        break;
      default:
        break; // session/created, turn/*, compaction/* are not model-facing
    }
  }
  return messages;
}
