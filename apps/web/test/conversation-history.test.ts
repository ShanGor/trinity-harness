import { describe, expect, it, vi } from 'vitest';
import type { TimelinePage, ServerEvent } from '@trinity-harness/shared';
import { loadTimelineWithPrompt } from '../src/conversation-history';

const prompt: ServerEvent = {
  type: 'message/committed',
  sessionId: 's',
  message: { role: 'user', content: 'Original prompt' },
};
const answer: ServerEvent = {
  type: 'message/committed',
  sessionId: 's',
  message: { role: 'assistant', content: 'Answer', phase: 'final' },
};

describe('conversation history paging', () => {
  it('retrieves a prompt across empty tool-log pages, preserving order and the stream watermark', async () => {
    const getTimeline = vi
      .fn<() => Promise<TimelinePage>>()
      .mockResolvedValueOnce({ events: [answer], nextBefore: 401, lastSeq: 600 })
      .mockResolvedValueOnce({ events: [], nextBefore: 201, lastSeq: 605 })
      .mockResolvedValueOnce({ events: [prompt], nextBefore: 1, lastSeq: 605 });
    const page = await loadTimelineWithPrompt({ getTimeline }, 's');
    expect(page).toEqual({ events: [prompt, answer], nextBefore: 1, lastSeq: 600 });
    expect(getTimeline.mock.calls).toEqual([
      ['s', undefined],
      ['s', 401],
      ['s', 201],
    ]);
  });

  it('keeps older history paginated once a prompt is present', async () => {
    const getTimeline = vi
      .fn()
      .mockResolvedValue({ events: [prompt, answer], nextBefore: 201, lastSeq: 600 });
    await loadTimelineWithPrompt({ getTimeline }, 's');
    expect(getTimeline).toHaveBeenCalledTimes(1);
  });

  it('stops fetching when navigation cancels a replay', async () => {
    const getTimeline = vi
      .fn()
      .mockResolvedValue({ events: [answer], nextBefore: 201, lastSeq: 600 });
    await loadTimelineWithPrompt({ getTimeline }, 's', undefined, () => true);
    expect(getTimeline).toHaveBeenCalledTimes(1);
  });

  it('rejects a repeated cursor instead of looping', async () => {
    const getTimeline = vi.fn().mockResolvedValue({ events: [], nextBefore: 201, lastSeq: 600 });
    await expect(loadTimelineWithPrompt({ getTimeline }, 's')).rejects.toThrow('cursor');
  });
});
