# Settings and feature flags

What administrators change at runtime without a deploy, and what users
set for themselves: typed values declared by the features, with defaults
in code and overrides in the database, for everyone, for a team, or
per principal. Feature flags are boolean settings that can also roll out
to a share of principals or, by rule, to the people with an attribute. The deployment's operators may also set a value
for every tenant at once, as a runtime default or as a kill switch. The code is in `apps/api/src/platform/settings/`; notes
is the example (`features/notes/note-settings.ts`).

## For features

A generated feature declares its settings in its record
(`settings: { paymentDays: recordSetting.int(30) }`,
[adding-a-feature](adding-a-feature.md)) and the platform declares them under
`<path>.<name>`; `recordSettings(INVOICE).paymentDays` is the declaration to
read. The hand-written way follows.

```ts
// features/notes/note-settings.ts
export const NOTE_PUBLISH_DELAY = setting({ key: 'notes.publishDelay', label: 'Publication delay', schema: duration, default: '10s' });
export const NOTE_RICH_TEXT = flag({ key: 'notes.richText', label: 'Rich text editor', default: false });
// notes.publishApproval (a flag too, scopes tenant and team: never per user) switches the approval of publications on: docs/approvals.md
export const NOTE_SETTINGS = defineSettings([NOTE_PUBLISH_DELAY, NOTE_RICH_TEXT]);
// app.module.ts
PlatformModule.forRoot({ …, settings: [...NOTE_SETTINGS] })
// anywhere
const delay = await this.settings.get(NOTE_PUBLISH_DELAY);          // for the tenant
const rich = await this.settings.enabled(NOTE_RICH_TEXT, user);     // for this principal
```

- `key`: dotted, the feature first. `schema`: a Zod type the value must
  pass (the default is checked at start). `scopes`: where it may be set,
  `['tenant']` by default; add `team` and/or `user` (a `user` scope
  makes it a preference users set for themselves). `public: false` hides
  it from callers who don't manage settings. A `flag()` is a boolean
  setting with every scope and a rollout.
- Precedence for a principal: the operators' **enforced** platform value →
  their own value → one of their teams' (in the order of their teams) → the
  tenant's targeting rules → the tenant's value → a flag's rollout → the
  operators' platform rules → their platform value (or rollout) → the
  default. `settings.resolve()` also says which (`source`).
- **Every stored value is a tenant's** (`setting_overrides` under
  row-level security, [tenancy](tenancy.md)): the declaration's default is
  what holds for every tenant, and each tenant's administrators change
  their own. The current context's tenant is read (a request's, a job's);
  outside any tenant every setting is its default. There is no value one
  tenant's administrator sets for another; the operators' platform values
  (below) are the one value that holds across tenants.
- Values are cached per tenant and instance and refreshed through the
  tenant's version in Redis (`tenant:<id>:settings:version`) after every
  change, like custom fields: a change applies on the next request on
  every instance, and reloads that tenant's cache alone.
- In a durable workflow, read a setting inside `ctx.step()` so a replay
  sees the value the instance started with (`note-publication.workflow.ts`).

## Gating a route on a flag

```ts
@Get('beta')
@Can.Anyone()
@RequireFlag(NOTE_BETA)            // platform/settings/require-flag.ts
beta() { … }
```

`@RequireFlag(FLAG)` (on a route or a controller) answers 404 while the
flag is off for the caller, as if the route did not exist. It is a route
guard (`Reflector.createDecorator` and `UseGuards`), so it runs after the
authentication and permission checks: a caller without the permission
gets their 403 first.

In the web app, `useFlag(key)` (`apps/web/src/features/settings/use-flag.ts`) reads
the flag the caller resolves from `GET /v1/settings`: off while it loads or when
it can't be read.

## For the operators: every tenant at once (`/platform`)

```
PUT    /v1/settings/{key}/platform     { value?, enforced?: false, rollout? }
DELETE /v1/settings/{key}/platform     204, no body
```

Operators only (`Access.manageSettings` in the operator tenant,
`@OperatorOnly()`; another tenant's administrator gets 403
`operator_required`). Any setting takes one, flag or not.

- **`enforced: false`** (the default): the runtime default of every tenant,
  below each tenant's own values and rollouts, above the code's default.
  Turning a feature on for everyone without a deploy.
- **`enforced: true`**: above every tenant's, team's and principal's value,
  a kill switch. Their stored values stay and hold again once it is removed.
- **`rollout: 20`** (flags, no value, never enforced): on for a stable 20 %
  of the principals of every tenant that set nothing itself (no value, no
  rollout of its own), drawn per tenant as a tenant's rollout is. A gradual
  release across the deployment: raise it step by step, then set the value.
- The value passes the declaration's schema and `restrict()` like any
  other (400 `validation_failed`, `setting_not_allowed`). For a policy
  read with `anyOn()` (`auth.requireMfa`), the platform's `true` counts as
  the widest scope; its `false`, even enforced, exempts nobody.
