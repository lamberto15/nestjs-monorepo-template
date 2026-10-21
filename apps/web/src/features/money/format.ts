/**
 * Money on screen follows docs/money.md: amounts are decimal strings (never a
 * JS number), shown with the currency's own decimals and always the `latn`
 * numbering system; the currency comes from the amount, never the locale.
 */
export function formatAmount(
  amount: string,
  currency: string,
  language: string,
): string {
  try {
    return new Intl.NumberFormat(language, {
      style: 'currency',
      currency,
      numberingSystem: 'latn',
    }).format(amount as unknown as number);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** A currency's name in the UI's language ("US Dollar"), else its code. */
export function currencyName(code: string, language: string): string {
  try {
    return (
      new Intl.DisplayNames(language, { type: 'currency' }).of(code) ?? code
    );
  } catch {
    return code;
  }
}

/** A rate to show: the decimal string as is, digits in `latn`. */
export function formatRate(rate: string, language: string): string {
  try {
    return new Intl.NumberFormat(language, {
      numberingSystem: 'latn',
      minimumFractionDigits: 0,
      maximumFractionDigits: 10,
    }).format(rate as unknown as number);
  } catch {
    return rate;
  }
}
