import { atHour, wallClock } from './digest-time.js';

/**
 * A user's quiet hours: push and SMS are held back between `start` and
 * `end` on the clock of their time zone, `HH:MM` each (a window past
 * midnight, `22:00` to `07:00`, is the usual one). Docs: docs/notifications.md,
 * "Quiet hours".
 */
export interface QuietHours {
  start: string;
  end: string;
}

const DAY = 86_400_000;

const minutes = (time: string) => {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return hour * 60 + minute;
};

/** The moment the clock of `timeZone` reads `time` on `date` (YYYY-MM-DD). */
const at = (date: string, time: string, timeZone: string) =>
  atHour(date, Math.floor(minutes(time) / 60), timeZone) +
  (minutes(time) % 60) * 60_000;

/**
 * When the quiet hours that cover `now` end, or null when `now` is outside
 * them (or they are not set). The zone's own clock decides, so the window
 * follows daylight-saving changes; `start` equal to `end` is no window.
 */
export function quietUntil(
  now: Date,
  quiet: QuietHours | null | undefined,
  timeZone: string,
): Date | null {
  if (!quiet || quiet.start === quiet.end) return null;
  const start = minutes(quiet.start);
  const end = minutes(quiet.end);
  const time = now.getTime();
  const clock = wallClock(time, timeZone);
  const current = clock.hour * 60 + clock.minute;
  const overnight = start > end;
  const inside = overnight
    ? current >= start || current < end
    : current >= start && current < end;
  if (!inside) return null;
  // The end is today's, unless the window began this evening and runs past midnight.
  const endsTomorrow = overnight && current >= start;
  const date = endsTomorrow ? wallClock(time + DAY, timeZone).date : clock.date;
  return new Date(at(date, quiet.end, timeZone));
}
