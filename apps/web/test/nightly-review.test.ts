// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AcpClient } from '@trinity-harness/client-acp';
import { ScheduledTasks } from '../src/scheduled-tasks';

let root: Root;
let container: HTMLDivElement;
let client: AcpClient;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  client = new AcpClient();
  vi.spyOn(client, 'getSchedules').mockResolvedValue({ available: true, schedules: [] });
  vi.spyOn(client, 'getInbox').mockResolvedValue({ available: true, items: [] });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('prepares a reviewable nightly schedule without enabling it on preset selection', async () => {
  const create = vi.spyOn(client, 'createSchedule');
  await act(async () =>
    root.render(createElement(ScheduledTasks, { client, sessions: [], onOpen: vi.fn() })),
  );
  const preset = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Nightly memory review',
  )!;
  await act(async () => preset.click());
  expect(document.body.textContent).toContain('Enable nightly memory review');
  expect(document.body.textContent).toContain('No automatic Persona changes');
  expect((document.querySelector('input[id="title"]') as HTMLInputElement).value).toBe(
    'Nightly digest and memory review',
  );
  expect((document.querySelector('input[id="hour"]') as HTMLInputElement).value).toBe('3');
  expect(document.body.textContent).toContain('previous seven local days, oldest first');
  expect(create).not.toHaveBeenCalled();
});

it('loads account History timezone and reports a failed account save independently of history reads', async () => {
  const { AssistantHistory } = await import('../src/personal-assistant');
  vi.spyOn(client, 'getHistoryPreferences').mockResolvedValue({ timezone: 'Asia/Hong_Kong' });
  vi.spyOn(client, 'getHistory').mockResolvedValue({ episodes: [], nextBefore: null });
  const save = vi.spyOn(client, 'setHistoryPreferences').mockRejectedValue(new Error('offline'));
  await act(async () => root.render(createElement(AssistantHistory, { client, onOpen: vi.fn() })));
  const input = document.querySelector('input[aria-label="History timezone"]') as HTMLInputElement;
  expect(input.value).toBe('Asia/Hong_Kong');
  expect(client.getHistory).toHaveBeenLastCalledWith(
    expect.objectContaining({ timezone: 'Asia/Hong_Kong' }),
  );
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'Europe/London',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
  expect(save).toHaveBeenCalledWith({ timezone: 'Europe/London' });
  expect(document.body.textContent).toContain('account save failed');
});

it('shows catch-up expiry, retry timing and persisted attempt counts in Updates', async () => {
  vi.mocked(client.getInbox).mockResolvedValue({
    available: true,
    items: [
      {
        id: 'gap',
        scheduleId: 'schedule',
        title: 'Older review',
        status: 'skipped',
        reason: 'expired',
        sessionId: null,
        at: '2026-10-01T00:00:00Z',
        readAt: null,
        attempts: 0,
        retryAt: null,
      },
      {
        id: 'retry',
        scheduleId: 'schedule',
        title: 'Retry review',
        status: 'failed',
        reason: 'outcome',
        sessionId: 'run',
        at: '2026-10-24T00:00:00Z',
        readAt: null,
        attempts: 2,
        retryAt: '2026-10-24T00:10:00Z',
      },
    ],
  });
  await act(async () =>
    root.render(createElement(ScheduledTasks, { client, sessions: [], onOpen: vi.fn() })),
  );
  expect(document.body.textContent).toContain('Older catch-up dates expired (seven-day limit)');
  expect(document.body.textContent).toContain('Attempt 2');
  expect(document.body.textContent).toContain('Retry after');
});
