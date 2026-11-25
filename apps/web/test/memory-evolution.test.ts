// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from 'antd';
import { afterEach, expect, it, vi } from 'vitest';
import { AcpClient } from '@trinity-harness/client-acp';
import { AssistantMemory } from '../src/personal-assistant';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('adjudicates a suggestion without overwriting an unsaved Persona draft; retains failed decisions', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computed(element));
  const client = new AcpClient();
  vi.spyOn(client, 'getMemory').mockResolvedValue({
    revision: 1,
    items: [],
    hasSuppression: false,
    persona: { content: 'Original Persona', revision: 1, updatedAt: null },
  });
  const page = {
    revision: 1,
    facts: [],
    playbooks: [],
    nextBefore: null,
    candidates: [
      {
        candidateId: '00000000-0000-4000-8000-000000000001',
        status: 'pending' as const,
        revision: 1,
        policyRevision: 1,
        at: '2026-11-24T00:00:00.000Z',
        decidedAt: null,
        journal: {
          sessionId: '00000000-0000-4000-8000-000000000002',
          promptId: '00000000-0000-4000-8000-000000000003',
          callId: 'call',
        },
        draft: {
          type: 'fact' as const,
          fact: {
            kind: 'preference' as const,
            text: 'Prefers tea.',
            source: {
              sourceEpisodeId: '00000000-0000-4000-8000-000000000004',
              sourceEventId: '00000000-0000-4000-8000-000000000004',
              sourceSessionId: '00000000-0000-4000-8000-000000000005',
              sourceQuote: 'I prefer tea.',
            },
          },
        },
      },
    ],
  };
  const read = vi
    .spyOn(client, 'getMemoryEvolution')
    .mockResolvedValue({ available: true, page, policyRevision: 1 });
  const decide = vi
    .spyOn(client, 'decideMemoryCandidate')
    .mockRejectedValueOnce(new Error('conflict'))
    .mockResolvedValue();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string): HTMLButtonElement =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === text)!;
  try {
    await act(async () =>
      root.render(
        createElement(App, null, createElement(AssistantMemory, { client, sessionId: null })),
      ),
    );
    const input = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        'Unsaved Persona',
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Accept').click());
    expect(container.textContent).toContain('could not be confirmed');
    expect(input.value).toBe('Unsaved Persona');
    const firstCommand = decide.mock.calls[0]![0];
    read.mockResolvedValue({
      available: true,
      page: { ...page, revision: 2, candidates: [] },
      policyRevision: 1,
    });
    await act(async () => button('Accept').click());
    expect(decide.mock.calls[1]![0]).toEqual(firstCommand);
    expect(container.textContent).toContain('No pending suggestions');
    expect(input.value).toBe('Unsaved Persona');
    expect(client.getMemory).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('discloses exact v3 fact/playbook snapshots and sources used for an answer', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const { MemoryContextDisclosure } = await import('../src/personal-assistant');
  const id = '00000000-0000-4000-8000-000000000001';
  const source = {
    sourceEpisodeId: id,
    sourceEventId: id,
    sourceSessionId: id,
    sourceQuote: 'I prefer tea.',
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(MemoryContextDisclosure, {
          receipt: {
            version: 3,
            promptId: id,
            policyRevision: 0,
            memories: [],
            episodes: [],
            omitted: false,
            recallMode: 'hybrid',
            facts: [
              {
                factId: id,
                kind: 'preference',
                text: 'Prefers tea.',
                source,
                sources: [
                  source,
                  {
                    ...source,
                    sourceEventId: '00000000-0000-4000-8000-000000000002',
                    sourceQuote: 'Tea is my lasting preference.',
                  },
                ],
                revision: 1,
                validFrom: '2026-11-24T00:00:00.000Z',
                validTo: null,
              },
            ],
            playbooks: [
              {
                playbookId: id,
                taskType: 'Preparing tea',
                approach: 'Check the original preference.',
                pitfalls: [],
                sources: [source],
                revision: 2,
                at: '2026-11-24T00:00:00.000Z',
                referenceOnly: true,
              },
            ],
          },
        }),
      ),
    );
    expect(container.textContent).toContain('1 archival facts');
    expect(container.textContent).toContain('1 playbooks');
    await act(async () => (container.querySelector('[role="button"]') as HTMLElement).click());
    expect(container.textContent).toContain('Original source: I prefer tea.');
    expect(container.textContent).toContain('Original source: Tea is my lasting preference.');
    expect(container.textContent).toContain('Check the original preference.');
    expect(container.textContent).toContain('Semantic and keyword episode recall');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
