import { describe, expect, it } from 'vitest';
import { browserResultSchema, type SessionEvent } from '@trinity-harness/contracts';
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
  it('warns on browser failures and gives distinct advice for unrelated tool failures', () => {
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
    ).toContain('Repeated tool failures: bash');
    expect(progressGuidance([...events, ...pair('4', snapshot, 'useful')], 1, 5, 64)).toBeNull();
  });
  it('warns in the final quarter without taking away available steps', () => {
    expect(progressGuidance([user()], 1, 47, 64)).toBeNull();
    expect(progressGuidance([user()], 1, 48, 64)).toContain('final quarter');
    expect(progressGuidance([user()], 1, 64, 64)).toContain('final quarter');
  });
  it('advises citation recovery after two rejections and clears it after a valid record or new prompt', () => {
    const rejected = (id: string): SessionEvent[] => [
      { ...meta(), type: 'tool/call', callId: id, name: 'research', args: { action: 'record' } },
      {
        ...meta(),
        type: 'tool/result',
        callId: id,
        isError: true,
        value: { code: 'RESEARCH_SOURCE_MISMATCH' },
      },
    ];
    const events = [user(), ...rejected('a')];
    expect(progressGuidance(events, 1, 2, 64, true)).toBeNull();
    events.push(...rejected('b'));
    expect(progressGuidance(events, 1, 3, 64, true)).toContain('copy a short contiguous passage');
    expect(progressGuidance(events, 1, 3, 64, true)).toContain('not a stop request');
    expect(progressGuidance(events, 1, 3, 64, true)).toContain(
      'omit internal research bookkeeping',
    );
    expect(progressGuidance(events, 1, 3, 64, false)).toBeNull();
    const status: SessionEvent[] = [
      {
        ...meta(),
        type: 'tool/call',
        callId: 'status',
        name: 'research',
        args: { action: 'status' },
      },
      {
        ...meta(),
        type: 'tool/result',
        callId: 'status',
        isError: false,
        value: { kind: 'research-notes', promptSeq: 1, notes: null },
      },
    ];
    expect(progressGuidance([...events, ...status], 1, 4, 64, true)).toContain(
      'rejected repeatedly',
    );
    const recorded: SessionEvent[] = [
      {
        ...meta(),
        type: 'tool/call',
        callId: 'fixed',
        name: 'research',
        args: { action: 'record' },
      },
      {
        ...meta(),
        type: 'tool/result',
        callId: 'fixed',
        isError: false,
        value: {
          kind: 'research-notes',
          promptSeq: 1,
          notes: {
            question: 'Question',
            findings: [],
            openQuestions: ['Unresolved'],
            readyToAnswer: false,
          },
        },
      },
    ];
    expect(progressGuidance([...events, ...recorded], 1, 4, 64, true)).toBeNull();
    const next = [...events, user()];
    expect(progressGuidance(next, next.length, 1, 64, true)).toBeNull();
    const unrelated = events.map((event): SessionEvent =>
      event.type === 'tool/call' ? { ...event, name: 'other' } : event,
    );
    expect(progressGuidance(unrelated, 1, 3, 64, true)).not.toContain('Research citations');
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

it('does not prescribe research from source counts and respects model-authored readiness', () => {
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
  expect(progressGuidance(events, 1, 3, 64, true)).toBeNull();
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
          question: 'What does the evidence establish?',
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
      question: 'What does the evidence establish?',
      findings: [
        {
          claim: 'Observed',
          relation: 'context',
          sources: [{ url: 'https://example.com/a', quote: 'An observed passage.' }],
        },
      ],
      openQuestions: ['What remains uncertain?'],
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
  expect(progressGuidance([...pending, ...extraSources], 1, 6, 64, true)).toBeNull();
  expect(
    progressGuidance([...pending, ...extraSources, { ...result, callId: 'notes' }], 1, 7, 64, true),
  ).toBeNull();
});

function browserPair(
  id: string,
  operation: string,
  isError = false,
  code = 'DRIVER_FAILED',
): SessionEvent[] {
  const saved = ['read_observation', 'search_observation'].includes(operation);
  return [
    { ...meta(), type: 'tool/call', callId: id, name: 'browser', args: { operation } },
    {
      ...meta(),
      type: 'tool/result',
      callId: id,
      isError,
      value: isError
        ? { kind: 'browser-error-v1', operation, code, effect: 'none', message: 'Failure' }
        : {
            kind: 'browser-result-v1',
            operation,
            callId: id,
            sessionId: 's',
            observationId: id,
            artifactUri: `blob://browser/s/${id}.json`,
            url: 'https://example.com/',
            title: 'Evidence',
            capturedAt: meta().at,
            bindingId: 'binding',
            tabId: 'tab',
            documentRevision: 'rev',
            readiness: 'ready',
            saved,
            representation: 'article',
            scope: 'main',
            captureTruncated: false,
            outputTruncated: false,
            exclusions: [],
            publishedAt: null,
            outline: [],
            duplicateSuppressed: false,
            continuation: null,
            blocks: [{ id: 'b0', kind: 'paragraph', text: id, start: 0, end: id.length }],
            receipt: [{ blockId: 'b0', start: 0, end: id.length }],
          },
    },
  ];
}

it('keeps live failure guidance across saved reads, replay and a process restart', () => {
  const events = [
    user(),
    ...browserPair('failed1', 'navigate', true),
    ...browserPair('saved1', 'read_observation'),
    ...browserPair('failed2', 'navigate', true),
    ...browserPair('saved2', 'search_observation'),
    ...browserPair('failed3', 'read_page', true),
  ];
  const warning = progressGuidance(events, 1, 6, Infinity);
  expect(warning).toContain('three consecutive browser commands');
  expect(warning).toContain('Successful saved reads do not demonstrate live recovery');
  expect(
    progressGuidance(
      structuredClone([...events, ...browserPair('saved3', 'read_observation')]),
      1,
      7,
      Infinity,
    ),
  ).toBe(warning);
  expect(
    progressGuidance([...events, ...browserPair('recovered', 'navigate')], 1, 8, Infinity),
  ).toBeNull();
  const next = [...events, user()];
  expect(progressGuidance(next, next.length, 1, Infinity)).toBeNull();
});

it('reports live denial immediately and only clears it after live success', () => {
  for (const code of ['NOT_AUTHORIZED', 'DISABLED']) {
    const events = [user(), ...browserPair('denied', 'navigate', true, code)];
    expect(progressGuidance(events, 1, 1, Infinity)).toContain(
      'Live browser access was denied or disabled',
    );
    expect(
      progressGuidance([...events, ...browserPair('saved', 'read_observation')], 1, 2, Infinity),
    ).toContain('does not restore live authorization');
    expect(
      progressGuidance([...events, ...browserPair('recovered', 'get_page_text')], 1, 3, Infinity),
    ).toBeNull();
  }
  expect(
    progressGuidance(
      [user(), ...browserPair('missing', 'read_observation', true, 'ARTIFACT_UNAVAILABLE')],
      1,
      1,
      Infinity,
    ),
  ).toBeNull();
});

function evidencePair(
  id: string,
  texts: string[],
  headingOnly = false,
  operation = 'read_observation',
): SessionEvent[] {
  const events = browserPair(id, operation);
  const call = events[0]!;
  const result = events[1]!;
  if (call.type !== 'tool/call' || result.type !== 'tool/result') throw new Error('Expected pair');
  call.args = { operation, ...(headingOnly ? { blockIds: ['b0'] } : {}) };
  const value = browserResultSchema.parse(result.value);
  value.blocks = texts.map((text, index) => ({
    id: `b${index}`,
    kind: headingOnly ? 'heading' : 'paragraph',
    text,
    start: 0,
    end: text.length,
  }));
  result.value = value;
  return events;
}

it('explains heading-only selections and clears advice after reading section content', () => {
  const events = [user(), ...evidencePair('heading', ['Memory requirements'], true)];
  expect(progressGuidance(events, 1, 2, Infinity)).toContain('selected only heading blocks');
  expect(progressGuidance(events, 1, 2, Infinity)).toContain('sectionId');
  expect(progressGuidance(structuredClone(events), 1, 2, Infinity)).toBe(
    progressGuidance(events, 1, 2, Infinity),
  );
  expect(
    progressGuidance(
      [...events, ...evidencePair('body', ['Requires 16 GB of memory.'])],
      1,
      3,
      Infinity,
    ),
  ).toBeNull();
  const next = [...events, user()];
  expect(progressGuidance(next, next.length, 1, Infinity)).toBeNull();
});

it('detects interspersed repeated blocks across captures and regroupings without ending work', () => {
  const events = [
    user(),
    ...evidencePair('original', ['alpha', 'beta']),
    ...evidencePair('repeat1', ['beta']),
    ...evidencePair('new1', ['gamma'], false, 'navigate'),
    ...evidencePair('repeat2', ['beta', 'alpha']),
    ...evidencePair('new2', ['delta']),
    ...evidencePair('repeat3', ['alpha']),
  ];
  const warning = progressGuidance(events, 1, 7, Infinity);
  expect(warning).toContain('three of the last six browser reads');
  expect(warning).toContain('not a completion or stop rule');
  expect(progressGuidance(structuredClone(events), 1, 7, Infinity)).toBe(warning);
  expect(progressGuidance([...events, ...evidencePair('fresh', ['epsilon'])], 1, 8, Infinity)).toBe(
    warning,
  );
  expect(
    progressGuidance(
      [...events, ...evidencePair('fresh1', ['epsilon']), ...evidencePair('fresh2', ['zeta'])],
      1,
      9,
      Infinity,
    ),
  ).toBeNull();
  const next = [...events, user()];
  expect(progressGuidance(next, next.length, 1, Infinity)).toBeNull();
});

it('does not mistake genuinely new saved pages for stalled research regardless of step count', () => {
  const events = [
    user(),
    ...Array.from({ length: 12 }, (_, i) => evidencePair(`page${i}`, [`New evidence ${i}`])).flat(),
  ];
  expect(progressGuidance(events, 1, 100, Infinity)).toBeNull();
});

describe('general action guidance', () => {
  function read(id: string, path: string, text = 'do-not-copy-result'): SessionEvent[] {
    return [
      { ...meta(), type: 'tool/call', callId: id, name: 'read_file', args: { path } },
      { ...meta(), type: 'tool/result', callId: id, value: { text }, isError: false },
    ];
  }
  it('detects identical reads across other successful work without exposing arguments or contents', () => {
    const events = [
      user(),
      ...read('a', 'private-name'),
      ...read('other', 'other', 'new'),
      ...read('b', 'private-name'),
      ...read('c', 'private-name'),
    ];
    const advice = progressGuidance(events, 1, 5, Infinity);
    expect(advice).toContain('Repeated unchanged observations: read_file');
    expect(advice).not.toContain('private-name');
    expect(advice).not.toContain('do-not-copy-result');
    expect(
      progressGuidance([...events, ...read('changed', 'private-name', 'changed')], 1, 6, Infinity),
    ).toBeNull();
  });
  it('invalidates repetition after workspace changes and resets at the next prompt', () => {
    const events = [user(), ...read('a', 'a'), ...read('b', 'a'), ...read('c', 'a')];
    const effect: SessionEvent[] = [
      {
        ...meta(),
        type: 'tool/call',
        callId: 'edit',
        name: 'write_file',
        args: {},
        effect: { kind: 'mutation', scope: 'workspace' },
      },
      { ...meta(), type: 'tool/result', callId: 'edit', value: {}, isError: false },
    ];
    expect(
      progressGuidance([...events, ...effect, ...read('new', 'a')], 1, 6, Infinity),
    ).toBeNull();
    const next = [...events, user()];
    expect(progressGuidance(next, next.length, 1, Infinity)).toBeNull();
  });
  it('warns after two failing browser operations despite unrelated shell success', () => {
    const failure = (id: string, operation: string): SessionEvent[] => [
      { ...meta(), type: 'tool/call', callId: id, name: 'browser', args: { operation } },
      {
        ...meta(),
        type: 'tool/result',
        callId: id,
        value: { code: 'DRIVER_FAILED' },
        isError: true,
      },
    ];
    const events = [
      user(),
      ...failure('a', 'navigate'),
      ...pair('shell', 'uname -a', 'guest kernel'),
      ...failure('b', 'web_search'),
    ];
    expect(progressGuidance(events, 1, 4, Infinity)).toContain('Repeated tool failures: browser');
    expect(progressGuidance(events, 1, 4, Infinity)).toContain('unknown effect');
  });
  it('replays the same guidance from a serialized event log', () => {
    const events = [user(), ...pair('a', 'pytest', '', true), ...pair('b', 'pytest', '', true)];
    expect(progressGuidance(JSON.parse(JSON.stringify(events)), 1, 3, Infinity)).toBe(
      progressGuidance(events, 1, 3, Infinity),
    );
  });
});
