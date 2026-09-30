import { describe, expect, it } from 'vitest';

import {
  mergeCommittedAssistantMessage,
  mergeCommittedUserMessage,
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

describe('mergeCommittedUserMessage', () => {
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
