import type { DigestMode } from './notification.types.js';

const DAY = 86_400_000;

/** The wall-clock date and hour of `time` in `timeZone`. */
export function wallClock(time: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(time));
  const part = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  ) as Record<Intl.DateTimeFormatPartTypes, string>;
  return {
    date: `${part.year}-${part.month}-${part.day}`,
    hour: +part.hour,
    minute: +part.minute,
    second: +part.second,
  };
}

/**
 * The moment `date` (YYYY-MM-DD) has its clock at `hour`:00 in `timeZone`:
 * the zone's offset is read from the moment itself, so a daylight-saving
 * change on that day is accounted for (an hour the clock skips: moved to
 * the next hour, as Temporal does).
 */
export function atHour(date: string, hour: number, timeZone: string) {
  const asUtc = Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00Z`);
  // Two guesses (the offsets a day apart), kept when they show the hour.
  for (const guess of [asUtc - DAY, asUtc + DAY]) {
    const offset = Date.parse(`${wallDate(guess, timeZone)}Z`) - guess;
    const moment = asUtc - offset;
    const clock = wallClock(moment, timeZone);
    if (clock.date === date && clock.hour === hour) {
      return moment;
    }
  }
  // The clock skips that hour: the first moment after the gap.
  let moment = asUtc - offsetAt(asUtc, timeZone);
  while (wallClock(moment, timeZone).hour < hour) moment += 60_000;
  return moment;
}

const wallDate = (time: number, timeZone: string) => {
  const { date, hour, minute, second } = wallClock(time, timeZone);
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
};

const offsetAt = (time: number, timeZone: string) =>
  Date.parse(`${wallDate(time, timeZone)}Z`) - time;

/**
 * When a digest mail flagged at `now` is due: an hourly one at once (the
 * hourly job sends what is due); a daily one at the next `hour`:00 of the
 * recipient's time zone (today's, if still ahead; else tomorrow's).
 */
export function nextDigestTime(
  mode: DigestMode,
  now: Date,
  timeZone: string,
  hour: number,
): Date {
  if (mode === 'hourly') {
    return now;
  }
  const time = now.getTime();
  const today = wallClock(time, timeZone).date;
  const due = atHour(today, hour, timeZone);
  if (due > time) {
    return new Date(due);
  }
  const tomorrow = wallClock(time + DAY, timeZone).date;
  return new Date(atHour(tomorrow, hour, timeZone));
}
