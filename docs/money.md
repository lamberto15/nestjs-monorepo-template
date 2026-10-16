# Money and currency

`apps/api/src/platform/money/`: a library features import (amounts, rounding,
allocation, formatting, columns, schemas), and exchange rates (the ECB's,
fetched every working day, used to convert). Nothing in NestJS or the
installed packages does decimal money: `@nestjs/i18n`'s `formatNumber()`
takes a number or a bigint, not an exact decimal, so the formatting calls
`Intl.NumberFormat` itself; the fetch goes through `@nestjs/http-client`
and runs as a cron job of `@nestjs/schedule` with `@nestjs/locks`.

## The rules

- **Amounts are integers of minor units** (cents, fils, yen) with their
  ISO 4217 code: a `bigint` column and a `char(3)` one. 12.34 EUR is
  `1234`, 1200 JPY is `1200`, 1.234 KWD is `1234`.
- **Unit prices and rates are `numeric`**: they have more decimals than the
  minor unit (`0.0125` EUR a page). Drizzle reads `numeric` as a string.
- **Strings end to end.** The API sends and takes amounts as decimal
  strings in major units (`"12.34"`), typed `string` in OpenAPI; never a
  JSON number (a float in most clients). Code never builds money from a JS
  number with a fraction: `Money.of(0.1, …)` throws.
- **Currencies never mix.** Adding, subtracting or comparing EUR with USD
  throws a `CurrencyMismatchError` (`currency_mismatch`, 422 if it reaches
  a request). Convert first.
- **Rounding happens once, on purpose, by a named mode**, default
  `half-up`. Input with more decimals than its currency has is refused
  (400), never rounded silently.

## Amounts: `Money`

```ts
import { Money } from '../../platform/money/money.js';

const price = Money.of('19.99', 'EUR');           // exact; '19.999' throws AmountPrecisionError
const total = price.times(3);                      // 59.97 EUR
const vat = total.times('0.19');                   // 11.39 EUR (11.3943, half-up)
const net = Money.of('119', 'EUR').dividedBy('1.19'); // 100.00 EUR
const line = Money.fromDecimal(multiplyDecimals(unitPrice, quantity), 'EUR'); // a numeric price × quantity, rounded once
total.plus(vat).toJSON();                          // { amount: '71.36', currency: 'EUR' }
Money.ofMinor(row.totalMinor, row.totalCurrency);  // from the columns
```

| | |
| --- | --- |
| `Money.of(decimal, code)` | exact; more decimals than the currency's: `AmountPrecisionError` (trailing zeros are fine) |
| `Money.ofMinor(bigint, code)` | from minor units (a stored column) |
| `Money.fromDecimal(decimal, code, rounding?)` | any precision, rounded to the minor unit |
| `plus`, `minus`, `compare` | same currency, or `CurrencyMismatchError`; `equals` is false across currencies |
| `times(factor, rounding?)`, `dividedBy(divisor, rounding?)` | a decimal string or an integer; one rounding |
| `allocate(ratios)`, `split(n)` | see Allocation |
| `toDecimal()`, `toJSON()` | `"12.30"`, `{ amount, currency }`, always the currency's decimals |

**Currencies** (`currencies.ts`) are ISO 4217's list one with its exponents:
0 (JPY, KRW, VND, CLP, ISK, the CFA francs…), 2 (most), 3 (KWD, BHD, OMR,
JOD, IQD, LYD, TND), 4 (CLF, UYW). Not CLDR's display digits, which differ
(CLDR writes IRR, RSD or LBP without decimals; ISO 4217 has two). Codes
without a minor unit (XAU, XDR, XTS) aren't money a feature stores, and
aren't listed.

## Rounding

A parameter of every operation that can fall between two minor units
(`times`, `dividedBy`, `fromDecimal`, a conversion), and of
`GET /v1/money/convert?rounding=`:

