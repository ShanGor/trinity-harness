import {
  compactionRanges,
  compactionSummaryText,
  type ConversationMessage,
  type SessionEvent,
} from '@trinity-harness/contracts';

function textFromContent(
  content: Extract<SessionEvent, { type: 'message/user' | 'message/assistant' }>['content'],
): string {
  return content
    .map((block) => {
      switch (block.kind) {
        case 'text':
          return block.text;
        case 'reasoning':
          // Reasoning blocks replay via `reasoning`, never inline in text.
          return '';
        case 'image':
          return `[image: ${block.uri}]`;
        case 'file':
          return `[file: ${block.uri}]`;
      }
    })
    .filter((s) => s.length > 0)
    .join('\n');
}

function mediaBlocksFromContent(
  content: Extract<SessionEvent, { type: 'message/user' }>['content'],
): ConversationMessage['blocks'] {
  const blocks = content.filter((b) => b.kind === 'image' || b.kind === 'file');
  return blocks.length > 0 ? blocks : undefined;
}

function textOnlyFromContent(
  content: Extract<SessionEvent, { type: 'message/user' | 'message/assistant' }>['content'],
): string {
  return content
    .filter((block) => block.kind === 'text')
    .map((block) => (block.kind === 'text' ? block.text : ''))
    .join('\n');
}

function reasoningFromContent(
  content: Extract<SessionEvent, { type: 'message/assistant' }>['content'],
): { text: string; signature?: string }[] {
  return content
    .filter((block) => block.kind === 'reasoning')
    .map((block) => ({
      text: block.text,
      ...(block.signature !== undefined ? { signature: block.signature } : {}),
    }));
}

/**
 * Pure fold of the session event log into model-conversation messages
 * (docs/design.md §7): message events become user/assistant turns; tool/call
 * attaches to the preceding assistant message; tool/result becomes a
 * role:'tool' message. M4: events inside applied `compaction/summary` ranges
 * are skipped and the summary is injected IN PLACE of the range (chronological
 * order preserved despite the append-only log); user messages carry image/file
 * blocks for the multimodal gateway. Deterministic — unit tested without IO.
 */
export function toModelMessages(events: readonly SessionEvent[]): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const ranges = compactionRanges(events);
  let emitIdx = 0;
  let activeIdx = -1; // range currently covering events
  const toolNames = new Map<string, string>();
  events.forEach((event, i) => {
    const seq = i + 1;
    // In-place summary insertion at the start of each covered range; the
    // range becomes active so its own events (starting at fromSeq) are
    // skipped below.
    while (emitIdx < ranges.length && ranges[emitIdx]!.fromSeq === seq) {
      messages.push({ role: 'user', content: compactionSummaryText(ranges[emitIdx]!.summary) });
      activeIdx = emitIdx;
      emitIdx += 1;
    }
    if (activeIdx >= 0 && seq >= ranges[activeIdx]!.fromSeq && seq <= ranges[activeIdx]!.toSeq) {
      return; // covered by the current compaction range
    }
    switch (event.type) {
      case 'message/user': {
        const media = mediaBlocksFromContent(event.content);
        messages.push({
          role: 'user',
          // With media blocks the text part carries only text blocks — image
          // content reaches the provider via `blocks`, not as a marker line.
          content:
            media !== undefined
              ? textOnlyFromContent(event.content)
              : textFromContent(event.content),
          ...(media !== undefined ? { blocks: media } : {}),
        });
        break;
      }
      case 'message/assistant': {
        const reasoning = reasoningFromContent(event.content);
        messages.push({
          role: 'assistant',
          content: textFromContent(event.content),
          ...(reasoning.length > 0 ? { reasoning } : {}),
        });
        break;
      }
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
        break; // session/created, turn/*, approval/*, compaction/* not model-facing
    }
  });
  // Trailing ranges (defensive: compaction normally never covers the tail).
  while (emitIdx < ranges.length) {
    messages.push({ role: 'user', content: compactionSummaryText(ranges[emitIdx]!.summary) });
    emitIdx += 1;
  }
  return messages;
}
