// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App as AntdApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@trinity-harness/shared';

import App from '../src/App';

const fake = vi.hoisted(() => ({
  onEvent: undefined as ((event: ServerEvent) => void) | undefined,
  markdown: vi.fn(),
  sendPrompt: vi.fn(async () => undefined),
  cancelTurn: vi.fn(async () => undefined),
}));

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => {
    fake.markdown(children);
    return createElement('div', null, children);
  },
}));

vi.mock('@trinity-harness/client-acp', () => ({
  AcpClient: class {
    listSessions = async () =>
      Array.from({ length: 30 }, (_, index) => ({
        sessionId: `s${index}`,
        title: `Conversation ${index}`,
        userId: 'user',
        createdAt: '2026-10-08T00:00:00Z',
        workspaceUri: '/workspace/user',
        scope: 'personal',
      }));
    listTeams = async () => [];
    createSession = async () => 'new-session';
    sendPrompt = fake.sendPrompt;
    cancelTurn = fake.cancelTurn;
    openEventStream(_id: string, handlers: { onEvent: (event: ServerEvent) => void }) {
      fake.onEvent = handlers.onEvent;
      return { close: () => undefined };
    }
    queryAudit = async () => ({ records: [], total: 0 });
  },
}));

let container: HTMLDivElement;
let root: Root;
let dateRender: ReturnType<typeof vi.spyOn>;

async function type(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function emit(event: ServerEvent): Promise<void> {
  await act(async () => fake.onEvent?.(event));
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addListener: () => undefined,
    removeListener: () => undefined,
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user: { id: 'user', email: 'user@example.com', role: 'admin' },
          }),
        ),
    ),
  );
  // jsdom does not implement pseudo-element computed styles or scrolling.
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  Element.prototype.scrollTo = vi.fn();
  sessionStorage.setItem('trinity.token', 'test-token');
  dateRender = vi.spyOn(Date.prototype, 'toLocaleString').mockReturnValue('Oct 8');
  fake.onEvent = undefined;
  fake.markdown.mockClear();
  fake.sendPrompt.mockClear();
  fake.cancelTurn.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(AntdApp, null, createElement(App))));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('chat typing and streaming performance', () => {
  it('keeps draft updates local without rerendering history or completed messages', async () => {
    await click(container.querySelector('.history-item'));
    await emit({ type: 'message/committed', message: { role: 'user', content: 'Question' } });
    await emit({
      type: 'message/committed',
      message: { role: 'assistant', content: 'Completed answer' },
    });
    const textarea = container.querySelector('textarea')!;
    await act(async () => textarea.focus());
    dateRender.mockClear();
    fake.markdown.mockClear();

    for (const value of ['n', 'ne', 'next question']) await type(textarea, value);

    expect(dateRender).not.toHaveBeenCalled();
    expect(fake.markdown).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(textarea);
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('next question');
  });

  it('preserves focus and a new draft during streaming, session creation and layout updates', async () => {
    const textarea = container.querySelector('textarea')!;
    await act(async () => textarea.focus());
    await type(textarea, 'First prompt');
    await click(container.querySelector('.ant-sender-actions-btn'));
    expect(fake.sendPrompt).toHaveBeenCalledWith('new-session', 'First prompt', []);
    expect(container.querySelector('textarea')).toBe(textarea);
    await type(textarea, 'Draft for next turn');
    textarea.setSelectionRange(5, 5);
    fake.markdown.mockClear();
    await emit({
      type: 'session/update',
      update: { kind: 'agent_message_chunk', text: 'Streaming answer' },
    });
    await emit({
      type: 'session/update',
      update: { kind: 'agent_message_chunk', text: ' continues' },
    });
    await emit({ type: 'session/turn_status', status: 'completed' });
    await click(container.querySelector('.history-toggle'));

    expect(container.querySelector('textarea')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe('Draft for next turn');
    expect(textarea.selectionStart).toBe(5);
    expect(textarea.selectionEnd).toBe(5);
    expect(fake.markdown.mock.calls.map(([content]) => content)).toEqual([
      'Streaming answer',
      'Streaming answer continues',
      'Streaming answer continues',
    ]);
  });

  it('only rerenders the active message when a new stream chunk arrives', async () => {
    await click(container.querySelector('.history-item'));
    await emit({
      type: 'message/committed',
      message: { role: 'assistant', content: 'Earlier answer' },
    });
    const textarea = container.querySelector('textarea')!;
    await type(textarea, 'Next prompt');
    await click(container.querySelector('.ant-sender-actions-btn'));
    fake.markdown.mockClear();
    dateRender.mockClear();

    await emit({
      type: 'session/update',
      update: { kind: 'agent_message_chunk', text: 'New answer' },
    });

    expect(fake.markdown.mock.calls.map(([content]) => content)).toEqual(['New answer']);
    expect(dateRender).not.toHaveBeenCalled();
  });

  it('clears the draft when starting or selecting a conversation', async () => {
    const textarea = container.querySelector('textarea')!;
    await type(textarea, 'Draft');
    await click(container.querySelector('.new-chat-button'));
    expect(textarea.value).toBe('');
    await type(textarea, 'Another draft');
    await click(container.querySelector('.history-item'));
    expect(textarea.value).toBe('');
  });

  it('connects the sender cancel action to the active turn', async () => {
    const textarea = container.querySelector('textarea')!;
    await type(textarea, 'Run a task');
    await click(container.querySelector('.ant-sender-actions-btn'));
    await click(container.querySelector('.ant-sender-actions-btn'));
    expect(fake.cancelTurn).toHaveBeenCalledWith('new-session');
  });
});
