# Retention rules and legal holds

Personal data is not kept forever, and some records must be kept whatever the
rules say. Roadmap item 5, second part (the first is [encryption.md](encryption.md)).

Code: `apps/api/src/platform/retention/` (rules, policies, the job) and
`apps/api/src/iam/holds/` (legal holds, in IAM because the recycle bin's purge
checks them).

## Retention rules

A feature **declares** how a kind of record ages, next to its service:

```ts
constructor(retention: RetentionRegistry) {
  retention.register({
    name: 'note',                 // the route key
    label: 'Notes',
    subject: 'Note',              // the permission subject, what a hold names
    table: notes,
    ageColumn: notes.createdAt,   // what dates a record
    action: 'purge',              // or 'anonymise'
    defaultDays: 730,
    minDays: 30,
  });
}
```

- `purge` deletes the rows, with what refers to them (`RecordPurgeRegistry`:
  comments, tags, watchers, revisions, as the recycle bin's purge does).
- `anonymise` keeps the rows and overwrites what identifies a person:
  `anonymise: { set: { email: null }, pending: isNotNull(t.email) }`. `pending`
  is the condition of a row not yet anonymised, so each row is written once.
- `where` limits which rows are ever due (a closed record, say).

A declared rule **does nothing** until a tenant turns it on. Retention is the
tenant's decision: `GET /v1/retention/rules` lists the rules with the tenant's
choice, `PUT /v1/retention/rules/{name}` sets `{ enabled, days }` (days not below
`minDays`; leave `days` out to keep them). Both need `Access.manageRetention`; a
change is audited (`retention.policy-changed`, from and to). The template
declares one rule, `note` (off until turned on); a feature with personal data
declares its own.

## The job

Never in a request. `RetentionScheduler` runs every night at 04:10 in
`APP_TIMEZONE` on one instance and, for every tenant (deactivated ones too) and
each enabled rule, queues a job on the **`retention`** queue. A job handles one
batch of 500 rows in the tenant's scope as `system:retention` and queues the
next while a batch comes back full:

- the batch's SQL leaves out held records (`notHeld()`), then the rows are
  locked (`FOR UPDATE SKIP LOCKED`) so a concurrent delete waits;
- each batch is one transaction with its audit entry, `retention.purged` or
  `retention.anonymised` (`rule`, `ids`, `retentionDays`) in the tenant's log;
- **resumable:** a handled row leaves the rule's condition, so a job that dies is
  retried and the next night finds what is left;
- the policy keeps `lastRunAt` and `lastCount` (shown by the list);
- when a hold keeps due rows, the first batch logs how many.

A hold placed while a batch's transaction runs applies from the next batch.

## Legal holds

A hold names a permission **subject** and one **record**, or no record to hold
every record of the subject in the tenant (also the ones made later). It stays
active until released; released holds stay in the list as the record of who held
what and why.

| Route (`Access.manageLegalHolds`) | |
| --- | --- |
| `POST /v1/legal-holds` `{ subject, recordId?, reason }` | place; audited `legal-hold.placed` |
| `GET /v1/legal-holds` | list; `?active=true`, `?subject=`, `?recordId=` |
| `GET /v1/legal-holds/{id}` | one |
| `POST /v1/legal-holds/{id}/release` `{ note? }` | release; audited `legal-hold.released`; 409 when released already |

An active hold:

- **blocks deletion:** `RecordStore.delete()` (every generated feature, the
  route and bulk delete alike) answers 409 `legal_hold`, recycle bin or not. A
  hand-written delete calls `LegalHoldsService.assertNotHeld(subject, ids, tx)`
  in its transaction (`notes.service.ts` does);
- **blocks the purge:** `SoftDeletePurgeJob` leaves a held record in the bin and
  the retention job skips it (both through `notHeld(subject, id)` in their SQL);
- **blocks an account deletion:** a hold with subject `User` and the person's id
  in any tenant they belong to keeps `AccountDeletionJob` from starting: the
  request stays open and cancellable, and the next night looks again.

Not covered: deleting a whole tenant (`TenantDeletionJob`) ignores holds, as the
tenant is the unit the owner removes; the data is exported before. Revisions,
audit entries, exports and report files already stored are not reached by
retention rules yet (roadmap item 5).

## Tenancy

Both tables are tenant tables (RLS, [tenancy.md](tenancy.md)): a hold and a
policy exist per tenant, the job works in one tenant's scope at a time, and one
tenant's rule never touches another's rows.

Proof: `apps/api/test/retention.e2e-spec.ts`, `retention.registry.spec.ts`,
`legal-hold.schemas.spec.ts`.