- Stored in `platform_setting_values`, a global table (no `tenant_id`),
  cached once per instance and refreshed through
  `settings:platform:version` in Redis, like the tenants' values. They
  hold outside any tenant too (a job of none).
- Audited in the operator's tenant (`setting.updated`, `setting.reset`,
  `details.scope: platform`).
- Every view says what is set (`platform: { value, enforced, rollout } | null`,
  `source: platform` when it decides) and whether the caller may change it
  (`canEditPlatform`).

The deployment's default tenant limits are settings of this kind
(`quotas.maxMembers`, `quotas.maxApiClients`, `quotas.maxStorageBytes`,
`quotas.maxRecords`: no tenant scope, so only the operators' platform value
sets them; [tenancy](tenancy.md#quotas)).

## Targeting rules (flags)

A flag may be switched by attribute: an ordered list of rules at the tenant
scope and at the platform scope, each rule conditions that must **all** hold
and an outcome. The first rule that matches decides (`source: rule`), before
that scope's plain value and rollout; a principal's own value and their
team's still come first (they are the more specific choice), and an
enforced platform value beats everything. Code: `setting-rules.ts`.

```
PUT /v1/settings/{key}             { rules: [...], value?, rollout? }   tenant scope
PUT /v1/settings/{key}/platform    { rules: [...], value?, enforced?, rollout? }
```

```json
{
  "rules": [
    {
      "conditions": [
        { "key": "emailDomain", "params": { "domains": ["acme.com"] } },
        { "key": "principalKind", "params": { "kinds": ["user"] } }
      ],
      "outcome": { "rollout": 25 }
    },
    {
      "conditions": [
        { "key": "principalKind", "params": { "kinds": ["client"] } }
      ],
      "outcome": { "value": false }
    }
  ]
}
```

- **Conditions have the shape of a permission's** (`{ key, params }`,
  [permissions](permissions.md)): a key naming a template of a closed catalog,
  evaluated in code. There is no expression language; nothing stored is
  executed.

  | Key              | Params                        | Holds when                                                                                                    |
  | ---------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------- |
  | `principalKind`  | `kinds: ['user' \| 'client']` | the caller is one of these                                                                                    |
  | `role`           | `roleIds: [uuid]`             | they hold one of these roles of the tenant (unexpired grants); tenant scope only: roles are each tenant's own |
  | `emailDomain`    | `domains: ['acme.com']`       | a user whose **verified** email is at exactly that domain (no subdomains, case-insensitive)                   |
  | `locale`         | `locales: ['en', 'pt-BR']`    | the user's chosen language (`en` also covers `en-GB`)                                                         |
  | `tenantSlug`     | `slugs: ['acme']`             | they act in one of these tenants (the tenant attribute)                                                       |
  | `tenantOperator` | `operator: true \| false`     | the tenant is (or is not) the operators'                                                                      |

- **Outcome**: `{ value: true | false }`, or `{ rollout: 20 }`, on for a stable
  20 % of the matched people (drawn like a rollout, per tenant) and **off for
  the rest of them**: the group matched, so the rule decided.
- **Fails closed.** A condition that cannot be evaluated does not hold, so
  its rule never matches and never switches anything on: an attribute the
  caller lacks (an API client has no email or language; an unverified email
  proves no domain), a key this code does not know, params that do not parse.
  No principal (a guest, a job) matches no rule. Put an "off" rule that must
  not be missed first, and do not rely on one for a restriction: a rule that
  does not match leaves the plain value, which may be on.
- **Checked at write** (400 `validation_failed`, `errors[].path` under
  `rules.<i>.conditions.<j>`): known keys, params that parse, a `role` that is
  one of the tenant's roles, at most 20 rules of 10 conditions of 50 values;
  only flags take rules, at the tenant scope (not a team or a user) and the
  platform scope. `PUT` replaces the scope's value and rollout; **left out,
  `rules` stay**, `rules: []` clears them. A rules-only override (no value, no
  rollout) is valid.
- Audited with the rules from → to (`setting.updated`); every view of the
  stored values (`GET /v1/settings/{key}/overrides`, `platform`) carries
  `rules`. Stored as `rules` (jsonb) on `setting_overrides` and
  `platform_setting_values`, cached with the rest.
- The admin UI edits them on `/settings` (a flag's dialog: "Targeting rules",
  and "Targeting rules for all tenants" for operators): conditions per rule,
  reorder, the tags input for domains, languages and tenants. The role
  condition is offered to the access administrators, who may list the roles.
- Not here: A/B experiments (variants, metrics on which one wins) are a
  different system, not flags.

## IAM's auth policies (`auth.*`)

Declared by the platform (`platform/auth-policy/auth-settings.ts`, merged
before the features' like approvals' settings) for IAM, which reads them
through its `AUTH_POLICY` port under the environment's ceiling
([auth.md](auth.md#policies)). Shown to managers only (`public: false`).

| Key                      | Value             | Scopes                                                     | Default                                                                                                                   |
| ------------------------ | ----------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `auth.requireMfa`        | boolean           | `tenant`, `team` (never `user`: nobody exempts themselves) | `false`                                                                                                                   |
| `auth.passwordMinLength` | integer, 12 to 64 | `tenant`                                                   | `12`                                                                                                                      |
| `auth.passwordHistory`   | integer, 0 to 24  | `tenant`                                                   | `0` (off; N: the account's last N passwords, the current one included, can't be reused: [auth.md](auth.md#passwords))   |
| `auth.allowBreakGlass`   | boolean           | `tenant`                                                   | `true` (`false`: the operators' break-glass grants are refused, and running ones stop: [tenancy](tenancy.md#break-glass)) |

- **`true` wins for `auth.requireMfa`**: it applies to a user when the
  tenant's value or one of their teams' is `true` (`SettingsService.anyOn()`),
  so a team's `false` exempts nobody from the tenant's `true`, unlike the
  usual precedence.
- **The ceiling at set**: a value the deployment doesn't allow is refused
  with 400 `setting_not_allowed` (`detail` says why; `errors[0].path:
value`): `auth.requireMfa: true` with `AUTH_MFA=off`. A value stored
  before the env changed stays stored and has no effect. Any declaration
  can be limited so (`SettingsService.restrict(declaration, check)`).

## For administrators (`Access.manageSettings`)

```
GET    /v1/settings                     every setting, with your value and its source (also for anyone, public ones)
GET    /v1/settings/{key}/overrides     the stored values, every scope
PUT    /v1/settings/{key}               { scope?: tenant|team|user, scopeId?, value?, rollout? }
DELETE /v1/settings/{key}?scope=&scopeId=          204, no body
```

- `scope` defaults to `tenant` (before tenancy it was `global`, which is
  gone: a breaking change). `scopeId`: one of the tenant's teams, or a
  principal's key (`user:<id>` of a member of the tenant, `client:<id>` of
  its clients; anyone else is a 404); none for the tenant. The scope must be one the setting
  takes; the value must pass its schema (400 `validation_failed`, the
  path naming `scope`, `value` or `rollout`).
- A flag at the tenant scope takes `rollout: 20` (a percentage) with no
  value: it is then on for a stable 20 % of the tenant's principals (the
  same principal always gets the same answer; raising the percentage never
  switches anyone off). The share is drawn with the tenant in the hash
  (`sha256(key:tenantId:principalKey)`), so each tenant's rollout picks
  its own principals, and a person in two tenants is drawn in each apart.
  A value, when set, beats the rollout.
- Every change is audited (`setting.updated` with from → to,
  `setting.reset`).

## What each setting takes, and who may set it

`GET /v1/settings` and `GET /v1/settings/{key}` describe each value, so a
client renders the right input and checks it before PUT. All of it is
generated from the declaration's Zod schema (`setting-value-schema.ts`,
with Zod's `z.toJSONSchema()`, the input side), once at start: nothing to
declare twice, nothing to drift from what PUT checks.

| Field        | When                    | What                                                                                                                |
| ------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `type`       | always                  | `boolean`, `number`, `string`, `enum`, or `json` for anything else (an object, an array, a union, a nullable value) |
| `options`    | `enum`                  | the values (`z.enum([...])`, or a union of literals)                                                                |
| `min`, `max` | `number`, when declared | inclusive bounds (`.min()`, `.max()`; exclusive ones, `.positive()`, are in `schema` only)                          |
| `integer`    | `number`                | `true` for `.int()`                                                                                                 |
| `maxLength`  | `string`, when declared | `.max()`                                                                                                            |
| `schema`     | always                  | the value's JSON Schema (draft 2020-12): patterns, exclusive bounds, an object's shape                              |

`type` is for simple forms; `schema` says the rest, for a generic JSON
editor or a validator. What JSON Schema can't say (a `refine()`, a
transform's output) is left out of `schema` and still checked on PUT (400
`validation_failed`); `SettingsService.restrict()`'s deployment ceiling
too (400 `setting_not_allowed`).

Two booleans say what the caller may do:

- `canEdit`: they may set and remove the shared values, `PUT` and
  `DELETE /v1/settings/{key}`, at every scope the setting takes. It is the
  routes' own check (`AccessPolicy.manageSettings`: `Access.manageSettings`,
  a user, not while impersonating), evaluated for the caller; the scopes
  never differ in who may set them, so one answer holds for all.
- `canSetMine`: they may set their own value (`PUT` and
  `DELETE /v1/settings/{key}/mine`): the setting's scopes include `user`.
  Anyone may, users and API clients.

There is no `editableBy`: a declaration names no role (roles are each
tenant's own), only the permission above. Don't infer either from
`public: false` or the `auth.` prefix.

Picking whom a `user` scope's value is for: `GET /v1/access/principals?q=`
([permissions.md](permissions.md#picking-users-and-api-clients)) answers
each user's and API client's `key`, the `scopeId` to send.

## For users and clients

```
GET    /v1/settings                 your value of each (and `source`: user, team, tenant, rule, rollout, platform, default)
GET    /v1/settings/{key}
PUT    /v1/settings/{key}/mine      { value }   settings whose scopes include user
DELETE /v1/settings/{key}/mine
```
