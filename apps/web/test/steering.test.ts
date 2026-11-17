// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { applyTimelineEvent, type ChatItem } from '../src/chat-items';

vi.mock('@ant-design/x', () => ({
  Sender: (props: { value: string; onSubmit(text: string): void }) =>
    createElement('textarea', {
      value: props.value,
      readOnly: true,
      onKeyDown: () => props.onSubmit(props.value),
    }),
}));
vi.mock('antd', () => ({
  App: { useApp: () => ({ message: { error: vi.fn() } }) },
  Flex: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
  Button: 'button',
  Select: (props: {
    value: string;
    onChange(value: string): void;
    options: { value: string; label: string }[];
  }) =>
    createElement(
      'select',
      {
        value: props.value,
        onChange: (event: { target: { value: string } }) => props.onChange(event.target.value),
      },
      props.options.map((option) =>
        createElement('option', { key: option.value, value: option.value }, option.label),
      ),
    ),
}));
import { ChatComposer } from '../src/chat-composer';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('keeps a rejected steering draft and its retry ID, preserves focus, and distinguishes queue mode', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const submit = vi.fn(async () => false);
  const drafts = new Map([['task', 'Use C instead']]);
  try {
    await act(async () =>
      root.render(
        createElement(ChatComposer, {
          busy: true,
          canSteer: true,
          canQueue: true,
          draftKey: 'task',
          draftStore: drafts,
          resetVersion: 0,
          onSubmit: submit,
          onCancel() {},
        }),
      ),
    );
    const textarea = container.querySelector('textarea')!;
    textarea.focus();
    await act(async () =>
      textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
    );
    await act(async () =>
      textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
    );
    expect(submit.mock.calls[0]?.slice(0, 2)).toEqual(['Use C instead', 'steer']);
    expect(submit.mock.calls[0]?.[2]).toBe(submit.mock.calls[1]?.[2]);
    expect(textarea.value).toBe('Use C instead');
    expect(document.activeElement).toBe(textarea);
    await act(async () => {
      const select = container.querySelector('select')!;
      select.value = 'queue';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await act(async () =>
      textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' })),
    );
    expect(submit.mock.calls.at(-1)?.[1]).toBe('queue');
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

it('attaches supplement states to the original request without creating a second answer or changing stable history', () => {
  const promptId = crypto.randomUUID();
  const inputId = crypto.randomUUID();
  const first: ChatItem = {
    key: 'old',
    role: 'user',
    content: 'earlier',
    streaming: false,
    tools: [],
    attachments: [],
  };
  const current: ChatItem = { ...first, key: 'current', messageId: promptId };
  const assistant: ChatItem = { ...first, key: 'answer', role: 'assistant', streaming: true };
  const waiting = applyTimelineEvent([first, current, assistant], {
    type: 'session/steering',
    sessionId: 's',
    promptId,
    inputId,
    state: 'waiting',
    text: 'Use C',
  });
  expect(waiting).toHaveLength(3);
  expect(waiting[0]).toBe(first);
  expect(waiting[2]).toBe(assistant);
  const applied = applyTimelineEvent(waiting, {
    type: 'session/steering',
    sessionId: 's',
    promptId,
    inputIds: [inputId],
    state: 'applied',
  });
  expect(applied[1]?.supplements?.[0]?.state).toBe('applied');
  const ended = applyTimelineEvent(waiting, {
    type: 'session/turn_status',
    sessionId: 's',
    status: 'aborted',
  });
  expect(ended[1]?.supplements?.[0]?.state).toBe('ended');
});
