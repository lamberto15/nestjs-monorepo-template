/**
 * Naming series patterns, as Frappe writes them: parts between dots,
 * `INV-.YYYY.-.MM.-.#####` → `INV-2026-10-00042`. A part is literal text
 * (`INV-`), a date part (`YYYY`, `YY`, `MM`, `DD`) or the counter: one
 * run of `#`, its length the zero-padding.
 *
 * Frappe's syntax, not a template language of our own: administrators who
 * know naming series write the same patterns here (docs/sequences.md).
 */

export const DATE_PARTS = ['YYYY', 'YY', 'MM', 'DD'] as const;
export type DatePart = (typeof DATE_PARTS)[number];

export type PatternPart =
  | { kind: 'text'; text: string }
  | { kind: 'date'; part: DatePart }
  | { kind: 'counter'; width: number };

/** The moment's date parts, as they print: `{ YYYY: '2026', YY: '26', MM: '10', DD: '20' }`. */
export type DateValues = Record<DatePart, string>;

/** Letters, digits, `-`, `_` and `/`: a number stays one token to quote and search. */
const TEXT = /^[A-Za-z0-9_\-/]+$/;
export const MAX_PATTERN_LENGTH = 60;
export const MAX_COUNTER_WIDTH = 12;

export class PatternError extends Error {}

/** A pattern's parts; a PatternError says what is wrong with it. */
export function parsePattern(pattern: string): PatternPart[] {
  if (pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
    throw new PatternError(
      `A pattern is 1 to ${MAX_PATTERN_LENGTH} characters.`,
    );
  }
  const parts = pattern
    .split('.')
    .filter((part) => part !== '')
    .map((part): PatternPart => {
      if (/^#+$/.test(part)) {
        return { kind: 'counter', width: part.length };
      }
      if ((DATE_PARTS as readonly string[]).includes(part)) {
        return { kind: 'date', part: part as DatePart };
      }
      if (!TEXT.test(part)) {
        throw new PatternError(
          `"${part}" is not a date part (${DATE_PARTS.join(', ')}), a counter (#####) or text of letters, digits, "-", "_" and "/".`,
        );
      }
      return { kind: 'text', text: part };
    });
  const counters = parts.filter((part) => part.kind === 'counter');
  if (counters.length !== 1) {
    throw new PatternError(
      'A pattern has exactly one counter: a run of # between dots, as in INV-.YYYY.-.#####.',
    );
  }
  if (counters[0]!.width > MAX_COUNTER_WIDTH) {
    throw new PatternError(
      `A counter has at most ${MAX_COUNTER_WIDTH} digits.`,
    );
  }
  // Digits right next to the counter would merge with it: `NOTE-.1.#` at 5
  // and `NOTE-.#` at 15 both print NOTE-15, from two counters.
  const at = parts.indexOf(counters[0]!);
  const [before, after] = [parts[at - 1], parts[at + 1]];
  if (
    (before && (before.kind === 'date' || /[0-9]$/.test(before.text))) ||
    (after && (after.kind === 'date' || /^[0-9]/.test(after.text)))
  ) {
    throw new PatternError(
      'The counter needs a separator that is not a digit or a date part on each side it has text, as in INV-.YYYY.-.#####.',
    );
  }
  return parts;
}

/**
 * What the pattern prints around its counter at a moment: `INV-2026-{#}`.
 * The counter is keyed by it, as Frappe keys by the prefix: a series
 * restarts when a date part changes (each month with `MM`), and two
 * patterns that print the same share one counter, so they never give the
 * same number twice (`INV-.####` and `INV-.#####` included).
 */
export function counterKey(parts: PatternPart[], date: DateValues) {
  return parts
    .map((part) =>
      part.kind === 'text'
        ? part.text
        : part.kind === 'date'
          ? date[part.part]
          : '{#}',
    )
    .join('');
}

/** The number a counter value makes at a moment: `INV-2026-00042`. */
export function renderPattern(
  parts: PatternPart[],
  value: number,
  date: DateValues,
) {
  return parts
    .map((part) =>
      part.kind === 'text'
        ? part.text
        : part.kind === 'date'
          ? date[part.part]
          : String(value).padStart(part.width, '0'),
    )
    .join('');
}

/** The date parts of a moment in a time zone (the app's: APP_TIMEZONE). */
export function dateValues(at: Date, timeZone: string): DateValues {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(at)
      .map(({ type, value }) => [type, value]),
  );
  const year = String(parts.year);
  return {
    YYYY: year,
    YY: year.slice(-2),
    MM: String(parts.month),
    DD: String(parts.day),
  };
}

/**
 * A declared format (`{ prefix: 'NOTE', perYear: true, width: 5 }`) as a
 * pattern: `NOTE-.YYYY.-.#####`. A feature's numbers before any naming
 * series read the same through it.
 */
export function patternOf({
  prefix,
  perYear,
  width,
  separator = '-',
}: {
  prefix?: string;
  perYear?: boolean;
  width?: number;
  separator?: string;
}) {
  return [
    ...(prefix ? [`${prefix}${separator}`] : []),
    ...(perYear ? ['YYYY', separator] : []),
    '#'.repeat(width ?? 1),
  ].join('.');
}
