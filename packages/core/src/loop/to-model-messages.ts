import {
  compactionRanges,
  turnMessageProjection,
  citationContext,
  isCompacted,
  skillResultSchema,
  browserResultSchema,
  type SkillSnapshot,
  compactionSummaryText,
  type ConversationMessage,
  type SessionEvent,
} from '@trinity-harness/contracts';
import { taskVerification } from './task-verification.js';

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
  // Finished exchanges retain only their input and final output. Active work
  // keeps exact tool pairs and reasoning until its terminal event is committed.
  const { closed, finals, progress, terminalFallbacks } = turnMessageProjection(events);
  const ranges = compactionRanges(events);
  const latestUser = events.findLastIndex((event) => event.type === 'message/user');
  const promptId = events[latestUser]?.eventId;
  let emitIdx = 0;
  let activeIdx = -1; // range currently covering events
  const toolNames = new Map<string, string>();
  let catalog: Extract<SessionEvent, { type: 'skill/catalog' }> | undefined;
  const snapshots = new Map<string, { snapshot: SkillSnapshot; seq: number; explicit: boolean }>();
  events.forEach((event, i) => {
    if (event.type === 'tool/call') toolNames.set(event.callId, event.name);
    if (event.type === 'skill/catalog') catalog = event;
    if (event.type === 'skill/loaded')
      snapshots.set(event.snapshot.name, { snapshot: event.snapshot, seq: i + 1, explicit: true });
    if (event.type === 'tool/result' && !event.isError && toolNames.get(event.callId) === 'skill') {
      const parsed = skillResultSchema.safeParse(event.value);
      if (parsed.success && parsed.data.kind === 'instructions') {
        snapshots.set(parsed.data.snapshot.name, {
          snapshot: parsed.data.snapshot,
          seq: i + 1,
          explicit: false,
        });
      }
    }
  });
  // Durable instruction context precedes history, including compacted loads.
  if (catalog) messages.push({ role: 'user', content: catalog.instructions });
  // Keep recently used instruction snapshots within a reserved context budget.
  // Older snapshots remain in the log and can be loaded again via the catalog.
  let pinnedBytes = 0;
  const pinned: string[] = [];
  for (const { snapshot, seq, explicit } of [...snapshots.values()].sort((a, b) => b.seq - a.seq)) {
    const bytes = new TextEncoder().encode(snapshot.instructions).byteLength;
    if (pinnedBytes + bytes > 128 * 1024) continue;
    pinnedBytes += bytes;
    if (explicit || closed.has(seq - 1) || isCompacted(seq, ranges))
      pinned.push(snapshot.instructions);
  }
  for (const content of pinned.reverse()) messages.push({ role: 'user', content });
  // Control state survives checkpoint replacement and is rebuilt only from durable events.
  if (promptId) {
    const plan = events.findLast(
      (event) => event.type === 'task/plan' && event.promptId === promptId,
    );
    if (plan?.type === 'task/plan')
      messages.push({
        role: 'user',
        content: `[Task requirements and verification]\n${JSON.stringify({ checks: plan.checks, ...taskVerification(events, promptId) })}`,
      });
    const recovery = events.findLast(
      (event) => event.type === 'task/recovery' && event.promptId === promptId,
    );
    if (recovery?.type === 'task/recovery')
      messages.push({ role: 'user', content: `[Execution recovery]\n${recovery.advice}` });
  }
  let start = -1;
  events.forEach((event, i) => {
    if (event.type === 'message/user') start = i;
    if (event.type === 'turn/end') start = -1;
  });
  let latestGuidance = -1;
  events.forEach((event, i) => {
    if (start >= 0 && event.type === 'turn/guidance' && event.promptSeq === start + 1)
      latestGuidance = i;
  });
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
    if (
      i !== latestUser &&
      activeIdx >= 0 &&
      seq >= ranges[activeIdx]!.fromSeq &&
      seq <= ranges[activeIdx]!.toSeq
    ) {
      return; // covered by the current compaction range
    }
    if (terminalFallbacks.has(i))
      messages.push({ role: 'assistant', content: terminalFallbacks.get(i)! });
    if (closed.has(i) && !finals.has(i)) return;
    switch (event.type) {
      case 'turn/guidance': {
        if (i === latestGuidance)
          messages.push({ role: 'user', content: `[Runtime progress guidance]\n${event.advice}` });
        break;
      }
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
        const reasoning = finals.has(i) ? [] : reasoningFromContent(event.content);
        messages.push({
          role: 'assistant',
          content:
            (progress.has(i) && !event.continuation ? '' : textFromContent(event.content)) +
            (event.citationList && !progress.has(i) ? citationContext(event.citationList) : ''),
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
      case 'tool/result': {
        const skill =
          !event.isError && toolNames.get(event.callId) === 'skill'
            ? skillResultSchema.safeParse(event.value)
            : null;
        const superseded =
          skill?.success &&
          skill.data.kind === 'instructions' &&
          snapshots.get(skill.data.snapshot.name)?.snapshot.version !== skill.data.snapshot.version;
        const value =
          superseded && skill?.success && skill.data.kind === 'instructions'
            ? {
                kind: 'superseded-instructions',
                name: skill.data.snapshot.name,
                message:
                  'This historical skill version has been replaced. Follow the current skill instructions in the runtime context.',
              }
            : event.value;
        messages.push({
          role: 'tool',
          content: JSON.stringify(value),
          toolCallId: event.callId,
          toolName: toolNames.get(event.callId),
          ...(!event.isError &&
          toolNames.get(event.callId) === 'browser' &&
          browserResultSchema.safeParse(value).success &&
          browserResultSchema.parse(value).image
            ? {
                blocks: [
                  {
                    kind: 'image' as const,
                    uri: browserResultSchema.parse(value).image!.uri,
                    mimeType: 'image/png',
                  },
                ],
              }
            : {}),
        });
        break;
      }
      default:
        break; // session/created, turn/*, approval/*, compaction/* not model-facing
    }
  });
  // Trailing ranges (defensive: compaction normally never covers the tail).
  while (emitIdx < ranges.length) {
    messages.push({ role: 'user', content: compactionSummaryText(ranges[emitIdx]!.summary) });
    emitIdx += 1;
  }
  // Crash recovery: an instruction load may have committed its call without
  // its result. Repair the model projection without executing it or claiming
  // that instructions were loaded; the same log always yields the same repair.
  const completed = new Set(
    messages.filter((message) => message.role === 'tool').map((message) => message.toolCallId),
  );
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    const interrupted = (message.toolCalls ?? []).filter((call) => !completed.has(call.id));
    if (interrupted.length === 0) continue;
    let insertAt = i + 1;
    while (messages[insertAt]?.role === 'tool') insertAt += 1;
    messages.splice(
      insertAt,
      0,
      ...interrupted.map((call): ConversationMessage => ({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: JSON.stringify({
          code: call.name === 'skill' ? 'SKILL_INTERRUPTED' : 'TOOL_INTERRUPTED',
          message:
            call.name === 'skill'
              ? 'Instruction loading was interrupted. Call skill again if these instructions are needed.'
              : 'Tool execution was interrupted and its outcome is unknown. Inspect current state before deciding whether to retry; do not assume success or automatically repeat side effects.',
        }),
      })),
    );
  }
  return messages;
}
