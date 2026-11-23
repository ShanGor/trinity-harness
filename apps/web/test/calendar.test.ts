// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  calendarDefinitionSchema,
  defaultCalendarPreferences,
  type CalendarRecord,
  type CalendarSnapshot,
} from '@trinity-harness/shared';
import { PersonalCalendar, CalendarReminderList } from '../src/personal-calendar';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {} }));
  const style = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => style(element));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture() {
  const today = new Date().toISOString().slice(0, 10);
  const item: CalendarRecord = {
    id: '00000000-0000-4000-8000-000000000001',
    revision: 1,
    status: 'active',
    source: {
      sessionId: '00000000-0000-4000-8000-000000000002',
      eventId: '00000000-0000-4000-8000-000000000003',
      quote: 'My appointment is at 11 pm.',
      capture: 'automatic',
    },
    scheduleId: null,
    nextAt: `${today}T23:00:00.000Z`,
    createdAt: `${today}T00:00:00.000Z`,
    updatedAt: `${today}T00:00:00.000Z`,
    definition: calendarDefinitionSchema.parse({
      title: 'Appointment',
      kind: 'event',
      timing: {
        date: {
          calendar: 'gregorian',
          year: Number(today.slice(0, 4)),
          month: Number(today.slice(5, 7)),
          day: Number(today.slice(8, 10)),
        },
        timezone: 'UTC',
        hour: 23,
        minute: 0,
        recurrence: 'daily',
        durationMinutes: 30,
      },
    }),
  };
  const snapshot: CalendarSnapshot = {
    available: true,
    items: [
      item,
      {
        ...item,
        id: '00000000-0000-4000-8000-000000000004',
        status: 'suggested',
        definition: { ...item.definition, title: 'Possible follow-up' },
      },
    ],
    reminders: [],
    preferences: { ...defaultCalendarPreferences },
    pushAvailable: false,
    pushPublicKey: null,
  };
  const client = {
    getCalendar: vi.fn(async () => snapshot),
    saveCalendar: vi.fn(async () => item),
    saveCalendarPreferences: vi.fn(async () => ({ ...defaultCalendarPreferences, revision: 1 })),
    calendarReminderAction: vi.fn(async () => undefined),
    subscribeCalendarPush: vi.fn(async () => undefined),
  };
  return { item, snapshot, client };
}
function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}

it('shows agenda/month lunar labels, source links and reviewable suggestions', async () => {
  const f = fixture();
  const open = vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(PersonalCalendar, {
          client: f.client,
          sessions: [],
          onOpen: open,
          onOpenScheduled: vi.fn(),
        }),
      ),
    );
    expect(container.textContent).toContain('Automatic capture off');
    expect(container.textContent).toContain('Closed-app push unavailable');
    expect(container.textContent).toContain('Appointment');
    await act(async () =>
      [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find((t) => t.textContent === 'Month')!
        .click(),
    );
    expect(container.querySelector('[role="table"]')?.textContent).toMatch(/月\d+日/);
    await act(async () =>
      [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
        .find((t) => t.textContent === 'All items and suggestions')!
        .click(),
    );
    await act(async () => button('Source conversation · automatic').click());
    expect(open).toHaveBeenCalledWith(f.item.source!.sessionId);
    expect(container.textContent).toContain('Possible follow-up');
    await act(async () => button('Accept').click());
    expect(f.client.saveCalendar).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', expectedRevision: 1 }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('preserves editing drafts and operation identity after a failed save', async () => {
  const f = fixture();
  f.client.saveCalendar.mockRejectedValueOnce(new Error('uncertain save'));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(PersonalCalendar, {
          client: f.client,
          sessions: [],
          onOpen: vi.fn(),
          onOpenScheduled: vi.fn(),
        }),
      ),
    );
    await act(async () => button('Open item').click());
    const title = document.querySelector<HTMLInputElement>('[aria-label="Calendar title"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        title,
        'Changed appointment',
      );
      title.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('Save calendar item').click());
    expect(title.value).toBe('Changed appointment');
    expect(container.textContent).toContain('Your draft is preserved');
    const first = f.client.saveCalendar.mock.calls[0];
    await act(async () => button('Save calendar item').click());
    expect(f.client.saveCalendar.mock.calls[1]).toEqual(first);
    expect(container.textContent).not.toContain('Your draft is preserved');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('creates a draft and saves capture preferences only on explicit Save', async () => {
  const f = fixture();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(PersonalCalendar, {
          client: f.client,
          sessions: [],
          onOpen: vi.fn(),
          onOpenScheduled: vi.fn(),
        }),
      ),
    );
    await act(async () => button('Add calendar item').click());
    expect(document.querySelector('[aria-label="Calendar title"]')).not.toBeNull();
    expect(f.client.saveCalendar).not.toHaveBeenCalled();
    await act(async () => button('Cancel').click());
    await act(async () => button('Preferences').click());
    const checkbox = [...document.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('Automatically capture definite commitments'))!
      .querySelector<HTMLInputElement>('input')!;
    await act(async () => checkbox.click());
    expect(f.client.saveCalendarPreferences).not.toHaveBeenCalled();
    await act(async () => button('Save preferences').click());
    expect(f.client.saveCalendarPreferences).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 0, automaticCapture: true }),
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it('dismisses reminders without completing the obligation', async () => {
  const f = fixture();
  const refresh = vi.fn(async () => undefined);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        createElement(CalendarReminderList, {
          client: f.client,
          onRefresh: refresh,
          reminders: [
            {
              id: f.item.id,
              itemId: f.item.id,
              revision: 1,
              title: 'Appointment',
              eventAt: f.item.nextAt!,
              dueAt: f.item.nextAt!,
              status: 'delivered',
              deliveredAt: f.item.nextAt!,
              readAt: null,
              pushStatus: 'unavailable',
            },
          ],
        }),
      ),
    );
    await act(async () => button('Dismiss').click());
    expect(f.client.calendarReminderAction).toHaveBeenCalledWith(f.item.id, { action: 'dismiss' });
    expect(f.client.saveCalendar).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
