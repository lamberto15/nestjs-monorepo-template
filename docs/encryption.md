# Encrypted columns

Personal data the database should never hold in clear (tax numbers, national ids,
phone numbers, bank details) goes in an **encrypted column**: AES-256-GCM with the
deployment's keys, bound to its table, column and tenant, with an optional **blind
index** to find rows by value. Roadmap item 5; what is still open is at the end.

Code: `apps/api/src/core/encryption/` (the cipher, the column registry,
`EncryptionService`) and `apps/api/src/platform/encryption/` (the re-encryption job).

## Declaring a column

```ts
// customers.tables.ts
export const customers = pgTable(
  'customers',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),
    taxNumber: encryptedText('tax_number'),
    taxNumberIndex: blindIndexText('tax_number_index'), // only to look rows up by value
    ...timestamps(),
  },
  (t) => [
    ...tenantTable('customers', t),
    index('customers_tax_number_idx').on(t.tenantId, t.taxNumberIndex),
  ],
).enableRLS();

encrypted(customers.taxNumber, {
  blindIndex: customers.taxNumberIndex,
  normalize: normalizers.exact, // email, text, exact, phone (E.164)
});
```

Then `pnpm db:generate` as for any table. `encrypted()` is the registry: it runs
at import time, next to the table, and

- adds the column to the list the boot check, the re-encryption job and its metric walk;
- declares the column's property name (`taxNumber`) to the log redaction
  ([deployment.md](deployment.md), "Log redaction"): a row logged by mistake shows
  `[REDACTED]` there.

The table needs an `id` (the job pages by it). Both columns are `text`.

Keep an encrypted column out of a `searchVector()`: a ciphertext in a `tsvector`
finds nothing.

## Writing and reading

Services do it where they write and read the column (the service owns the logic;
the binding needs the tenant, which the scope gives):

```ts
constructor(private readonly encryption: EncryptionService) {}

await tx.insert(customers).values({ name, ...this.encryption.seal(customers.taxNumber, taxNumber) });
const rows = await db.select().from(customers).where(this.encryption.lookup(customers.taxNumber, taxNumber));
const plain = this.encryption.decrypt(customers.taxNumber, rows[0].taxNumber);
```

- `seal()` gives the ciphertext and the blind index by their row properties
  (`{ taxNumber, taxNumberIndex }`), for an insert or an update; `null` stays `null`.
- `lookup()` is the condition matching the blind index under **every** configured
  index key, so rows not yet re-indexed after a rotation are found too.
- `decrypt()` throws a `DecryptionError` (`malformed`, `unknown_format`,
  `unknown_key`, `authentication_failed`) when a value doesn't open; never with the
  value in it.
- A tenant table's values need a tenant: the current scope's, or the `tenantId`
  argument (a job working for one). A table of no tenant binds none.

## The stored format

`v1.<key id>.<iv>.<ciphertext>.<tag>` (base64url parts), the shape of the packages'
sealed values.

- **`v1` is the format version**, and it says what the additional data (AAD) binds:
  `v1|<table>.<column>|<tenant id>`. A value copied to another tenant, column or table
  fails to open. A value swapped between two rows of one tenant's column still
  opens: binding to the row needs its id before the insert (app-side UUIDv7, decision
  3 in the roadmap). That would be `v2`: every value names its format, so `v1` rows
  keep opening and the re-encryption job rewrites them, without a format break. The
  version is inside the AAD too, so a value can't be relabelled.
- **The key id is the key version**: the first 6 characters of the derived key's hash,
  so the key list needs no ids. The first key encrypts, every key decrypts.
- A blind index is `<key id>.<HMAC-SHA-256>` of `v1|table.column|tenant|<normalized
value>`: the same value in two tenants or columns gives unrelated indexes.
- Keys are derived with HKDF-SHA-256 under labels of their own, so one key string
  never gives the same bytes to the cipher and the index; the app still refuses the
  same key in both lists.
- A renamed table or column changes the binding: keep the old name with
  `encrypted(column, { aad: 'old_table.old_column' })`.

## Keys

| Variable | What |
| --- | --- |
| `DATA_ENCRYPTION_KEYS` | the data keys, newest first, comma-separated (`openssl rand -base64 32` each, at least 32 characters) |
| `BLIND_INDEX_KEYS` | the blind-index keys, the same way; none of the data keys |

Both are secrets (`_FILE` works; Compose mounts `data_encryption_keys` and
`blind_index_keys`). **The app never creates them and never keeps them in the
database**: a key next to its ciphertext protects nothing in a backup. Boot is
refused when a column is declared encrypted and `DATA_ENCRYPTION_KEYS` is unset, or
a column has a blind index and `BLIND_INDEX_KEYS` is unset. `pnpm setup` writes both.

## Rotating a key

1. Put the new key **in front** of the list and redeploy. New writes use it; old
   values still open.
2. The **re-encryption job** moves the rows over within the hour: `ReencryptionScheduler`
   (every hour at :20, one instance, as `system:reencryption`) queues one job per
   tenant and column with stale rows on the `reencryption` queue; each job rewrites
   one batch of 500 in id order and queues the next. A row is written back only where
   it still holds the value read (`… WHERE id = $1 AND tax_number = <old>`), so a
   request's write in between is never overwritten. A batch that dies is retried; a
   row stays stale until rewritten, so the next schedule finds what is left.
3. Watch **`encrypted_rows_on_old_key{column}`** on the workers' `/metrics`. At 0,
   remove the old key and redeploy. A value that stays is one that doesn't open
   (its key already gone): the job logs its column, row id and reason, never the value.

The job changes no value anyone sees: no audit entry, no revision.

## Not covered yet (roadmap item 5)

- The MFA, webhook and idempotency ciphers live inside `@nestjs/authentication`,
  `@nestjs/webhooks` and `@nestjs/idempotency`, with their own keys; they don't take
  a pluggable cipher, so their values aren't in this registry or this job.
  `MFA_ENCRYPTION_KEYS` still auto-creates in `app_secrets` when unset.
- Revisions, audit `changes`, exports and custom fields' JSONB don't consult the
  registry yet; the template declares no encrypted column of its own (the tests'
  fixture `test_encrypted_records` does).
- Retention rules and legal holds.
