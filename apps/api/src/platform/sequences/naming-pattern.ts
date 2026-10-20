/**
 * Naming series patterns, as Frappe writes them: parts between dots,
 * `INV-.YYYY.-.MM.-.#####` → `INV-2026-10-00042`. A part is literal text
 * (`INV-`), a date part (`YYYY`, `YY`, `MM`, `DD`, `JJJ`, `WW`), a
 * variable (`FY`, `ABBR`, or one a feature declares: naming-variables.ts),
 * one of the record's own fields in braces (`{customer}`), or the counter:
 * one run of `#`, its length the zero-padding.
 *
 * Frappe's syntax, not a template language of our own: administrators who
 * know naming series write the same patterns here (docs/sequences.md).
 */

export const DATE_PARTS = ['YYYY', 'YY', 'MM', 'DD', 'JJJ', 'WW'] as const;
export type DatePart = (typeof DATE_PARTS)[number];

export type PatternPart =
  | { kind: 'text'; text: string }
  | { kind: 'date'; part: DatePart }
  | { kind: 'variable'; name: string }
  | { kind: 'field'; name: string }
  | { kind: 'counter'; width: number };

/** The moment's date parts, as they print: `{ YYYY: '2026', YY: '26', MM: '10', DD: '20', JJJ: '293', WW: '43' }`. */
export type DateValues = Record<DatePart, string>;

/** What a pattern's parts print at a moment, for one record. */
export interface PartValues {
  date: DateValues;
  /** Variables' values (`FY` → `2026-2027`). */
  variables?: Record<string, string>;
  /** The record's fields, as they print (`customer` → `ACME`). */
  fields?: Record<string, string>;
}

/**
 * What a pattern's names may be: the variables there are and the fields of
 * the subject. Without it, any braced name is a field and any upper-case
 * part that is no date part is text (the syntax alone, as the body schema
 * checks it).
 */
export interface PatternNames {
  variables: ReadonlySet<string>;
  fields: ReadonlySet<string>;
}

/** Letters, digits, `-`, `_` and `/`: a number stays one token to quote and search. */
const TEXT = /^[A-Za-z0-9_\-/]+$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
export const MAX_PATTERN_LENGTH = 60;
export const MAX_COUNTER_WIDTH = 12;
/** The most a field's value prints: a number stays short enough to read and quote. */
export const MAX_FIELD_VALUE_LENGTH = 40;

export class PatternError extends Error {}