| Mode | 2.5 | -2.5 | 2.4 | Use |
| --- | --- | --- | --- | --- |
| `half-up` (default) | 3 | -3 | 2 | invoices, VAT: ties away from zero |
| `half-even` | 2 | -2 | 2 | banker's: no drift over many roundings (interest, statistics), where a domain asks for it |
| `half-down` | 2 | -2 | 2 | |
| `up` / `down` | 3 / 2 | -3 / -2 | 3 / 2 | away from / toward zero |
| `ceiling` / `floor` | 3 / 2 | -2 / -3 | 3 / 2 | toward +∞ / −∞ |

Rounding is symmetric: `-x` rounds as the mirror of `x` (but `ceiling` and
`floor`). The arithmetic is bigint throughout (`decimal.ts`): every result is
computed as an exact fraction, then rounded once.

## Allocation

`amount.allocate(ratios)` splits without losing or making a minor unit
(largest remainder): each part gets the floor of its exact share, and the
units left over go one each to the parts with the largest remainders, ties
to the earlier part. Deterministic; the parts always add up to the amount; a
zero ratio gets zero; a negative amount splits as the mirror of its
absolute value. Ratios are integers or decimal strings (`'0.7'`).

```ts
Money.of('100', 'EUR').allocate([1, 1, 1]);   // 33.34, 33.33, 33.33
Money.of('0.10', 'EUR').allocate([1, 2]);     // 0.03, 0.07 (6.67 cents has the larger remainder)
Money.of('100', 'JPY').split(3);              // 34, 33, 33
```

## Formatting

```ts
formatMoney(Money.of('-1234.5', 'EUR'), 'de');   // -1.234,50 €
formatMoney(Money.of('1234.5', 'KWD'), 'ar-AE');  // ‏1,234.500 د.ك.‏
formatMoney(amount, i18nContext.locale);          // in a request (I18nContext), or the recipient's locale in mail and jobs
```

`Intl.NumberFormat` with the amount as a decimal string (formatted exactly,
however large), exactly the currency's ISO 4217 decimals, and **an explicit
numbering system**: always `latn` (0–9) unless you pass another, whatever
the runtime ICU's default for the locale (CLDR data: Arabic-Indic digits for
`ar-EG` in Node 22, Latin for `ar` and `ar-AE`, and it has changed between
CLDR versions). Pass `{ numberingSystem: 'arab' }` to have Arabic-Indic
digits. Also `currencyDisplay` (`symbol`, `narrowSymbol`, `code`, `name`) and
`currencySign: 'accounting'` (`($5.00)`). Tested in the five locales (en,
de, ar, zh, ms). The currency comes from the record, never from the locale.

## In a feature

**Table** (`money.columns.ts`):

```ts
export const invoices = pgTable('invoices', {
  id: uuidPk(),
  ...moneyColumns('total'),               // total_minor bigint, total_currency char(3), NOT NULL
  ...moneyColumns('discount', { nullable: true }),
  unitPrice: numeric('unit_price').notNull(),
  ...moneyColumns('totalEur', { nullable: true }), // a converted amount…
  ...conversionColumns('totalEur'),       // …with its rate, rate date and source
  ...timestamps(),
});
// write: { ...moneyValues('total', total), ...conversionValues('totalEur', conversion) }
// read:  moneyOf(row, 'total')
```

