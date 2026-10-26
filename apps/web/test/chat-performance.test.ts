// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App as AntdApp } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TimelinePage, ServerEvent } from '@trinity-harness/shared';

import App from '../src/App';

const fake = vi.hoisted(() => ({
  onEvent: undefined as ((event: ServerEvent) => void) | undefined,
  markdown: vi.fn(),
  getTimeline: vi.fn<() => Promise<TimelinePage>>(),
  createSession: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'new-session'),
  sendPrompt: vi.fn(async () => undefined),
  respondApproval: vi.fn(async () => undefined),
  cancelTurn: vi.fn(async () => ({ ok: true as const, alreadyStopped: false })),
  getBrowserPreview: vi.fn(async () => ({ state: 'unavailable' as const })),
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
        kind: index === 0 ? 'work' : undefined,
        sessionRole: index === 0 ? 'task' : undefined,
        title: `Conversation ${index}`,
        userId: 'user',
        createdAt: '2026-10-08T00:00:00Z',
        workspaceUri: '/workspace/user',
        scope: 'personal',
      }));
    listTeams = async () => [];
    getSchedules = async () => ({ available: false, schedules: [] });
    getInbox = async () => ({ available: false, items: [] });
    getBrowserPreview = fake.getBrowserPreview;
    createSession = fake.createSession;
    ensureMainChat = async () => 'main-session';
    getTimeline = fake.getTimeline;
    sendPrompt = fake.sendPrompt;
    cancelTurn = fake.cancelTurn;
    respondApproval = fake.respondApproval;
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
let clipboardDescriptor: PropertyDescriptor | undefined;

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
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-08T06:00:00Z'));
  // Plain HTTP LAN origins expose getRandomValues but not randomUUID.
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
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
  fake.getTimeline.mockReset().mockResolvedValue({ events: [], lastSeq: 0, nextBefore: null });
  fake.onEvent = undefined;
  fake.markdown.mockClear();
  fake.createSession.mockReset().mockResolvedValue('new-session');
  fake.sendPrompt.mockClear();
  fake.cancelTurn.mockClear();
  fake.getBrowserPreview.mockClear();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(AntdApp, null, createElement(App))));
  await click(container.querySelector('.new-chat-button'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
});

