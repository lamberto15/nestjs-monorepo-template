# Identity boundaries

Four things are easy to mix up. The template keeps them apart, and a project
that adds people records (a CRM, an HRIS) should too.

| Layer | Is | Lives in | Who changes it |
| --- | --- | --- | --- |
| **Account** | a person who signs in: one per address, global | `users` (no tenant) | its owner; never a tenant's administrator, never SCIM (name, address, password) |
| **Tenant membership** | that account's access to one organization: active or not, roles | `memberships` (per tenant) | the tenant's administrators (`Access.manageUsers`), an accepted invitation, SSO or SCIM provisioning |
| **Organizational-unit membership** | where a member sits in the organization's structure and policy context: `member` or `lead`, `validFrom` to `validTo` | `organizational_unit_memberships` (per tenant; needs the tenant membership) | the unit's members routes (`Access.manageUsers`), or SCIM for the units it manages |
| **Employee, contact, customer** | a domain record about a person | the project's own feature tables | the project's feature |

The first three are the template's ([auth](auth.md), [tenancy](tenancy.md),
[permissions](permissions.md)). The fourth is **not**: the template ships no
employee or payroll module, and no feature may assume that every employee has
an account or every account has an employee record.

- An account is not an organization's property. A tenant's administrators
  manage its **membership** (`PATCH /v1/access/users/{id}` deactivates the
  membership, never the account); they never set or change a password or name.
- A membership is not a unit membership. A unit membership belongs to a user
  who is already a member; it changes only through the unit's members routes
  (`/v1/access/organizational-units/{id}/members`), is dated, and an ended one
  stays as history. Deactivating the tenant membership does not rewrite it.
- A unit is not an employee's department history. Units are the access and
  policy structure; employment dates, manager and reporting lines and
  department history are domain records of the project's module.

## Getting people in

A membership starts in one of four ways. Roles are never implied: each path
says which it gives.

| Path | Default | Account | Membership and roles | Audit |
| --- | --- | --- | --- | --- |
| **Invitation** | yes: how an administrator adds a person today | made at acceptance (the owner chooses the password), or the existing account accepts signed in as itself | the invitation's roles (and end dates, units), in the acceptance's transaction | `user.invited`, `invitation.resent`, `invitation.revoked`, then the join |
| **Opt-in sign-up** | off: `AUTH_SIGN_UP=on` | self-made, verify first (no session until the address is proved) | none in `multi` (a tenant invites it); with `TENANT_SIGN_UP` its own new tenant; with `TENANCY=single` the one tenant with `SIGN_UP_ROLES` | `user.signed-up`, `user.joined` |
| **SSO just in time** | off: a connection's `jitProvisioning` | linked or made at the first provider sign-in, a verified domain only | the connection's `defaultRoleIds` and its `roleMappings` | `member.provisioned`, `sso.roles-synced` |
| **SCIM** | off: a token with `Access.provisionScim` | linked (address proved) or made without a password, a verified domain only | member, no roles over SCIM (map groups to roles on the SSO connection) | `scim.user-provisioned`, `scim.user-updated`, `scim.user-deprovisioned` |

