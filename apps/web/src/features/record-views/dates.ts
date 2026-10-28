/**
 * Calendar days of a time zone, for the calendar and the timeline. A day is
 * a `YYYY-MM-DD` string; an instant is an ISO 8601 string. Days are added
 * as calendar days (never +24 h), and a day's start is found in the zone,
 * so a daylight-saving change moves nothing it should not.
 */

export type Day = string;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const parts = (day: Day): [number, number, number] => {
  const match = DAY.exec(day);
  if (!match) throw new Error(`Not a day: ${day}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** Whether the text is a real calendar day (`2026-02-30` is not). */
export function isDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const [y, m, d] = parts(value);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

const format = (date: Date): Day => date.toISOString().slice(0, 10);

export function addDays(day: Day, days: number): Day {
  const [y, m, d] = parts(day);
  return format(new Date(Date.UTC(y, m - 1, d + days)));
}

export function addMonths(day: Day, months: number): Day {
  const [y, m] = parts(day);
  return format(new Date(Date.UTC(y, m - 1 + months, 1)));
}

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (day: Day): number => {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

/** Days from `from` to `to` (negative when before). */
export function daysBetween(from: Day, to: Day): number {
  const [fy, fm, fd] = parts(from);
  const [ty, tm, td] = parts(to);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
  );
}

/** The first day of the week holding `day`; `firstDay` 0 = Sunday, 1 = Monday. */
export function startOfWeek(day: Day, firstDay: number): Day {
  return addDays(day, -((weekday(day) - firstDay + 7) % 7));
}

export const startOfMonth = (day: Day): Day => `${day.slice(0, 8)}01`;

/** Today in the zone. */
export const today = (zone?: string): Day =>
  dayOf(new Date().toISOString(), zone);

/** The zone's local time of an instant, as the fields of a UTC date. */
function local(instant: number, zone?: string): Date {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return new Date(
    Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      Number(p.hour),
      Number(p.minute),
      Number(p.second),
      // Whole seconds are all the zone's clock shows: the milliseconds carry over.
      ((instant % 1000) + 1000) % 1000,
    ),
  );
}

/** The day an instant falls on in the zone (the browser's when unset). */
export function dayOf(instant: string, zone?: string): Day {
  return format(local(new Date(instant).getTime(), zone));
}

/** The wall-clock time of an instant in the zone, as ms since midnight. */
export function timeOf(instant: string, zone?: string): number {
  const date = local(new Date(instant).getTime(), zone);
  return (
    ((date.getUTCHours() * 60 + date.getUTCMinutes()) * 60 +
      date.getUTCSeconds()) *
      1000 +
    date.getUTCMilliseconds()
  );
}

/**
 * The instant at which the zone's clock reads `day` at `time` ms. A time the
 * zone skips (the hour a spring change leaves out) is read with the offset
 * from before the change, so it lands just after the gap; one it repeats
 * (autumn) is the first of the two.
 */
export function instantAt(day: Day, zone?: string, time = 0): string {
  const [y, m, d] = parts(day);
  const wall = Date.UTC(y, m - 1, d) + time;
  const offsetAt = (instant: number) =>
    local(instant, zone).getTime() - instant;
  // The offsets a day before and after (a change is not nearer than that).
  const before = wall - offsetAt(wall - 86_400_000);
  const after = wall - offsetAt(wall + 86_400_000);
  const valid = [before, after].filter(
    (instant) => local(instant, zone).getTime() === wall,
  );
  return new Date(valid.length > 0 ? Math.min(...valid) : before).toISOString();
}

/**
 * Where a record's date is on the calendar: an all-day field (`date`) is its
 * own day; a `datetime` is the day it falls on in the user's zone.
 */
export function calendarDay(
  value: string,
  type: 'date' | 'datetime',
  zone?: string,
): Day {
  return type === 'date' ? value.slice(0, 10) : dayOf(value, zone);
}

/**
 * The value the field takes when its record moves to `day`: an all-day date
 * is that day; a moment keeps its time of day in the zone.
 */
export function movedTo(
  value: string,
  type: 'date' | 'datetime',
  day: Day,
  zone?: string,
): string {
  return type === 'date' ? day : instantAt(day, zone, timeOf(value, zone));
}

/**
 * The instants bounding days `from` (included) to `to` (excluded) in the
 * zone: what a query by `gte` and `lt` takes for a `datetime` field; the
 * days themselves for a `date` field.
 */
export function bounds(
  from: Day,
  to: Day,
  type: 'date' | 'datetime',
  zone?: string,
): [string, string] {
  return type === 'date'
    ? [from, to]
    : [instantAt(from, zone), instantAt(to, zone)];
}
