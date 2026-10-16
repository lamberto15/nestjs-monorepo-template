import { isCurrency } from './currencies.js';
import { DECIMAL_PATTERN, toDecimal } from './decimal.js';

/** One day of reference rates: units of each currency per 1 EUR, as decimal strings. */
export interface RatesOfDay {
  day: string;
  rates: Record<string, string>;
}

/** The ECB's answer isn't the reference-rates document it should be. */
export class EcbFormatError extends Error {
  constructor(message: string) {
    super(`ECB reference rates: ${message}`);
    this.name = 'EcbFormatError';
  }
}

const TIME = /<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']\s*>/g;
const RATE =
  /<Cube\s+currency=["']([A-Z]{3})["']\s+rate=["']([^"']+)["']\s*\/>/g;

/**
 * The days of an ECB euro foreign exchange reference rates document
 * (eurofxref-daily.xml: one day; eurofxref-hist-90d.xml: ninety), newest
 * first as the ECB lists them:
 *
 * ```xml
 * <Cube><Cube time='2026-10-15'><Cube currency='USD' rate='1.1652'/>…</Cube></Cube>
 * ```
 *
 * Custom code: no installed package reads XML, and this document is three
 * nested elements of attributes, read here strictly. Anything else (an
 * HTML error page, a malformed rate, a day without rates, an impossible
 * or repeated day, a currency twice, a Cube element in any other form) is
 * an EcbFormatError, so nothing half-read is stored. A currency this module
 * doesn't know (one ISO 4217 retired) is skipped.
 */
export function parseEcbRates(xml: string): RatesOfDay[] {
  if (!xml.includes('eurofxref')) {
    throw new EcbFormatError('not a eurofxref document');
  }
  const times = [...xml.matchAll(TIME)];
  if (times.length === 0) {
    throw new EcbFormatError('no day in the document');
  }
  // A day element written otherwise than the pattern reads would be skipped with its rates.
  if ((xml.match(/<Cube\s+time\b/g) ?? []).length !== times.length) {
    throw new EcbFormatError('a day element in an unexpected form');
  }
  const seen = new Set<string>();
  return times.map((time, index) => {
    const day = time[1];
    // Date.parse accepts 2026-02-30 (as March 2nd); PostgreSQL doesn't.
    const date = new Date(`${day}T00:00:00Z`);
    if (
      Number.isNaN(date.getTime()) ||
      date.toISOString().slice(0, 10) !== day
    ) {
      throw new EcbFormatError(`invalid day ${day}`);
    }
    if (seen.has(day)) {
      throw new EcbFormatError(`${day} appears twice`);
    }
    seen.add(day);
    const end = times[index + 1]?.index ?? xml.length;
    const body = xml.slice(time.index + time[0].length, end);
    const elements = [...body.matchAll(RATE)];
    // Every other Cube element of the day (another attribute order, an extra
    // attribute, a non-self-closing one) would be skipped silently: refuse.
    if ((body.match(/<Cube\b/g) ?? []).length !== elements.length) {
      throw new EcbFormatError(
        `a rate element in an unexpected form on ${day}`,
      );
    }
    const rates: Record<string, string> = {};
    const codes = new Set<string>();
    for (const [, code, rate] of elements) {
      if (!DECIMAL_PATTERN.test(rate) || toDecimal(rate).units <= 0n) {
        throw new EcbFormatError(`invalid rate ${rate} for ${code} on ${day}`);
      }
      if (codes.has(code)) {
        throw new EcbFormatError(`${code} appears twice on ${day}`);
      }
      codes.add(code);
      if (isCurrency(code) && code !== 'EUR') {
        rates[code] = rate;
      }
    }
    if (Object.keys(rates).length === 0) {
      throw new EcbFormatError(`no rates on ${day}`);
    }
    return { day, rates };
  });
}
