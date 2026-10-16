/**
 * ISO 4217 currencies and their exponent: how many decimal places their
 * minor unit has (EUR 2: cents; JPY 0; KWD and BHD 3: fils).
 *
 * An explicit table, not `Intl.NumberFormat().resolvedOptions()`: Intl's
 * digits come from CLDR, which differs from ISO 4217 where amounts are
 * stored (CLDR gives ALL, IRR, LBP, RSD… 0 digits, ISO 4217 gives them 2).
 * Stored minor units must follow the standard, never a display convention.
 * Active codes of ISO 4217 list one (fund codes included); the codes
 * without a minor unit (gold XAU, the SDR XDR, testing XTS…) are left out:
 * they aren't money a feature stores.
 */

/** The currencies whose minor unit isn't 1/100. Every other listed code: 2. */
const EXPONENTS: Record<string, number> = {
  // No minor unit.
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  UYI: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  // Thousandths.
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
  // Unidad de Fomento, the unidad previsional: ten-thousandths.
  CLF: 4,
  UYW: 4,
};

const TWO_DECIMALS =
  `AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BMD BND BOB
  BOV BRL BSD BTN BWP BYN BZD CAD CDF CHE CHF CHW CNY COP COU CRC CUP CVE CZK
  DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GTQ GYD HKD HNL HTG
  HUF IDR ILS INR IRR JMD KES KGS KHR KPW KYD KZT LAK LBP LKR LRD LSL MAD MDL
  MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD
  PAB PEN PGK PHP PKR PLN QAR RON RSD RUB SAR SBD SCR SDG SEK SGD SHP SLE SOS
  SRD SSP STN SVC SYP SZL THB TJS TMT TOP TRY TTD TWD TZS UAH USD USN UYU UZS
  VED VES WST XCD XCG YER ZAR ZMW ZWG`
    .split(/\s+/)
    .filter(Boolean);

const CURRENCIES: ReadonlyMap<string, number> = new Map([
  ...TWO_DECIMALS.map((code) => [code, 2] as const),
  ...Object.entries(EXPONENTS),
]);

/** Every code, sorted: for a picker, or a schema's enum. */
export const CURRENCY_CODES: readonly string[] = [...CURRENCIES.keys()].sort();

/** An ISO 4217 code this module knows (`EUR`). A string checked by `isCurrency()`. */
export type CurrencyCode = string & { readonly __currency: unique symbol };

/** Whether `code` is a known ISO 4217 code, in capitals. */
export function isCurrency(code: unknown): code is CurrencyCode {
  return typeof code === 'string' && CURRENCIES.has(code);
}

/** An unknown or malformed currency code. */
export class UnknownCurrencyError extends Error {
  readonly code = 'unknown_currency';
  constructor(readonly currency: unknown) {
    super(`Unknown currency: ${String(currency)}`);
    this.name = 'UnknownCurrencyError';
  }
}

/** `code` as a CurrencyCode, or an UnknownCurrencyError. */
export function currency(code: string): CurrencyCode {
  if (!isCurrency(code)) {
    throw new UnknownCurrencyError(code);
  }
  return code;
}

/** The decimal places of `code`'s minor unit: 0, 2, 3 (or 4 for CLF, UYW). */
export function currencyExponent(code: string): number {
  const exponent = CURRENCIES.get(code);
  if (exponent === undefined) {
    throw new UnknownCurrencyError(code);
  }
  return exponent;
}
