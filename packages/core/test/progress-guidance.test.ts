import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@trinity-harness/contracts';
import { progressGuidance } from '../src/loop/progress-guidance.js';
import { toModelMessages } from '../src/index.js';

const meta = () => ({ eventId: crypto.randomUUID(), at: '2026-01-01T00:00:00.000Z' });
const user = (): SessionEvent => ({
  ...meta(),
  type: 'message/user',
  surfaceOp: 'append',
  content: [{ kind: 'text', text: 'research' }],
});
function pair(id: string, command: string, stdout: string, isError = false): SessionEvent[] {
  return [
    { ...meta(), type: 'tool/call', callId: id, name: 'bash', args: { command } },
    {
      ...meta(),
      type: 'tool/result',
      callId: id,
      value: { stdout, stderr: '', exitCode: isError ? 1 : 0 },
      isError,
    },
  ];
}
const snapshot = 'agent-browser --session test --cdp 9222 --pin-tab snapshot -i';
describe('progress guidance', () => {
  it('detects redundant reads even when accessibility refs change', () => {
    const events = [
      user(),
      ...Array.from({ length: 4 }, (_, i) => pair(`c${i}`, snapshot, `article [ref=e${i}]`)).flat(),
    ];
    expect(progressGuidance(events, 1, 5, 64)).toContain('last three browser reads');
    expect(progressGuidance(events, 1, 5, 64)).toContain('does not prove');
    expect(toModelMessages(events).filter((message) => message.role === 'tool')).toHaveLength(4);
  });
  it('clears repetition after a new observation, navigation, or a new prompt', () => {
    const events = [
      user(),
      ...Array.from({ length: 4 }, (_, i) => pair(`c${i}`, snapshot, 'same')).flat(),
    ];
    expect(
      progressGuidance([...events, ...pair('new', snapshot, 'new evidence')], 1, 6, 64),
    ).toBeNull();
    expect(
      progressGuidance(
        [...events, ...pair('nav', 'agent-browser open https://example.com', 'opened')],
        1,
        6,
        64,
      ),
    ).toBeNull();
    const next = [...events, user()];
    expect(progressGuidance(next, next.length, 1, 64)).toBeNull();
  });
  it('warns on consecutive failures or empty reads, but ignores unrelated shell work', () => {
    const events = [
      user(),
      ...pair('1', snapshot, '', true),
      ...pair('2', snapshot, ''),
      ...pair('3', snapshot, '', true),
    ];
    expect(progressGuidance(events, 1, 4, 64)).toContain('three consecutive browser commands');
    expect(
      progressGuidance(
        [user(), ...Array.from({ length: 4 }, (_, i) => pair(`${i}`, 'pytest', '', true)).flat()],
        1,
        5,
        64,
      ),
    ).toBeNull();
    expect(progressGuidance([...events, ...pair('4', snapshot, 'useful')], 1, 5, 64)).toBeNull();
  });
  it('warns in the final quarter without taking away available steps', () => {
    expect(progressGuidance([user()], 1, 47, 64)).toBeNull();
    expect(progressGuidance([user()], 1, 48, 64)).toContain('final quarter');
    expect(progressGuidance([user()], 1, 64, 64)).toContain('final quarter');
  });
  it('projects only the latest active guidance and drops it after completion', () => {
    const events: SessionEvent[] = [
      user(),
      { ...meta(), type: 'turn/guidance', promptSeq: 1, advice: 'old' },
      { ...meta(), type: 'turn/guidance', promptSeq: 1, advice: 'new' },
    ];
    expect(toModelMessages(events).map((message) => message.content)).toEqual([
      'research',
      '[Runtime progress guidance]\nnew',
    ]);
    expect(
      JSON.stringify(
        toModelMessages([...events, { ...meta(), type: 'turn/end', reason: 'error' }]),
      ),
    ).not.toContain('Runtime progress guidance');
  });
});

it('requests an evidence checkpoint after multiple sources and prompts a conclusion when notes are ready', () => {
  const document = (url: string) => ({
    kind: 'trinity-research-page-v1',
    url,
    title: 'Source',
    publishedAt: null,
    text: 'An observed passage.',
    truncated: false,
    links: [],
  });
  const events = [
    user(),
    ...pair(
      'a',
      "agent-browser --json eval 'trinity-research-page-v1'",
      JSON.stringify(document('https://example.com/a')),
    ),
    ...pair(
      'b',
      "agent-browser --json eval 'trinity-research-page-v1'",
      JSON.stringify(document('https://example.com/b')),
    ),
  ];
  expect(progressGuidance(events, 1, 3, 64, true)).toContain('Evidence checkpoint');
  expect(progressGuidance(events, 1, 3, 64, false)).toBeNull();
  const recorded: SessionEvent[] = [
    ...events,
    { ...meta(), type: 'tool/call', callId: 'notes', name: 'research', args: {} },
    {
      ...meta(),
      type: 'tool/result',
      callId: 'notes',
      isError: false,
      value: {
        kind: 'research-notes',
        promptSeq: 1,
        notes: {
          question: 'Which product supports this feature?',
          findings: [
            {
              claim: 'Observed context',
              relation: 'context',
              sources: [{ url: 'https://example.com/a', quote: 'An observed passage.' }],
            },
          ],
          openQuestions: [],
          readyToAnswer: true,
        },
      },
    },
  ];
  expect(progressGuidance(recorded, 1, 4, 64, true)).toContain('ready for answering');
  expect(progressGuidance(recorded, 1, 4, 64, true)).not.toContain('Evidence checkpoint');
  const pending = structuredClone(recorded);
  const result = pending.at(-1)!;
  if (result.type !== 'tool/result') throw new Error('Expected research result');
  result.value = {
    ...(result.value as object),
    notes: {
      question: 'Which product supports this feature?',
      findings: [
        {
          claim: 'Observed',
          relation: 'context',
          sources: [{ url: 'https://example.com/a', quote: 'An observed passage.' }],
        },
      ],
      openQuestions: ['Is there a roadmap?'],
      readyToAnswer: false,
    },
  };
  expect(progressGuidance(pending, 1, 4, 64, true)).toBeNull();
  const extraSources = [
    ...pair(
      'c',
      "agent-browser --json eval 'trinity-research-page-v1'",
      JSON.stringify(document('https://example.com/c')),
    ),
    ...pair(
      'd',
      "agent-browser --json eval 'trinity-research-page-v1'",
      JSON.stringify(document('https://example.com/d')),
    ),
  ];
  expect(progressGuidance([...pending, ...extraSources], 1, 6, 64, true)).toContain(
    'two more sources',
  );
  expect(
    progressGuidance([...pending, ...extraSources, { ...result, callId: 'notes' }], 1, 7, 64, true),
  ).toBeNull();
});
