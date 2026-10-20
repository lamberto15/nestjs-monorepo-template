import { useTranslation } from 'react-i18next';
import { i18n } from '@/i18n';
import { useMe } from '@/lib/features';

/** A date and time in the UI's language (the API's are ISO 8601, UTC). */
export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  return new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

/**
 * Dates and times for the signed-in user: in their UI language and their
 * time zone (the profile's, else the browser's), as `Intl` formats them.
 */
export function useDateTimeFormat() {
  const { i18n: current } = useTranslation();
  const timeZone = useMe()?.user.timezone ?? undefined;
  const format = (
    value: string | null | undefined,
    style: 'date' | 'dateTime' | 'time' = 'dateTime',
  ) =>
    value
      ? new Intl.DateTimeFormat(current.language, {
          ...(style !== 'time' && { dateStyle: 'medium' }),
          ...(style === 'dateTime' && { timeStyle: 'short' }),
          ...(style === 'time' && { timeStyle: 'medium' }),
          ...(timeZone && { timeZone }),
        }).format(new Date(value))
      : '';
  return format;
}
