# Data quality

Missing business values, references to deleted records and duplicates are
hard to see one record at a time. The data-quality checks find them across a
tenant's records, in a background scan, and list each one to act on. Nothing
here changes a record: a person fixes it where it lives, or dismisses the
finding as right as it is.

Code: `apps/api/src/platform/data-quality/`; the web page
`apps/web/src/features/data-quality/` (`/data-quality`).

## What is checked

| Check       | Severity   | Finds                                                                     |
| ----------- | ---------- | ------------------------------------------------------------------------- |
| `missing`   | suggestion | a recommended field left empty (null, or text that is blank once trimmed) |
| `duplicate` | suggestion | a field whose value, whatever its case, another live record has too       |
| `reference` | error      | a `ref` field pointing at a record in the recycle bin                     |

An **error** is wrong as it stands; a **suggestion** may be right (a note with
no text yet, two customers who share a name). A reference to a record that
does not exist can't happen: the key refuses it (record-relations.ts); one
deleted for good empties (optional) or blocks the delete (required).

## Declaring the checks

A declared record (`<item>.record.ts`) says which fields it checks; its `ref`
fields are always checked:

```ts
export const CUSTOMER = defineRecord({
  // …
  quality: { recommended: ['email', 'phone'], duplicates: ['name'] },
  fields: { … },
});
```

`recordParts()` registers it (`RecordDataQuality`); no other code. A
hand-written feature registers its own target in `DataQualityRegistry` (notes:
`note-quality.ts`): its table, id and recycle-bin column, and the columns of
each check. The checks are the platform's.

## Scans

`POST /v1/data-quality/scans` (`DataQuality.manage`) answers 202 and runs on
the `data-quality` queue in the tenant that started it: one job per batch of
500 records (`SCAN_BATCH`), each queuing the next, subject after subject, so
no job runs long and a retried batch does no harm. The scan records its
`total` (records when it started) and `scanned` so far: `GET /v1/data-quality`
shows it as `lastScan` with the open findings per subject, and the page shows
the progress and when the last scan finished.

- A finding that still holds is kept (its `checkedAt` moves); one the scan no
  longer finds is deleted when its subject is done. A dismissed finding stays
  dismissed while it holds.
- One scan at a time per tenant: another while one runs is a 409
  `scan_running`. One queued or running for over an hour is taken as lost (its
  worker gone) and a new one may start; a batch that fails its last attempt
  marks the scan `failed`.
- Audited: `data-quality.scan-started`.

## Findings

`GET /v1/data-quality/subjects/{subject}/findings` pages a subject's open
findings (`dismissed=true`: the dismissed ones; `severity`, `check` filter).

- **Who sees what.** `DataQuality.read`, then the subject's own read
  permission: only findings on records the caller may read (`sqlFilter`), and
  never on a field their permissions hide or show on some records only
  (`unmatchableFields`): a finding would tell whether the value is empty or
  shared. The summary counts the same way. Rows are tenant rows behind
  row-level security ([tenancy](tenancy.md)).
- **Dismiss** (`POST …/findings/{id}/dismiss`, `DataQuality.manage`): right as
  it is. Audited `data-quality.finding-dismissed`.
- **Recheck** (`POST …/findings/{id}/recheck`): checks the finding's record
  again now and answers `{ resolved, finding }`; the record's other findings
  come up to date with it.

No seed role grants `DataQuality.*`: administrators give it in a role
([permissions](permissions.md)).
