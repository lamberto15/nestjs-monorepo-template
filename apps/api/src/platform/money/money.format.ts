import type { Money } from './money.js';

export interface MoneyFormatOptions {
  /** How the currency shows: `symbol` (€, the default), `narrowSymbol` ($ for any dollar), `code` (EUR), `name` (euros). */
  currencyDisplay?: 'symbol' | 'narrowSymbol' | 'code' | 'name';
  /**
   * The digits: always `latn` (0–9) unless asked, whatever the locale's
   * default in the runtime's ICU. That default is CLDR data, differs between
   * Arabic locales (`ar-EG` gives Arabic-Indic ٠–٩ in Node 22, `ar` and
   * `ar-AE` give 0–9) and has changed between CLDR versions, so it is never
   * relied on. Pass `arab` to choose Arabic-Indic digits.
   */
  numberingSystem?: string;
  /** `accounting` writes negative amounts in parentheses where the locale does. */
  currencySign?: 'standard' | 'accounting';
}

/**
 * `amount` written for `locale` (`en`, `de`, `ar-AE`…): `€1,234.50`,
 * `1.234,50 €`, `‏1,234.500 د.ك.‏`, with exactly the currency's ISO 4217
 * decimals. The decimal string goes to `Intl.NumberFormat` as a string,
 * which formats it exactly (no float on the way).
 *
 * In a request, pass the request's locale (`I18nContext.locale`); in mail
 * and jobs, the recipient's. @nestjs/i18n's `formatNumber()` takes a number
 * or a bigint only, which can't carry the fraction exactly, hence
 * `Intl.NumberFormat` here.
 */
export function formatMoney(
  amount: Money,
  locale: string,
  {
    currencyDisplay = 'symbol',
    numberingSystem = 'latn',
    currencySign = 'standard',
  }: MoneyFormatOptions = {},
): string {
  const digits = amount.exponent;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: amount.currency,
    currencyDisplay,
    currencySign,
    numberingSystem,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount.toDecimal() as `${number}`);
}
