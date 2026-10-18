import type { TFunction } from 'i18next';
import type { Schedule } from './api';

/** 0 Sunday … 6 Saturday, as the API counts them. */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
/** 1-28: every month has them (docs/reports.md). */
export const MONTH_DAYS = Array.from({ length: 28 }, (_, i) => i + 1);
export const HOURS = Array.from({ length: 24 }, (_, i) => i);

/** The weekday's name in the language (2023-01-01 was a Sunday). */
export function weekdayName(weekday: number, language: string): string {
  return new Intl.DateTimeFormat(language, {
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2023, 0, 1 + weekday)));
}

/** An hour on the wall clock, `08:00` (or `8 AM`) as the language writes it. */
export function hourLabel(hour: number, language: string): string {
  return new Intl.DateTimeFormat(language, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2023, 0, 1, hour)));
}

/** "Weekly on Monday at 08:00": the schedule in words, in the report's zone. */
export function describeSchedule(
  schedule: Schedule,
  t: TFunction<'reports'>,
  language: string,
): string {
  const at = hourLabel(schedule.hour, language);
  switch (schedule.every) {
    case 'daily':
      return t('schedule.daily', { at });
    case 'weekly':
      return t('schedule.weekly', {
        at,
        weekday: weekdayName(schedule.weekday, language),
      });
    case 'monthly':
      return t('schedule.monthly', { at, day: schedule.day });
  }
}
