/**
 * Pure chat-item helpers for the M2 chat UI (docs/design.md §11.5).
 * Extracted from App.tsx so the replay-merge logic is unit-testable in a
 * node environment (AGENTS.md §6); no React/antd imports here.
 */

import {
  newId,
  type AnswerCitation,
  type ServerEvent,
  type RecallReceipt,
  type ModelUsage,
  type SurfaceMessage,
  type SessionUpdate,
} from '@trinity-harness/shared';

export type ToolCallView = {
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content?: string;
};

/** M4 multimodal: an attachment reference rendered from the blob store. */
export type AttachmentView = { kind: 'image' | 'file'; uri: string; mimeType?: string };

export type ChatItem = {
  messageId?: string;
  at?: string;
  key: string;
  role: 'user' | 'assistant';
  content: string;
  streaming: boolean;
  tools: ToolCallView[];
  attachments: AttachmentView[];
  activity?: { content: string; at?: string }[];
  stepCommitted?: boolean;
  final?: boolean;
  stopped?: boolean;
  error?: boolean;
  errorDetail?: string;
  awaitingApproval?: boolean;
  citationList?: AnswerCitation[];
  usage?: ModelUsage[];
  recall?: RecallReceipt;
  removed?: boolean;
};

export type CommittedUserMessage = {
  id?: string;
  at?: string;
  content: string;
  attachments?: AttachmentView[];
};

/**
 * RFC 4122 v7 id for ChatItem keys (time-ordered; see packages/shared).
 * Falls back gracefully on runtimes without Web Crypto.
 */
export function newItemKey(): string {
  return newId();
}

export function mergeAssistantChunk(
  items: readonly ChatItem[],
  text: string,
  newKey: () => string,
  at: string,
): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.role === 'assistant' && (last.final || last.stopped || last.error)) return [...items];
  if (last?.role === 'assistant') {
    const base = last.stepCommitted ? archiveAssistantStep(last) : last;
    return [
      ...items.slice(0, -1),
      {
        ...base,
        at: base.at ?? at,
        content: base.content + text,
        streaming: true,
        stepCommitted: false,
        final: false,
        stopped: false,
      },
    ];
  }
  return [
    ...items,
    {
      key: newKey(),
      role: 'assistant',
      at,
      content: text,
      streaming: true,
      tools: [],
      attachments: [],
    },
  ];
}

/**
 * Merge a replayed/relayed `message/committed` (role=user) into the list.
 *
 * The optimistic send already appended the user bubble followed by the
 * assistant placeholder, so a replay of the same prompt must be dropped.
 * The duplicate is the most recent USER item — not necessarily the very
 * last item. Appending it would shadow the assistant placeholder, and every
 * subsequent assistant update (which targets the trailing assistant item)
 * would be silently dropped.
 */
export function mergeCommittedUserMessage(
  items: readonly ChatItem[],
  message: CommittedUserMessage,
  newKey: () => string,
): ChatItem[] {
  const lastUser = [...items].reverse().find((i) => i.role === 'user');
  if (lastUser) {
    const incoming = message.attachments ?? [];
    const sameContent = lastUser.content === message.content;
    const sameAttachments =
      lastUser.attachments.length > 0 &&
      lastUser.attachments.length === incoming.length &&
      lastUser.attachments.every((a, i) => a.uri === incoming[i]?.uri);
    if (
      (!message.id || !lastUser.messageId || message.id === lastUser.messageId) &&
      (sameContent || sameAttachments)
    ) {
      return items.map((item) =>
        item === lastUser &&
        ((message.at !== undefined && item.at !== message.at) ||
          (message.id && item.messageId !== message.id))
          ? {
              ...item,
              ...(message.at ? { at: message.at } : {}),
              ...(message.id ? { messageId: message.id } : {}),
            }
          : item,
      );
    }
  }
  return [
    ...items,
    {
      key: newKey(),
      role: 'user',
      ...(message.id ? { messageId: message.id } : {}),
      ...(message.at !== undefined ? { at: message.at } : {}),
      content: message.content,
      streaming: false,
      tools: [],
      attachments: message.attachments ?? [],
    },
  ];
}

