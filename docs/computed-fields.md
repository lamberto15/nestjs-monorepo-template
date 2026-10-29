# Computed fields

Totals, durations and derived statuses, declared once in a feature's
`<item>.record.ts` instead of written by hand in each service:

```ts
export const INVOICE = defineRecord({
  // …
  fields: {
    quantity: field.int(),
    unitPrice: field.money(),
    dueOn: field.date(),
    paidOn: field.date().optional(),
  },
  computed: {
    total: computed.money('quantity * unitPrice'),
    withTax: computed.money('round(total * 1.19, 2)'), // fails: round() takes numbers
    late: computed.bool('paidOn > dueOn'),
    status: computed.string("if(paidOn == null, 'open', 'paid')"),
  },
  capabilities: [],
});
```

The example's `withTax` doesn't load: the declaration is checked when it
loads, so a mistake is an error at startup (and in every test), never a
wrong value. `computed.money('total * 1.19')` is the valid form: money
times a number rounds once, half-up, to the currency's minor unit.

Code: `platform/records/record-computed.ts` (the declaration, its checks,
computing and hiding), `platform/expressions/expression.ts` (the language).

## What the platform does with them

| Where                                                      | Behavior                                                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Responses (`GET`, lists, writes' answers)                  | computed from the stored row each time a record is shown (`RecordPresenter`), after its fields; read-only (a body that sends one is ignored like any unknown key) |
| The response schema, OpenAPI, the client                   | each one, nullable and optional, described with its expression                                                                                                    |
| `?fields=`                                                 | selectable like a field                                                                                                                                           |
| Filters, sorts, `?q=`, the global search                   | **not** offered: there is no column to query. Store the value in a field (set by the service) when lists need it                                                  |
| Exports, imports, PDFs, webhooks, revisions, the audit log | **not** included: they carry the fields a computed field is computed from, so nothing is lost and a receiver's own permissions decide what it sees                |
| ETags                                                      | cover them; stable, since a value depends only on the row                                                                                                         |

**Recalculation:** none needed. A computed field is never stored, so a
change to a field it reads (or to its expression, on the next deploy)
shows on the next read. There is no clock in the language (`now()`,
`today()`): a value that changes with time alone would change a record's
ETag without a write; compute "days open" on the client, or store it.

## Permissions

A computed field must not tell a field its reader may not see. So on each
record, after field-level redaction (`access.redactAll`, docs/permissions.md):

- a computed field that reads, directly or through another computed field,
  a field redaction took out of that record is taken out too;
- a computed field can be restricted itself: name it in the policy's
  `fields` like a stored field, and those reading it hide with it.

Selecting one with `?fields=` is allowed, as for any field: redaction
decides per record. It can't be filtered, sorted or searched by, so no
probe by query is possible either.

## Types, money and dates

Each kind is the API type of the field kind of the same name:

| Kind       | In the API                 | The expression gives                                 |
| ---------- | -------------------------- | ---------------------------------------------------- |
| `int`      | a number                   | an int                                               |
| `decimal`  | a string (`"12.5"`), exact | an int or a decimal                                  |
| `money`    | `{ amount, currency }`     | money ([money](money.md): minor units, one currency) |
| `string`   | a string                   | a string                                             |
| `bool`     | a boolean                  | a bool                                               |
| `date`     | `2026-01-31`               | a date                                               |
| `datetime` | an ISO datetime (UTC)      | a datetime                                           |

Numbers are exact decimals (bigint), never floats: `0.1 + 0.2` is `0.3`.
A division keeps 10 decimals (half-up), a product at most 20. Money never
mixes currencies: adding EUR to USD can't be computed (below). Dates are
calendar days without a time zone; datetimes are UTC.

**Null:** a field it reads that is empty makes arithmetic, comparisons and
functions null, so the computed value is `null`; handle it with
`coalesce(paidOn, dueOn)` or `paidOn == null`. `and`, `or`, `not` and
`if()` read null as false. A value that can't be computed (a division by
zero, two currencies, a number out of range) is `null` too.

## The expression language

The same evaluator is meant for any rule declared in code or written by a
tenant (automation conditions): it is safe for untrusted input.

- **Safe:** a hand-written parser, no `eval`, `Function` or `vm`, no SQL:
  only the operators and functions below exist, and only the names it was
  compiled with can be read (an unknown one is an error).
- **Typed:** compiled once against the names and their types; a type
  error, an unknown name or function, or a syntax error fails the compile.
- **Bounded:** at most 2000 characters, 200 parts, 24 levels of nesting;
  no loops; numbers of at most 30 whole digits, strings of at most 10 000
  characters.
- **Deterministic and side-effect free:** no clock, randomness, locale or
  I/O.

| Syntax                           | Meaning                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `12`, `0.19`, `'text'`, `"text"` | numbers and strings (escapes: `\\`, `\'`, `\"`)                                |
| `true`, `false`, `null`          | literals                                                                       |
| `quantity`, `createdAt`          | a field (not JSON), `createdAt`/`updatedAt`, another computed field            |
| `+ - * /`, unary `-`             | numbers; money `±` money, money `*` or `/` a number, money `/` money (a ratio) |
| `== != < <= > >=`                | one type (an int compares with a decimal); `== null`; comparisons don't chain  |
| `and`, `or`, `not`               | bools                                                                          |

| Function                                                          | Gives                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------- |
| `if(condition, then, else)`                                       | `then` or `else` (one type)                             |
| `coalesce(a, b, …)`                                               | the first that isn't null                               |
| `round(x)`, `round(x, places)`                                    | half-up, `places` a literal 0 to 10                     |
| `floor(x)`, `ceil(x)`, `abs(x)`                                   | numbers (`abs` money too)                               |
| `min(a, b, …)`, `max(a, b, …)`                                    | numbers, money, dates, datetimes                        |
| `length(s)`, `lower(s)`, `upper(s)`, `trim(s)`, `concat(a, b, …)` | strings (locale-independent)                            |
| `text(x)`                                                         | any value as a string (`12.50 EUR`)                     |
| `daysBetween(a, b)`                                               | whole days from `a` to `b`: two dates, or two datetimes |
| `minutesBetween(a, b)`                                            | whole minutes between two datetimes                     |
| `addDays(date, n)`                                                | a date                                                  |
| `date('2026-01-31')`, `datetime('…Z')`                            | a date or datetime from a string                        |

From code:

```ts
import { compileExpression } from '../expressions/expression.js';

const rule = compileExpression("status == 'sent' and total > 100", {
  status: 'string',
  total: 'decimal',
});
rule.type; // 'bool'
rule.reads; // ['status', 'total']: check the caller may read each
rule.evaluate({ status: 'sent', total: '120.00' }); // true
```

`compileExpression` throws an `ExpressionError` (`code`: `syntax`,
`too_long`, `too_complex`, `too_deep`, `unknown_name`, `unknown_function`,
`type`; `position` in the source) and `evaluate` one (`division_by_zero`,
`currency_mismatch`, `out_of_range`, `invalid_value`) when a value can't be
computed. `evaluate` takes values as the API shows them and answers in the
API's form of its type.

## What a declaration may not do

`defineRecord` refuses, naming the field:

- a computed field that reads itself, directly or through others (a cycle:
  `a → b → a`);
- an expression that doesn't compile, or whose type isn't the kind declared;
- a name a field or the record already has (`id`, `ownerId`, `tags`,
  `custom`, `number`, the dates…).
