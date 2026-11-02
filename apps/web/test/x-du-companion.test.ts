import { describe, expect, it } from 'vitest';
import { companionState } from '../src/x-du-companion';
import type { ChatItem } from '../src/chat-items';

const working: ChatItem = {
  key: 'a',
  role: 'assistant',
  content: '',
  streaming: false,
  attachments: [],
  tools: [{ toolCallId: 't', title: 'work', status: 'in_progress' }],
};
describe('companion state', () => {
  it('prioritizes approval and reflects active work', () => {
    expect(companionState([working], true, true, 'speaking', false)).toBe('approval');
    expect(companionState([working], true, false, 'idle', false)).toBe('working');
    expect(companionState([working], false, false, 'idle', false)).toBe('idle');
  });
  it('reflects voice and does not claim to listen while muted', () => {
    expect(companionState([], false, false, 'listening', false)).toBe('listening');
    expect(companionState([], false, false, 'listening', true)).toBe('idle');
    expect(companionState([], true, false, 'idle', false)).toBe('thinking');
  });
});
