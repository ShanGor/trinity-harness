import { describe, expect, it, vi } from 'vitest';
import { publishResponseSpeech, subscribeResponseSpeech } from '../src/response-speech-events';

describe('response speech events', () => {
  it('delivers session-scoped playback phases and unsubscribes', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeResponseSpeech(listener);
    publishResponseSpeech({ sessionId: 'one', phase: 'playing' });
    publishResponseSpeech({ sessionId: 'one', phase: 'ended' });
    unsubscribe();
    publishResponseSpeech({ sessionId: 'two', phase: 'stopped' });
    expect(listener.mock.calls.map(([event]) => event)).toEqual([
      { sessionId: 'one', phase: 'playing' },
      { sessionId: 'one', phase: 'ended' },
    ]);
  });
});
