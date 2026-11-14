import { describe, expect, it } from 'vitest';
import {
  browserResultSchema,
  turnGuidanceEventSchema,
  type SessionEvent,
} from '@trinity-harness/contracts';
import { progressGuidance } from '../src/loop/progress-guidance.js';
import { toModelMessages } from '../src/index.js';
import { browserDiscovery } from '../src/tools/browser-discovery.js';
import { personalModelMessages } from '../src/loop/to-model-messages.js';

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
    expect(progressGuidance(events, 1, 4, 64)).toContain('three browser channel failures');
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
  expect(warning).toContain('three browser channel failures');
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

it('does not turn mixed page privacy, argument and adapter errors into a channel failure streak', () => {
  const events = [
    user(),
    ...browserPair('private-page', 'get_page_text', true, 'PRIVACY_DENIED'),
    ...browserPair('bad-scroll', 'scroll', true, 'INVALID_ARGUMENTS'),
    ...browserPair('bad-adapter', 'read_page', true, 'DRIVER_FAILED'),
  ];
  const advice = progressGuidance(events, 1, 4, Infinity);
  expect(advice).toBeNull();
  expect(progressGuidance(structuredClone(events), 1, 4, Infinity)).toBe(advice);
});

it('keeps source-specific failures out of tool-wide outage guidance after successful live reads', () => {
  const events = [
    user(),
    ...browserPair('failed-page', 'navigate', true, 'PAGE_UNAVAILABLE'),
    ...browserPair('recovered-search', 'web_search'),
    ...browserPair('another-page', 'navigate', true, 'PAGE_UNAVAILABLE'),
  ];
  expect(progressGuidance(events, 1, 4, Infinity)).toBeNull();
  expect(progressGuidance(structuredClone(events), 1, 4, Infinity)).toBeNull();
});

