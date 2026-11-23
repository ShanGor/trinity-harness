import { Solar, LunarYear } from 'lunar-typescript';
import { z } from 'zod';

export const calendarTimezoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown IANA timezone');

export const calendarDateSchema = z
  .object({
    calendar: z.enum(['gregorian', 'chinese']),
    year: z.number().int().min(1901).max(2100),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(31),
    leapMonth: z.boolean().default(false),
  })
  .strict()
  .refine(
    (d) =>
      d.calendar === 'chinese'
        ? d.day <= 30
        : !d.leapMonth &&
          new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCMonth() === d.month - 1,
    'Invalid calendar date',
  );
export type CalendarDate = z.infer<typeof calendarDateSchema>;

export const calendarTimingSchema = z
  .object({
    date: calendarDateSchema,
    timezone: calendarTimezoneSchema,
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    allDay: z.boolean().default(false),
    durationMinutes: z.number().int().min(0).max(10080).default(0),
    recurrence: z.enum(['once', 'daily', 'weekly', 'monthly', 'yearly']),
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
    until: z.iso.date().optional(),
    missingDay: z.enum(['skip', 'last_day']).default('skip'),
    leapMonthPolicy: z.enum(['strict', 'regular_if_absent', 'both']).default('strict'),
  })
  .strict()
  .refine(
    (t) => t.date.calendar !== 'chinese' || ['once', 'yearly'].includes(t.recurrence),
    'Chinese lunar dates support one-off or yearly recurrence',
  );
export type CalendarTiming = z.infer<typeof calendarTimingSchema>;

/** Chinese civil calendar dates; delivery timezone is separate from date conversion. */
export function chineseDate(date: string): CalendarDate {
  const [year, month, day] = date.split('-').map(Number);
  const lunar = Solar.fromYmd(year!, month!, day!).getLunar();
  return {
    calendar: 'chinese',
    year: lunar.getYear(),
    month: Math.abs(lunar.getMonth()),
    day: lunar.getDay(),
    leapMonth: lunar.getMonth() < 0,
  };
}

type LunarMonth = { month: number; leapMonth: boolean; start: number; days: number };
// Pure derived conversion cache, never scheduling state or an authority source.
const lunarYears = new Map<number, LunarMonth[]>();
function lunarMonths(year: number): LunarMonth[] {
  const cached = lunarYears.get(year);
  if (cached) return cached;
  const result: LunarMonth[] = LunarYear.fromYear(year)
    .getMonths()
    .filter((m) => m.getYear() === year)
    .map((m) => ({
      month: Math.abs(m.getMonth()),
      leapMonth: m.getMonth() < 0,
      start: Date.parse(`${Solar.fromJulianDay(m.getFirstJulianDay()).toYmd()}T00:00:00Z`),
      days: m.getDayCount(),
    }));
  if (lunarYears.size >= 24) lunarYears.delete(lunarYears.keys().next().value!);
  lunarYears.set(year, result);
  return result;
}

export function calendarDateToGregorian(date: CalendarDate): string | null {
  if (date.calendar === 'gregorian')
    return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
  const month = lunarMonths(date.year).find(
    (m) => m.month === date.month && m.leapMonth === date.leapMonth,
  );
  return month && date.day <= month.days
    ? new Date(month.start + (date.day - 1) * 86400000).toISOString().slice(0, 10)
    : null;
}

