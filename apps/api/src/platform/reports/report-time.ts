import { atHour, wallClock } from '../notifications/digest-time.js';

/** When a report runs: an hour of a day, a weekday (0 Sunday) or a day of the month (1-28), in its zone. */
export type ReportSchedule =
  | { every: 'daily'; hour: number }
  | { every: 'weekly'; weekday: number; hour: number }
  | { every: 'monthly'; day: number; hour: number };

const DAY = 86_400_000;

/** The calendar day after `date` (YYYY-MM-DD). */
const nextDate = (date: string) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + DAY).toISOString().slice(0, 10);

const matches = (schedule: ReportSchedule, date: string) => {
  switch (schedule.every) {
    case 'daily':
      return true;
    case 'weekly':
      return new Date(`${date}T00:00:00Z`).getUTCDay() === schedule.weekday;
    case 'monthly':
      return Number(date.slice(8, 10)) === schedule.day;
  }
};

/**
 * The first moment after `from` the schedule names, on the wall clock of
 * `timeZone` (digest-time's approach: no date library; a daylight-saving
 * change is accounted for, an hour the clock skips moves to the next).
 * Strictly after: computed from the run's own moment, a missed hour never
 * runs twice.
 */
export function nextRunTime(
  schedule: ReportSchedule,
  from: Date,
  timeZone: string,
): Date {
  const time = from.getTime();
  let date = wallClock(time, timeZone).date;
  // A month and a bit covers every schedule (monthly: day 28 at most).
  for (let days = 0; days < 40; days++, date = nextDate(date)) {
    if (!matches(schedule, date)) continue;
    const due = atHour(date, schedule.hour, timeZone);
    if (due > time) {
      return new Date(due);
    }
  }
  throw new Error(`No next run for ${JSON.stringify(schedule)}`);
}
