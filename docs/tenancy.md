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
| `idempotency_keys`, `locks`, `app_secrets`, `exchange_rates`, `mail_*` | global | infrastructure (an idempotency key carries the tenant) |
| everything else | tenant table | `tenant_id NOT NULL`, RLS enabled and forced, four policies |

`audit_log` and `notifications` are tenant tables whose `tenant_id` may be null:
an account's own rows, written outside any tenant (a sign-in and its new-device
notification). Null audit rows are read only outside a tenant (no tenant's
administrator reads another person's sign-ins); null notification rows in every
scope, the code filtering by recipient as it always did.

What a membership may do lives in tenant tables: its roles (`user_roles`) and
org units (`user_org_units`), whose keys reference the membership. API clients
belong to one tenant; their roles, keys and usage too.

## The wall

**Settings.** At the start of every transaction the pool (`TenantPool`,
`core/tenancy/tenant-pool.ts`) sends, with the `begin` in the same round trip:

```sql
select set_config('app.tenant_id', '<uuid>', true),
       set_config('app.read_tenants', '<uuid>[,<uuid>…]', true),
       set_config('app.bypass_rls', '' | 'on', true)
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
| all four | `app.bypass_rls = 'on'` (the worker's maintenance jobs) |

An unset or empty setting matches no row: a connection without a tenant reads
nothing and writes nothing. `FORCE ROW LEVEL SECURITY` (which drizzle-kit
can't emit) is set by the role bootstrap (`core/database/roles.ts`, every
migrate), which also refuses to finish when a table with a `tenant_id` lacks
RLS, FORCE or its policies (the two global ones excepted:
`core/tenancy/global-tables.ts`).

**Outside a transaction.** A query through the pool outside a transaction, in
a tenant's scope, runs in one of its own (`begin` with the settings, the query,
`commit`): reads through `database(txHost)` keep working, each in a short
transaction, and no connection is held across a request's other awaits.

**Without a tenant.** A statement naming a tenant table with no tenant in its
scope is refused before it is sent (`TenantScopeMissingError`, in every
environment); over HTTP it is 403 `tenant_required`. The policies would have
answered with nothing (fail closed); the refusal says why.

**Keys.** Every tenant table has a unique `(tenant_id, id)`, and keys between
tenant tables are composite (`tenantReference()`): PostgreSQL checks keys as
the owner, past RLS, so a plain `x_id → id` could point at another tenant's
row. Uniques are per tenant (`(tenant_id, …)`), except the global account
identity (`users.email`).

**Roles.** `migrate` runs as the owner; api and worker as the app role, which is
no superuser, has no `BYPASSRLS`, owns nothing (docs/deployment.md, "Database
roles"). With FORCE, the owner is bound too.

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
signals: `withTenant(data)` on the producer's side, `inTenantOf(envelope, work)`
or `TenantWorkerHost` on the consumer's. A payload without it is refused, never
run without a tenant. A queued principal must act in the envelope's tenant, and
is checked again (`stillActive()`: still a member).

**The bypass** (`Tenancy.bypass(job, work)`, `app.bypass_rls`) opens every
tenant's rows: only in a process that runs workers, never inside a request's
context, logged. It is for maintenance that sweeps a table whole by age
(notification, revision, usage retention); jobs that act per tenant, and audit
what they did, walk the tenants instead (`forEachTenant()`, which logs each
run's tenant). `app.bypass_rls` is a setting any connection could set: the code
is the guard, as it is for `app.tenant_id`.

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
| Stored files | `tenants/<tid>/…` (attachments, documents, transfers): a tenant's deletion and export are prefix operations |

## Accounts and sessions

- **One origin.** The session carries the tenant it acts in. A sign-in (any
  method) starts in the last chosen tenant, else the oldest membership
  (`DrizzleAuthenticationStore.createSession`). `GET /v1/auth/tenants` lists
  the user's tenants; `POST /v1/auth/tenant { tenantId }` re-issues the session
  in another (a new cookie; realtime connections reconnect). Token clients ask
  for a tenant when they sign in (`POST /v1/auth/token { tenantId }`); the
  tenant is the token family's `tid` claim.
- **Users are global; administrators manage memberships.** `POST
  /v1/access/users` with an address that has an account adds that account
  (its roles, units); a password for it is refused (409 `account_exists`). An
  account whose address its owner never proved (`emailVerified` false: an
  administrator made it, or set its password) loses every way in (password,
  two-factor, linked providers, sessions, tokens) when another tenant adds it,
  and its owner gets the invitation: whoever set the password can't follow the
  account into the other tenant. `PATCH /v1/access/users/{id}` changes the
  membership (`active`, roles, units); the account's name or password only while
  it belongs to this tenant alone (else 409 `account_shared`), and a password
  set there makes the account unclaimed again.
- **Impersonation never crosses tenants.** Only a member of the administrator's
  current tenant; the impersonation session is pinned to that tenant (no
  switching, no profile changes) and ends when either membership does.
- **Your own account** (`/v1/account`: export, deletion) spans your tenants:
  the export reads each tenant you belong to in turn, plus the account-level
  rows; the deletion job erases you in each.

## Operators

The first start makes one tenant (`ADMIN_TENANT_NAME`, default `Default`) with
the first administrator: the **operator tenant** (`tenants.operator`). Routes
that reach past one tenant answer only principals acting in it
(`@OperatorOnly()`, 403 `operator_required`), on top of their permission: the
ops API (queues, outbox, workflow events: every tenant's jobs), the mail
suppression list (every address), and `GET/POST /v1/tenants` (the operators make
tenants, each with its first administrator: `Access.manageTenants`). Roadmap
1b replaces this with the platform's super tenant, and adds tenant settings,
deactivation, export and deletion.

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
    ...tenantTable('invoices', t),      // the policies, unique (tenant_id, id)
    uniqueIndex('invoices_number_idx').on(t.tenantId, t.number),   // per tenant
    tenantReference('invoices_customer_fk', [t.tenantId, t.customerId], [customers.tenantId, customers.id]),
  ],
).enableRLS();
```

Then `pnpm db:generate`. Inserts leave `tenantId` out: the column takes the
scope's (and refuses without one); the `WITH CHECK` policy proves it. A
composite key added to an **existing** table needs that table's unique
`(tenant_id, id)` first: drizzle-kit writes foreign keys before unique
constraints in one migration, so generate the uniques in one migration and the
keys in the next (`0025_tenancy`, `0026_tenancy_keys`). New tables don't need
this (their constraints are in `CREATE TABLE`).

## Tests

`apps/api/test/tenancy.e2e-spec.ts`: as the app role in SQL (another tenant's
rows unreadable, inserts and moves refused, the owner bound by FORCE, every
tenant table walled), the pool's refusal, API clients, member lists, the
unclaimed account, sessions and the switch, idempotency replays, impersonation,
realtime rooms, operators, and a cron job purging in two tenants under RLS.
Test helpers: `node.otherTenant()` (a second tenant, its administrator signed
in), `node.inTenant(work, tenantId?)` and `node.acrossTenants(work)` for a
test's own queries (`database.db` is the app's pool: no tenant, no rows).