describe('chat typing and streaming performance', () => {
  it('creates side Chat with workspace-write permissions', async () => {
    await type(container.querySelector('textarea')!, 'Save research notes');
    await click(container.querySelector('.ant-sender-actions-btn'));
    expect(fake.createSession).toHaveBeenCalledWith(
      expect.any(String),
      'workspace-write',
      undefined,
      expect.objectContaining({ kind: 'chat' }),
    );
  });

  it('retains workspace-write in the Chat recovery descriptor after a lost creation response', async () => {
    fake.createSession.mockRejectedValueOnce(new Error('connection lost'));
    await type(container.querySelector('textarea')!, 'Save research notes');
    await click(container.querySelector('.ant-sender-actions-btn'));
    expect(JSON.parse(sessionStorage.getItem('trinity.pendingCreation:user')!)).toMatchObject({
      kind: 'chat',
      policy: 'workspace-write',
    });
  });

  it('preserves the recorded policy when recovering an existing Chat creation operation', async () => {
    await act(async () => root.unmount());
    const operationId = '019a1e10-1234-7000-8000-000000000001';
    sessionStorage.setItem(
      'trinity.pendingCreation:user',
      JSON.stringify({ operationId, kind: 'chat', policy: 'read-only', title: 'Pending Chat' }),
    );
    fake.createSession.mockClear();
    root = createRoot(container);
    await act(async () => root.render(createElement(AntdApp, null, createElement(App))));
    expect(fake.createSession).toHaveBeenCalledWith('Pending Chat', 'read-only', undefined, {
      kind: 'chat',
      creationOperationId: operationId,
    });
    expect(sessionStorage.getItem('trinity.pendingCreation:user')).toBeNull();
  });

  it('shows Browser activity and opens the viewer without replacing the composer or draft', async () => {
    await click(container.querySelector('.history-item'));
    const textarea = container.querySelector('textarea')!;
    await type(textarea, 'Keep this browser follow-up');
    await emit({
      type: 'session/update',
      sessionId: 's0',
      update: {
        kind: 'tool_call',
        toolCallId: 'browser-1',
        title: 'browser({"operation":"navigate"})',
        status: 'in_progress',
      },
    });
    expect(container.querySelector('[aria-label="Browser activity"]')?.textContent).toContain(
      'Agent is browsing',
    );
    await click(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Open browser',
      ) ?? null,
    );
    expect(document.body.textContent).toContain('No active browser available');
    expect(fake.getBrowserPreview).toHaveBeenCalledOnce();
    await click(document.querySelector('.ant-modal-close'));
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('Keep this browser follow-up');
  });
  it('shows a saved turn failure inline without presenting it as a new loading error', async () => {
    fake.getTimeline.mockResolvedValueOnce({
      events: [
        {
          type: 'message/committed',
          sessionId: 's0',
          message: { role: 'user', content: 'Saved question' },
        },
        {
          type: 'message/committed',
          sessionId: 's0',
          message: { role: 'assistant', content: 'Checking sources', phase: 'progress' },
        },
        { type: 'error', sessionId: 's0', message: 'Invalid URL' },
      ],
      lastSeq: 237,
      nextBefore: null,
    });
    await click(container.querySelector('.history-title'));
    expect(container.querySelector('.task-progress')?.textContent).toContain('Invalid URL');
    expect(container.querySelector('.user-message-heading')?.parentElement?.textContent).toContain(
      'Saved question',
    );
    expect(document.body.querySelector('.ant-message-notice')).toBeNull();
    expect(container.querySelector('.response-streaming')).toBeNull();
  });
  it('switches Chat and Work only in New while preserving the composer and draft', async () => {
    await click(
      Array.from(container.querySelectorAll('.sidebar-navigation button')).find(
        (button) => button.textContent === 'Main chat',
      ) ?? null,
    );
    expect(container.querySelector('.mode-tabs')).toBeNull();
    await click(container.querySelector('.new-chat-button'));
    const textarea = container.querySelector('textarea')!;
    await type(textarea, 'A question to keep');
    expect(textarea.placeholder).toBe('Ask anything…');
    await click(container.querySelector('.mode-tabs button:nth-child(2)'));
    expect(
      container.querySelector('.mode-tabs button:nth-child(2)')?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(container.textContent).toContain('What would you like to work on?');
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('A question to keep');
    expect(textarea.placeholder).toBe('Describe a task…');
    expect(container.querySelector('.new-chat-button')?.textContent).toBe('＋ New');
    await click(container.querySelector('.mode-tabs button:first-child'));
    expect(textarea.value).toBe('A question to keep');
    expect(container.textContent).toContain('Where should we begin?');
  });

  it('returns from Scheduled to the live conversation with its draft intact', async () => {
    await click(container.querySelector('.history-item'));
    const textarea = container.querySelector('textarea')!;
    await type(textarea, 'Keep the next question');
    await click(
      Array.from(container.querySelectorAll('.sidebar-navigation button')).find((button) =>
        button.textContent?.includes('Scheduled'),
      ) ?? null,
    );
    expect(container.textContent).toContain('Scheduling isn’t available yet');
    expect(container.querySelector('.chat-panel')?.hasAttribute('hidden')).toBe(true);
    await emit({
      type: 'session/update',
      update: { kind: 'agent_message_chunk', text: 'Still running' },
    });
    await click(container.querySelector('.history-item'));
    expect(container.querySelector('.chat-panel')?.hasAttribute('hidden')).toBe(false);
    expect(container.textContent).toContain('Still running');
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('Keep the next question');
  });

  it('puts Work setup in New and audit in the account menu', async () => {
    expect(container.querySelector('[aria-label="Workspace for the next session"]')).toBeNull();
    expect(container.querySelector('.workspace-controls .account-menu-trigger')).toBeNull();
    expect(container.querySelector('.sidebar-account .account-menu-trigger')).not.toBeNull();
    await click(container.querySelector('.new-chat-button'));
    await click(container.querySelector('.mode-tabs button:nth-child(2)'));
    expect(container.querySelector('[aria-label="Work workspace"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Work permissions"]')).not.toBeNull();
  });

  it('keeps the latest update visible through tool execution without disturbing the draft', async () => {
    await click(container.querySelector('.history-item'));
    await emit({ type: 'message/committed', message: { role: 'user', content: 'Fix sign-in' } });
    await emit({
      type: 'session/update',
      update: { kind: 'agent_message_chunk', text: 'Inspecting session handling' },
    });
    await emit({
      type: 'message/committed',
      message: { role: 'assistant', content: 'Inspecting session handling', phase: 'progress' },
    });
    const textarea = container.querySelector('textarea')!;
    await act(async () => textarea.focus());
    await type(textarea, 'Keep this draft');
    textarea.setSelectionRange(4, 4);
    fake.markdown.mockClear();
    dateRender.mockClear();
    await emit({
      type: 'session/update',
      update: {
        kind: 'tool_call',
        toolCallId: 'inspect',
        title: 'Read auth.ts',
        status: 'in_progress',
      },
    });
    const card = container.querySelector('[aria-label="Task progress"]')!;
    expect(card.closest('details')).toBeNull();
    expect(card.textContent).toContain('Inspecting session handling');
    expect(card.textContent).toContain('RunningRead auth.ts');
    expect(container.querySelector('.turn-activity')?.hasAttribute('open')).toBe(false);
    await emit({
      type: 'session/update',
      update: {
        kind: 'tool_call',
        toolCallId: 'inspect',
        title: 'Read auth.ts',
        status: 'completed',
        content: 'Detailed output',
      },
    });
    expect(card.textContent).toContain('CompletedRead auth.ts');
    expect(card.textContent).not.toContain('Detailed output');
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe('Keep this draft');
    expect(textarea.selectionStart).toBe(4);
    expect(fake.markdown).not.toHaveBeenCalled();
    expect(dateRender).not.toHaveBeenCalled();
    await emit({
      type: 'message/committed',
      message: { role: 'assistant', content: 'Sign-in fixed', phase: 'final' },
    });
    await emit({ type: 'session/turn_status', status: 'completed' });
    expect(card.textContent).toBe('Completed1 tool call');
    expect(container.querySelector('.md')?.textContent).toBe('Sign-in fixed');
    expect(container.querySelector('.turn-progress')?.textContent).toContain(
      'Inspecting session handling',
    );
  });

  it('bounds parallel tool activity and keeps failures visible while work continues', async () => {
    await click(container.querySelector('.history-item'));
    for (let index = 0; index < 6; index++) {
      await emit({
        type: 'session/update',
        update: {
          kind: 'tool_call',
          toolCallId: `tool-${index}`,
          title: `Explore module ${index}`,
          status: index === 0 ? 'pending' : 'in_progress',
        },
      });
    }
    const card = container.querySelector('[aria-label="Task progress"]')!;
    expect(card.querySelectorAll(':scope > .task-progress-tools > li')).toHaveLength(4);
    expect(card.textContent).toContain('QueuedExplore module 0');
    const more = card.querySelector('details')!;
    expect(more.hasAttribute('open')).toBe(false);
    expect(more.querySelector('summary')?.textContent).toBe('Show 2 more active tool calls');
    expect(more.querySelectorAll('li')).toHaveLength(2);
    await click(more.querySelector('summary'));
    expect(more.hasAttribute('open')).toBe(true);
    await emit({
      type: 'session/update',
      update: {
        kind: 'tool_call',
        toolCallId: 'tool-0',
        title: 'Explore module 0',
        status: 'failed',
      },
    });
    expect(card.textContent).toContain(
      '0 of 6 tool calls succeeded · 1 failed — Agent is continuing',
    );
    expect(card.querySelector('details')).toBe(more);
    expect(more.hasAttribute('open')).toBe(true);
    await emit({ type: 'session/turn_status', status: 'aborted' });
    expect(card.textContent).toBe('Task stopped6 tool calls');
    expect(card.querySelector('.task-progress-tools')).toBeNull();
  });

  it('replays a single response with collapsed activity and Trinity-style source evidence', async () => {
    await click(container.querySelector('.history-item'));
    await emit({ type: 'message/committed', message: { role: 'user', content: 'Research' } });
    await emit({
      type: 'message/committed',
      message: { role: 'assistant', content: 'Reading primary sources', phase: 'progress' },
    });
    await emit({
      type: 'session/update',
      update: { kind: 'tool_call', toolCallId: 'read', title: 'browser', status: 'completed' },
    });
    const citations = [
      {
        kind: 'web_source' as const,
        label: 'Primary announcement',
        url: 'https://example.com/announcement',
        detail: 'Observed public passage.',
        callId: 'read',
        evidenceSeq: 5,
      },
    ];
    await emit({
      type: 'message/committed',
      message: {
        role: 'assistant',
        content: 'A supported answer',
        phase: 'final',
        citationList: citations,
      },
    });
    await emit({ type: 'session/turn_status', status: 'completed' });
    expect(container.querySelectorAll('.assistant-response')).toHaveLength(1);
    expect(container.querySelector('.md')?.textContent).toBe('A supported answer');
    expect(container.querySelector('.turn-activity')?.hasAttribute('open')).toBe(false);
    expect(container.querySelector('.answer-sources')?.textContent).toContain(
      'Sources · 1 citation · 1 source',
    );
    const textarea = container.querySelector('textarea')!;
    await act(async () => textarea.focus());
    await type(textarea, 'Next draft');
    fake.markdown.mockClear();
    await click(
      [...container.querySelectorAll('button')].find(
        (button) => button.textContent === 'View evidence',
      ) ?? null,
    );
    const link = document.body.querySelector<HTMLAnchorElement>('.answer-evidence a');
    expect(link?.href).toBe('https://example.com/announcement');
    expect(document.body.querySelector('.answer-evidence')?.textContent).toContain(
      'Observed public passage.',
    );
    expect(fake.markdown).not.toHaveBeenCalled();
    expect(textarea.value).toBe('Next draft');
  });
  it('clears stale approval and streaming state when an errored turn ends', async () => {
    await click(container.querySelector('.history-item'));
    await emit({
      type: 'session/update',
      update: { kind: 'agent_message_chunk', text: 'working' },
    });
    await emit({
      type: 'session/update',
      update: {
        kind: 'permission_request',
        approvalId: 'approval',
        toolName: 'bash',
        title: 'browser',
        argsPreview: 'browser',
        status: 'pending',
      },
    });
    expect(document.body.querySelector('.ant-modal')).not.toBeNull();
    expect(container.querySelector('.task-progress [role="status"]')?.textContent).toBe(
      'Waiting for your approval',
    );
    await emit({ type: 'error', message: 'turn failed' });
    const modal = document.body.querySelector<HTMLElement>('.ant-modal');
    expect(
      modal === null ||
        modal.classList.contains('ant-zoom-leave') ||
        modal.closest<HTMLElement>('.ant-modal-wrap')?.style.display === 'none',
    ).toBe(true);
    expect(container.querySelector('.response-streaming')).toBeNull();
    expect(container.querySelector('.task-progress')?.textContent).toContain(
      'The task could not finish',
    );
    expect(container.querySelector('.task-progress')?.textContent).not.toContain('Waiting');
  });

  it('offers Stop during approval and waits for the active worker terminal event', async () => {
    await click(container.querySelector('.history-item'));
    await emit({
      type: 'session/update',
      update: { kind: 'agent_message_chunk', text: 'working' },
    });
    await emit({
      type: 'session/update',
      update: {
        kind: 'permission_request',
        approvalId: 'approval',
        toolName: 'bash',
        title: 'browser',
        argsPreview: 'browser',
        status: 'pending',
      },
    });
    await click(
      [...document.body.querySelectorAll('button')].find(
        (button) => button.textContent === 'Stop task',
      ) ?? null,
    );
    expect(fake.cancelTurn).toHaveBeenCalledWith('s0');
    expect(container.querySelector('.response-streaming')).not.toBeNull();
    await emit({ type: 'session/turn_status', status: 'aborted' });
    expect(container.querySelector('.response-streaming')).toBeNull();
  });

  it('clears an already-stopped turn when clicking the composer Stop button', async () => {
    await click(container.querySelector('.history-item'));
    await emit({
      type: 'session/update',
      update: { kind: 'agent_message_chunk', text: 'stale working' },
    });
    fake.cancelTurn.mockResolvedValueOnce({ ok: true, alreadyStopped: true });
    await click(container.querySelector('.ant-sender-actions-btn'));
    expect(fake.cancelTurn).toHaveBeenCalledWith('s0');
    expect(container.querySelector('.response-streaming')).toBeNull();
    expect(container.querySelector('.md')).toBeNull();
    expect(container.querySelector('.turn-progress')?.textContent).toContain('stale working');
  });

  it('displays chunks before commit after replay and between assistant steps', async () => {
    await click(container.querySelector('.history-item'));
    await emit({ type: 'message/committed', message: { role: 'user', content: 'Question' } });
    await emit({
      type: 'session/update',
      update: { kind: 'agent_message_chunk', text: 'First step' },
    });
    expect(container.querySelector('.md')?.textContent).toContain('First step');
    expect(container.querySelector('.response-streaming')).not.toBeNull();
    await emit({
      type: 'message/committed',
      message: { role: 'assistant', content: 'First step' },
    });
    fake.markdown.mockClear();
    await emit({
      type: 'session/update',
      update: { kind: 'agent_message_chunk', text: 'Next step' },
    });
    expect(Array.from(container.querySelectorAll('.md'), (node) => node.textContent)).toEqual([
      'Next step▋',
    ]);
    expect(fake.markdown.mock.calls.map(([content]) => content)).toEqual(['Next step']);
    await emit({
      type: 'message/committed',
      message: { role: 'assistant', content: 'Next step done' },
    });
    await emit({ type: 'session/turn_status', status: 'completed' });
    expect(container.querySelectorAll('.assistant-response')).toHaveLength(1);
    expect(container.querySelector('.turn-progress')?.textContent).toContain('First step');
    expect(container.querySelector('.turn-activity')?.hasAttribute('open')).toBe(false);
    expect(container.querySelector('.response-streaming')).toBeNull();
  });
  it('exposes session settings and keyboard accessible history actions', async () => {
    const title = container.querySelector<HTMLButtonElement>('.history-title')!;
    expect(title.tagName).toBe('BUTTON');
    expect(title.textContent).toBe('Conversation 0');
    expect(container.querySelector('[aria-label="Actions for Conversation 0"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Session settings"]')).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Account menu for user@example.com"]'),
    ).not.toBeNull();
    await act(async () => title.focus());
    expect(document.activeElement).toBe(title);
    await click(title);
    expect(title.getAttribute('aria-current')).toBe('true');
    expect(container.querySelectorAll('.history-title[aria-current="true"]')).toHaveLength(1);
    expect(fake.onEvent).toBeTypeOf('function');
    await click(container.querySelector('[aria-label="Session settings"]'));
    expect(document.body.textContent).toContain('Chat gets its own workspace automatically.');
    expect(
      document.body.querySelector('[aria-label="Tool permissions for the next session"]'),
    ).toBeNull();
  });

  it('starts with history collapsed on phones and lets the user restore it', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addListener: () => undefined,
      removeListener: () => undefined,
    }));
    await act(async () =>
      root.render(createElement(AntdApp, null, createElement(App, { key: 'phone' }))),
    );
    expect(container.querySelector('#conversation-history')?.hasAttribute('hidden')).toBe(true);
    expect(container.querySelector('textarea')).not.toBeNull();
    await click(container.querySelector('.history-toggle'));
    expect(container.querySelector('#conversation-history')?.hasAttribute('hidden')).toBe(false);
    expect(container.querySelectorAll('.history-title')).toHaveLength(12);
  });

  it('shows task guidance and composing shortcuts without submitting a prompt', () => {
    expect(container.querySelector('.empty-chat-description')?.textContent).toContain(
      'explore an idea',
    );
    expect(container.querySelector('.composer-hint')?.textContent).toContain('Shift + Enter');
    expect(fake.sendPrompt).not.toHaveBeenCalled();
  });

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

  it('copies a response and toggles feedback without rerendering its Markdown', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await click(container.querySelector('.history-item'));
    const content = '## Summary\n\n```ts\nconst value = 42;\n```';
    await emit({ type: 'message/committed', message: { role: 'assistant', content } });
    expect(container.querySelector('article[aria-label="Trinity response"]')).not.toBeNull();
    fake.markdown.mockClear();

    await click(container.querySelector('[aria-label="Copy response"]'));
    expect(writeText).toHaveBeenCalledWith(content);
    expect(container.querySelector('.response-action-status')?.textContent).toBe('Copied');

    const like = container.querySelector('[aria-label="Like response"]');
    const dislike = container.querySelector('[aria-label="Dislike response"]');
    await click(like);
    expect(like?.getAttribute('aria-pressed')).toBe('true');
    expect(dislike?.getAttribute('aria-pressed')).toBe('false');
    await click(dislike);
    expect(like?.getAttribute('aria-pressed')).toBe('false');
    expect(dislike?.getAttribute('aria-pressed')).toBe('true');
    await click(dislike);
    expect(dislike?.getAttribute('aria-pressed')).toBe('false');
    expect(fake.markdown).not.toHaveBeenCalled();

    await click(like);
    await emit({
      type: 'message/committed',
      message: { role: 'user', content: 'Another question' },
    });
    await emit({
      type: 'message/committed',
      message: { role: 'assistant', content: 'Another response' },
    });
    const likes = container.querySelectorAll('[aria-label="Like response"]');
    expect(likes[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(likes[1]?.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows clipboard failures and allows a successful retry', async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error('Clipboard permission denied'))
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await click(container.querySelector('.history-item'));
    await emit({ type: 'message/committed', message: { role: 'assistant', content: 'An answer' } });
    await click(container.querySelector('[aria-label="Copy response"]'));
    expect(container.querySelector('.response-action-status')?.textContent).toContain(
      'Could not copy',
    );
    await click(container.querySelector('[aria-label="Copy response"]'));
    expect(container.querySelector('.response-action-status')?.textContent).toBe('Copied');
  });

  it('offers manual copying when the clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await click(container.querySelector('.history-item'));
    await emit({ type: 'message/committed', message: { role: 'assistant', content: 'An answer' } });
    await click(container.querySelector('[aria-label="Copy response"]'));
    expect(container.querySelector('.response-action-status')?.textContent).toContain(
      'copy manually',
    );
  });

  it('only shows response actions after streaming finishes', async () => {
    const textarea = container.querySelector('textarea')!;
    await type(textarea, 'First prompt');
    await click(container.querySelector('.ant-sender-actions-btn'));
    await emit({
      type: 'session/update',
      update: { kind: 'agent_message_chunk', text: 'In progress' },
    });
    expect(container.querySelector('.response-streaming')?.textContent).toBe('Working');
    expect(container.querySelector('.response-actions')).toBeNull();
    await emit({ type: 'session/turn_status', status: 'completed' });
    expect(container.querySelector('.response-streaming')).toBeNull();
    expect(container.querySelectorAll('.response-actions')).toHaveLength(1);
    await click(container.querySelector('.new-chat-button'));
    expect(container.querySelector('.response-actions')).toBeNull();
  });

  it('renders saved timestamps on both user and assistant messages during replay', async () => {
    await click(container.querySelector('.history-item'));
    const userAt = '2026-10-07T06:00:00.000Z';
    const assistantAt = '2026-10-07T06:01:00.000Z';
    await emit({
      type: 'message/committed',
      message: { role: 'user', content: 'Yesterday', at: userAt },
    });
    await emit({
      type: 'message/committed',
      message: { role: 'assistant', content: 'Saved reply', at: assistantAt },
    });
    expect(container.querySelector('.user-message-heading time')?.getAttribute('datetime')).toBe(
      userAt,
    );
    expect(container.querySelector('.response-heading time')?.getAttribute('datetime')).toBe(
      assistantAt,
    );
    expect(container.querySelector('.response-heading time')?.getAttribute('title')).toBe('Oct 8');
  });

  it('reconciles optimistic timestamps without clearing a draft or duplicating messages', async () => {
    const textarea = container.querySelector('textarea')!;
    await type(textarea, 'First prompt');
    await click(container.querySelector('.ant-sender-actions-btn'));
    expect(container.querySelectorAll('time.message-timestamp')).toHaveLength(2);
    await type(textarea, 'Next draft');
    const at = '2026-10-08T06:00:02.000Z';
    await emit({
      type: 'message/committed',
      message: { role: 'user', content: 'First prompt', at },
    });
    await emit({ type: 'message/committed', message: { role: 'assistant', content: 'Reply', at } });
    expect(container.querySelectorAll('time.message-timestamp')).toHaveLength(2);
    expect(
      [...container.querySelectorAll('time.message-timestamp')].map((node) =>
        node.getAttribute('datetime'),
      ),
    ).toEqual([at, at]);
    expect(textarea.value).toBe('Next draft');
  });

  it('preserves separate drafts when starting and selecting conversations', async () => {
    await click(
      Array.from(container.querySelectorAll('.sidebar-navigation button')).find(
        (button) => button.textContent === 'Main chat',
      ) ?? null,
    );
    const textarea = container.querySelector('textarea')!;
    await type(textarea, 'Draft');
    await click(container.querySelector('.new-chat-button'));
    expect(textarea.value).toBe('');
    await type(textarea, 'Another draft');
    await click(container.querySelector('.history-item'));
    expect(textarea.value).toBe('');
    await click(
      Array.from(container.querySelectorAll('.sidebar-navigation button')).find(
        (button) => button.textContent === 'Main chat',
      ) ?? null,
    );
    expect(textarea.value).toBe('Draft');
    await click(container.querySelector('.new-chat-button'));
    expect(textarea.value).toBe('Another draft');
  });

  it('connects the sender cancel action to the active turn', async () => {
    const textarea = container.querySelector('textarea')!;
    await type(textarea, 'Run a task');
    await click(container.querySelector('.ant-sender-actions-btn'));
    await click(container.querySelector('.ant-sender-actions-btn'));
    expect(fake.cancelTurn).toHaveBeenCalledWith('new-session');
  });
});

