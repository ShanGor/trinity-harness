// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { chatDateHeadings } from '../src/chat-dates';
import { readHistoryTimezone, saveHistoryTimezone } from '../src/history-timezone';
import type { ChatItem } from '../src/chat-items';
const item = (key: string, at: string, role: 'user' | 'assistant' = 'user'): ChatItem => ({
  key,
  at,
  role,
  content: key,
  streaming: false,
  tools: [],
  attachments: [],
});
afterEach(() => localStorage.clear());
describe('Main calendar dates', () => {
  it('anchors a midnight-spanning response to the prompt and joins pages without duplicate separators', () => {
    const older = [item('old', '2026-11-02T23:58:00Z')];
    const recent = [
      item('prompt', '2026-11-02T23:59:00Z'),
      item('answer', '2026-11-03T00:01:00Z', 'assistant'),
      item('next', '2026-11-03T00:02:00Z'),
    ];
    expect([...chatDateHeadings(recent, 'UTC')]).toEqual([
      ['prompt', '2026-11-02'],
      ['next', '2026-11-03'],
    ]);
    expect([...chatDateHeadings([...older, ...recent], 'UTC')]).toEqual([
      ['old', '2026-11-02'],
      ['next', '2026-11-03'],
    ]);
  });
  it('uses calendar days through DST and changes only grouping with timezone', () => {
    const items = [
      item('a', '2026-11-01T05:30:00Z'),
      item('b', '2026-11-01T06:30:00Z'),
      item('c', '2026-11-02T04:30:00Z'),
    ];
    expect([...chatDateHeadings(items, 'America/New_York')]).toEqual([['a', '2026-11-01']]);
    expect([...chatDateHeadings(items, 'Asia/Hong_Kong')]).toEqual([
      ['a', '2026-11-01'],
      ['c', '2026-11-02'],
    ]);
    expect(items[0]!.at).toBe('2026-11-01T05:30:00Z');
  });
  it('ignores removed, missing and invalid timestamps', () => {
    expect([
      ...chatDateHeadings(
        [
          { ...item('deleted', '2026-11-02T00:00:00Z'), removed: true },
          item('bad', 'invalid'),
          item('ok', '2026-11-03T00:00:00Z'),
        ],
        'UTC',
      ),
    ]).toEqual([['ok', '2026-11-03']]);
  });
  it('shares valid browser timezone preferences and ignores invalid persisted values', () => {
    saveHistoryTimezone('Asia/Hong_Kong');
    expect(readHistoryTimezone()).toBe('Asia/Hong_Kong');
    saveHistoryTimezone('Asia/');
    expect(readHistoryTimezone()).toBe('Asia/Hong_Kong');
    localStorage.setItem('trinity.history.timezone', 'invalid');
    expect(
      () => new Intl.DateTimeFormat(undefined, { timeZone: readHistoryTimezone() }),
    ).not.toThrow();
  });
});
