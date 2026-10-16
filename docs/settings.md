# Settings and feature flags

What administrators change at runtime without a deploy, and what users
set for themselves: typed values declared by the features, with defaults
in code and overrides in the database, for everyone, for an org unit, or
per principal. Feature flags are boolean settings that can also roll out
to a share of principals. The code is in `apps/api/src/platform/settings/`; notes
is the example (`features/notes/note-settings.ts`).

## For features

```ts
// features/notes/note-settings.ts
export const NOTE_PUBLISH_DELAY = setting({ key: 'notes.publishDelay', label: 'Publication delay', schema: duration, default: '10s' });
export const NOTE_RICH_TEXT = flag({ key: 'notes.richText', label: 'Rich text editor', default: false });
// notes.publishApproval (a flag too, scopes global and orgUnit: never per user) switches the approval of publications on: docs/approvals.md
export const NOTE_SETTINGS = defineSettings([NOTE_PUBLISH_DELAY, NOTE_RICH_TEXT]);
// app.module.ts
PlatformModule.forRoot({ …, settings: [...NOTE_SETTINGS] })
// anywhere
const delay = await this.settings.get(NOTE_PUBLISH_DELAY);          // for everyone
const rich = await this.settings.enabled(NOTE_RICH_TEXT, user);     // for this principal
```

- `key`: dotted, the feature first. `schema`: a Zod type the value must
  pass (the default is checked at start). `scopes`: where it may be set,
  `['global']` by default; add `orgUnit` and/or `user` (a `user` scope
  makes it a preference users set for themselves). `public: false` hides
  it from callers who don't manage settings. A `flag()` is a boolean
  setting with every scope and a rollout.
- Precedence for a principal: their own value → one of their org units'
  (in the order of their units) → the global value → a flag's rollout →
  the default. `settings.resolve()` also says which.
- Values are cached per instance and refreshed through a version in
  Redis after every change, like custom fields: a change applies on the
  next request on every instance.
- In a durable workflow, read a setting inside `ctx.step()` so a replay
  sees the value the instance started with (`note-publication.workflow.ts`).

## For administrators (`Access.manageSettings`)

```
GET    /v1/settings                     every setting, with your value and its source (also for anyone, public ones)
GET    /v1/settings/{key}/overrides     the stored values, every scope
PUT    /v1/settings/{key}               { scope?: global|orgUnit|user, scopeId?, value?, rollout? }
DELETE /v1/settings/{key}?scope=&scopeId=
```

- `scopeId`: the org unit's id, or the principal's key (`user:<id>`,
  `client:<id>`); none for global. The scope must be one the setting
  takes; the value must pass its schema (400 `validation_failed`, the
  path naming `scope`, `value` or `rollout`).
- A flag at the global scope takes `rollout: 20` (a percentage) with no
  value: it is then on for a stable 20 % of principals (the same
  principal always gets the same answer; raising the percentage never
  switches anyone off). A value, when set, beats the rollout.
- Every change is audited (`setting.updated` with from → to,
  `setting.reset`).

## For users and clients

```
GET    /v1/settings                 your value of each (and `source`: user, orgUnit, global, rollout, default)
GET    /v1/settings/{key}
PUT    /v1/settings/{key}/mine      { value }   settings whose scopes include user
DELETE /v1/settings/{key}/mine
```