it('offers a conversation command prefix and sends it with approval', async () => {
  await click(container.querySelector('.history-item'));
  await emit({
    type: 'session/update',
    update: {
      kind: 'permission_request',
      approvalId: 'a',
      toolName: 'bash',
      toolCallId: 'c',
      title: 'custom-cli inspect',
      argsPreview: JSON.stringify({ command: 'custom-cli inspect' }),
      status: 'pending',
    },
  });
  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Command prefix"]');
  expect(input?.value).toBe('custom-cli');
  await click(
    [...document.body.querySelectorAll('button')].find(
      (node) => node.textContent === 'Allow pattern for conversation',
    ) ?? null,
  );
  expect(fake.respondApproval).toHaveBeenCalledWith('s0', 'a', 'allowed', ['custom-cli']);
});

it('shows turn and session costs during usage updates while preserving focus, draft and history', async () => {
  await click(container.querySelector('.history-item'));
  await emit({
    type: 'message/committed',
    sessionId: 's0',
    message: { id: '00000000-0000-4000-8000-000000000001', role: 'user', content: 'old' },
  });
  await emit({
    type: 'message/committed',
    sessionId: 's0',
    message: { role: 'assistant', phase: 'final', content: 'old answer' },
  });
  await emit({
    type: 'message/committed',
    sessionId: 's0',
    message: { id: '00000000-0000-4000-8000-000000000002', role: 'user', content: 'new' },
  });
  const textarea = container.querySelector('textarea')!;
  await act(async () => textarea.focus());
  await type(textarea, 'Keep draft');
  fake.markdown.mockClear();
  const usage = {
    requestId: '00000000-0000-4000-8000-000000000003',
    promptId: '00000000-0000-4000-8000-000000000002',
    model: 'fake/a',
    purpose: 'assistant' as const,
    tokens: {
      inputTokens: 100,
      uncachedInputTokens: 40,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      outputTokens: 20,
      reasoningTokens: 5,
    },
    cost: { currency: 'USD', amount: '0.00031500000000' },
  };
  await emit({ type: 'model/usage', sessionId: 's0', usage });
  await emit({ type: 'model/usage', sessionId: 's0', usage });
  expect(container.querySelector('[aria-label="Session usage"]')?.textContent).toContain(
    '120 tokens',
  );
  expect(container.querySelector('[aria-label="Session usage"]')?.textContent).toContain(
    'USD 0.000315',
  );
  expect(container.querySelectorAll('[aria-label="Turn usage"]')[1]?.textContent).toContain(
    '120 tokens',
  );
  expect(container.querySelector('textarea')).toBe(textarea);
  expect(document.activeElement).toBe(textarea);
  expect(textarea.value).toBe('Keep draft');
  expect(fake.markdown).not.toHaveBeenCalledWith('old answer');
  await click(container.querySelectorAll('[aria-label="Turn usage"]')[1]!);
  expect(document.body.textContent).toContain('Uncached input');
  expect(document.body.textContent).toContain('Cache write');
  expect(document.body.textContent).toContain('Of which reasoning');
});

