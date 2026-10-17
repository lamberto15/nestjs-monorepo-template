# @nestjs-monorepo-template/api-client

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
