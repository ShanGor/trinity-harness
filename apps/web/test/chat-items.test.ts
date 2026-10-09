import { describe, expect, it } from 'vitest';

import {
  settleAssistantItems,
  mergeAssistantChunk,
  mergeCommittedAssistantMessage,
  mergeCommittedUserMessage,
  mergeToolUpdate,
  type ChatItem,
} from '../src/chat-items';

/**
 * Regression test for the "question shown twice, no answer" bug: the
 * optimistic append adds the user bubble followed by the assistant
 * placeholder, and the SSE replay of `message/committed` (role=user) must
 * be dropped against the most recent USER item — otherwise the duplicate
 * shadows the placeholder and every assistant update is dropped too.
 */

let n = 0;
const key = () => `k${++n}`;
const user = (content: string): ChatItem => ({
  key: key(),
  role: 'user',
  content,
  streaming: false,
  tools: [],
  attachments: [],
});
const assistant = (): ChatItem => ({
  key: key(),
  role: 'assistant',
  content: '',
  streaming: true,
  tools: [],
  attachments: [],
});

describe('mergeAssistantChunk', () => {
  it('ignores late live chunks after a final answer or cancellation', () => {
    const final = mergeCommittedAssistantMessage([user('q')], 'Answer', key, undefined, {
      phase: 'final',
    });
    expect(mergeAssistantChunk(final, 'late', key, '2026-10-09T00:00:00Z')[1]).toBe(final[1]);
    const stopped = settleAssistantItems(
      [user('q'), { ...assistant(), content: 'Partial progress' }],
      'aborted',
    );
    expect(stopped[1]).toMatchObject({
      content: '',
      stopped: true,
      activity: [{ content: 'Partial progress' }],
    });
    expect(mergeAssistantChunk(stopped, 'late', key, '2026-10-09T00:00:00Z')[1]).toBe(stopped[1]);
  });
  it('creates a live message after replay or an intermediate committed assistant step', () => {
    const history = [user('Question')];
    const live = mergeAssistantChunk(history, 'First', key, '2026-10-09T00:00:00Z');
    expect(live[0]).toBe(history[0]);
    expect(live[1]).toMatchObject({ content: 'First', streaming: true });
    const extended = mergeAssistantChunk(live, ' answer', key, '2026-10-09T00:00:01Z');
    expect(extended[1]).toMatchObject({
      key: live[1]!.key,
      content: 'First answer',
      at: '2026-10-09T00:00:00Z',
    });
    const committed = mergeCommittedAssistantMessage(extended, 'First answer', key);
    const next = mergeAssistantChunk(committed, 'Next step', key, '2026-10-09T00:00:02Z');
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({
      key: committed[1]!.key,
      content: 'Next step',
      streaming: true,
      activity: [{ content: 'First answer' }],
    });
  });
});

describe('mergeCommittedUserMessage', () => {
  it('uses saved identities to distinguish identical prompts in later turns', () => {
    const first = mergeCommittedUserMessage([], { content: 'again', id: 'prompt-1' }, key);
    const replay = mergeCommittedUserMessage(first, { content: 'again', id: 'prompt-1' }, key);
    expect(replay).toHaveLength(1);
    const second = mergeCommittedUserMessage(replay, { content: 'again', id: 'prompt-2' }, key);
    expect(second).toHaveLength(2);
    expect(second[1]?.messageId).toBe('prompt-2');
  });
  it('drops the replayed prompt even when an assistant placeholder follows it', () => {
    const items = [user('hello'), assistant()];
    const merged = mergeCommittedUserMessage(items, { content: 'hello' }, key);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(items[0]);
    expect(merged[1]).toEqual(items[1]);
  });

  it('appends the replayed prompt when there is no local user message (reload)', () => {
    const merged = mergeCommittedUserMessage([assistant()], { content: 'hello' }, key);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({ role: 'user', content: 'hello', streaming: false });
  });

  it('appends a genuinely different prompt (same text sent again is still a duplicate)', () => {
    const items = [user('first'), assistant(), user('second'), assistant()];
    const merged = mergeCommittedUserMessage(items, { content: 'second' }, key);
    expect(merged).toHaveLength(4);
  });

  it('drops the replay when attachments match by uri', () => {
    const withAtt: ChatItem = {
      ...user('[see attachments]'),
      attachments: [{ kind: 'image', uri: 'blob://a' }],
    };
    const items = [withAtt, assistant()];
    const merged = mergeCommittedUserMessage(
      items,
      { content: 'look at this', attachments: [{ kind: 'image', uri: 'blob://a' }] },
      key,
    );
    expect(merged).toHaveLength(2);
  });

  it('appends when attachment uris differ', () => {
    const withAtt: ChatItem = {
      ...user('[see attachments]'),
      attachments: [{ kind: 'image', uri: 'blob://a' }],
    };
    const items = [withAtt, assistant()];
    const merged = mergeCommittedUserMessage(
      items,
      { content: 'other', attachments: [{ kind: 'image', uri: 'blob://b' }] },
      key,
    );
    expect(merged).toHaveLength(3);
    expect(merged[2]).toMatchObject({ role: 'user', content: 'other' });
  });
});

