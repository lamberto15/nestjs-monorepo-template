# Tenancy

A **tenant** is a customer: a contract, a billing and legal boundary, and a hard
wall that PostgreSQL's row-level security (RLS) enforces. One customer is one
tenant, with all its teams and departments inside it (groups, roadmap item 25).
A holding whose subsidiaries must stay apart gets a tenant per subsidiary (the
tenant tree is roadmap 1b).

The test: a separate customer, whose data must never leak even through a bug,
is a tenant. A way one customer organizes itself is a group.

## The model

| Table | Kind | What it holds |
| --- | --- | --- |
| `tenants` | global | `slug`, `name`, `active`, `operator` |
| `users` | global | one account per address, in every tenant it belongs to |
| `memberships` | global, with `tenant_id` | which tenants a user belongs to, `active`, `selected_at` |
| `api_keys` | global, with `tenant_id` | keys are looked up by id before the tenant is known |
| `sessions`, `refresh_tokens`, two-factor, links | global | the person's; a session's tenant is `metadata.tenantId` |
| `notification_preferences`, `consents`, `account_deletions` | global | the person's |
| `idempotency_keys`, `locks`, `app_secrets`, `exchange_rates`, `mail_*`, `webhook_delivery_requests` | global | infrastructure (an idempotency key carries the tenant; a delivery's request is read only after its tenant-scoped delivery) |
| everything else | tenant table | `tenant_id NOT NULL`, RLS enabled and forced, four policies |

`audit_log` and `notifications` are tenant tables whose `tenant_id` may be null:
an account's own rows, written outside any tenant (a sign-in and its new-device
notification). Null audit rows are read only outside a tenant (no tenant's
administrator reads another person's sign-ins); null notification rows in every
scope, the code filtering by recipient as it always did.

What a membership may do lives in tenant tables: its roles (`user_roles`) and
teams (`user_teams`), whose keys reference the membership. API clients
belong to one tenant; their roles, keys and usage too.

## The wall

**Settings.** At the start of every transaction the pool (`TenantPool`,
`core/tenancy/tenant-pool.ts`) sends, with the `begin` in the same round trip:

```sql
select set_config('app.tenant_id', '<uuid>', true),
       set_config('app.read_tenants', '<uuid>[,<uuid>…]', true)
```

`true` is `SET LOCAL`: the values end with the transaction and never stay on a
pooled connection. They come from the scope of the current CLS context
(below); every value is a checked UUID. The hook sits in the pool rather than
the transaction adapter so that every transaction carries it: the transaction
host's, and a store's own `db.transaction()`.

**Policies** (`tenantPolicies()`, `core/tenancy/tenant-scope.ts`), declared with
each table so `pnpm db:generate` emits them; each setting is read once per
statement through a `(select current_setting(…))` subquery:

| Command | Rows |
| --- | --- |
| `SELECT` | `tenant_id = any(app.read_tenants)` |
| `INSERT`, `UPDATE` (both sides), `DELETE` | `tenant_id = app.tenant_id` |

There is no bypass clause: work across tenants runs as another role (below,
"The bypass").

An unset or empty setting matches no row: a connection without a tenant reads
nothing and writes nothing. `FORCE ROW LEVEL SECURITY` (which drizzle-kit
can't emit) is set by the role bootstrap (`core/database/roles.ts`, every
migrate), which also refuses to finish when a table with a `tenant_id` lacks
RLS, FORCE, or exactly its four policies (by name and command) with no other
permissive one (the two global tables excepted: `core/tenancy/global-tables.ts`).

**Outside a transaction.** A query through the pool outside a transaction that
names a tenant table, in a tenant's scope, runs in one of its own (`begin` with
the settings, the query, `commit`): reads through `database(txHost)` keep
working, each in a short transaction, and no connection is held across a
request's other awaits. A query on global tables alone goes straight through.

**Without a tenant.** A statement naming a tenant table with no tenant in its
scope is refused before it is sent, and before a client is checked out
(`TenantScopeMissingError`, in every environment); over HTTP it is 403
`tenant_required`. The policies would have answered with nothing (fail
closed); the refusal says why.

