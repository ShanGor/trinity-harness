/**
 * Pure chat-item helpers for the M2 chat UI (docs/design.md §11.5).
 * Extracted from App.tsx so the replay-merge logic is unit-testable in a
 * node environment (AGENTS.md §6); no React/antd imports here.
 */

export type ToolCallView = {
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content?: string;
};

/** M4 multimodal: an attachment reference rendered from the blob store. */
export type AttachmentView = { kind: 'image' | 'file'; uri: string; mimeType?: string };

export type ChatItem = {
  key: string;
  role: 'user' | 'assistant';
  content: string;
  streaming: boolean;
  tools: ToolCallView[];
  attachments: AttachmentView[];
};

export type CommittedUserMessage = {
  content: string;
  attachments?: AttachmentView[];
};

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
    if (sameContent || sameAttachments) return [...items];
  }
  return [
    ...items,
    {
      key: newKey(),
      role: 'user',
      content: message.content,
      streaming: false,
      tools: [],
      attachments: message.attachments ?? [],
    },
  ];
}

/**
 * Merge a `message/committed` (role=assistant) into the list.
 *
 * In the live flow the optimistic placeholder (streaming) is filled in place.
 * During log replay there is no placeholder: each committed assistant
 * message follows a user message, so a NEW item is appended instead —
 * otherwise the update would target the wrong turn or be dropped.
 */
export function mergeCommittedAssistantMessage(
  items: readonly ChatItem[],
  content: string,
  newKey: () => string,
): ChatItem[] {
  const last = items[items.length - 1];
  if (last?.role === 'assistant' && last.streaming) {
    return [...items.slice(0, -1), { ...last, content, streaming: false }];
  }
  return [
    ...items,
    {
      key: newKey(),
      role: 'assistant',
      content,
      streaming: false,
      tools: [],
      attachments: [],
    },
  ];
}
