/**
 * The pure rules of push and SMS, apart from the services so they can be
 * read and tested alone (docs/notifications.md, "Push and SMS").
 */

/** The words that opt a number out, as carriers and Twilio's default list have them. */
const STOP_WORDS = new Set([
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
]);
/** The words that re-enable a number that opted out. */
const START_WORDS = new Set(['START', 'YES', 'UNSTOP']);

/**
 * What an inbound text means: the whole message is the keyword (case and
 * surrounding space ignored), as the carriers' rules read it; anything else
 * ("please stop", "yes I will") is not a command.
 */
export function inboundKeyword(body: string): 'stop' | 'start' | null {
  const word = body.trim().toUpperCase();
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  return null;
}

/**
 * The longest allowed prefix a number starts with (`+44` for `+447700900123`),
 * or null when none matches: the toll-fraud allowlist. A prefix is `+` and
 * digits; a malformed entry never matches.
 */
export function allowedPrefix(
  phone: string,
  allowed: readonly string[],
): string | null {
  let best: string | null = null;
  for (const prefix of allowed) {
    if (!/^\+[1-9]\d{0,5}$/.test(prefix) || !phone.startsWith(prefix)) continue;
    if (best === null || prefix.length > best.length) best = prefix;
  }
  return best;
}

/** `text` cut to at most `max` characters, ending in an ellipsis when it was cut. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** `text` cut to at most `max` UTF-8 bytes, on a character boundary. */
export function clipBytes(text: string, max: number): string {
  if (Buffer.byteLength(text) <= max) return text;
  let out = '';
  for (const char of text) {
    if (Buffer.byteLength(out + char + '…') > max) break;
    out += char;
  }
  return `${out}…`;
}

/** A phone number with all but its country prefix and last two digits hidden. */
export function maskPhone(phone: string): string {
  return phone.length <= 6
    ? '••••'
    : `${phone.slice(0, 3)}${'•'.repeat(phone.length - 5)}${phone.slice(-2)}`;
}

/** The UTC calendar day, `YYYY-MM-DD`: what the daily caps count by. */
export const utcDay = (now: Date) => now.toISOString().slice(0, 10);

/** The UTC month's first day, `YYYY-MM-01`: the row the monthly spend counts in. */
export const utcMonthStart = (now: Date) =>
  `${now.toISOString().slice(0, 7)}-01`;

/** The first day of the month before `now`'s, `YYYY-MM-01`. */
export const previousMonthStart = (now: Date) =>
  utcMonthStart(
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
  );

/**
 * How many SMS segments (the unit carriers bill) a text takes: 160 characters
 * in one segment, 153 each when split, or 70 and 67 when any character is
 * outside ASCII (UCS-2). Conservative for the GSM extras (£, €), which it
 * counts as non-ASCII.
 */
export function smsSegments(text: string): number {
  // Code points, and whether any is beyond ASCII.
  let length = 0;
  let unicode = false;
  for (const char of text) {
    length += 1;
    if (char.charCodeAt(0) > 0x7f) unicode = true;
  }
  const [single, multi] = unicode ? [70, 67] : [160, 153];
  return length <= single ? 1 : Math.ceil(length / multi);
}

/**
 * What one SMS costs, in minor units: the segments times the prefix's price
 * (`prices`), else `fallback`.
 */
export function smsCost(
  text: string,
  prefix: string,
  prices: Readonly<Record<string, number>>,
  fallback: number,
): number {
  return smsSegments(text) * (prices[prefix] ?? fallback);
}

/** The text of a verification code (also what the cost of the code job is estimated from). */
export const verificationText = (code: string) =>
  `Your verification code is ${code}. It expires in 10 minutes.`;
