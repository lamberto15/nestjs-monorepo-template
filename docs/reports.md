# Scheduled reports

An export a user or an API client asks for once, run for them on a
schedule, its file mailed to the recipients with a download link.
`apps/api/src/platform/reports/`; any `DataExporter` ([data-transfer.md](data-transfer.md))
can be scheduled, nothing to add to a feature.

**`REPORTS=off`** ([configuration.md](configuration.md#deployment-switches))
leaves the module out: no `/v1/reports` (404), no hourly runner, no report mails. Exports and
imports are unaffected; a feature's `transfer` capability keeps working.

```http
POST /v1/reports
{ "name": "Weekly drafts", "exporter": "notes", "format": "xlsx",
  "filters": { "status": "draft" }, "sort": "-createdAt,title", "timezone": "Asia/Manila",
  "schedule": { "every": "weekly", "weekday": 1, "hour": 8 },
  "recipients": ["team@example.com"] }
```

| Route                                     | Does                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET /v1/reports`                         | your reports (cursor pages; `?active=`, `?exporter=`, `?sort=nextRunAt`)           |
| `POST /v1/reports`                        | schedule one (201, audited `report.created`)                                       |
| `GET`, `PATCH`, `DELETE /v1/reports/{id}` | one of yours (another's: 404); `report.updated`, `report.deleted`                  |
| `POST /v1/reports/{id}/run`               | run it now: 202 with the transfer id (`GET /v1/data/transfers/{id}`), `report.ran` |

- **Owner-scoped**: a report is its creator's (`user:<id>` or
  `client:<id>`) and runs as them: the export is what `POST /v1/data/exports`
  would give them (their read filter, their field-level permissions),
  checked again when each run starts and on the worker.
- **A report is a list saved**: its `filters` (the list's flat filters, `filter`
  JSON, `q`) and its `sort` (the list's `?sort=`, null: newest first; `PATCH`
  with `null` clears it) are stored and replayed on every run, so each file
  holds what that list showed, in that order (the exporter pages by keyset on
  the sort: [data-transfer.md](data-transfer.md)). The web's "Schedule
  report" on a list page sends all three.
- **Checked on create and update** as an export is: an exporter the owner
  may run (`GET /v1/data`), else a 400 on `exporter`; its filters and sort
  (`filters.<field>`, `sort`; a filter on a field the owner's permissions hide is
  a 403 `field_forbidden`, and a run that meets one is skipped); an IANA `timezone` (default: the user's own, else
  `APP_TIMEZONE`); at most 20 `recipients` (default: the user's own
  address; an API client names them). At most 20 active reports per
  owner (a 400 on `active` past it, on create or reactivation).
- **Recipients are addresses the owner vouches for**: any address, inside
  the organization or not, is mailed the owner's data; nothing confirms
  it. One mail per run: the owner's own address (a user's, when listed)
  is its `To`, every other recipient is in `Bcc`, so they don't see each
  other.
- **Schedules**, no cron: `{ every: 'daily', hour }`,
  `{ every: 'weekly', weekday: 0-6, hour }` (0 Sunday),
  `{ every: 'monthly', day: 1-28, hour }`, on the wall clock of the
  report's zone (`report-time.ts`: daylight-saving changes followed, a
  skipped hour moves to the next). The file's dates are in that zone too.
- **The runner** (`ReportRunnerJob`, every hour at :10, one instance)
  starts the active reports whose `nextRunAt` passed. Each run is claimed
  first: one transaction moves `nextRunAt` past that moment (only where it
  is still the value read, so a second runner claims nothing) and stores
  the transfer id; then the export starts (an export that can't start
  undoes the claim: next hour tries again). After downtime a report runs
  once, not once per missed hour. The export's audit entry
  (`data.export-started`) carries `{ report, trigger: 'schedule' }`. A report whose owner was deactivated, or may no longer run
  its export, is made inactive (`report.deactivated`, with the reason);
  one whose filters no longer parse skips that run (`report.skipped`).
  Those, and `report.finished`, are the runner's: the system principal
  `system:report-runner`; the export runs as its owner.
- **The mail**: when the export finishes (`DataTransferRegistry.onFinished`,
  the transfer tagged `report:<id>`), the recipients get `ReportReadyMail`
  or `ReportFailedMail`, once per transfer (the mail job's id is
  `report-<transferId>`), in the owner's language (a client's: the
  default one). `lastStatus` is the last run's (`lastTransferId`): a
  superseded run's end still mails, but changes nothing; each end is
  audited `report.finished`.
- **The link** works `REPORT_LINK_TTL` (default `24h`, at most `7d`).
  It is a bearer link: whoever holds the mail (forwarded, a shared inbox)
  downloads the file until then, without signing in, and the file itself
  stays in storage. Longer suits weekly readers, shorter limits a leak.
- **A worker that dies mid-run**: BullMQ fails the export after its
  stalled-job limit, without running it again; the worker that applies
  that failure tells the listeners (`DataTransferProcessor.onFailed`), so
  the failure mail goes all the same.
- **Tenancy** ([tenancy](tenancy.md)): the hourly runner walks the tenants
  one at a time (`Tenancy.forEachTenant()`, logging each); a report's owner
  must still be a member of the report's tenant, or the report is made
  inactive (`owner_inactive`), and its export runs in that tenant.
