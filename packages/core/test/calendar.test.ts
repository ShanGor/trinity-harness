import { describe, expect, it } from 'vitest';
import {
  calendarTimingSchema,
  calendarDateSchema,
  calendarDateToGregorian,
  chineseDate,
  nextCalendarInstant,
  calendarLocalInstant,
  nextScheduleInstant,
  calendarOccurrences,
  calendarOccurrenceDate,
  calendarDefinitionSchema,
  type CalendarRecord,
} from '@trinity-harness/contracts';
import { calendarPushEndpointAllowed, createCalendarPush } from '../src/index.js';

function timing(input: Record<string, unknown> = {}) {
  return calendarTimingSchema.parse({
    date: { calendar: 'gregorian', year: 2026, month: 11, day: 23 },
    timezone: 'Asia/Hong_Kong',
    hour: 9,
    minute: 0,
    recurrence: 'once',
    ...input,
  });
}
describe('Chinese lunar calendar and recurrence', () => {
  // HKO 2026 conversion table: Lunar New Year 17 Feb; Mid-Autumn 25 Sep.
  it.each([
    ['2026-02-17', 1, 1],
    ['2026-09-25', 8, 15],
  ] as const)('round trips HKO date %s', (gregorian, month, day) => {
    const date = chineseDate(gregorian);
    expect(date).toEqual({ calendar: 'chinese', year: 2026, month, day, leapMonth: false });
    expect(calendarDateToGregorian(date)).toBe(gregorian);
  });
  it('keeps the regular and leap sixth months distinct', () => {
    expect(chineseDate('2025-07-25')).toMatchObject({
      year: 2025,
      month: 6,
      day: 1,
      leapMonth: true,
    });
    expect(
      calendarDateToGregorian({
        calendar: 'chinese',
        year: 2025,
        month: 6,
        day: 1,
        leapMonth: true,
      }),
    ).toBe('2025-07-25');
    expect(
      calendarDateToGregorian({
        calendar: 'chinese',
        year: 2026,
        month: 6,
        day: 1,
        leapMonth: true,
      }),
    ).toBeNull();
  });
  it('recurs by lunar month/day across Gregorian years and does not reuse the converted anniversary', () => {
    const t = timing({
      date: { calendar: 'chinese', year: 2026, month: 1, day: 1 },
      recurrence: 'yearly',
    });
    expect(nextCalendarInstant(t, new Date('2026-02-16T00:00:00Z'))?.toISOString()).toBe(
      '2026-02-17T01:00:00.000Z',
    );
    expect(nextCalendarInstant(t, new Date('2026-02-17T01:00:00Z'))?.toISOString()).toBe(
      '2027-02-06T01:00:00.000Z',
    );
  });
  it('supports explicit leap-only, regular fallback and both policies', () => {
    const t = timing({
      date: { calendar: 'chinese', year: 2025, month: 6, day: 1, leapMonth: true },
      recurrence: 'yearly',
    });
    const strict = nextCalendarInstant(t, new Date('2025-08-01T00:00:00Z'))!;
    expect(chineseDate(strict.toISOString().slice(0, 10))).toMatchObject({
      month: 6,
      day: 1,
      leapMonth: true,
    });
    const fallback = nextCalendarInstant(
      { ...t, leapMonthPolicy: 'regular_if_absent' },
      new Date('2025-08-01T00:00:00Z'),
    )!;
    expect(chineseDate(fallback.toISOString().slice(0, 10))).toMatchObject({
      year: 2026,
      month: 6,
      day: 1,
      leapMonth: false,
    });
    const regular = timing({
      date: { calendar: 'chinese', year: 2025, month: 6, day: 1 },
      recurrence: 'yearly',
      leapMonthPolicy: 'both',
    });
    expect(nextCalendarInstant(regular, new Date('2025-07-01T00:00:00Z'))?.toISOString()).toBe(
      '2025-07-25T01:00:00.000Z',
    );
  });
  it('rejects invalid dates and never rolls lunar day 30 into another month', () => {
    expect(
      calendarDateSchema.safeParse({ calendar: 'gregorian', year: 2026, month: 2, day: 29 })
        .success,
    ).toBe(false);
    expect(
      calendarDateSchema.safeParse({ calendar: 'chinese', year: 2026, month: 1, day: 31 }).success,
    ).toBe(false);
    expect(
      calendarDateSchema.safeParse({ calendar: 'chinese', year: 2101, month: 1, day: 1 }).success,
    ).toBe(false);
    expect(
      calendarDateToGregorian({
        calendar: 'chinese',
        year: 2026,
        month: 2,
        day: 30,
        leapMonth: false,
      }),
    ).toBeNull();
    const t = timing({
      date: { calendar: 'chinese', year: 2023, month: 12, day: 30 },
      recurrence: 'yearly',
    });
    const last = nextCalendarInstant(
      { ...t, missingDay: 'last_day' },
      new Date('2025-02-01T00:00:00Z'),
    )!;
    expect(chineseDate(last.toISOString().slice(0, 10))).toMatchObject({
      year: 2025,
      month: 12,
      day: 29,
    });
    const skipped = nextCalendarInstant(t, new Date('2025-02-01T00:00:00Z'))!;
    expect(chineseDate(skipped.toISOString().slice(0, 10))).toMatchObject({ month: 12, day: 30 });
    expect(skipped > last).toBe(true);
  });
  it('accepts annual rules whose day or leap month is absent in the starting lunar year', () => {
    const t = timing({
      date: { calendar: 'chinese', year: 2026, month: 12, day: 30 },
      recurrence: 'yearly',
      missingDay: 'last_day',
    });
    const result = nextCalendarInstant(t, new Date('2026-11-23T00:00:00Z'))!;
    expect(result.toISOString()).toBe('2027-02-05T01:00:00.000Z');
    expect(chineseDate(result.toISOString().slice(0, 10))).toMatchObject({
      year: 2026,
      month: 12,
      day: 29,
    });
    const leap = timing({
      date: { calendar: 'chinese', year: 2026, month: 6, day: 1, leapMonth: true },
      recurrence: 'yearly',
    });
    const next = nextCalendarInstant(leap, new Date('2026-01-01T00:00:00Z'))!;
    expect(chineseDate(next.toISOString().slice(0, 10))).toMatchObject({
      month: 6,
      day: 1,
      leapMonth: true,
    });
    expect(
      nextCalendarInstant({ ...leap, recurrence: 'once' }, new Date('2026-01-01T00:00:00Z')),
    ).toBeNull();
  });
});