/** A pattern's parts; a PatternError says what is wrong with it. */
export function parsePattern(
  pattern: string,
  names?: PatternNames,
): PatternPart[] {
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
      const braced = /^\{(.*)\}$/.exec(part)?.[1];
      if (braced !== undefined) {
        return named(braced, names);
      }
      if (names?.variables.has(part)) {
        return { kind: 'variable', name: part };
      }
      if (!TEXT.test(part)) {
        throw new PatternError(
          `"${part}" is not a date part (${DATE_PARTS.join(', ')}), a variable, a field in braces ({customer}), a counter (#####) or text of letters, digits, "-", "_" and "/".`,
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
  // and `NOTE-.#` at 15 both print NOTE-15, from two counters. Date parts,
  // variables and fields can end in digits, so they never touch it.
  const at = parts.indexOf(counters[0]!);
  const merges = (part: PatternPart | undefined, digit: RegExp) =>
    part !== undefined &&
    (part.kind !== 'text' || digit.test(part.text));
  if (merges(parts[at - 1], /[0-9]$/) || merges(parts[at + 1], /^[0-9]/)) {
    throw new PatternError(
      'The counter needs a separator that is not a digit, a date part, a variable or a field on each side it has something, as in INV-.YYYY.-.#####.',
    );
  }
  return parts;
}

/** `{customer}`: the subject's field, or a variable written as Frappe's `format:` rules write them (`{FY}`). */
function named(name: string, names?: PatternNames): PatternPart {
  if (!NAME.test(name)) {
    throw new PatternError(
      `"{${name}}" is not a field: a name of letters, digits and "_" in braces, as in {customer}.`,
    );
  }
  if ((DATE_PARTS as readonly string[]).includes(name)) {
    return { kind: 'date', part: name as DatePart };
  }
  if (!names) {
    return { kind: 'field', name };
  }
  if (names.fields.has(name)) {
    return { kind: 'field', name };
  }
  if (names.variables.has(name)) {
    return { kind: 'variable', name };
  }
  throw new PatternError(
    `"{${name}}" is neither a field of the record (${[...names.fields].join(', ') || 'none can be used'}) nor a variable (${[...names.variables].join(', ')}).`,
  );
}

/** The fields and variables a pattern reads. */
export function namesIn(parts: PatternPart[]) {
  return {
    fields: parts.flatMap((part) => (part.kind === 'field' ? [part.name] : [])),
    variables: parts.flatMap((part) =>
      part.kind === 'variable' ? [part.name] : [],
    ),
  };
}

/** A part's text, the counter aside; an unknown field or variable prints as its braced name. */
function printed(part: Exclude<PatternPart, { kind: 'counter' }>, values: PartValues) {
  switch (part.kind) {
    case 'text':
      return part.text;
    case 'date':
      return values.date[part.part];
    case 'variable':
      return values.variables?.[part.name] ?? `{${part.name}}`;
    case 'field':
      return values.fields?.[part.name] ?? `{${part.name}}`;
  }
}

/**
 * What the pattern prints around its counter, for a record at a moment:
 * `INV-2026-ACME-{#}`. The counter is keyed by it, as Frappe keys by the
 * prefix: a series restarts when a date part changes (each month with
 * `MM`), each value of a field in it counts on its own (`{customer}`), and
 * two patterns that print the same share one counter, so they never give
 * the same number twice (`INV-.####` and `INV-.#####` included).
 */
export function counterKey(parts: PatternPart[], values: PartValues) {
  return parts
    .map((part) => (part.kind === 'counter' ? '{#}' : printed(part, values)))
    .join('');
}

/** The number a counter value makes: `INV-2026-ACME-00042`. */
export function renderPattern(
  parts: PatternPart[],
  value: number,
  values: PartValues,
) {
  return parts
    .map((part) =>
      part.kind === 'counter'
        ? String(value).padStart(part.width, '0')
        : printed(part, values),
    )
    .join('');
}

/**
 * A field's value as a number prints it: trimmed, spaces as `-`, only
 * letters (any script), digits, `-`, `_` and `/`, at most
 * MAX_FIELD_VALUE_LENGTH characters. Undefined when nothing is left: the
 * record has no value to number by.
 */
export function printValue(value: unknown): string | undefined {
  if (value === null || value === undefined || typeof value === 'object') {
    return undefined;
  }
  const text = String(value)
    .trim()
    .replaceAll(/\s+/g, '-')
    .replaceAll(/[^\p{L}\p{N}_\-/]/gu, '')
    .slice(0, MAX_FIELD_VALUE_LENGTH);
  return text === '' ? undefined : text;
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
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  // The calendar day in the zone, as a UTC date: day of year and ISO week.
  const date = Date.UTC(year, month - 1, day);
  const dayOfYear = (date - Date.UTC(year, 0, 1)) / 86_400_000 + 1;
  return {
    YYYY: String(year),
    YY: String(year).slice(-2),
    MM: String(month).padStart(2, '0'),
    DD: String(day).padStart(2, '0'),
    JJJ: String(dayOfYear).padStart(3, '0'),
    WW: String(isoWeek(date)).padStart(2, '0'),
  };
}

/** The ISO 8601 week of a UTC midnight: the week with the year's first Thursday is 1. */
function isoWeek(date: number) {
  const day = new Date(date).getUTCDay() || 7;
  // The Thursday of the date's week decides its year.
  const thursday = new Date(date + (4 - day) * 86_400_000);
  const firstDay = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.floor((thursday.getTime() - firstDay) / 86_400_000 / 7) + 1;
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
