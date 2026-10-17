import { i18n } from '@/i18n';

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
