import { useTranslation } from 'react-i18next';
import { formatDateTime } from '@/lib/date-time';

const units: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

/** "5 minutes ago" in the UI's language (Intl, so five languages and RTL come free). */
export function relativeTime(
  value: string,
  language: string,
  now = Date.now(),
): string {
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const seconds = Math.round((new Date(value).getTime() - now) / 1000);
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return format.format(Math.round(seconds / 60), 'minute');
}

// Dice UI's relative-time-card was looked at and not used: its texts are
// English only ("5 minutes ago") and fixed in the component, which the five
// languages and right-to-left layout of this app can't take.
/** A `<time>` with the relative text and the full date as its tooltip. */
export function RelativeTime(props: { value: string }) {
  const { i18n } = useTranslation();
  return (
    <time
      dateTime={props.value}
      title={formatDateTime(props.value)}
      className="text-xs text-muted-foreground"
    >
      {relativeTime(props.value, i18n.language)}
    </time>
  );
}