/** Move a provisional step into the turn's activity without creating a new response. */
export function archiveAssistantStep(item: ChatItem): ChatItem {
  if (!item.content.trim()) return item;
  const activity = item.activity ?? [];
  return {
    ...item,
    content: '',
    stepCommitted: false,
    citationList: undefined,
    activity:
      activity.at(-1)?.content === item.content
        ? activity
        : [...activity, { content: item.content, at: item.at }],
  };
}

/** Live and replayed model steps replace the same assistant response for a prompt. */
export function mergeCommittedAssistantMessage(
  items: readonly ChatItem[],
  content: string,
  newKey: () => string,
  at?: string,
  metadata: Pick<SurfaceMessage, 'phase' | 'citationList' | 'id'> = {},
): ChatItem[] {
  const last = items.at(-1);
  let item: ChatItem =
    last?.role === 'assistant'
      ? last
      : {
          key: newKey(),
          role: 'assistant',
          content: '',
          streaming: true,
          tools: [],
          attachments: [],
        };
  if (item.stepCommitted && item.content !== content) item = archiveAssistantStep(item);
  item = {
    ...item,
    content,
    ...(metadata.id ? { messageId: metadata.id } : {}),
    ...(at !== undefined ? { at } : {}),
    citationList: metadata.citationList,
    stopped: false,
  };
  if (metadata.phase === 'progress') {
    item = { ...archiveAssistantStep(item), streaming: true, final: false };
  } else {
    item = { ...item, streaming: false, stepCommitted: true, final: metadata.phase === 'final' };
  }
  return last?.role === 'assistant' ? [...items.slice(0, -1), item] : [...items, item];
}

/** Tool-only steps also belong to the current prompt's single assistant response. */
export function mergeToolUpdate(
  items: readonly ChatItem[],
  update: SessionUpdate & { kind: 'tool_call' },
  newKey: () => string,
  at: string,
): ChatItem[] {
  const last = items.at(-1);
  let item: ChatItem =
    last?.role === 'assistant'
      ? last
      : {
          key: newKey(),
          role: 'assistant',
          content: '',
          streaming: true,
          tools: [],
          attachments: [],
          at,
        };
  if (update.status === 'in_progress' && !item.final)
    item = { ...archiveAssistantStep(item), streaming: true };
  const existing = item.tools.find((tool) => tool.toolCallId === update.toolCallId);
  const tool: ToolCallView = {
    toolCallId: update.toolCallId,
    title: existing?.title || update.title || update.toolCallId,
    status: update.status,
    content: update.content ?? existing?.content,
  };
  item = {
    ...item,
    tools: existing
      ? item.tools.map((value) => (value === existing ? tool : value))
      : [...item.tools, tool],
  };
  return last?.role === 'assistant' ? [...items.slice(0, -1), item] : [...items, item];
}

/** Approval state belongs to the active response and cannot reopen a terminal turn. */
export function setAssistantApproval(
  items: readonly ChatItem[],
  awaitingApproval: boolean,
): ChatItem[] {
  const last = items.at(-1);
  if (
    last?.role !== 'assistant' ||
    last.final ||
    last.stopped ||
    last.error ||
    !!last.awaitingApproval === awaitingApproval
  )
    return [...items];
  return [...items.slice(0, -1), { ...last, awaitingApproval }];
}

/** Settle live output and pending tools when their turn ends without results. */
export function settleAssistantItems(
  items: readonly ChatItem[],
  status: 'completed' | 'aborted' | 'error' = 'completed',
  errorDetail?: string,
): ChatItem[] {
  if (items.at(-1)?.role === 'user')
    items = [
      ...items,
      {
        key: newItemKey(),
        role: 'assistant',
        content: '',
        streaming: true,
        tools: [],
        attachments: [],
      },
    ];
  return items.map((item) => {
    if (item.role !== 'assistant' || item !== items.at(-1)) return item;
    const pending = item.tools.some(
      (tool) => tool.status === 'pending' || tool.status === 'in_progress',
    );
    if (
      !item.streaming &&
      !pending &&
      !item.awaitingApproval &&
      !(item.stepCommitted && !item.final) &&
      !(status !== 'completed')
    )
      return item;
    const base = status !== 'completed' && !item.final ? archiveAssistantStep(item) : item;
    return {
      ...base,
      streaming: false,
      awaitingApproval: false,
      final: status === 'completed' && base.content.trim().length > 0,
      stopped: status === 'aborted',
      error: status === 'error',
      ...(status === 'error' && errorDetail ? { errorDetail } : {}),
      tools: item.tools.map((tool) =>
        tool.status === 'pending' || tool.status === 'in_progress'
          ? {
              ...tool,
              status: 'failed' as const,
              content: 'No result received; the turn has ended.',
            }
          : tool,
      ),
    };
  });
}