it('does not count rejected or unexecuted browser calls as repeated execution failures', () => {
  const events = [
    user(),
    ...browserPair('bad1', 'scroll', true, 'INVALID_ARGUMENTS'),
    ...browserPair('skipped', 'scroll', true, 'NOT_EXECUTED'),
    ...browserPair('bad2', 'read_page', true, 'INVALID_ARGUMENTS'),
  ];
  expect(progressGuidance(events, 1, 4, Infinity)).toBeNull();
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

it('detects search variations with no new destinations without equating discovery with evidence', () => {
  const search = (id: string, urls: string[]): SessionEvent[] => {
    const events = evidencePair(id, [`Different snippet ${id}`], false, 'web_search');
    const result = events[1]!;
    if (result.type !== 'tool/result') throw new Error('Expected result');
    result.value = {
      ...browserResultSchema.parse(result.value),
      url: `https://search.invalid/?q=${id}`,
      links: urls.map((url) => ({ url, title: 'Discovered destination', blockId: 'b0' })),
    };
    return events;
  };
  const events = [
    user(),
    ...['one', 'two', 'three', 'four'].flatMap((id) =>
      search(id, [`https://source.invalid/private-name#${id}`, `https://search.invalid/?q=${id}`]),
    ),
  ];
  const warning = progressGuidance(events, 1, 5, Infinity);
  expect(warning).toContain('three of the last four search observations');
  expect(warning).toContain('Do not infer a fact from missing search results');
  expect(warning).not.toContain('private-name');
  expect(progressGuidance(structuredClone(events), 1, 5, Infinity)).toBe(warning);
  expect(
    progressGuidance([...events, ...search('new', ['https://source.invalid/new'])], 1, 6, Infinity),
  ).toBe(warning);
  expect(
    progressGuidance(
      [
        ...events,
        ...search('new', ['https://source.invalid/new']),
        ...search('newer', ['https://source.invalid/newer']),
      ],
      1,
      7,
      Infinity,
    ),
  ).toBeNull();
  const next = [...events, user()];
  expect(progressGuidance(next, next.length, 1, Infinity)).toBeNull();
});

it('shares discovery across operation paths and providers, without counting saved reads', () => {
  const search = (
    id: string,
    operation: string,
    url: string,
    target = 'https://source.invalid/reference',
  ): SessionEvent[] => {
    const events = evidencePair(id, [`Different query heading ${id}`], false, operation);
    const result = events[1]!;
    if (result.type !== 'tool/result') throw new Error('Expected result');
    const value = browserResultSchema.parse(result.value);
    value.url = url;
    value.links = [{ blockId: 'b0', title: 'Reference', url: target }];
    value.discovery = browserDiscovery(url, value.operation, value.links, true);
    result.value = value;
    return events;
  };
  const events = [
    user(),
    ...search('one', 'web_search', 'https://www.google.com/search?q=one'),
    ...search(
      'two',
      'navigate',
      'https://html.duckduckgo.com/html/?q=two',
      'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fsource.invalid%2Freference%23section',
    ),
    ...search('three', 'navigate', 'https://www.bing.com/search?q=three'),
    ...search('four', 'navigate', 'https://html.duckduckgo.com/html/?q=four'),
  ];
  const warning = progressGuidance(events, 1, 5, Infinity);
  expect(warning).toContain('last four search observations');
  expect(warning).toContain('Partial captures');
  expect(warning).not.toContain('source.invalid');
  expect(progressGuidance(structuredClone(events), 1, 5, Infinity)).toBe(warning);
  const saved = [user(), ...search('first', 'navigate', 'https://www.google.com/search?q=first')];
  for (const id of ['saved1', 'saved2', 'saved3'])
    saved.push(...search(id, 'read_observation', `https://www.google.com/search?q=${id}`));
  expect(progressGuidance(saved, 1, 5, Infinity) ?? '').not.toContain(
    'last four search observations',
  );
  const next = [...events, user()];
  expect(progressGuidance(next, next.length, 1, Infinity)).toBeNull();
  const newSources = [
    ...events,
    ...search('new1', 'navigate', 'https://www.bing.com/search?q=new1', 'https://new.invalid/one'),
    ...search('new2', 'navigate', 'https://www.bing.com/search?q=new2', 'https://new.invalid/two'),
  ];
  expect(progressGuidance(newSources, 1, 7, Infinity) ?? '').not.toContain(
    'last four search observations',
  );
});

it('keeps the latest guidance near the next decision after later tool pairs and recovery', () => {
  const events: SessionEvent[] = [
    user(),
    { ...meta(), type: 'turn/guidance', promptSeq: 1, advice: 'Change the reading strategy.' },
    ...pair('first', 'read-only-tool', 'observed evidence'),
    ...pair('second', 'read-only-tool', 'more evidence'),
  ];
  const messages = toModelMessages(events);
  expect(messages.at(-1)).toMatchObject({
    role: 'user',
    context: 'control',
    content: '[Runtime progress guidance]\nChange the reading strategy.',
  });
  expect(messages.filter((m) => m.content.includes('Runtime progress guidance'))).toHaveLength(1);
  expect(messages.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual([
    'first',
    'second',
  ]);
  expect(toModelMessages(structuredClone(events))).toEqual(messages);
  const before = structuredClone(events);
  const personal = personalModelMessages(events, {
    version: 2,
    promptId: events[0]!.eventId,
    policyRevision: 0,
    memories: [],
    episodes: [],
    dialogue: [],
    omitted: false,
  });
  expect(personal.at(-1)).toEqual(messages.at(-1));
  expect(personal.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual([
    'first',
    'second',
  ]);
  expect(events).toEqual(before);
  const interrupted: SessionEvent[] = [
    ...events,
    {
      ...meta(),
      type: 'tool/call',
      callId: 'pending',
      name: 'browser',
      args: { operation: 'navigate' },
    },
  ];
  const recovery = toModelMessages(interrupted);
  expect(recovery.at(-2)).toMatchObject({ role: 'tool', toolCallId: 'pending' });
  expect(recovery.at(-1)).toEqual(messages.at(-1));
  const closed = toModelMessages([...events, { ...meta(), type: 'turn/end', reason: 'completed' }]);
  expect(closed.some((m) => m.content.includes('Runtime progress guidance'))).toBe(false);
});

it('keeps repeated unavailable-target advice across unrelated success and clears only matching recovery', () => {
  const navigation = (id: string, url: string, failed: boolean): SessionEvent[] => {
    const events = browserPair(id, 'navigate', failed, 'PAGE_UNAVAILABLE');
    const call = events[0]!;
    const result = events[1]!;
    if (call.type !== 'tool/call' || result.type !== 'tool/result')
      throw new Error('Expected pair');
    call.args = { operation: 'navigate', url };
    if (!failed) result.value = { ...browserResultSchema.parse(result.value), url };
    return events;
  };
  const url = 'https://unavailable.invalid/private';
  const events = [
    user(),
    ...navigation('one', url, true),
    ...navigation('unrelated', 'https://working.invalid/', false),
    ...navigation('two', url, true),
  ];
  const warning = progressGuidance(events, 1, 4, Infinity);
  expect(warning).toContain('target already reported PAGE_UNAVAILABLE');
  expect(warning).not.toContain(url);
  expect(warning).not.toContain('three browser channel failures');
  expect(
    progressGuidance(
      structuredClone([...events, ...navigation('other', 'https://working.invalid/', false)]),
      1,
      5,
      Infinity,
    ),
  ).toBe(warning);
  expect(
    progressGuidance([...events, ...navigation('recovered', url, false)], 1, 5, Infinity),
  ).toBeNull();
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

it('retains extraction recovery across screenshots and replay, clearing only on a fresh text capture', () => {
  const capture = (id: string, status: 'heading-only' | 'text-captured'): SessionEvent[] => {
    const events = browserPair(id, 'get_page_text');
    const result = events[1]!;
    if (result.type !== 'tool/result') throw new Error('Expected result');
    result.value = {
      ...browserResultSchema.parse(result.value),
      extraction: {
        status,
        visibleFrames: status === 'heading-only' ? 1 : 0,
        openShadowRoots: 0,
        canvases: 0,
        inspectionTruncated: false,
        scope: 'top-document',
      },
    };
    return events;
  };
  const events = [
    user(),
    ...capture('shell', 'heading-only'),
    ...browserPair('pixels', 'screenshot'),
    ...browserPair('saved', 'read_observation'),
  ];
  const guidance = progressGuidance(structuredClone(events), 1, 4, Infinity);
  expect(guidance).toContain('not evidence that navigation failed');
  expect(guidance).toContain('curl/shell HTTP');
  expect(guidance).toContain('do not claim a complete export');
  expect(
    progressGuidance([...events, ...capture('body', 'text-captured')], 1, 5, Infinity) ?? '',
  ).not.toContain('Browser extraction has limited');
  const next = [...events, user()];
  expect(progressGuidance(next, next.length, 1, Infinity)).toBeNull();
});

it('treats successful rendered capture as live recovery, with independent coverage advice', () => {
  const events: SessionEvent[] = [
    user(),
    ...Array.from({ length: 3 }, (_, i) => pair('fail' + i, snapshot, 'failed', true)).flat(),
    {
      ...meta(),
      type: 'tool/call',
      name: 'browser',
      callId: 'capture',
      args: { operation: 'capture_document' },
    },
    {
      ...meta(),
      type: 'tool/result',
      callId: 'capture',
      isError: false,
      value: {
        kind: 'browser-document-result-v1',
        operation: 'capture_document',
        buildId: 'trinity-document-v1',
        browserVersion: 'Chrome',
        sessionId: 's',
        callId: 'capture',
        captureId: 'cap',
        hash: 'a'.repeat(64),
        coverage: 'partial',
        stability: 'checked-interval',
        documents: [],
        omittedFrames: 1,
        omissionReasons: ['frame-unavailable'],
        resources: { captured: 0, unavailable: 1 },
        ranges: [],
        continuation: null,
      },
    },
  ];
  const guidance = progressGuidance(events, 1, 5, 64);
  expect(guidance).toContain('Convert and read available saved documents offline');
  expect(guidance).not.toContain('three browser channel failures');
});
it('keeps missing document capability separate from ordinary live access', () => {
  const events: SessionEvent[] = [
    user(),
    {
      ...meta(),
      type: 'tool/call',
      name: 'browser',
      callId: 'capture',
      args: { operation: 'capture_document' },
    },
    {
      ...meta(),
      type: 'tool/result',
      callId: 'capture',
      isError: true,
      value: {
        kind: 'browser-error-v1',
        operation: 'capture_document',
        code: 'DISABLED',
        effect: 'none',
        message: 'Old guest',
      },
    },
  ];
  const guidance = progressGuidance(events, 1, 2, 64);
  expect(guidance).toContain('does not disable ordinary live navigation');
  expect(guidance).not.toContain('Live browser access was denied or disabled');
});

it.each([false, true])(
  'bounds combined recovery guidance with unavailable capture=%s',
  (unavailable) => {
    const heading = browserPair('heading', 'get_page_text');
    const result = heading[1]!;
    if (result.type !== 'tool/result') throw new Error('Expected browser result');
    result.value = {
      ...browserResultSchema.parse(result.value),
      extraction: {
        scope: 'top-document',
        status: 'heading-only',
        visibleFrames: 1,
        embeddedFrames: 0,
        unavailableFrames: 1,
        openShadowRoots: 0,
        canvases: 0,
        inspectionTruncated: false,
      },
    };
    const events: SessionEvent[] = [
      user(),
      ...heading,
      ...pair('failure1', 'inspect', '', true),
      ...pair('failure2', 'inspect', '', true),
      ...['a', 'b'].flatMap((callId): SessionEvent[] => [
        { ...meta(), type: 'tool/call', name: 'research', callId, args: { action: 'record' } },
        {
          ...meta(),
          type: 'tool/result',
          callId,
          isError: true,
          value: { code: 'RESEARCH_SOURCE_MISMATCH' },
        },
      ]),
      ...(unavailable ? browserPair('capture', 'capture_document', true, 'DISABLED') : []),
    ];
    const advice = progressGuidance(events, 1, 8, 10, true)!;
    expect(advice.length).toBeLessThanOrEqual(2000);
    expect(
      turnGuidanceEventSchema.safeParse({ ...meta(), type: 'turn/guidance', promptSeq: 1, advice })
        .success,
    ).toBe(true);
    expect(advice.endsWith('.')).toBe(true);
    expect(progressGuidance(structuredClone(events), 1, 8, 10, true)).toBe(advice);
    if (unavailable) {
      expect(advice).toContain('capture is unavailable on the installed build');
      expect(advice).not.toContain('use one rendered document capture');
    } else {
      expect(advice).toContain('Browser extraction has limited');
      expect(advice).not.toContain('Repeated tool failures');
    }
  },
);
