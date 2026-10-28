import { wallClock } from '../notifications/digest-time.js';

/** A span of one day's clock, `HH:MM`; `end` may be `24:00`. */
export interface DayHours {
  start: string;
  end: string;
}

/** The hours the calendar works on a weekday (0 Sunday … 6 Saturday). */
export interface WeekdayHours extends DayHours {
  weekday: number;
}

/** A date that differs from the week: closed (a holiday), or other `hours`. */
export interface CalendarException {
  /** YYYY-MM-DD in the calendar's zone. */
  date: string;
  name: string;
  hours?: DayHours[];
}

/** What deadline math needs of a calendar. */
export interface CalendarDefinition {
  timezone: string;
  hours: WeekdayHours[];
  exceptions: CalendarException[];
}

/** Longest wait for working time, in days: a calendar with none fails instead of looping. */
export const MAX_SEARCH_DAYS = 3660;
/** Most minutes one deadline may add. */
export const MAX_DEADLINE_MINUTES = 100_000;

const DAY = 86_400_000;
const MINUTE = 60_000;

/** `HH:MM` as minutes since midnight; NaN when it is not a time (`24:00` is the day's end). */
export function minuteOf(clock: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!match) return NaN;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number(match[2]) < 60 && minutes <= 1440 ? minutes : NaN;
}

/** Why the spans are not usable (a bad time, an end before its start, an overlap), or null. */
export function spansProblem(spans: readonly DayHours[]) {
  const parsed = spans.map((span) => [
    minuteOf(span.start),
    minuteOf(span.end),
  ]);
  if (parsed.some(([start, end]) => Number.isNaN(start! + end!))) {
    return 'Times are HH:MM, from 00:00 to 24:00.';
  }
  if (parsed.some(([start, end]) => start! >= end!)) {
    return 'A span ends after it starts.';
  }
  const sorted = parsed.sort((a, b) => a[0]! - b[0]!);
  return sorted.some((span, i) => i > 0 && span[0]! < sorted[i - 1]![1]!)
    ? 'Spans of one day must not overlap.'
    : null;
}

const wallString = (time: number, timeZone: string) => {
  const { date, hour, minute } = wallClock(time, timeZone);
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const offsetAt = (time: number, timeZone: string) =>
  Date.parse(`${wallString(time, timeZone)}:00Z`) -
  Math.floor(time / MINUTE) * MINUTE;

/**
 * The moment the clock of `timeZone` shows `minute` (since midnight, up
 * to 1440) on `date`. The offset is read at the moment itself, so a
 * daylight-saving change is followed: a time the clock repeats gives its
 * first occurrence, one it skips the moment after the gap (as Temporal's
 * "compatible" does).
 */
export function zonedMoment(date: string, minute: number, timeZone: string) {
  const asUtc = Date.parse(`${date}T00:00:00Z`) + minute * MINUTE;
  const wanted = new Date(asUtc).toISOString().slice(0, 16);
  const before = offsetAt(asUtc - DAY, timeZone);
  const candidates = [before, offsetAt(asUtc + DAY, timeZone)]
    .map((offset) => asUtc - offset)
    .filter((moment) => wallString(moment, timeZone) === wanted);
  return candidates.length > 0 ? Math.min(...candidates) : asUtc - before;
}

const nextDate = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

/** The spans a local date works: its exception's, else its weekday's. */
function spansOn(
  definition: CalendarDefinition,
  exceptions: ReadonlyMap<string, CalendarException>,
  date: string,
): DayHours[] {
  const exception = exceptions.get(date);
  if (exception) return exception.hours ?? [];
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return definition.hours.filter((span) => span.weekday === weekday);
}

/** A calendar that no span of can ever work: nothing to wait for. */
export class NoWorkingTimeError extends Error {
  constructor() {
    super('The calendar has no working time in the next ten years.');
  }
}

/**
 * The moment `minutes` of working time have passed since `from`: the
 * calendar's hours on the wall clock of its zone, less its exceptions
 * (closed days, special hours). Working time counts as elapsed time, so
 * a span that a daylight-saving change cuts or stretches is shorter or
 * longer on the clock but counts what really passed. `minutes: 0` gives
 * the first working moment at or after `from` (`from` itself while it is
 * working time). Starting outside working time waits for the next span.
 */
export function addWorkingMinutes(
  definition: CalendarDefinition,
  from: Date,
  minutes: number,
): Date {
  const exceptions = new Map(definition.exceptions.map((e) => [e.date, e]));
  const { timezone } = definition;
  let remaining = minutes;
  let date = wallClock(from.getTime(), timezone).date;
  for (let days = 0; days <= MAX_SEARCH_DAYS; days++, date = nextDate(date)) {
    const spans = spansOn(definition, exceptions, date)
      .map((span) => [minuteOf(span.start), minuteOf(span.end)] as const)
      .sort((a, b) => a[0] - b[0]);
    for (const [start, end] of spans) {
      const spanEnd = zonedMoment(date, end, timezone);
      const cursor = Math.max(
        zonedMoment(date, start, timezone),
        from.getTime(),
      );
      if (cursor >= spanEnd) continue;
      const available = (spanEnd - cursor) / MINUTE;
      if (remaining <= available) {
        return new Date(cursor + remaining * MINUTE);
      }
      remaining -= available;
    }
  }
  throw new NoWorkingTimeError();
}
