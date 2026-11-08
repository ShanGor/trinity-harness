// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { isLargePaste } from '@trinity-harness/shared';

vi.mock('@ant-design/x', () => ({
  Sender: (props: { value: string; onChange(value: string): void; onSubmit(text: string): void }) =>
    createElement(
      'div',
      null,
      createElement('textarea', {
        value: props.value,
        onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
      }),
      createElement('button', { onClick: () => props.onSubmit(props.value) }, 'Send'),
    ),
}));
vi.mock('antd', () => ({
  App: { useApp: () => ({ message: { error: vi.fn() } }) },
  Flex: ({ children }: { children: React.ReactNode }) => createElement('div', null, children),
  Button: 'button',
}));
import { ChatComposer } from '../src/chat-composer';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((clean) => clean()));

it('has explicit threshold behavior without normalizing paste text', () => {
  expect(isLargePaste('x'.repeat(31_996))).toBe(false);
  expect(isLargePaste('x'.repeat(31_997))).toBe(true);
  expect(isLargePaste('x'.repeat(32_000))).toBe(true);
});
it('stages only large clipboard text, preserves surrounding instruction and selection, and keeps failed drafts', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const staged = vi.fn(() => true);
  const submit = vi.fn(async () => false);
  const drafts = new Map([['one', 'Summarize SELECT please']]);
  await act(async () =>
    root.render(
      createElement(ChatComposer, {
        busy: false,
        draftKey: 'one',
        draftStore: drafts,
        resetVersion: 0,
        onSubmit: submit,
        onCancel: vi.fn(),
        onStagePaste: staged,
      }),
    ),
  );
  const input = container.querySelector('textarea')!;
  input.focus();
  input.setSelectionRange(10, 16);
  const paste = (text: string): Event => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
    act(() => {
      input.dispatchEvent(event);
    });
    return event;
  };
  expect(paste('small').defaultPrevented).toBe(false);
  const original = ' 你好\r\n'.repeat(8000);
  expect(paste(original).defaultPrevented).toBe(true);
  expect(staged).toHaveBeenCalledWith(original);
  expect(input.value).toBe('Summarize [pasted text attached] please');
  expect(document.activeElement).toBe(input);
  await act(async () => {
    container.querySelector('button')!.click();
  });
  expect(input.value).toBe('Summarize [pasted text attached] please');
  expect(drafts.get('one')).toBe(input.value);
});