export function calendarLocalParts(
  at: Date,
  timezone: string,
): { date: string; hour: number; minute: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts['year']}-${parts['month']}-${parts['day']}`,
    hour: Number(parts['hour']),
    minute: Number(parts['minute']),
  };
}

/** Skip nonexistent local minutes and choose the first instant of a DST fold. */
export function calendarLocalInstant(
  date: string,
  hour: number,
  minute: number,
  timezone: string,
): Date | null {
  const target = Date.parse(
    `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`,
  );
  const candidates: number[] = [];
  for (const delta of [-86400000, 0, 86400000]) {
    const probe = target + delta;
    const local = calendarLocalParts(new Date(probe), timezone);
    const offset =
      Date.parse(
        `${local.date}T${String(local.hour).padStart(2, '0')}:${String(local.minute).padStart(2, '0')}:00Z`,
      ) - probe;
    const candidate = target - offset;
    const actual = calendarLocalParts(new Date(candidate), timezone);
    if (actual.date === date && actual.hour === hour && actual.minute === minute)
      candidates.push(candidate);
  }
  return candidates.length ? new Date(Math.min(...candidates)) : null;
}

/** Strictly after `after`; calendar arithmetic, not elapsed 24-hour recurrence. */
export function nextCalendarInstant(timing: CalendarTiming, after: Date): Date | null {
  const converted = calendarDateToGregorian(timing.date);
  const anchor =
    converted ??
    (timing.date.calendar === 'chinese' && timing.recurrence === 'yearly'
      ? `${timing.date.year}-01-01`
      : null);
  if (!anchor) return null;
  const localAfter = calendarLocalParts(after, timing.timezone).date;
  const eligible = (date: string): Date | null => {
    if (date < anchor || (timing.until && date > timing.until)) return null;
    const instant = calendarLocalInstant(date, timing.hour, timing.minute, timing.timezone);
    return instant && instant > after ? instant : null;
  };
  if (timing.recurrence === 'once') return eligible(anchor);
  if (timing.date.calendar === 'chinese') {
    for (
      let year = Math.max(timing.date.year, Number(localAfter.slice(0, 4)) - 1);
      year <= 2100;
      year++
    ) {
      const months = lunarMonths(year).filter((m) => m.month === timing.date.month);
      const hasLeap = months.some((m) => m.leapMonth);
      for (const month of months) {
        if (timing.leapMonthPolicy !== 'both') {
          const leap =
            timing.date.leapMonth && (timing.leapMonthPolicy !== 'regular_if_absent' || hasLeap);
          if (month.leapMonth !== leap) continue;
        }
        if (timing.date.day > month.days && timing.missingDay === 'skip') continue;
        const date = new Date(month.start + (Math.min(timing.date.day, month.days) - 1) * 86400000)
          .toISOString()
          .slice(0, 10);
        const candidate = eligible(date);
        if (candidate) return candidate;
      }
      if (timing.until && String(year) > timing.until.slice(0, 4)) return null;
    }
    return null;
  }
  if (timing.recurrence === 'monthly' || timing.recurrence === 'yearly') {
    const firstYear = Math.max(timing.date.year, Number(localAfter.slice(0, 4)));
    for (let year = firstYear; year <= 2100; year++) {
      const months =
        timing.recurrence === 'yearly'
          ? [timing.date.month]
          : Array.from({ length: 12 }, (_, i) => i + 1);
      for (const month of months) {
        const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
        if (timing.date.day > days && timing.missingDay === 'skip') continue;
        const date = new Date(Date.UTC(year, month - 1, Math.min(days, timing.date.day)))
          .toISOString()
          .slice(0, 10);
        const candidate = eligible(date);
        if (candidate) return candidate;
      }
      if (timing.until && String(year) > timing.until.slice(0, 4)) return null;
    }
    return null;
  }
  const first = Math.max(Date.parse(`${anchor}T00:00:00Z`), Date.parse(`${localAfter}T00:00:00Z`));
  for (let day = first; day <= first + 8 * 86400000; day += 86400000) {
    const date = new Date(day).toISOString().slice(0, 10);
    if (date > '2100-12-31') return null;
    if (timing.recurrence === 'weekly' && !timing.weekdays.includes(new Date(day).getUTCDay()))
      continue;
    const candidate = eligible(date);
    if (candidate) return candidate;
  }
  return null;
}

export function calendarDateLabel(date: CalendarDate): string {
  return date.calendar === 'chinese'
    ? `農曆 ${date.year}年${date.leapMonth ? '閏' : ''}${date.month}月${date.day}日`
    : calendarDateToGregorian(date)!;
}

/** Relative preparation runs use elapsed minutes before a calendar occurrence. */
export function nextOffsetCalendarInstant(
  timing: CalendarTiming,
  after: Date,
  beforeMinutes = 0,
): Date | null {
  const next = nextCalendarInstant(timing, new Date(after.getTime() + beforeMinutes * 60000));
  return next ? new Date(next.getTime() - beforeMinutes * 60000) : null;
}