**Keys.** Keys between tenant tables are composite (`tenantReference()`):
PostgreSQL checks keys as the owner, past RLS, so a plain `x_id → id` could
point at another tenant's row. A table such a key points at declares
`tenantTable(…, { referenced: true })`, which adds the unique `(tenant_id, id)`
the key needs (only those: an index elsewhere would cost every insert). Uniques are per tenant (`(tenant_id, …)`), except the global account
identity (`users.email`).

**Roles.** `migrate` runs as the owner; api and worker as the app role, which is
no superuser, has no `BYPASSRLS`, owns nothing (docs/deployment.md, "Database
roles"). With FORCE, the owner is bound too (unless it is a superuser, as
Compose's is: it never serves a request). The worker also holds the
maintenance role (below).

## The tenant of the work

The scope lives in CLS (nestjs-cls), so the pool reads it without injection:

| Work | Its tenant |
| --- | --- |
| An HTTP request | the principal's, set by `PrincipalGuard` after authentication (the CLS middleware gives every request a context) |
| A socket message | the socket's principal's (`ClsInterceptor` on the gateway) |
| A queue job | its envelope's `tenantId` (`TenantWorkerHost` restores it) |
| An outbox message (notifications) | its payload's `tenantId` (`inTenantOf()`) |
| A workflow step | its input's or signal's `tenantId` |
| A cron job | each tenant in turn (`Tenancy.forEachTenant()`), or the bypass |
| Anything else | `SystemContext.run(job, work, { tenantId })`, `Tenancy.run(tenantId, work)` |

A transaction's tenant is fixed when it begins: `Tenancy.run()` refuses to
switch tenants inside an open transaction of another (start the transaction
inside instead).

**Principals.** A user's `tenantId` is the session's (or the token's `tid`) while
the membership in it, the tenant and the account are active; otherwise null,
and the user can only list their tenants and switch. An API client's is its
own, always.

**Async carries the tenant by type.** `TenantEnvelope` (`tenantId: string |
null`) is a required field of job data, outbox payloads, workflow inputs and
signals. The producer fills it from the scope: `withTenant(data)` where the
job's tenant is simply the context's; the record's own `tenantId` where the
work is about a record (a workflow's input, a document, a notification's
delivery); the principal's, checked against the scope, for a data transfer;
`null` only for an account's own work (a security notification, the account
export). The consumer restores it first (`inTenantOf(envelope, work)`, or a
`TenantWorkerHost` processor). A payload without it is refused, never run
without a tenant. A queued principal must act in the envelope's tenant, and is
checked again (`stillActive()`: still a member; for the account export, the
account still active).

**The bypass** (`Tenancy.bypass(job, work)`) opens every tenant's rows. It is not
a setting: its queries run as the **maintenance role** (`BYPASSRLS`,
`DATABASE_MAINTENANCE_URL`), on a small pool of its own that `TenantPool`
routes to in the bypass's scope. Only workers (and `migrate`, which creates the
role) hold its URL: an api process has no bypass at all, and no setting turns
one on. (An `APP_ROLE=all` process, as in development and the tests, holds both;
`Tenancy.bypass()` still refuses inside a request, and the metrics' read-only
aggregates are the only other user.) What the wall is not: SQL injected into a
request still runs as the app role and may set `app.tenant_id` and
`app.read_tenants` itself, to any tenant id it can read from the global
`tenants` table. Row-level security protects against bugs in correct queries
(a forgotten filter, a wrong join), not against injection, which parameters
prevent. It runs only in a process that
runs workers and has the role, never inside a request's context, logged. It is
for maintenance that sweeps a table whole by age (notification, revision,
usage retention); jobs that act per tenant, and audit what they did, walk the
tenants instead (`forEachTenant()`, which logs each run's tenant, carries on
past a failed tenant and reports every failure at the end: `TenantRunsFailed`;
`{ includeInactive: true }` walks deactivated tenants too, for retention).

