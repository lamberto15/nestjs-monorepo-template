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
      names: { singular: 'Note', plural: 'Notes' },        // how texts name its records
      fields: { body: { label: 'The text' } },            // restrictable one by one
      conditions: {
        mine: createdBy('ownerId', notes.ownerId),       // "Created by me"
        inMyTeams: inMyTeams('teamId', notes.teamId),
        draft: { label, description, casl: () => ({ status: 'draft' }), sql: () => eq(notes.status, 'draft') },
      },
      actions: {
        read: { label: 'See notes', conditions: ['mine', 'inMyTeams'] },
        update: { label: 'Change notes', conditions: ['mine', 'draft'] },
      },
    },
  },
  clientPermissions: [...],   // what API clients may do by default (a generated feature: clientAccess)
  seedRoles: [{ key: 'editor', name: 'Editor', permissions: [...] }],
});
```

Add it to `IamModule.forRoot({ permissions })`. `GET /v1/access/catalog` lists
everything, for the roles screen, its texts in the request's language
([i18n](i18n-and-time.md)): `src/i18n/<locale>/permissions.json` holds them
by subject, under its name in kebab case, a feature's item key
(`mail-suppression.label`, `note.names.singular|plural`, `note.actions.<action>`, `.fields.<field>`,
`.conditions.<key>.label|description|input`, a feature's own jobs in
`.systemJobs.<key>`), so `pnpm feature:remove` takes them with the
feature's other texts; the shared conditions once (`conditions.mine`,
`conditions.inMyTeams`: a template's `translation`), and the groups'
system jobs (`systemJobs.<key>.label|description`). A text no catalog has
shows as declared (English): a generated feature's, until it adds its keys.
`names` (one record, several) is how other responses name the subject's
records, translated the same way (`PermissionCatalog.subjectNames()`: the
global search's `subjectLabel`); a generated feature's come from its
`noun` and `path`, a subject declared without them is named by itself. `src/i18n/permissions.spec.ts` checks the English
file says what the declarations say.

**Generated features** (`recordPermissions(RECORD, table)`) make both lists a
choice of the feature's `<item>.record.ts`, not code. `clientAccess: 'own'`
gives every API client its own records (create, read, change, delete);
the default, `clientAccess: false`, **denies clients by default**: they reach
the feature only through a role an administrator grants them. `grants:
'none'` leaves the seed roles (editor, team lead, viewer) without the
feature, so only administrators have it until someone grants it; the default
`'standard'` is editors their own, team leads their teams' (with `team`),
viewers read all. A client's permissions are code (a change reaches every
tenant on deploy); the seed roles are written when a tenant is made, so a
changed `grants` reaches only new tenants (docs/adding-a-feature.md,
"Changing a feature"). The hand-written notes example grants its clients as
before.

## Checking

| Where | How |
| --- | --- |
| The route | `@Can(NotePolicy, 'create')` |
| One record | `authorization.authorize(NotePolicy, 'read', user, note)` |
| What a reader may do with records (`?include=can`) | `recordCan(authorization, NotePolicy, user, rows, actions, flags)` (`platform/records/record-can.ts`): the same policy check per record and action, `authorization.can()`, in memory; `flags` for what is not one action (`issue`) |
| A list | `access.sqlFilter(user, 'Note', 'read')`: a SQL condition, so lists never load what they'd hide |
| Fields read | `access.redact(user, 'read', 'Note', note)` / `redactAll()` |
| Fields written | `access.forbiddenFields(user, 'update', 'Note', changes, note)` → 403 `field_forbidden` |
| Fields a list query uses | `access.assertQueryFields(user, 'Note', query)` after `list.parse()` → 403 `field_forbidden` (hidden, or shown on some records only and filtered, sorted or searched by) |

`GET /v1/auth/me`'s `can` says what the user may do on some records at
least (`Note.update`: a note of theirs, say); a record's own `can`
(`?include=can`, [api-conventions](api-conventions.md), "Resources") says
it per record: `{ update, delete, restore }`, each the policy the route
calls (`NotePolicy.update(user, note)`), so the conditions (`mine`,
`draft`), the recycle bin and the request's tenant and principal (an API
client's own permissions too) are the route's, and a `false` is the 403 the
route would answer. The ability is the request's, loaded once (cached per
tenant and principal): no query per row. Generated features get it from
`RecordPresenter` (`one(user, row, include)`, `page()`); a policy's own
rule (an override in `<x>.policy.ts`) is in it with nothing to add.

A subject with PDFs (the `pdf` capability, notes) adds `issue`: what
`POST …/{id}/pdf` checks before it queues, in its order
(`DocumentsService.issueFlag()`, a `CanFlag` of `recordCan()`): documents on
(`GOTENBERG_URL` set; unset, `issue` is `false`, where the route answers
503), the record readable (the policy's `read`; never one in the recycle
bin, which the route can't find), and the source's `canIssue` (false: the
route's 403). Generic sources and notes allow whoever may read; a feature
whose `canIssue` queries per record pays that query per row of an
`?include=can` page.

### Field-level permissions and lists

`redact()` takes a hidden field out of the items, but a filter on it would
still tell its values by which records match, one probe at a time. So
every list of a subject with declared fields refuses (403
`field_forbidden`) a query that uses a field the caller may read on **no**
record (`deniedFields()`): its flat filters, its `filter` tree at any
depth, `sort`, `fields` and `q` (`queryReads()` in
`core/http/list-query.ts` collects them; a list field's `reads` says which
record fields it reveals: `q` and `rank` the search document's, a money
field's currency filter the money field; `custom.<key>` also counts as
`custom`).

A field the caller may read on **some** of the records they may read only
(`conditionalFields()`: a rule reaches records without granting the field
on them, as `read` own notes with every field beside `read` the team's
with `fields: []`; or a rule with conditions forbids it) is refused the
same way in filters, `filter`, `sort` and `q` (`queryMatches()`): which
rows match, or their order, would tell its value on the records that hide
it. Selecting it (`fields=`) is allowed: `redact()` decides per record
what is shown. It is read from CASL's rules: `rulesFor(action, subject,
field)` (the rules for the field, the winning one first) and
`possibleRulesFor(action, subject)` (every rule of the action); the field
is shown wherever the action reaches when a rule without conditions grants
it, or when every rule of the action has the same conditions as one that
grants it. Administrators, grants without conditions and roles whose
reads all carry the field (`read` own notes, every field) are unaffected.
`GET /v1/lists/{subject}` describes such a field with no operators, not
sortable, still selectable, and `search: false` when `q` reads one.

Some queries match rows another action reaches, while what they show of
those rows is still what `read` grants: the recycle bin (`deleted=true`)
lists what the caller may `restore`, a bulk run selects what its action
(`delete`, `restore`…) reaches, an export what its exporter's `action`
does. The check takes that action (`assertQueryFields(…, { reach })`;
`RecordPresenter.query()` and the notes list pass `restore` for the bin,
bulk runs their action, exports and reports `exporter.action ?? 'read'`):
a field is matchable only when every rule of the reaching action has a
`read` grant of the field with the same conditions, or `read` grants it
without conditions. `read` own items with every field beside `restore`
the team's refuses `deleted=true&q=…`. `GET /v1/lists/{subject}`
describes the live list (`read`'s reach), not the recycle bin's.

A generated record's list route gets its query only through
`RecordPresenter.query()`, which calls `assertQueryFields`; notes' calls it
by hand; exports, bulk runs and scheduled reports check their filters the
same way (again in the job: permissions may have changed). The global
search (`GET /v1/search`) matches only the fields the caller may read on
every record they may read (`unmatchableFields()` left out), with a vector made per
request.

A sorted list's `nextCursor` holds the last row's sort values, so it is
sealed (AES-256-GCM, `CURSOR_KEYS`, bound to the sort): a client never
reads a value through it, whatever its permissions
(`core/http/cursor-seal.ts`).

**Residual risk:** none known for filters, sorts, search and cursors. The
price is precision: conditions are compared as written, so two that cover
the same records in different words count as different, and such a field
is refused even on the caller's own records. Give a role's reads of a
subject the same fields when its users need to filter by them.

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

Roles, grants, teams and the audit log are per tenant ([tenancy](tenancy.md)):
every tenant gets the built-in Administrator and the declared `seedRoles`
when it is made; a user's roles are their membership's in the tenant the
session acts in. `Access.manageTenants` (the tenants: list, create, read,
rename, deactivate) answers only in the operator tenant (`GET /v1/auth/me`'s
`tenant.operator`), and so does `Platform.breakGlass` (reading another
tenant read only, without its invitation: [tenancy](tenancy.md#break-glass)).
`Access.readConsolidated` reads the tenants below the session's in its tenant
tree, read-only (consolidated reports of a holding: [tenancy](tenancy.md),
"The tenant tree"); users only, never while impersonating.

The built-in `Access` permissions (`ACCESS_PERMISSIONS`,
`iam/access/permission-catalog.ts`; none takes conditions) and the one `Platform` permission:

| Permission | What it opens |
| --- | --- |
| `Access.manageRoles`, `manageUsers`, `manageClients`, `manageTeams` | roles; invitations, memberships, roles and teams of users; API clients and their keys; the team tree |
| `Access.readAudit` | the audit log and the sign-in log |
| `Access.impersonate` | acting as another user (support), never as an administrator |
| `Access.manageCustomFields`, `manageSettings`, `manageTags`, `manageNamingSeries`, `manageViews` | custom field definitions; settings and feature flags; tags; naming series and their counters; saved views shared with the tenant |
| `Access.manageRetention`, `manageLegalHolds` | retention rules; legal holds ([retention](retention.md)) |
| `Access.manageSso` | the tenant's SAML and OpenID Connect connections and verified domains ([auth](auth.md), "Enterprise SSO") |
| `Access.provisionScim` | SCIM 2.0 provisioning: API clients only, the identity provider's token ([auth](auth.md), "Enterprise SSO") |
| `Access.manageTenants`, `readConsolidated`; `Platform.breakGlass` | as above |

- **Reading** the access API (`GET` of the catalog, roles, users, teams,
  API clients, principals; one role, user or client by id) takes any
  permission of access administration (`AccessPolicy.open`: `Access.manageRoles`,
  `manageUsers`, `manageClients`, `manageTeams`, `impersonate` or
  `readAudit`): whoever manages teams lists them and their members, whoever
  impersonates finds whom. Changing takes the matching permission.
  The two lists the SSO page's pickers need, `GET` roles and users (not one
  by id), also admit `Access.manageSso` (`AccessPolicy.openForSso`), so an
  administrator holding only that reads them and still changes nothing.
  `GET /v1/access/users?teamId=<id>` (or `teamId.in=`) lists a team's own
  members (not those of the teams below); `GET /v1/lists/User` describes
  that list ([api-conventions](api-conventions.md), "List metadata").
- `/v1/access/roles`: roles of permissions. A permission may carry
  conditions and `fields` (absent: all; `[]`: none of the restrictable ones).
- You can only grant what you hold without conditions (fields included).
  `Administrator` is built in (`all.manage`); the last active one of each tenant stays.
- Grants to users and API clients may end: `roleExpiresAt: { roleId: date }`.
  Expired grants never count; cached abilities never outlive them.
- An ended grant is gone: the user and client lists never report it
  (`roleIds`, `roles`, a role's `members`), a change of roles deletes its
  row, and a role sent back in `roleIds` after its grant ended is granted
  anew, under the grant rule above (on yourself too), for good unless
  `roleExpiresAt` names an end. Without `roleExpiresAt`, the roles kept keep
  their ends; with it, every role not named in it has none. A kept role whose
  end moves (later, earlier or none) is a grant too.
- Changes apply on the next request, on every instance (the invalidation is
  published through Redis).

## Picking users and API clients

`GET /v1/access/principals` lists the tenant's members and API clients as
one cursor-paged list, for the pickers of whom a setting's value or a
flag is for (`scopeId: user:<id>`), an `actor` filter, and the like:

```
GET /v1/access/principals?q=ada&kind=user&limit=20
{ "items": [{ "id": "…", "key": "user:…", "kind": "user", "label": "Ada Lovelace", "email": "ada@example.com", "active": true }], "nextCursor": "…" }
```

- **Who:** the callers who may already list users and clients
  (`AccessPolicy.open`: any of `Access.manageRoles`, `manageUsers`,
  `manageClients`, `manageTeams`, `impersonate`, `readAudit`), as users (an API key is no credential on
  the access API, 401). Anyone else: 403. It shows nothing those two lists
  don't: the same people and clients, their name and address, which the
  access lists show to the same callers whole (no field-level rules apply
  to them).
- **Whose:** the current tenant's alone: users through their memberships
  in it (as `GET /v1/access/users`, inactive ones too: `active=true` to
  leave them out), clients through row-level security. No other tenant's
  user or client ever appears; an operator appears only as a member of a
  tenant, in that tenant. With `API_CLIENTS=off` no client is listed.
- **`q`:** a part of a user's name or address, or of a client's name,
  whatever the case; 1 to 200 characters (else 400). `%` and `_` are
  searched as the characters (escaped, as `contains` filters do). Also
  `kind=user|client`, `active`, `label.contains`, `sort=label` (whatever
  the case), `fields=`, `count=true`, `page=`, as every list
  ([api-conventions.md](api-conventions.md)).
- Rate-limited as every route (600 a minute per IP).

## The people directory

`GET /v1/people?q=` is the light lookup **any member** may read (a user
without a role too), for @mention autocomplete and the like
(`platform/people`):

```
GET /v1/people?q=may&limit=10
{ "items": [{ "key": "user:…", "name": "Maya Patel", "avatarUrl": null }] }
```

- **What:** a key (`user:<id>`, what `@user:<id>` mentions and what
  `author`, `changedBy`, `ownerId` hold), a name and the `avatarUrl` of their
  picture (null for none; [attachments.md](attachments.md), "Avatars"),
  nothing else: no address, no role, no status. Managing people stays on the access API.
- **Whose:** the current tenant's active members (an active account and an
  active membership in it), by name; never another tenant's, never an API
  client. `q` is a part of the name, whatever the case (1 to 100
  characters; `%` and `_` are the characters), `limit` 1 to 20 (default
  10). Users only: an API key is no credential here (401).
- **By key:** `GET /v1/people?key=user:<id>,client:<id>` names the keys a
  page already holds (a list's `ownerId` cells, a `?ownerId=eq.user:<id>`
  filter in the URL: the list metadata's `ref: principal`), in the order
  asked, each once:

  ```
  GET /v1/people?key=user:0198…,client:0199…
  { "items": [{ "key": "user:0198…", "name": "Maya Patel" }, { "key": "client:0199…", "name": "Billing sync" }] }
  ```

  Whom `names()` names (below): a user who is or was a member of the
  tenant (a deactivated one keeps their name: they still own records), an
  API client of the tenant (its name is already on what it wrote, a
  comment's `authorName`). Never an address, never another tenant's: a key
  the tenant has no one for (another tenant's user or client, a removed
  client, an unknown id) is left out of the answer, with no error, so it
  never tells such a key from one that doesn't exist. 1 to 20 keys, each
  `user:<uuid>` or `client:<uuid>` (else 400, `validation_failed`); `q`
  and `key` together are a 400 (one searches, the other names); `limit`
  doesn't apply.
- **Names on records:** comments carry `authorName` and `mentionNames`,
  revisions `changedByName` (`PeopleService.names()`, one query a page): the name of
  a user who is or was a member of the tenant, or of the tenant's API
  client; null for `anonymous`, `anonymized`, `unknown`, or anyone the
  tenant never had.

## The teams lookup

`GET /v1/teams` is the teams' counterpart (`platform/people`): **any
member** may read the tenant's teams, for the pickers and names of a list's
`ref: team` fields (`teamId`), where `GET /v1/access/teams` takes
`AccessPolicy.open`:

```
GET /v1/teams?q=north&limit=50
{ "items": [{ "id": "…", "name": "North", "parentId": "…", "depth": 1 }], "nextCursor": null }
```

- **What:** a team's id, name, parent and depth (0 at the top), nothing
  else: no members, no counts, no dates. Managing teams stays on
  `/v1/access/teams` (`Access.manageTeams`).
- **Whose:** the current tenant's teams alone (row-level security, and the
  query names the tenant too); never another tenant's.
- **Query:** `q`, a part of the name, whatever the case (1 to 100
  characters; `%` and `_` are the characters); `id=<id>,<id>` (1 to 100)
  the teams to name, an id the tenant has no team of left out; cursor
  pages, newest first (`limit` 1 to 100, default 50, the same with `id`:
  send at least as many as the ids; over 100 is a 400; `cursor` the
  previous page's `nextCursor`): read every page to build the tree from
  `parentId`. The route's Swagger description and its `limit` say so too.
  Anything else is a 400. Users only, as `GET /v1/people` (an API key:
  401).
- Rate-limited as every route.

## Organization hierarchy

Teams form a tree (`/v1/access/teams`; a closure table, so "under X"
is one lookup at any depth). Users belong to units (`teamIds`). The
`inMyTeams(field, column)` condition grants what is in a user's units and
every unit below: a lead of "Sales" sees "Sales / North / East". Moving a
unit moves everything under it.

Other trees (categories, folders): `closureTable()` and `Tree` in
`core/database/tree.ts`.

## The system principal

Work that runs without a user acts as **the system principal**, never as
"anonymous" or a made-up actor: the first-boot seed, every cron job, the
outbox relay's notification delivery, workflow steps (approvals, the
notes' publication) and the demo seed. SCIM is an API client's
work (`Access.provisionScim`) and an AI run acts as the principal who asked. It is a third principal kind next to `user` and `client`:

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
template's: `seed`, `audit-retention`, `soft-delete-purge`, `sign-up-tenant-sweep`, `tenant-deletion`, `sso` (IAM,
`iam/iam.jobs.ts`); `account-deletion`, `usage-rollup`,
`attachment-sweep`, `attachment-scan`, `attachment-images`, `revisions-retention`, `notification-retention`,
`notification-digests`, `notification-delivery`, `report-runner`,
`approvals`, `exchange-rates`, `mail-intake`, `mail-events-retention`, `webhook-delivery-retention`, `platform-analytics`,
`reencryption`, `retention`, `messaging`, `messaging-inbound`, `messaging-retention` (platform,
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
The tenant goes with the same call (`run(job, work, { tenantId })`;
`null` for no tenant; left out, the current context's), so every
transaction of the job carries `app.tenant_id` ([tenancy](tenancy.md)).

**Where it acts** (the audit's actor, and the tenant it works in):

| Work | Actor | Tenant | Audit entries |
| --- | --- | --- | --- |
| First start (AccessSeeder) | `system:seed` | the operator tenant it creates | `user.seeded` |
| Audit retention | `system:audit-retention` | each tenant in turn, then none (account-level entries) | `audit.pruned` (count, cut-off) in the log it pruned, when it deleted any |
| Recycle bin purge | `system:soft-delete-purge` | each tenant in turn | `records.purged` per batch (the ids), with the purge |
| Account deletion | `system:account-deletion` | each tenant the person belonged to (their data there), then none (the account) | `account.deleted` (no tenant), with the anonymization |
| Attachment sweep | `system:attachment-sweep` | each tenant in turn | `attachments.swept` per round (the ids), with the rows |
| Attachment malware scan (and its retry job, every five minutes) | `system:attachment-scan` | the upload's (the job's tenant); the retry job: each tenant in turn | `attachment.rejected` (signature) when the file is infected, with the deletion; `attachments.released` (the ids) when scanning is switched off and pending files are released |
| Attachment image processing (and its retry job, every five minutes) | `system:attachment-images` | the upload's (the job's tenant); the retry job: each tenant in turn | `attachment.processed` (renditions, metadata removed, size before and after) with the new rows |
| Scheduled reports | `system:report-runner` | each tenant in turn | `report.skipped`, `report.deactivated`, `report.finished`; the export itself runs, and is audited, as the report's owner |
| Approvals workflow | `system:approvals` | the request's (the workflow's input) | the workflow's own (`approval.escalated`, `.expired`, `.failed`…); its outcome handlers get it as `outcome.actor` |
| Note publication workflow | `system:note-publication` | the note's (the workflow's input) | `note.updated` (draft → published); an approval it asks for is on the owner's behalf |
| Demo seed (`pnpm db:seed:demo`, development databases only) | `system:demo-seed` | the demo tenant it creates | everything it writes (`team.created`, `user.seeded`, `tag.created`, `note.created` on its users' behalf, `tags.changed`, `comment.added`, `attachment.added`), then `demo.seeded` |
| Tenant deletion, unverified sign-ups' sweep | `system:tenant-deletion`, `system:sign-up-tenant-sweep` | each due tenant | `tenant.purged` outside any tenant (`details.reason`) |
| Retention rules | `system:retention` | each tenant in turn | `retention.purged` or `retention.anonymised` per batch (the ids) |
| Mail intake, mail events retention, exchange rates | `system:<job>` | none (global tables) | the intake's suppressions (`mailSuppression.*`, no tenant) |
| Notification delivery (outbox), usage roll-up, revision and notification retention, digests | `system:<job>` | the event's, or each tenant | none (no change a person would audit) |

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
`GET /v1/access/audit` filters by action, actor, target, time
(`GET /v1/lists/Audit` describes it, to whoever has `Access.readAudit`).
Who acted is a key (`actor=user:<id>`, a picker's from
`GET /v1/access/principals`) or a name or address
(`actorLabel`, `actorLabel.contains`, `actorLabel.startsWith`, whatever the
case, `%` and `_` as the characters): the label the entry stored (a user's
address, `admin as user`, a client's name, `System: …`), or the current
name or address of the member, or the name of the API client, the entry
names. Only members (a membership in the entry's tenant) and clients of
the entry's tenant are looked up, and only the caller's tenant's entries
are read: another tenant's people never match, and nothing is matched that
the access lists don't already show the caller (`readAudit` opens them).
Each entry also names its actor as they are called now (`actorName`): a
member or former member of the tenant, an API client of it, looked up for
the whole page at once (`AuditService.withActorNames()`, through the
`ACTOR_NAMES` token the platform provides with `PeopleService.names()`,
so IAM imports nothing of the platform); `null` for `system:<key>`,
`anonymous`, a deleted account or a removed client, where `actorLabel` is
what there is. `actorLabel` keeps what the entry stored when it was
written. The response is typed in OpenAPI (`AuditPage` of `AuditEntry`).
A nightly job deletes entries older than `AUDIT_RETENTION_DAYS`.
