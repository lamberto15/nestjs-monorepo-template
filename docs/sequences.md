# Sequences: human-readable numbers

`INV-2026-00042`, `T-000017`: gapless numbers for the records people quote,
next to the UUID the API keys them by. `apps/api/src/platform/sequences/`; notes
carry a `number` as the example.

```ts
// in the write's transaction
const { value, formatted } = await this.sequences.next(tx, 'note', {
  prefix: 'NOTE', perYear: true, width: 5,   // NOTE-2026-00042
  scope: teamId,                            // a series per team (default: one series)
});
```

- One counter per tenant, sequence name and scope (plus the year with
  `perYear`, in `APP_TIMEZONE`), in the `sequences` table: each tenant
  numbers its own series ([tenancy](tenancy.md)), so tenant A's
  `NOTE-2026-00001` and tenant B's are two numbers, and neither learns how
  many the other took. The counter's row is
  locked until the commit: two writes never get the same number, and a
  rollback leaves no gap. A busy series serializes its writes on that row;
  that is the price of no gaps (a UUID pays none), so number what people
  need numbered, not every row.
- `sequences.current(name, { scope, perYear })` shows the last number
  taken; never number with it.
- The number is the feature's column (`notes.number`, unique per tenant), set on
  create and never changed; list, filter and export it like any field.