describe('mergeCommittedAssistantMessage', () => {
  it('groups explicit progress, tool-only steps and final output under one stable response', () => {
    const initial = [user('question'), assistant()];
    const progress = mergeCommittedAssistantMessage(initial, 'Checking sources', key, undefined, {
      phase: 'progress',
    });
    expect(progress[1]).toMatchObject({
      content: '',
      streaming: true,
      activity: [{ content: 'Checking sources' }],
    });
    const tools = mergeToolUpdate(
      progress,
      { kind: 'tool_call', toolCallId: 'c', title: 'browser', status: 'in_progress' },
      key,
      '2026-10-09T00:00:00Z',
    );
    const final = mergeCommittedAssistantMessage(tools, 'The answer', key, undefined, {
      phase: 'final',
    });
    expect(final).toHaveLength(2);
    expect(final[1]).toMatchObject({
      key: initial[1]!.key,
      content: 'The answer',
      final: true,
      streaming: false,
      tools: [{ toolCallId: 'c' }],
      activity: [{ content: 'Checking sources' }],
    });
  });
  it('fills the streaming placeholder in the live flow', () => {
    const items = [user('hi'), assistant()];
    const merged = mergeCommittedAssistantMessage(items, 'hello there', key);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      role: 'assistant',
      content: 'hello there',
      streaming: false,
    });
  });

  it('appends a new item during replay, where no placeholder exists', () => {
    const done: ChatItem = { ...assistant(), streaming: false, content: 'turn one' };
    const items = [user('q1'), done, user('q2')];
    const merged = mergeCommittedAssistantMessage(items, 'turn two', key);
    expect(merged).toHaveLength(4);
    expect(merged[3]).toMatchObject({ role: 'assistant', content: 'turn two', streaming: false });
  });
});

describe('message timestamp reconciliation', () => {
  const at = '2026-10-08T06:12:00.000Z';

  it('replaces the optimistic user time with the saved time without duplicating the prompt', () => {
    const optimistic = { ...user('hello'), at: '2026-10-08T06:11:00.000Z' };
    const placeholder = assistant();
    const merged = mergeCommittedUserMessage(
      [optimistic, placeholder],
      { content: 'hello', at },
      key,
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ key: optimistic.key, at });
    expect(merged[1]).toBe(placeholder);
    expect(mergeCommittedUserMessage(merged, { content: 'hello', at }, key)[0]).toBe(merged[0]);
  });

  it('preserves saved timestamps when replaying both roles', () => {
    const users = mergeCommittedUserMessage([], { content: 'Question', at }, key);
    const all = mergeCommittedAssistantMessage(users, 'Answer', key, at);
    expect(all.map((item) => item.at)).toEqual([at, at]);
  });

  it('settles the assistant placeholder with the saved timestamp and stable key', () => {
    const placeholder = { ...assistant(), at: '2026-10-08T06:11:00.000Z' };
    const merged = mergeCommittedAssistantMessage([placeholder], 'Answer', key, at);
    expect(merged[0]).toMatchObject({ key: placeholder.key, at, streaming: false });
    expect(mergeCommittedAssistantMessage([placeholder], 'Answer', key)[0]?.at).toBe(
      placeholder.at,
    );
  });
});

describe('newItemKey', () => {
  it('returns unique v7-shaped keys even without crypto.randomUUID (http LAN origins)', async () => {
    const original = crypto.randomUUID;
    // Plain-http LAN origins (e.g. http://sam-pc:5173) are not secure
    // contexts, so crypto.randomUUID is absent there — simulate that.
    // newId() only needs crypto.getRandomValues, which IS available.
    delete (crypto as { randomUUID?: unknown }).randomUUID;
    try {
      const { newItemKey } = await import('../src/chat-items');
      const keys = new Set(Array.from({ length: 200 }, () => newItemKey()));
      expect(keys.size).toBe(200);
      for (const k of keys) {
        expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      }
    } finally {
      crypto.randomUUID = original;
    }
  });

  it('produces v7 ids in secure contexts too', async () => {
    const { newItemKey } = await import('../src/chat-items');
    expect(newItemKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

it('settles pending tool indicators and preserves unchanged history on terminal events', () => {
  const user: ChatItem = {
    key: 'user',
    role: 'user',
    content: 'question',
    streaming: false,
    tools: [],
    attachments: [],
  };
  const completed: ChatItem = {
    key: 'completed',
    role: 'assistant',
    content: 'done',
    streaming: false,
    tools: [],
    attachments: [],
  };
  const active: ChatItem = {
    key: 'active',
    role: 'assistant',
    content: 'working',
    streaming: true,
    tools: [{ toolCallId: 'pending', title: 'bash', status: 'in_progress' }],
    attachments: [],
  };
  const result = settleAssistantItems([user, completed, active]);
  expect(result[0]).toBe(user);
  expect(result[1]).toBe(completed);
  expect(result[2]).toMatchObject({
    streaming: false,
    tools: [{ status: 'failed', content: 'No result received; the turn has ended.' }],
  });
  expect(settleAssistantItems(result)[2]).toBe(result[2]);
});