**Metrics across tenants** (`MetricsService.collect(…, { acrossTenants: true })`:
the approvals' gauges) read as the maintenance role in read-only transactions,
so only where it is: the workers' `/metrics`; api replicas don't register them.

## Per-principal keys carry the tenant

Built in the platform code, never at call sites (`tenantKey()`):

| Key | Shape |
| --- | --- |
| Idempotency scope | `tenant:<tid>:<kind>:<id>` (a replay in tenant B never returns tenant A's response) |
| Realtime rooms | `tenant:<tid>:principal:<key>`; a user's account room `principal:user:<id>` for account-level events |
| Ability cache | `<tid>:<principal key>` |
| Sequences | rows per tenant (`(tenant_id, name, scope)`) |
| Settings | the `tenant` scope (was `global`); rollouts hashed with the tenant; caches per tenant |
| Usage counters | `tenant:<tid>:usage:<client>:<day>` |
| A principal's transfers and bulk runs (their lists) | `tenant:<tid>:jobs:<list>:<principal key>` (`JobIndex`; each job's own tenant checked again); a user's account exports, in no tenant, `account:jobs:data-transfers:account:<principal key>` |
| Stored files | `tenants/<tid>/…` (attachments, documents, transfers): a tenant's deletion and export are prefix operations |

## Accounts and sessions

- **One origin.** The session carries the tenant it acts in. A sign-in (any
  method) starts in the last chosen tenant, else the oldest membership
  (`DrizzleAuthenticationStore.createSession`). `GET /v1/auth/tenants` lists
  the user's tenants; `POST /v1/auth/tenant { tenantId }` re-issues the session
  in another (a new cookie; realtime connections reconnect). Token clients ask
  for a tenant when they sign in (`POST /v1/auth/token { tenantId }`); the
  tenant is the token family's `tid` claim.
- **Invitations: adding people is invite-only.** `POST /v1/access/users
  { email, name?, roleIds, roleExpiresAt?, teamIds? }` (202) stores an
  invitation (a tenant table; the link's token, `inv_<tenant id>_<secret>`,
  only as its SHA-256) and mails a link (`WEB_URL/accept-invitation?token=…`,
  `INVITATION_TTL_HOURS`). Nothing about an account is read, changed or
  returned, and the answer is the same whether or not the address has one.
  `POST /v1/auth/invitations/accept { token, password?, name? }`: a new
  address chooses its password (its address proved by the link; 400
  `password_required` without one); an existing account must be signed in as
  itself (401 `sign_in_required`, 403 `invitation_other_account`). The
  membership, with the invitation's roles and units (those still there), comes
  then, in one transaction under the account's and the membership's locks (an
  acceptance never interleaves with the account's deletion or the membership's
  deactivation). `GET /v1/access/invitations` (with each one's `roleIds`,
  `roleExpiresAt` and `teamIds`), `DELETE /v1/access/invitations/{id}`,
  `POST /v1/access/invitations/{id}/resend` (202, expired or not: a new link
  and expiry, the old link stops; the roles, their ends and the units stay;
  the resender must be able to grant its roles, and signed in recently;
  audited `invitation.resent`). Administrators never set or change anyone's
  password or name: `PATCH /v1/access/users/{id}` changes the membership
  (`active`, roles, units) only, and a `password` or `name` is refused (400).
  Linking a provider and enrolling two-factor want a proved address (403
  `email_unverified`). The only accounts made with a password are made by
  system jobs, never a request: the first start's administrator
  (AccessSeeder) and the demo seed's members (`AccessAdminService.seedUser()`,
  development databases only: [development](development.md), "Demo data").
