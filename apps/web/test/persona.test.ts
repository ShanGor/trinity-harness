// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from 'antd';
import { AcpClient } from '@trinity-harness/client-acp';
import { AssistantMemory } from '../src/personal-assistant';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('edits Markdown, preserves draft after conflict and reloads only explicitly', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  const client = new AcpClient();
  const persona = {
    content: '## About me\n张三',
    revision: 1,
    updatedAt: '2026-11-09T00:00:00.000Z',
  };
  vi.spyOn(client, 'getMemory').mockResolvedValue({
    revision: 1,
    items: [],
    hasSuppression: true,
    persona,
  });
  const save = vi
    .spyOn(client, 'savePersona')
    .mockRejectedValueOnce(new Error('Persona changed; reload before saving.'))
    .mockResolvedValue({ ...persona, content: '## About me\n李四', revision: 2 });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const button = (text: string): HTMLButtonElement =>
    [...container.querySelectorAll('button')].find((item) => item.textContent === text)!;
  try {
    await act(async () =>
      root.render(
        createElement(App, null, createElement(AssistantMemory, { client, sessionId: null })),
      ),
    );
    const textarea = container.querySelector('textarea')!;
    expect(textarea.value).toBe(persona.content);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        '## About me\n李四',
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(client.savePersona).not.toHaveBeenCalled();
    await act(async () => button('Save Persona').click());
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ content: '## About me\n李四', expectedRevision: 1 }),
    );
    expect(textarea.value).toBe('## About me\n李四');
    expect(container.textContent).toContain('Persona changed');
    await act(async () => button('Reload saved Persona').click());
    expect(textarea.value).toBe(persona.content);
    expect(client.getMemory).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('persists the automatic-memory switch and loads exact version sources on demand', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  const client = new AcpClient();
  const persona = {
    content: 'My name is Sam.',
    revision: 2,
    updatedAt: '2026-11-09T00:00:00.000Z',
    autoSaveEnabled: true,
  };
  vi.spyOn(client, 'getMemory').mockResolvedValue({
    revision: 2,
    items: [],
    hasSuppression: false,
    persona,
  });
  const save = vi
    .spyOn(client, 'savePersona')
    .mockResolvedValue({ ...persona, revision: 3, autoSaveEnabled: false });
  const history = vi.spyOn(client, 'getPersonaHistory').mockResolvedValue({
    revisions: [
      {
        ...persona,
        source: {
          sessionId: 'source-session',
          eventId: 'source-event',
          excerpt: 'My name is Sam.',
        },
      },
    ],
    nextBefore: null,
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(App, null, createElement(AssistantMemory, { client, sessionId: null })),
      ),
    );
    expect(history).not.toHaveBeenCalled();
    await act(async () => container.querySelector<HTMLButtonElement>('[role="switch"]')!.click());
    expect(save).not.toHaveBeenCalled();
    await act(async () =>
      [...container.querySelectorAll('button')]
        .find((item) => item.textContent === 'Save Persona')!
        .click(),
    );
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        content: persona.content,
        autoSaveEnabled: false,
        expectedRevision: 2,
      }),
    );
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
    await act(async () =>
      [...container.querySelectorAll<HTMLElement>('.ant-collapse-header')]
        .find((item) => item.textContent?.includes('Persona versions'))!
        .click(),
    );
    expect(history).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('source-session');
    expect(container.textContent).toContain('My name is Sam.');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