**Manual preparation and activation: not built yet.** Today there is no
draft or pending member: no tenant-local person exists before the invitation
is accepted, and no pending state without an email. The approved plan (#603,
built in #604, its UI in #605) adds an administrator-prepared pending member
(roles and units set first, activation sent now or later, no access until the
activation rules are met), sharing the invitation's lifecycle rather than a
second pending table; this page then gains its rows. Until it lands, an
**invitation is the prepared state**: roles and units are set, nothing about
an account is read or changed, and the person activates it by accepting. A
membership turned off (`active: false`) and on again is a different thing:
access paused, not pending. A project that needs a person *known before they
can sign in* (an employee hired next month) keeps a domain record, below, and
sends the invitation when access should start.

```
                invite (default)            sign-up (opt-in)       SSO JIT / SCIM (trusted IdP)
                      |                           |                         |
              invitation pending            account, unverified      account linked or made
                      |                           |                         |
     owner accepts: account + membership          | verify address          |
                      |                           v                         |
                      |                    account, no membership           |
                      |              (multi: a tenant invites it;           |
                      |               single: joins; TENANT_SIGN_UP:        |
                      |               makes its own tenant)                 |
                      v                           v                         v
                      +---------------> membership ACTIVE (roles, unit memberships)
                                                  |
                       administrator PATCH active=false, SCIM active=false / DELETE
                                                  v
                                       membership INACTIVE: this tenant's sessions and
                                       tokens end; other tenants and the account go on
                                                  |
                         last active membership gone by SCIM: account deactivated
                         (never deleted); turned on again: it comes back
```

### Who may do what

| Action | Needs | Notes |
| --- | --- | --- |
| Invite, resend, revoke | `Access.manageUsers` | can grant only roles the actor may grant; resend needs a recent sign-in |
| Accept an invitation | the person | the link's owner, signed in as the account when it exists |
| Deactivate or reactivate a membership, change roles | `Access.manageUsers` | at least one administrator remains |
| Add a user to a unit, change role, end | `Access.manageUsers`, and authority over the user and unit | not oneself; a unit SCIM manages is read-only (409 `unit_managed_by_scim`) |
| Set up SSO, domains, connections | `Access.manageSso` | recent sign-in |
| SCIM provisioning | an API client with `Access.provisionScim` | only users and units it created |
| Change a person's password, name or address | the account's owner | nobody else, in any tenant |
| Make a tenant | operators (`Access.manageTenants`), or `TENANT_SIGN_UP` | [tenancy](tenancy.md) |

## Offboarding

When employment ends, a project revokes **organization access**, not the
person. The levers, narrowest first:

1. **Deactivate the tenant membership** (`PATCH /v1/access/users/{id}`
   `{ active: false }`, or SCIM `active: false`). It ends that tenant's
   sessions and tokens, disconnects its sockets, and runs the registered
   `UserLifecycleListener`s in the same transaction (the platform moves
   approvals and delegations on). It touches no other tenant and no record;
   audited `user.updated`.
2. **End the unit memberships** (`DELETE …/members/{userId}`, or `validTo`
   when added): the membership ends and stays, so "who was in Finance when
   this was approved" keeps its answer.
3. **Leave the account alone.** Only SCIM deprovisioning that leaves no active
   membership anywhere deactivates the account (`scim.account-deactivated`);
   an administrator never does. Deletion is the owner's
   (`/v1/account`).

A project hooks in at two places: `UserLifecycleRegistry` (`deactivated` in the
transaction, `afterDeactivation` after the commit) for what must follow a
deactivation, and its own employment service for the other direction (below).
Keep the statuses apart: **employment** (the project's record: active, on
leave, terminated, with dates), **membership** (`active`), **account**
(`active`). Termination never silently changes the other two. A project that
wants it wires it explicitly, calls the membership route as a named actor, and
audits it. Nothing in the template does.

## Reference example: an HRIS `employees` module

A project feature, **not shipped**; generate it with `pnpm feature:add`
([adding a feature](adding-a-feature.md)). It shows how the fourth layer
relates to the first three.

- **An employee exists with no email and no login.** `employees` has a name,
  number, hire and termination dates, manager (`managerId`, another employee),
  and its history (`employee_assignments`: department, manager, dates). It is
  a normal tenant table: `tenant_id`, RLS, records, audit.
- **An optional link to an account**: `employees.user_id`, nullable, with a
  composite foreign key `(tenant_id, user_id)` to `memberships`, so the account
  must be a **member of that organization**. Another tenant cannot point at it.
- **Cardinality, per organization.** A partial unique index on
  `(tenant_id, user_id) WHERE user_id IS NOT NULL`: within one organization an
  account is linked to at most one employee, and an employee has at most one
  account. The same account may have an employee in each of its tenants, so
  there is no global employee per account, and none is assumed.
- **Linking** is explicit: `POST /employees/{id}/link { userId }`, never
  inferred from a matching email. Proof is two-sided. The actor holds the
  project's `Employees.link` permission **and** `Access.manageUsers`, and the
  target is an existing member of the tenant (to find one the actor lists
  members; nothing about accounts outside the tenant is revealed). Linking
  grants no role and does not change the account.
- **Unlinking** (`DELETE …/link`) needs `Employees.link`. It clears `user_id`
  and nothing else: the membership, the roles and the employee stay.
- **Audit**: `employee.linked` and `employee.unlinked` through
  `audit.record(actor, …, tx)` with the employee id and the user id, in the
  transaction of the change.
- **Hire**: create the employee; when access is wanted, invite the work
  address (`POST /v1/access/users`); link after acceptance, or let the link
  be made by an administrator. **Termination**: set the end date and status,
  then, if the project wants it, deactivate the membership (offboarding
  above). The employee row, its dates, manager and department history stay.
  A person's membership in another tenant is not read or touched.

The same shape fits a `contacts` or `customers` feature.

## Disposable development

Reset and reseed only a throwaway database: drop the development volume
(`pnpm services:down`, then `docker volume rm <name>-dev_postgres_data`) and
run `pnpm db:seed:demo` ([development](development.md), "Demo data"). A real
database never gets an edit of identities or memberships by SQL: it changes
through the routes above, with audit.

## Where it is built

Parent #603 (onboarding modes); the organization rewrite #595 (units);
backend #604 (pending-member provisioning) and UI #605 (Invite or Prepare
member). The earlier "adding people is invite-only" decision is superseded:
invitation stays the default, and sign-up, SSO and SCIM are supported
optional paths. The code is `apps/api/src/iam` (`access`, `sso`, `auth`).
