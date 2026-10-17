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