A generated feature takes this with the `numbered` capability
(`pnpm feature:add --with numbered`, or `'numbered'` in its
`<item>.record.ts`): `number: { prefix: 'INV', perYear: true, width: 5 }`
declares the format (sequence name: the record's key, `invoice`), the
platform adds the nullable `number` column (unique per tenant), assigns it in
the create transaction (`RecordLifecycle.creating()`), and shows it in
responses, the list (`?number=`, `?sort=number`), the PDF and exports. It is
never in a create or update body.

## Naming series: the formats administrators define

The declared format numbers a subject until a tenant's administrators
(`Access.manageNamingSeries`) define **naming series** for it, as in
Frappe: several per numbered subject, one the default, at
`/v1/naming-series` (the web app's Administration → Numbering).
`apps/api/src/platform/sequences/naming-*.ts`.

```text
INV-.YYYY.-.MM.-.#####        →  INV-2026-10-00042        (restarts each month)
CN-.YY.-.####                 →  CN-26-0007               (restarts each year)
T-.######                     →  T-000017                 (never restarts)
SO-.{region}.-.YY.-.####      →  SO-EU-26-0012            (one counter per region)
.ABBR.-.FY.-.#####            →  HQ-2026-2027-00003       (the tenant's, its fiscal year)
```

- **Patterns** are parts between dots:
  - text (letters, digits, `-`, `_`, `/`);
  - the date parts `YYYY`, `YY`, `MM`, `DD`, `JJJ` (day of the year),
    `WW` (ISO week), in `APP_TIMEZONE`;
  - **variables**, as Frappe's `naming_series_variables`: `FY`, the fiscal
    year (`numbering.fiscalYearStart`, a tenant setting: 1 prints `2026`,
    4 prints `2026-2027` from April), `ABBR`, the tenant's abbreviation
    (`numbering.abbreviation`, else its slug in capitals), and any a
    feature declares (below); `GET /v1/naming-series/variables` lists them;
  - **the record's own fields** in braces, `{region}`, from its create
    body: text, enum, number, date and datetime fields (a datetime prints
    its date); `GET /v1/naming-series/subjects` lists each subject's. A
    value prints as one token (spaces as `-`, only letters of any script,
    digits, `-`, `_`, `/`, at most 40 characters). A record whose value
    prints nothing is refused (400 at that field), never numbered
    `SO--26-0001` as Frappe would;
  - exactly one counter, a run of `#` whose length is the zero-padding.

  Variables and date parts are also written in braces, as Frappe's
  `format:` rules do (`{FY}`). At most 60 characters, 12 digits. Next to
  the counter there is no digit, date part, variable or field
  (`NOTE-1.#`, `INV-.{customer}.###` are refused): it could merge with the
  counter, and two counters could print the same number. Overlaps that
  remain (two series of a subject whose texts line up around different
  counters) are the administrator's to avoid: the record's unique number
  refuses the second.
- **The counter is keyed by what the pattern prints around it** for the
  record at the moment (`SO-EU-26-{#}`), as Frappe keys by the prefix: a
  date part that changes starts a new counter, each value of a field gets
  its own, and two patterns that print the same (`INV-2026-.####` and
  `INV-.YYYY.-.#####`) share one, so they never give the same number. The
  counters stay in `sequences`, gapless and locked in the write's
  transaction as above. Per-value counters are never cleaned up, as in
  Frappe: print fields with few values (a region, a type), not a title.
- **Dates from the record** (`dateField`, as ERPNext's posting date): a
  series may take its date parts and `FY` from one of the record's date
  or datetime fields (an invoice's date) instead of the moment it is
  created; a record without the value falls back to now.
- **Choosing**, in this order:
  1. the series the create body names (`namingSeriesId`; never an
     update's, nor an import's);
  2. **rules** (Frappe's Document Naming Rule): the first series, by
     `priority` (higher first, then the oldest), whose `conditions` all
     hold for the body, each `{ field, op, value }` with `op` one of
     `eq`, `ne`, `gt`, `gte`, `lt`, `lte` (numbers compared as numbers,
     dates and text as text; a value the body leaves out meets only
     `ne`);
  3. the subject's default;
  4. the declared format.

  A subject's first series becomes its default; deleting the default makes
  the oldest one left the default, or the declared format when none is.
  Records keep the numbers they were given whatever happens to the series
  or their fields later: a number is never recomputed.
- **Taking over the declared format**: a series that prints what the
  declared format prints (`NOTE-.YYYY.-.#####` for notes) carries on its
  counter: after `NOTE-2026-00042` comes `00043`, never a second `00001`.
  `GET /v1/naming-series/subjects` lists each subject's declared pattern.
- **The counter** (`GET`/`PUT /v1/naming-series/{id}/counter`): this
  period's key, the last value taken, the next number; `PUT { current }`
  starts it at a value (numbers carried on from another system), never
  below what is taken (409), audited as `namingSeries.counterSet`. With
  fields in the pattern, `PUT { current, values: { region: 'EU' } }` sets
  that value's counter, and `GET` shows them as `{region}`.
  `POST /v1/naming-series/preview { subject, pattern, dateField?, values? }`
  answers the same for a pattern not saved yet, for a record with
  `values`.

A feature numbers through `NamingSeriesService`, never `sequences.next()`
directly (that would skip the tenant's series and their counters):
RecordLifecycle registers a generated `numbered` record and passes the
create body (`this.lifecycle.creating(tx, dto)`); a hand-written service
registers its subject in its constructor, as notes do:

```ts
namingSeries.register({
  subject: 'Note', sequence: 'note',
  declared: { prefix: 'NOTE', perYear: true, width: 5 },
  fields: { title: 'text' },   // what a series may print, date by or test
});
// in the create's transaction: the body's values
const { formatted } = await this.namingSeries.next(tx, 'Note', { seriesId: dto.namingSeriesId, values: { title: dto.title } });
```

A generated record's fields are its declaration's (`numberingFields()`,
platform/records), the body passed as it is. A feature adds a variable
from a constructor, as Frappe's hook does:

```ts
namingSeries.declareVariable({
  name: 'REGION', description: "The warehouse's region code",
  resolve: async ({ values }) => (await this.warehouses.find(values.warehouseId as string)).region,
});
```

`resolve` gets the subject, the moment and its date parts, and the body;
what it returns prints as a field value does, and nothing is a 400.

Not like Frappe: fields of linked records (`ref` fields print nothing,
declare a variable instead), custom fields, and a bare `.field.` (fields
are always in braces, so a field can never be read as text).
