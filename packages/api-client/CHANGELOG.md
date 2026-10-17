# @nestjs-monorepo-template/api-client

## 0.2.0

### Minor Changes

- 09956cb: `createApiClient` looks up `globalThis.fetch` on every request instead of keeping the one it saw at creation, so a fetch replaced later (msw, instrumentation) is used; a `fetch` option still wins. `unwrap()` returns `undefined` for a 2xx without a body (204: sign-out, deletes, `POST /v1/auth/tenant`) instead of throwing `empty_response`, and is typed `undefined` for those operations; a 304 still throws `not_modified`. Each item of `GET /v1/auth/sessions` has a readable `device` ("Chrome on macOS", null when no user agent was recorded).
- f7deea1: `GET /v1/features` says which deployment switches are on, for a client that
  hides what is turned off: `realtime`, `webhooks`, `reports`, `usage`,
  `impersonation`, `mfa`, `apiClients`, `passkeys`, `signUp`, `magicLink`,
  `documents`, `tenancy` and `locales`. Any signed-in caller may read it.
- b17332e: `GET /v1/lists/{subject}`: a field whose values are ids of something has an optional `ref` (`tag`, `team`, `principal` for an owner's `user:<id>` / `client:<id>` key, or a record's subject), so a client renders a picker instead of guessing from the field's name.
- c5f9793: `GET /v1/lists/{subject}`: a list described at runtime (its filterable and sortable fields with their operators, enum options, the tenant's custom fields, `fields=` names, search, the recycle bin and the list limits), as the caller's permissions let them see it.
- ccfc29b: The notification preferences are typed. `GET /v1/notifications/types` (`channels`), `GET` and `PUT /v1/notifications/preferences` describe each channel's setting instead of `{ [key: string]: unknown }`: `email?: 'immediate' | 'hourly' | 'daily' | false` (users) and `webhook?: boolean` (API clients); in-app and realtime are always on and not settings. New `POST /v1/notifications/test` (development and tests only, absent in production) sends the caller a `system.test` notification through every channel they have on and answers `{ id }`.
- 7763a97: Record pages: `GET /v1/notes/{id}` and `GET /v1/notes` take `?include=can`,
  which adds `can: { update, delete, restore }` to each note (what its routes
  would allow you now; not part of the ETag). `POST /v1/notes` and
  `POST /v1/notes/{id}/restore` answer with the strong ETag `GET` sends, good
  as `If-Match` at once. Notes no longer carry `tenantId` (it was never in the
  schema). CORS exposes `ETag`, `Location` and `Idempotent-Replayed` to
  browser apps on `CORS_ORIGINS`.
- 8f65f9f: Settings describe their values and who may set them; the access API's read routes are typed (#111).

  - `GET /v1/settings` and `/v1/settings/{key}`: each setting adds `type` (`boolean | number | string | enum | json`), `options` (enums), `min`/`max`/`integer` (numbers), `maxLength` (strings) and `schema` (its JSON Schema), generated from the declaration's Zod schema; `canEdit` (you may set its value for the tenant, a team or a principal) and `canSetMine` (you may set your own).
  - New `GET /v1/access/principals?q=&kind=user|client`: the tenant's users and API clients searched by name or address, as principal keys (`user:<id>`, `client:<id>`), cursor-paged; for those who may list users and clients.
  - `GET /v1/access/users`, `/v1/access/roles` (and `POST`), `/v1/access/catalog` and `/v1/access/audit` declare their responses: no longer `never`. The users list no longer carries `tenantId` (always null).
  - `DELETE /v1/settings/{key}` was already a typed 204 (`unwrap()` returns `undefined`); a test now holds it.

### Patch Changes

- 6f97c69: A field the caller may read on some records only (a grant with conditions)
  can no longer be filtered, sorted or searched by (`q`, `sort=-rank`): 403
  `field_forbidden`, as for a hidden field; `fields=` still picks it.
  `GET /v1/lists/{subject}` describes such a field with no `operators`, not
  `sortable`, and `search: false` when the search reads one. A sorted list's
  `nextCursor` is now sealed by the server (opaque, bound to its `sort`): a
  cursor issued before the upgrade, or changed, is a 400; start again from the
  first page.
- 0abbd22: List routes, exports and scheduled reports document their 403 `field_forbidden`: a filter, search, sort or `fields` on a field the caller's permissions hide is refused.
- de31246: `redirectTo` (`POST /v1/auth/magic-link`, `GET /v1/auth/oidc/{provider}/login`): a path of the web app only (one leading `/`, printable ASCII, no `\`, at most 2,048 characters), with the pattern in the schema; anything else is a 400 on the magic link and ignored by the OIDC login.

## 0.1.0

### Minor Changes

- 053382a: New route `POST /v1/account/deletion/cancel { token }`: cancels a pending
  account deletion with the token of the deletion mail's link, without a
  sign-in. `GET /v1/auth/oidc/{provider}/login` takes `reauthenticate=true`
  (a step-up through the provider, with a fresh login there), and
  `POST /v1/auth/mfa/verify` documents the bot-protection header
  `X-Captcha-Token` (a wrong code counts as a failed sign-in).
- a652ccc: `GET /v1/auth/me` has `mfaEnrollmentRequired`: the tenant (or one of the
  user's teams) requires two-factor (`auth.requireMfa`) and the user has
  none, so other routes answer 403 `mfa_enrollment_required` until they set
  it up (`POST /v1/auth/mfa/enroll`, then `/confirm`).
- 6b5a277: Passkeys (WebAuthn, roadmap 3): `GET /auth/passkeys`,
  `POST /auth/passkeys/registration/options` and `POST /auth/passkeys`
  (register), `PATCH` and `DELETE /auth/passkeys/{id}`; signing in with
  `POST /auth/passkeys/sign-in/options`, then `POST /auth/passkeys/sign-in`
  (browser) or `POST /auth/passkeys/token` (app, with an optional `tenantId`);
  `POST /auth/passkeys/reauthentication/options`, and `POST /auth/reauthenticate`
  takes `passkey`. `GET /auth/methods` has `passkeys`.
- 7c1ed4f: Org units are teams: `/v1/access/org-units` is `/v1/access/teams` (`TeamsController_*` operations), `orgUnitIds` is `teamIds` (users, invitations), the notes' `orgUnitId` field and filter are `teamId`, the settings scope `orgUnit` is `team`, the approval rule `orgUnitRole` is `teamRole`, the permission `manageOrgUnits` is `manageTeams` and the condition `inMyUnits` is `inMyTeams`.
- 43c53b3: Tenancy (roadmap 1a), breaking: users carry the `tenantId` they act in, and
  `GET /auth/me` the `tenant`; new routes `GET /auth/tenants`,
  `POST /auth/tenant` (switch: the session is re-issued), `GET /tenants` and
  `POST /tenants` (operators); `POST /auth/token` takes an optional `tenantId`.
  The settings scope `global` is now `tenant`. Every other route answers within
  the caller's tenant.
  Invitations replace administrator-made accounts: `POST /access/users` answers
  202 with the invitation, `POST /auth/invitations/accept` takes its token.
  Sign-up makes no session; `POST /auth/email/verify` takes the sign-up's
  `password`.

### Patch Changes

- 7a4f874: `createRealtime` trims the URL's trailing slashes in linear time (it used a
  regex that was quadratic on a URL of many slashes). The types document the
  OIDC callback's query (`code`, `state`, `error`, `iss`), and a custom
  field's `validation.pattern` is now described as RE2 syntax: no lookaround,
  no backreferences.
- 46faff4: The notes bulk and watch paths moved in `openapi.json` (generated record routes); every operation, operationId and schema is unchanged.
- bdd3b48: `POST /v1/tenants` documents 409 `single_tenant` (a deployment with `TENANCY=single`).