- **Impersonation never crosses tenants.** Only a member of the administrator's
  current tenant; the impersonation session is pinned to that tenant (no
  switching, no profile, notification or preference changes) and ends when
  either membership does. While impersonating, account-wide reads show only
  what belongs to that tenant: the sessions list (only this one), the tenants
  list (only this one), notifications (not the account's own); consents and
  `GET /v1/account` are refused.
- **A membership deactivated** ends its sessions and token families in that
  tenant and disconnects its sockets there; the account's other tenants go on.
- **Your own account** (`/v1/account`: export, deletion) spans your tenants.
  The export is queued in no tenant (a person with no membership has one too),
  filed under `accounts/<user id>/`, and followed at `GET /v1/data/transfers/{id}`
  by that user in any tenant or none. It holds the account-level rows, then
  each tenant: an active membership's tenant gives what it holds about you; a
  tenant you left (an inactive membership) only what is personal (the
  membership, the audit entries about you), never its business records.
  The deletion job erases you in each tenant; a tenant that fails leaves the
  account open for the next night, and the others still run. While an
  administrator impersonates you, account-wide data stays hidden: your
  account's notifications, consents, preferences and deletion state.
- **Cron jobs that walk tenants** carry on past a tenant that fails (logged),
  then report every failure together (`TenantRunsFailed`); retention sweeps
  include deactivated tenants (their rows still age out).

## Operators

The first start makes one tenant (`ADMIN_TENANT_NAME`, default `Default`) with
the first administrator: the **operator tenant** (`tenants.operator`). Routes
that reach past one tenant answer only principals acting in it
(`@OperatorOnly()`, 403 `operator_required`), on top of their permission: the
ops API (queues, outbox, workflow events: every tenant's jobs), the mail
suppression list (every address), and `/v1/tenants` (below). `GET
/v1/auth/me`'s `tenant.operator` says whether the session acts in it (true
there, false elsewhere; `tenant` is null without one): the web shows the
operators' screens when it is true and `can['Access.manageTenants']` too.
Roadmap 1b replaces this with the platform's super tenant, and adds tenant
settings, export and deletion. With `TENANT_SIGN_UP` a sign-up makes a
tenant too ("Tenants made at sign-up").

**The tenants** (all `Access.manageTenants`, in the operator tenant only;
another tenant's administrator gets 403 `operator_required`, and nobody
outside the operators ever sees another tenant):

| Route | What |
| --- | --- |
| `GET /v1/tenants` | A page, newest first: `listQuery()` filters (`name`, `slug`: `eq`, `contains`, `startsWith`; `active`, `operator`; `createdAt`, `updatedAt` ranges), `sort` (`name`, `slug`, `createdAt`, `updatedAt`), `cursor`/`page`, `count`, `fields`. `GET /v1/lists/Tenant` describes it (to the same callers). |
| `POST /v1/tenants { name, slug, administratorEmail }` | A tenant, its roles and its first administrator's invitation (`administrator: { email, status: 'invited', expiresAt }`), audited in both tenants. 409 `tenant_slug_taken` (with `errors: [{ path: 'slug' }]`), 409 `single_tenant`. |
| `GET /v1/tenants/{id}` | One tenant, with an `ETag`. |
| `PATCH /v1/tenants/{id} { name?, slug?, active? }` | Rename, a new slug (409 `tenant_slug_taken` on the field), (de)activate. `If-Match` optional (412 `precondition_failed`). Audited `tenant.updated` (each field from → to) in the operator's tenant and in that one. |

**The first administrator is always invited.** The create's answer says
`status: 'invited'` whether or not the address has an account: like every
invitation ("Invitations" below), nothing about an account is read, so an
operator can't learn which addresses have one (an operator is a member of
the operator tenant, not of the others, and sees no more of them than
their administrators do). The owner of the address decides by accepting:
a new address chooses its password, an existing account accepts signed in
(the acceptance's `accountCreated` tells the person, not the operator).

**Deactivating a tenant** (`active: false`) is what `tenants.active` already
meant everywhere, made a route: a session or token in it stops (the
principal resolves to nobody: 401), its API keys stop, its invitations
can't be accepted, a sign-in never starts in it (it isn't among the user's
tenants), its jobs and cron runs are skipped (retention still sweeps it).
The route also ends, after the commit, what would outlive the check: every
session and token family in that tenant (so reactivating never revives an
old session: its members sign in again, and meanwhile into their other
tenants) and its realtime connections (`TenantLifecycleRegistry`, realtime
disconnects its members' and clients' rooms of that tenant). Nothing else is
deleted: `active: true` gives back its data, memberships, roles and API
keys. The operator tenant is never deactivated (409 `operator_tenant`):
the operators would lock themselves out of every operator route.