**Schemas** (`money.schemas.ts`): `moneySchema` for a body's money object
(`{ amount: "12.34", currency: "EUR" }`, at most the currency's decimals),
`moneyResponseSchema` for responses (`Money.toJSON()`), `decimalSchema` for
unit prices and quantities, `currencyCodeSchema`, `roundingSchema`.

**Errors**: the library throws its own errors (`CurrencyMismatchError`,
`AmountPrecisionError`, `UnknownCurrencyError`, `InvalidDecimalError`,
`RateUnavailableError`), which `money-errors.ts` maps to problem details
(`currency_mismatch` 422, `amount_precision` 400, `unknown_currency` 400,
`invalid_decimal` 400, `rate_unavailable` 422), translated in
`i18n/<locale>/money.json`.

## Exchange rates

**Source:** the ECB's euro foreign exchange reference rates, published
around 16:00 CET each TARGET working day: about 30 currencies against the
euro (USD, JPY, GBP, CHF, CNY, SGD, MYR…; not AED, KWD, SAR: converting
those is a `rate_unavailable`). Stored in `exchange_rates`: source (`ecb`),
day, base (`EUR`), currency, rate (`numeric`: units per euro). A
correction the ECB publishes for a day replaces the stored rate.

**The job** (`ExchangeRatesJob`, cron `7 * * * *` UTC on one instance, a
worker, as `system:exchange-rates`):

- nothing to do while the newest stored day is the one expected: today
  after 15:00 UTC on a weekday, else the working day before (one fetch a
  working day). On a TARGET holiday it reads the small daily document each
  hour after 15:00, finds nothing newer, and stores nothing (`current`);
- `eurofxref-daily.xml` normally; the 90-day history
  (`eurofxref-hist-90d.xml`) when nothing is stored or the newest stored day
  is more than five working days behind, and once when the daily document
  skipped a working day the table lacks (a short outage; also the day after
  a TARGET holiday, where it fills nothing). Only new or corrected rows are
  written, and the run reports how many;
- the ECB down, answering anything but a valid rates document (an impossible
  or repeated day, an element in an unexpected form, more than 1 MB), or a
  store that fails: a warning in the logs, the stored rates stay, the next
  hour tries again. The fetch itself retries 3 times
  (`@nestjs/http-client`), outside any transaction; the store is one
  transaction (a document is stored whole or not at all).

It runs in the worker like every cron job, not in a request, so it needs no
queue of its own. `EXCHANGE_RATES_FETCH=off` turns it off (an app without
money; the e2e tests, which stub the ECB on loopback).
`EXCHANGE_RATES_ECB_URL` points at a mirror.

**Staleness:** `exchange_rates_age_seconds` on `/metrics` is the age of the
newest stored day (from its 00:00 UTC; `+Inf` before the first fetch).
`ExchangeRatesStale` (warning) fires past six days for two hours: a Monday
morning is about four, Easter five.

**Converting** (`ExchangeRatesService.convert(amount, to, { day, rounding })`):

- through the euro (triangulation): USD → JPY is `amount × JPY/EUR ÷
  USD/EUR`, both legs of the same day, computed as one exact fraction and
  rounded once to the target's minor unit (no rounding of the euro amount
  in between);
- at the newest day on or before `day` (default today, UTC) that has both
  currencies: a weekend or holiday takes the working day before;
- the result carries what it was converted at: `rate` (target per source
  unit, to 10 decimals, half-up: to show and store; the amount comes from
  the exact legs), `rateDate`, `source`, `base` and both `legs`. Store
  them with the amount (`conversionColumns()`);
- the same currency converts to itself at `1`, source `identity`.

```ts
const conversion = await this.rates.convert(invoice.total, 'EUR', { day: invoice.issuedOn });
await tx.update(invoices).set({ ...moneyValues('totalEur', conversion.amount), ...conversionValues('totalEur', conversion) });
```

## Routes

Read-only, for any signed-in user or API client (`@Can.Anyone()`: the ECB's
rates are public, there is no record to permit). They let a client show a
conversion exactly as the server computes it instead of redoing it in
floats.

| Route | |
| --- | --- |
| `GET /v1/money/rates?date=2026-10-15` | the rates of the newest working day on or before the date (default today): `{ source, base, day, rates: { USD: "1.1652", … } }`; ETag; 404 `rates_unavailable` |
| `GET /v1/money/convert?amount=10&currency=USD&to=JPY[&date=][&rounding=]` | `{ from, amount, rate, rateDate, source, base, legs, rounding }`; 400 for an unknown currency or too many decimals, 422 `rate_unavailable` |

## Not here (yet)

- Other rate sources (a central bank for AED, a commercial feed with
  intraday rates): the table has a `source` and a `base` for them, and
  `convert({ source, base })` reads them; a second job would fetch them.
- History before the last 90 days: load `eurofxref-hist.xml` (the whole
  series since 1999) once with `ExchangeRatesService.store(parseEcbRates(…))`
  if a feature needs it.
- Per-tenant currencies and rounding settings arrive with tenancy (1a).
