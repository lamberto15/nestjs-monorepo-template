import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonths,
  bounds,
  calendarDay,
  instantAt,
  isDay,
  movedTo,
  startOfWeek,
  timeOf,
} from './dates';

const NEW_YORK = 'America/New_York';

describe('days', () => {
  it('adds calendar days and months across month ends and leap days', () => {
    expect(addDays('2024-02-28', 2)).toBe('2024-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-01');
    // Monday-first and Sunday-first weeks.
    expect(startOfWeek('2026-03-08', 1)).toBe('2026-03-02');
    expect(startOfWeek('2026-03-08', 0)).toBe('2026-03-08');
  });

  it('accepts real calendar days only', () => {
    expect(isDay('2026-02-28')).toBe(true);
    expect(isDay('2026-02-30')).toBe(false);
    expect(isDay('')).toBe(false);
    expect(isDay('26-02-28')).toBe(false);
  });
});

describe('time zones and daylight saving', () => {
  it('puts an instant on the day of the zone, an all-day date on its own', () => {
    // 03:30 UTC is still the evening before in New York.
    expect(calendarDay('2026-06-10T03:30:00.000Z', 'datetime', NEW_YORK)).toBe(
      '2026-06-09',
    );
    expect(calendarDay('2026-06-10T03:30:00.000Z', 'datetime', 'UTC')).toBe(
      '2026-06-10',
    );
    expect(calendarDay('2026-06-10', 'date', NEW_YORK)).toBe('2026-06-10');
  });

  it('bounds a day by the zone: 23 hours on the spring change, 25 on the autumn one', () => {
    const hours = (from: string, to: string) => {
      const [a, b] = bounds(from, to, 'datetime', NEW_YORK);
      return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
    };
    expect(hours('2026-03-08', '2026-03-09')).toBe(23);
    expect(hours('2026-11-01', '2026-11-02')).toBe(25);
    expect(hours('2026-06-01', '2026-06-02')).toBe(24);
    // A date field is bounded by days, not instants.
    expect(bounds('2026-03-08', '2026-03-09', 'date', NEW_YORK)).toEqual([
      '2026-03-08',
      '2026-03-09',
    ]);
  });

  it('keeps the time of day when a moment moves to another day', () => {
    // 09:30 in New York on the day before the spring change (EST, UTC-5)…
    const before = '2026-03-07T14:30:00.000Z';
    expect(timeOf(before, NEW_YORK)).toBe((9 * 60 + 30) * 60_000);
    // …is 09:30 after it, which is UTC-4.
    expect(movedTo(before, 'datetime', '2026-03-09', NEW_YORK)).toBe(
      '2026-03-09T13:30:00.000Z',
    );
    expect(movedTo('2026-03-07', 'date', '2026-03-09', NEW_YORK)).toBe(
      '2026-03-09',
    );
  });

  it('puts a time the spring change skips just after the gap, and a repeated one first', () => {
    // 02:30 does not exist on 2026-03-08 in New York: 03:00 EDT is 07:00Z.
    const skipped = new Date(instantAt('2026-03-08', NEW_YORK, 150 * 60_000));
    expect(skipped.getTime()).toBeGreaterThanOrEqual(
      Date.parse('2026-03-08T07:00:00Z'),
    );
    expect(skipped.getTime()).toBeLessThanOrEqual(
      Date.parse('2026-03-08T07:30:00Z'),
    );
    // 01:30 happens twice on 2026-11-01: the first is EDT, 05:30Z.
    expect(instantAt('2026-11-01', NEW_YORK, 90 * 60_000)).toBe(
      '2026-11-01T05:30:00.000Z',
    );
  });
});