describe('calendar civil-time scheduling', () => {
  it('uses local midnight and strict-after semantics', () => {
    const t = timing();
    expect(nextCalendarInstant(t, new Date('2026-11-22T23:59:59Z'))?.toISOString()).toBe(
      '2026-11-23T01:00:00.000Z',
    );
    expect(nextCalendarInstant(t, new Date('2026-11-23T01:00:00Z'))).toBeNull();
  });
  it('skips DST gaps and chooses only the first fold', () => {
    expect(calendarLocalInstant('2026-03-08', 2, 30, 'America/New_York')).toBeNull();
    expect(calendarLocalInstant('2026-11-01', 1, 30, 'America/New_York')?.toISOString()).toBe(
      '2026-11-01T05:30:00.000Z',
    );
    const t = timing({
      date: { calendar: 'gregorian', year: 2026, month: 10, day: 31 },
      timezone: 'America/New_York',
      hour: 1,
      minute: 30,
      recurrence: 'daily',
    });
    expect(nextCalendarInstant(t, new Date('2026-11-01T05:30:00Z'))?.toISOString()).toBe(
      '2026-11-02T06:30:00.000Z',
    );
  });
  it('handles month-end and calendar end dates explicitly', () => {
    const t = timing({
      date: { calendar: 'gregorian', year: 2026, month: 1, day: 31 },
      recurrence: 'monthly',
    });
    expect(nextCalendarInstant(t, new Date('2026-02-01T00:00:00Z'))?.toISOString()).toBe(
      '2026-03-31T01:00:00.000Z',
    );
    expect(
      nextCalendarInstant(
        { ...t, missingDay: 'last_day' },
        new Date('2026-02-01T00:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-02-28T01:00:00.000Z');
    expect(
      nextCalendarInstant({ ...t, until: '2026-02-28' }, new Date('2026-02-01T00:00:00Z')),
    ).toBeNull();
  });
  it('feeds lunar recurrence into the existing schedule engine', () => {
    const t = timing({
      date: { calendar: 'chinese', year: 2026, month: 8, day: 15 },
      recurrence: 'yearly',
    });
    expect(
      nextScheduleInstant(
        {
          title: 'Birthday',
          request: 'Prepare a private briefing',
          sourceSessionId: '00000000-0000-4000-8000-000000000001',
          timezone: t.timezone,
          timing: { kind: 'calendar', timing: t },
        },
        new Date('2026-09-01T00:00:00Z'),
      )?.toISOString(),
    ).toBe('2026-09-25T01:00:00.000Z');
    expect(calendarTimingSchema.safeParse({ ...t, recurrence: 'monthly' }).success).toBe(false);
  });
  it('bounds display recurrence and excludes cancelled/suggested items', () => {
    const definition = calendarDefinitionSchema.parse({
      title: 'Daily',
      kind: 'reminder',
      timing: timing({ recurrence: 'daily' }),
    });
    const item: CalendarRecord = {
      id: '00000000-0000-4000-8000-000000000001',
      definition,
      revision: 1,
      status: 'active',
      source: null,
      scheduleId: null,
      nextAt: null,
      createdAt: '2026-11-23T00:00:00Z',
      updatedAt: '2026-11-23T00:00:00Z',
    };
    expect(
      calendarOccurrences(
        [item],
        new Date('2026-11-23T00:00:00Z'),
        new Date('2026-12-23T00:00:00Z'),
        2,
      ),
    ).toMatchObject({ truncated: true, occurrences: [{ item }, { item }] });
    expect(
      calendarOccurrences(
        [
          { ...item, status: 'cancelled' },
          { ...item, status: 'suggested' },
        ],
        new Date('2026-11-23'),
        new Date('2026-12-01'),
      ).occurrences,
    ).toEqual([]);
  });
});

it('fails closed on incomplete push credentials and arbitrary provider targets', () => {
  expect(createCalendarPush({})).toBeUndefined();
  expect(() => createCalendarPush({ WEB_PUSH_PUBLIC_KEY: 'partial' })).toThrow();
  const origins = ['https://fcm.googleapis.com'];
  expect(calendarPushEndpointAllowed('https://fcm.googleapis.com/fcm/send/opaque', origins)).toBe(
    true,
  );
  for (const endpoint of [
    'http://fcm.googleapis.com/x',
    'https://fcm.googleapis.com.evil.test/x',
    'https://user@fcm.googleapis.com/x',
    'https://127.0.0.1/x',
    'https://fcm.googleapis.com:8443/x',
  ])
    expect(calendarPushEndpointAllowed(endpoint, origins)).toBe(false);
});

it('keeps all-day civil dates fixed when the calendar viewing timezone changes', () => {
  const definition = calendarDefinitionSchema.parse({
    title: 'Holiday',
    kind: 'event',
    timing: timing({
      date: { calendar: 'gregorian', year: 2026, month: 12, day: 25 },
      timezone: 'Pacific/Auckland',
      allDay: true,
    }),
  });
  const item: CalendarRecord = {
    id: '00000000-0000-4000-8000-000000000001',
    definition,
    revision: 1,
    status: 'active',
    source: null,
    scheduleId: null,
    nextAt: null,
    createdAt: '2026-11-23T00:00:00Z',
    updatedAt: '2026-11-23T00:00:00Z',
  };
  const occurrence = calendarOccurrences([item], new Date('2026-12-23'), new Date('2026-12-26'))
    .occurrences[0]!;
  expect(calendarOccurrenceDate(occurrence, 'America/Los_Angeles')).toBe('2026-12-25');
  expect(
    calendarOccurrenceDate(
      {
        ...occurrence,
        item: {
          ...item,
          definition: { ...definition, timing: { ...definition.timing, allDay: false } },
        },
      },
      'America/Los_Angeles',
    ),
  ).toBe('2026-12-24');
});
