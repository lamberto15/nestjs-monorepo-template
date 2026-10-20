# Sequences: human-readable numbers

`INV-2026-00042`, `T-000017`: gapless numbers for the records people quote,
next to the UUID the API keys them by. `apps/api/src/platform/sequences/`; notes
carry a `number` as the example.

```ts
// in the write's transaction
const { value, formatted } = await this.sequences.next(tx, 'note', {
  prefix: 'NOTE', perYear: true, width: 5,   // NOTE-2026-00042
  scope: teamId,                            // a series per unit (default: one series)
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
INV-.YYYY.-.MM.-.#####   →  INV-2026-10-00042   (restarts each month)
CN-.YY.-.####            →  CN-26-0007          (restarts each year)
T-.######                →  T-000017            (never restarts)
```

- **Patterns** are parts between dots: text (letters, digits, `-`, `_`,
  `/`), the date parts `YYYY`, `YY`, `MM`, `DD` (in `APP_TIMEZONE`), and
  exactly one counter, a run of `#` whose length is the zero-padding. At
  most 60 characters, 12 digits. Next to the counter there is no digit or
  date part (`NOTE-1.#` is refused): it would merge with the counter, and
  two counters could print the same number. Overlaps that remain (two
  series of a subject whose texts line up around different counters) are
  the administrator's to avoid: the record's unique number refuses the
  second.
- **The counter is keyed by what the pattern prints around it** at the
  moment (`INV-2026-10-{#}`), as Frappe keys by the prefix: a date part
  that changes starts a new counter, and two patterns that print the same
  (`INV-2026-.####` and `INV-.YYYY.-.#####`) share one, so they never give
  the same number. The counters stay in `sequences`, gapless and locked in
  the write's transaction as above.
- **Choosing**: a numbered record's create body takes `namingSeriesId`
  (never an update's, nor an import's); left out, the subject's default.
  A subject's first series becomes its default; deleting the default makes
  the oldest one left the default, or the declared format when none is.
  Records keep the numbers they were given whatever happens to the series.
- **Taking over the declared format**: a series that prints what the
  declared format prints (`NOTE-.YYYY.-.#####` for notes) carries on its
  counter: after `NOTE-2026-00042` comes `00043`, never a second `00001`.
  `GET /v1/naming-series/subjects` lists each subject's declared pattern.
- **The counter** (`GET`/`PUT /v1/naming-series/{id}/counter`): this
  period's key, the last value taken, the next number; `PUT { current }`
  starts it at a value (numbers carried on from another system), never
  below what is taken (409), audited as `namingSeries.counterSet`.
  `GET /v1/naming-series/preview?subject=&pattern=` answers the same for a
  pattern not saved yet.

A feature numbers through `NamingSeriesService`, never `sequences.next()`
directly (that would skip the tenant's series and their counters):
RecordLifecycle registers a generated `numbered` record and passes the
create body (`this.lifecycle.creating(tx, dto)`); a hand-written service
registers its subject in its constructor, as notes do:

```ts
namingSeries.register({ subject: 'Note', sequence: 'note', declared: { prefix: 'NOTE', perYear: true, width: 5 } });
// in the create's transaction
const { formatted } = await this.namingSeries.next(tx, 'Note', { seriesId: dto.namingSeriesId });
```

Not yet: record fields in a pattern (Frappe's `.{field}.`), fiscal years.