it('opens history in the main view with the original prompt and independent drafts', async () => {
  const mainButton =
    Array.from(container.querySelectorAll('.sidebar-navigation button')).find(
      (button) => button.textContent === 'Main chat',
    ) ?? null;
  await click(mainButton);
  const input = container.querySelector('textarea')!;
  await type(input, 'Main draft');
  fake.getTimeline
    .mockResolvedValueOnce({
      events: [
        {
          type: 'message/committed',
          sessionId: 's0',
          message: { role: 'assistant', phase: 'final', content: 'Saved answer' },
        },
      ],
      lastSeq: 500,
      nextBefore: 301,
    })
    .mockResolvedValueOnce({
      events: [
        {
          type: 'message/committed',
          sessionId: 's0',
          message: { role: 'user', content: 'Original input\nwith another line' },
        },
      ],
      lastSeq: 500,
      nextBefore: 101,
    });
  await click(container.querySelector('.history-title'));
  expect(container.querySelector('.side-conversation')).toBeNull();
  expect(container.querySelector('.workspace-heading')?.textContent).toContain('Work');
  expect(container.querySelector('.user-message-heading')?.parentElement?.textContent).toContain(
    'Original input\nwith another line',
  );
  expect(container.querySelector('.ant-typography-copy')).not.toBeNull();
  expect(container.querySelector('.md')?.textContent).toBe('Saved answer');
  expect(fake.getTimeline).toHaveBeenCalledWith('s0', 301);
  expect(container.querySelector('textarea')).toBe(input);
  expect(input.value).toBe('');
  await type(input, 'History draft');
  await click(mainButton);
  expect(input.value).toBe('Main draft');
  await click(container.querySelector('.history-title'));
  expect(input.value).toBe('History draft');
  const olderButton =
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Load older messages',
    ) ?? null;
  fake.getTimeline.mockResolvedValueOnce({
    events: [
      {
        type: 'message/committed',
        sessionId: 's0',
        message: { role: 'user', content: 'Earlier input' },
      },
      {
        type: 'message/committed',
        sessionId: 's0',
        message: { role: 'assistant', phase: 'final', content: 'Earlier answer' },
      },
    ],
    lastSeq: 500,
    nextBefore: null,
  });
  await click(olderButton);
  expect(fake.getTimeline).toHaveBeenCalledWith('s0', 101);
  expect(
    Array.from(
      container.querySelectorAll('.user-message-heading'),
      (node) => node.parentElement?.textContent,
    ),
  ).toEqual([expect.stringContaining('Earlier input'), expect.stringContaining('Original input')]);
  expect(input.value).toBe('History draft');
  expect(container.querySelector('textarea')).toBe(input);
});
