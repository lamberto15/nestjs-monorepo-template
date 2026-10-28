import { wallClock } from '../notifications/digest-time.js';
import { minuteOf, zonedMoment } from '../calendars/calendar-time.js';

/** Most records one schedule may create; also the ceiling of `COUNT`. */
export const MAX_OCCURRENCES = 1000;

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY = 86_400_000;

/** The subset of an RFC 5545 RRULE the schedules take. */
export interface Recurrence {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  /** Weekly: 0 Sunday … 6 Saturday; empty: the weekday of the start date. */
  byDay: number[];
  /** Monthly: the day of the month; null: the start date's. */
  byMonthDay: number | null;
  count: number | null;
  /** The last local date (YYYY-MM-DD) an occurrence may fall on. */
  until: string | null;
}

/** A recurrence anchored to a start date and a time of day on the wall clock of a zone. */
export interface RecurrenceSchedule {
  rule: Recurrence;
  /** YYYY-MM-DD, in `timezone`: the first date that may occur. */
  startDate: string;
  /** HH:MM, in `timezone`. */
  time: string;
  timezone: string;
}

export class RuleError extends Error {}

const integer = (key: string, value: string, min: number, max: number) => {
  const number = Number(value);
  if (!/^\d+$/.test(value) || number < min || number > max) {
    throw new RuleError(`${key} is a number from ${min} to ${max}.`);
  }
  return number;
};

/**
 * Parses `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10` (an `RRULE:` prefix
 * is allowed). Supported: FREQ (DAILY, WEEKLY, MONTHLY, YEARLY, nothing
 * shorter than a day), INTERVAL, BYDAY (weekly, plain weekdays), BYMONTHDAY
 * (monthly, one day), and one of COUNT or UNTIL. Anything else is refused,
 * not ignored.
 */
export function parseRule(text: string): Recurrence {
  const parts = new Map<string, string>();
  for (const part of text
    .trim()
    .replace(/^RRULE:/i, '')
    .split(';')) {
    const [key, value, ...rest] = part.split('=');
    if (!key || !value || rest.length > 0) {
      throw new RuleError(`"${part}" is not KEY=VALUE.`);
    }
    const name = key.toUpperCase();
    if (parts.has(name)) throw new RuleError(`${name} is given twice.`);
    if (
      !['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL'].includes(
        name,
      )
    ) {
      throw new RuleError(`${name} is not supported.`);
    }
    parts.set(name, value.toUpperCase());
  }
  const freq = parts.get('FREQ');
  if (
    freq !== 'DAILY' &&
    freq !== 'WEEKLY' &&
    freq !== 'MONTHLY' &&
    freq !== 'YEARLY'
  ) {
    throw new RuleError('FREQ is DAILY, WEEKLY, MONTHLY or YEARLY.');
  }
  const byDayText = parts.get('BYDAY');
  const byDay = byDayText
    ? byDayText.split(',').map((day) => {
        const index = WEEKDAYS.indexOf(day);
        if (index < 0) throw new RuleError(`BYDAY: "${day}" is not SU…SA.`);
        return index;
      })
    : [];
  if (byDay.length > 0 && freq !== 'WEEKLY') {
    throw new RuleError('BYDAY goes with FREQ=WEEKLY.');
  }
  const monthDay = parts.get('BYMONTHDAY');
  if (monthDay !== undefined && freq !== 'MONTHLY') {
    throw new RuleError('BYMONTHDAY goes with FREQ=MONTHLY.');
  }
  const countText = parts.get('COUNT');
  const untilText = parts.get('UNTIL');
  if (countText !== undefined && untilText !== undefined) {
    throw new RuleError('COUNT and UNTIL are exclusive.');
  }
  let until: string | null = null;
  if (untilText !== undefined) {
    const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(untilText);
    until = match ? `${match[1]}-${match[2]}-${match[3]}` : null;
    if (!until || Number.isNaN(Date.parse(`${until}T00:00:00Z`))) {
      throw new RuleError('UNTIL is a date: 20261231.');
    }
  }
  return {
    freq,
    interval: integer('INTERVAL', parts.get('INTERVAL') ?? '1', 1, 99),
    byDay: [...new Set(byDay)].sort(),
    byMonthDay:
      monthDay === undefined ? null : integer('BYMONTHDAY', monthDay, 1, 31),
    count:
      countText === undefined
        ? null
        : integer('COUNT', countText, 1, MAX_OCCURRENCES),
    until,
  };
}

const dayNumber = (date: string) =>
  Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Whether the rule, from `start`, has an occurrence on the local `date`. */
function occursOn(rule: Recurrence, start: string, date: string) {
  if (date < start) return false;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [sy, sm, sd] = start.split('-').map(Number) as [number, number, number];
  switch (rule.freq) {
    case 'DAILY':
      return (dayNumber(date) - dayNumber(start)) % rule.interval === 0;
    case 'WEEKLY': {
      // Weeks start on Monday (RFC 5545's default WKST).
      const monday = (day: string) => dayNumber(day) - ((weekday(day) + 6) % 7);
      const weeks = (monday(date) - monday(start)) / 7;
      const days = rule.byDay.length > 0 ? rule.byDay : [weekday(start)];
      return weeks % rule.interval === 0 && days.includes(weekday(date));
    }
    case 'MONTHLY':
      // A month without the day (the 31st) has no occurrence, as in the RFC.
      return (
        ((y - sy) * 12 + (m - sm)) % rule.interval === 0 &&
        d === (rule.byMonthDay ?? sd)
      );
    case 'YEARLY':
      return (y - sy) % rule.interval === 0 && m === sm && d === sd;
  }
}

/** How far ahead to look for an occurrence, in days (a 29 February needs eight years). */
const HORIZON_DAYS = 3660;

/**
 * The first occurrence strictly after `after` (a moment): its local date
 * must satisfy the rule and not pass UNTIL, its time is `time` on the
 * wall clock of the zone (daylight-saving changes followed: a time the
 * clock skips moves to the moment after the gap, one it repeats takes
 * the first). Null when there is none (UNTIL passed, or none within ten
 * years). COUNT is the caller's to enforce: it counts what ran.
 */
export function nextOccurrence(
  schedule: RecurrenceSchedule,
  after: Date,
): Date | null {
  const { rule, startDate, time, timezone } = schedule;
  const minute = minuteOf(time);
  const from = wallClock(after.getTime(), timezone).date;
  let day = from > startDate ? from : startDate;
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    if (rule.until && day > rule.until) return null;
    if (occursOn(rule, startDate, day)) {
      const moment = zonedMoment(day, minute, timezone);
      if (moment > after.getTime()) return new Date(moment);
    }
    day = new Date(Date.parse(`${day}T00:00:00Z`) + DAY)
      .toISOString()
      .slice(0, 10);
  }
  return null;
}
