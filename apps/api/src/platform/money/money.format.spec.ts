import { formatMoney } from './money.format.js';
import { Money } from './money.js';

/** Without bidi marks, and with Intl's no-break spaces as plain ones (they vary by ICU version). */
const plain = (text: string) =>
  text.replace(/[‎‏؜]/g, '').replace(/[  ]/g, ' ');

const ARABIC_INDIC = /[٠-٩۰-۹]/;

describe('formatMoney', () => {
  const eur = Money.of('-1234.5', 'EUR');
  const jpy = Money.of('1200', 'JPY');
  const kwd = Money.of('1234.5', 'KWD');

  it('writes each of the five locales with the currency’s own decimals', () => {
    expect(plain(formatMoney(eur, 'en'))).toBe('-€1,234.50');
    expect(plain(formatMoney(eur, 'de'))).toBe('-1.234,50 €');
    expect(plain(formatMoney(jpy, 'de'))).toBe('1.200 ¥');
    expect(plain(formatMoney(kwd, 'de'))).toBe('1.234,500 KWD');
    expect(plain(formatMoney(eur, 'zh'))).toBe('-€1,234.50');
    expect(plain(formatMoney(eur, 'ms'))).toBe('-€1,234.50');
    expect(plain(formatMoney(kwd, 'en', { currencyDisplay: 'code' }))).toBe(
      'KWD 1,234.500',
    );
    for (const locale of ['ar', 'ar-AE']) {
      const text = plain(formatMoney(eur, locale));
      expect(text).toContain('1,234.50');
      expect(text).toContain('€');
      expect(text).toMatch(/-/);
      expect(plain(formatMoney(kwd, locale))).toContain('1,234.500');
    }
  });

  it('uses Latin digits unless told otherwise, also where the locale’s default is Arabic-Indic', () => {
    for (const locale of ['ar', 'ar-AE', 'ar-EG', 'ar-SA']) {
      expect(formatMoney(eur, locale)).not.toMatch(ARABIC_INDIC);
    }
    expect(formatMoney(eur, 'ar-EG', { numberingSystem: 'arab' })).toMatch(
      ARABIC_INDIC,
    );
  });

  it('formats amounts beyond a double exactly', () => {
    expect(
      plain(formatMoney(Money.of('12345678901234567.89', 'EUR'), 'en')),
    ).toBe('€12,345,678,901,234,567.89');
  });

  it('writes negative amounts in parentheses with the accounting sign', () => {
    expect(
      plain(
        formatMoney(Money.of('-5', 'USD'), 'en', {
          currencySign: 'accounting',
        }),
      ),
    ).toBe('($5.00)');
  });
});