**Acting in a tenant (support).** An operator switches only into tenants
they are a member of (`POST /v1/auth/tenant`, 404 otherwise), and
impersonation never crosses tenants ("Accounts and sessions"). So support
access today is a membership: the tenant's administrator invites the
operator's address (`POST /v1/access/users`, with the roles they choose,
`roleExpiresAt` to make it temporary), the operator accepts and switches;
everything is audited in that tenant, and its administrators see it and end
it (`PATCH /v1/access/users/{id} { active: false }`). The operators
themselves can't add themselves to a tenant: the tenant consents. A
"break-glass" route for operators to act in any tenant without its consent
is not built: it needs the owner's decision (who may, for how long, how the
tenant is told), and belongs with the platform super tenant (roadmap 1b).

## Tenants made at sign-up

`TENANT_SIGN_UP=on` (off by default), with `TENANCY=multi` and
`AUTH_SIGN_UP=on`, lets people make their own tenant: a self sign-up
(`POST /v1/auth/sign-up`, or a first sign-in with a provider) makes a new
tenant, its roles, and the new account as its first administrator, in one
transaction in the new tenant's scope (`SignUpTenant`,
`iam/access/sign-up-tenant.ts`, through `TenantsService.create()` as the
operators' route does). Off, only operators make tenants.

- **The name** is the sign-up's `tenantName` (1 to 120 characters), the
  person's name without one (a provider sign-up: the provider's name, else
  the address). `GET /v1/auth/methods` says `tenantSignUp: true`, so the
  sign-up page asks for it.
- **The slug is drawn, never chosen:** the name's slug and six random
  characters (`acme-corp-k3x9q2`; drawn again on the rare collision). A
  sign-up gets no `tenant_slug_taken`, so it can't probe which handles
  exist, nor squat one; the operators rename it (`PATCH /v1/tenants/{id}`).
- **Behind the same wall** as every tenant: its rows under RLS, never an
  operator (`operator: false`, so 403 `operator_required` on the
  operators' routes).
- **Audited** in the new tenant: `user.signed-up` and `tenant.created`
  (`details.via: 'sign-up'`, the slug).
- **Verify first still holds:** the account signs in, and so reaches its
  tenant, only once its address is proved (docs/auth.md, "Sign-up"). An
  account refused (its address taken: 409) leaves no tenant behind.
- **Unverified sign-ups' tenants are swept.** Such a tenant is marked
  (`tenants.created_by_sign_up`, `createdBySignUp` in the operators'
  routes). Every night at 04:15 a cron job on the workers
  (`SignUpTenantSweepJob`, as `system:sign-up-tenant-sweep`) deletes the
  ones made more than 7 days ago (`UNVERIFIED_SIGN_UP_GRACE_DAYS`) whose
  members never proved their address and whose verification links (24
  hours each; a resend makes a new one) all expired more than 7 days ago,
  up to 500 a night. Each deletion runs in its own transaction, under its
  members' account locks, checked again there (an address proved meanwhile
  keeps its tenant). The tenant's row goes (`TenantsService.deleteRow()`,
  the database cascading to its rows and memberships; tenant deletion,
  roadmap 1b, adds files and jobs around it), audited outside any tenant
  (`tenant.purged`, `details.reason: 'sign-up-unverified'`, the members'
  ids), since the tenant's own log goes with it. The accounts stay:
  unverified, in no tenant. Operators' tenants are never swept.
- **Abuse.** One tenant per new account: a second tenant needs another
  address (an existing one gets 409), and a sign-up is limited to five per
  address and 15 minutes, with bot protection when `CAPTCHA_MODE` is on (a
  warning at start when it is off). Inviting, accepting and switching work
  as for any tenant; making a second tenant from a signed-in account isn't
  offered.
- **Ignored, with a warning at start,** with `TENANCY=single` (sign-ups join
  the one tenant: below) or `AUTH_SIGN_UP=off` (nobody signs up).

`test/tenant-sign-up.e2e-spec.ts` runs it on (and the sweep); `sign-up.e2e-spec.ts` checks
that off makes no tenant, `single-tenant.e2e-spec.ts` that `single` ignores it.