/** Attribute late/replayed usage to the originating user prompt, preserving other responses. */
export function mergeModelUsage(
  items: readonly ChatItem[],
  usage: ModelUsage,
  newKey: () => string,
): ChatItem[] {
  const userIndex = items.findIndex(
    (item) => item.role === 'user' && item.messageId === usage.promptId,
  );
  if (userIndex < 0) return [...items];
  const next = items[userIndex + 1];
  if (next?.role === 'assistant') {
    if (next.usage?.some((entry) => entry.requestId === usage.requestId)) return [...items];
    return items.map((item) =>
      item === next ? { ...item, usage: [...(item.usage ?? []), usage] } : item,
    );
  }
  const result = [...items];
  result.splice(userIndex + 1, 0, {
    key: newKey(),
    role: 'assistant',
    content: '',
    streaming: true,
    tools: [],
    attachments: [],
    usage: [usage],
  });
  return result;
}

export function mergeRecallSelection(
  items: readonly ChatItem[],
  receipt: RecallReceipt,
): ChatItem[] {
  const userIndex = items.findIndex(
    (item) => item.role === 'user' && item.messageId === receipt.promptId,
  );
  if (userIndex < 0) return [...items];
  const next = items[userIndex + 1];
  if (next?.role === 'assistant')
    return items.map((item) => (item === next ? { ...item, recall: receipt } : item));
  const result = [...items];
  result.splice(userIndex + 1, 0, {
    key: newItemKey(),
    role: 'assistant',
    content: '',
    streaming: true,
    tools: [],
    attachments: [],
    recall: receipt,
  });
  return result;
}

/** Same ACP projection for bounded pages and the independent detail pane. */
export function applyTimelineEvent(items: ChatItem[], event: ServerEvent): ChatItem[] {
  if (event.type === 'message/removed') return removeChatMessage(items, event.promptId, event.role);
  if (event.type === 'session/memory_selection') return mergeRecallSelection(items, event.receipt);
  if (event.type === 'message/committed')
    return event.message.role === 'user'
      ? mergeCommittedUserMessage(items, event.message, newItemKey)
      : mergeCommittedAssistantMessage(
          items,
          event.message.content,
          newItemKey,
          event.message.at,
          event.message,
        );
  if (event.type === 'model/usage') return mergeModelUsage(items, event.usage, newItemKey);
  if (event.type === 'session/update') {
    if (event.update.kind === 'agent_message_chunk')
      return mergeAssistantChunk(items, event.update.text, newItemKey, new Date().toISOString());
    if (event.update.kind === 'tool_call')
      return mergeToolUpdate(items, event.update, newItemKey, new Date().toISOString());
    if (event.update.kind === 'permission_request')
      return setAssistantApproval(items, event.update.status === 'pending');
  }
  if (event.type === 'error') return settleAssistantItems(items, 'error', event.message);
  if (
    event.type === 'session/turn_status' &&
    (event.status === 'completed' || event.status === 'aborted')
  )
    return settleAssistantItems(items, event.status);
  return items;
}

/** Keep removed entries internally so late chunks still attach to their originating turn. */
export function removeChatMessage(
  items: readonly ChatItem[],
  promptId: string,
  role: 'user' | 'assistant',
): ChatItem[] {
  let currentPrompt: string | undefined;
  return items.map((item) => {
    if (item.role === 'user') currentPrompt = item.messageId;
    return currentPrompt === promptId && item.role === role && !item.removed
      ? { ...item, removed: true }
      : item;
  });
}
