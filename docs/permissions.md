# Permissions

CASL (`@casl/ability`) decides; `@nestjs/authorization` policies ask it.
Nothing is hard-coded per role: features **declare** what can be done, and
roles in the database combine it.

## Declaring

```ts
export const NOTE_PERMISSIONS = definePermissions({
  subjects: {
    Note: {
      label: 'Notes',
      fields: { body: { label: 'The text' } },            // restrictable one by one
      conditions: {
        mine: createdBy('ownerId', notes.ownerId),       // "Created by me"
        inMyUnits: inMyUnits('orgUnitId', notes.orgUnitId),
        draft: { label, description, casl: () => ({ status: 'draft' }), sql: () => eq(notes.status, 'draft') },
      },
      actions: {
        read: { label: 'See notes', conditions: ['mine', 'inMyUnits'] },
        update: { label: 'Change notes', conditions: ['mine', 'draft'] },
      },
    },
  },
  clientPermissions: [...],   // what every API client may do
  seedRoles: [{ key: 'editor', name: 'Editor', permissions: [...] }],
});
```

Add it to `IamModule.forRoot({ permissions })`. `GET /v1/access/catalog` lists
everything, for the roles screen.

## Checking

| Where | How |
| --- | --- |
| The route | `@Can(NotePolicy, 'create')` |
| One record | `authorization.authorize(NotePolicy, 'read', user, note)` |
| A list | `access.sqlFilter(user, 'Note', 'read')`: a SQL condition, so lists never load what they'd hide |
| Fields read | `access.redact(user, 'read', 'Note', note)` / `redactAll()` |
| Fields written | `access.forbiddenFields(user, 'update', 'Note', changes, note)` → 403 `field_forbidden` |

Every condition has a CASL form (one record) and a SQL form (lists).

### Approvals

The platform's `Approval` subject (docs/approvals.md): `read`, `cancel` and
`manage` (abandoning a stuck approved request), each with the condition
`ofSubject`, and `managePolicies`. `Approval.read` shows approval
requests with their payloads and titles **whatever the record's own
subject lets its holder read**: an `Approval.read` of `Expense` shows the
amounts of expenses its holder can't open. Grant it as read access to
those records. Taking part in a request needs no permission.

### Deleted records (soft delete)

For a soft-deletable subject (its resource declares `softDelete`, e.g.
Note), `access.sqlFilter()` adds "not deleted" to every filter it returns,
and `access.can()` refuses every action on a deleted record but `restore`.
The recycle bin is `sqlFilter(principal, subject, 'restore', { deleted: true })`:
deleted rows the principal may restore, under that action's conditions
(`mine`…). See docs/adding-a-feature.md, step 5.

## Roles and grants

- `/v1/access/roles`: roles of permissions. A permission may carry
  conditions and `fields` (absent: all; `[]`: none of the restrictable ones).
- You can only grant what you hold without conditions (fields included).
  `Administrator` is built in (`all.manage`); the last active one stays.
- Grants to users and API clients may end: `roleExpiresAt: { roleId: date }`.
  Expired grants never count; cached abilities never outlive them.
- Changes apply on the next request, on every instance (the invalidation is
  published through Redis).

## Organization hierarchy

Org units form a tree (`/v1/access/org-units`; a closure table, so "under X"
is one lookup at any depth). Users belong to units (`orgUnitIds`). The
`inMyUnits(field, column)` condition grants what is in a user's units and
every unit below: a lead of "Sales" sees "Sales / North / East". Moving a
unit moves everything under it.

Other trees (categories, folders): `closureTable()` and `Tree` in
`core/database/tree.ts`.

## The system principal

Work that runs without a user acts as **the system principal**, never as
"anonymous" or a made-up actor: the first-boot seed, every cron job, the
outbox relay's notification delivery, workflow steps (approvals, the
notes' publication), and later SCIM (2), AI calls (15) and the demo
seed (10). It is a third principal kind next to `user` and `client`:

| | user | client | system |
| --- | --- | --- | --- |
| `principalKey()` | `user:<id>` | `client:<id>` | `system:<job>` (`system:account-deletion`) |
| Permissions | its roles | `clientPermissions` + its roles | what its job declares, nothing more |
| Audit label | the email | the client's name | `System: <job's label>` |
| Authenticates over HTTP or a socket | yes | yes | **never** |

**Declare the job** in its group's or feature's `definePermissions()`,
with what it may do, as for an API client (conditions read with the job
as the principal):

```ts
export const NOTE_PUBLICATION_JOB = defineSystemJob({
  key: 'note-publication',
  label: 'Note publication',
  description: 'Publishes draft notes when their delay passes.',
  permissions: [{ subject: 'Note', action: 'update', conditions: [{ key: 'draft' }] }],
});
// definePermissions({ subjects, …, systemJobs: [NOTE_PUBLICATION_JOB] })
```

Nothing is implicit: `all.manage` is refused at startup, as is an unknown
subject, action or condition, or a key twice. `permissions: []` is for a
job that checks none (a retention job keeping its own tables): any
service it calls that does check refuses it. `GET /v1/access/catalog`
lists every job (`systemJobs`: key, actor, label, permissions). The
template's: `seed`, `audit-retention`, `soft-delete-purge` (IAM,
`iam/iam.jobs.ts`); `account-deletion`, `usage-rollup`,
`attachment-sweep`, `revisions-retention`, `notification-retention`,
`notification-digests`, `notification-delivery`, `report-runner`,
`approvals`, `exchange-rates`, `mail-intake`, `mail-events-retention` (platform,
`platform/platform.jobs.ts`); `note-publication` (notes); `demo-seed` (the
demo seed, `src/demo/demo.jobs.ts`, [development](development.md), "Demo data").

**Run it** with `SystemContext.run()`, the one way in:

```ts
constructor(private readonly system: SystemContext, private readonly audit: AuditService) {}