## Single-tenant deployments

A project that serves one customer sets `TENANCY=single`. The wall, the
tenant columns and the policies stay as they are (nothing to strip out, and
a project can move to `multi` later); what changes is who joins and what
can be made (`iam/access/single-tenant.ts`):

- **One tenant.** The first start makes it (`ADMIN_TENANT_NAME`); making
  another is refused with 409 `single_tenant` in `TenantsService.create()`,
  so `POST /v1/tenants` alike (the other tenant routes work as in `multi`:
  the list holds the one tenant, it can be renamed, and, being the
  operators', never deactivated). The demo seed (`pnpm db:seed:demo`) fills the
  one tenant instead of making its own: that tenant is the operators', so
  the demo administrator acts as an operator (development databases only).
- **Sign-ups join it.** With `AUTH_SIGN_UP=on`, an account made by
  `POST /v1/auth/sign-up` or by a first sign-in with a provider becomes a
  member of the tenant in the transaction that makes it, with the roles in
  `SIGN_UP_ROLES` (seed role keys; none by default, so an open sign-up sees
  nothing until an administrator grants a role), audited as `user.joined`
  (`details.via: 'sign-up'`). Verify first still holds: the member signs in
  once the address is proved. Invitations work as in `multi`.
- **Checked at start:** `SIGN_UP_ROLES` names declared seed roles only (never
  `administrator`); more than one tenant (a deployment switched from
  `multi`) is a warning, sign-ups then join the operator tenant. Accounts
  made before the switch keep the memberships they have.

`test/single-tenant.e2e-spec.ts` runs the deployment this way.

## Adding a tenant table

```ts
export const invoices = pgTable(
  'invoices',
  {
    id: uuidPk(),
    tenantId: tenantColumn(),           // NOT NULL, no default: filled from the scope
    customerId: uuid('customer_id').notNull(),
    number: text('number').notNull(),
    ...timestamps(),
  },
  (t) => [
    ...tenantTable('invoices', t),      // the policies (`{ referenced: true }`: + unique (tenant_id, id))
    uniqueIndex('invoices_number_idx').on(t.tenantId, t.number),   // per tenant
    tenantReference('invoices_customer_fk', [t.tenantId, t.customerId], [customers.tenantId, customers.id]),
  ],
).enableRLS();
```

Then `pnpm db:generate`. Inserts leave `tenantId` out: the column takes the
scope's (and refuses without one); the `WITH CHECK` policy proves it. A
composite key added to an **existing** table needs the referenced table's
unique `(tenant_id, id)` first: drizzle-kit writes foreign keys before unique
constraints in one migration, so generate the uniques in one migration and the
keys in the next (`0025_tenancy`, `0026_tenancy_keys`). New tables don't need
this (their constraints are in `CREATE TABLE`).

## Tests

`apps/api/test/tenancy.e2e-spec.ts`: as the app role in SQL (another tenant's
rows unreadable, inserts and moves refused, the owner bound by FORCE, every
tenant table walled), the pool's refusal, a tenant switch refused inside an
open transaction, API clients, member lists and invitations (the same answer
for an existing account, acceptance only by its owner), sessions and the
switch, idempotency replays, impersonation, realtime rooms (and sockets
disconnected with a membership), operators, and a cron job purging in two
tenants under RLS. `tenant-pool.e2e-spec.ts`: the pool on one connection
(the wrapper and the straight path, the refusal before a checkout, the
settings forgotten at commit and rollback, the bypass as the maintenance
role). `account-export.e2e-spec.ts`: a person's export with no tenant and
across two. `tenants.e2e-spec.ts`: the operators' tenant routes (the
operator flag, the list and its description, reading and changing one,
deactivation and what it ends, the slug conflict on its field, the first
administrator's invitation).
Test helpers: `node.otherTenant()` (a second tenant, its administrator signed
in), `node.inTenant(work, tenantId?)` and `node.acrossTenants(work)` for a
test's own queries (`database.db` is the app's pool: no tenant, no rows).