run() {
  return this.system.run(AUDIT_RETENTION_JOB, async (system, tx) => {
    …                                              // one transaction
    await this.audit.record(system, { action: 'audit.pruned', … }, tx);
  });
}
// A batch job commits in short transactions of its own:
this.system.run(JOB, async (system) => { … inTransaction(…) … }, { transaction: false });
```

It opens a CLS context (nestjs-cls' `ClsService.run()`, its way for work
outside a request) carrying the principal (`system.current()`), and the
transaction unless `{ transaction: false }`. A nested run sees the inner
job; the outer context stays as it was. An undeclared job throws.
Multi-tenancy (1a) adds the tenant to the same call
(`run(job, work, { tenantId })`), so the transaction adapter sets
`app.tenant_id` for every query of the job.

**Where it acts** (and the audit's actor):

| Work | Actor | Audit entries |
| --- | --- | --- |
| First start (AccessSeeder) | `system:seed` | `user.seeded` |
| Audit retention | `system:audit-retention` | `audit.pruned` (count, cut-off), when it deleted any |
| Recycle bin purge | `system:soft-delete-purge` | `records.purged` per batch (the ids), with the purge |
| Account deletion | `system:account-deletion` | `account.deleted`, with the anonymization |
| Attachment sweep | `system:attachment-sweep` | `attachments.swept` per round (the ids), with the rows |
| Scheduled reports | `system:report-runner` | `report.skipped`, `report.deactivated`, `report.finished`; the export itself runs, and is audited, as the report's owner |
| Approvals workflow | `system:approvals` | the workflow's own (`approval.escalated`, `.expired`, `.failed`…); its outcome handlers get it as `outcome.actor` |
| Note publication workflow | `system:note-publication` | `note.updated` (draft → published); an approval it asks for is on the owner's behalf |
| Demo seed (`pnpm db:seed:demo`, development databases only) | `system:demo-seed` | everything it writes (`org-unit.created`, `user.created`, `tag.created`, `note.created` on its users' behalf, `tags.changed`, `comment.added`, `attachment.added`), then `demo.seeded` |
| Notification delivery (outbox), usage roll-up, revision and notification retention, digests | `system:<job>` | none (no change a person would audit) |

The system principal never acts within a request: a request that ends
approvals for someone (an administrator deactivating an approver, a
manager abandoning a stuck request) records the request's principal as
the actor of what follows (`approver_removed`, `approval.failed`, the
outcome handler's `outcome.actor`); inside a job (account deletion) it is
that job. The engine throws rather than fall back to `system:approvals`
when neither is given. The approval timeline's `actor` is the same key.

**What never takes it**, by type (`RequestPrincipal` = user | client) and
at run time:

- **HTTP and sockets.** `PrincipalGuard`, the authentication module's guard
  (`globalGuard: false`, registered in IamModule in its place), refuses a
  system principal any credential provider returns: 401
  `system_principal_refused`; the realtime handshake refuses it too. No
  provider makes one today (they load users and clients), and a token
  whose subject isn't a user id is no one (401, not a database error).
- **Data.** Only `systemPrincipal()` in code makes one (a private
  symbol marks it): `kind: 'system'` read from JSON (a token, a queued
  job, a stored owner) gets no permissions, and never the cached ability
  of the real one.
- **Queued jobs** (exports, imports, bulk operations): their principal
  travels as JSON, so they take a `RequestPrincipal` and refuse the system
  (`assertRequestPrincipal`). A job that needs an export calls the
  exporter itself.
- **Per-principal keys.** Idempotency scopes refuse it (requests only);
  realtime rooms refuse it (`Realtime.toPrincipal()` to it does nothing);
  usage is per API client only; `notify()` drops `system:` recipients and
  `subscribe()` ignores it (it gets no notifications); report owners are
  users or clients. Settings resolve for it as for nobody in particular
  (global values, rollouts hashed on `system:<job>`). It may own records
  (`createdBy` reads `system:<job>`).

## Audit

`audit.record(actor, { action, targetType, targetId, details }, tx)` for
anything sensitive; work without a user passes the system principal
(above), never `null`. For entities: declare `defineResource({ subject,
audit: {} })` and call `audit.recordChange(actor, NOTE, { action, id,
before, after }, tx)`: creates and deletes record the values, updates
record only what changed (from → to); `sensitive` fields are redacted;
`audit: { expand: ['custom'] }` diffs an object field key by key
(`custom.region`, see [custom fields](custom-fields.md)).
`GET /v1/access/audit` filters by action, actor, target, time. A nightly job
deletes entries older than `AUDIT_RETENTION_DAYS`.
