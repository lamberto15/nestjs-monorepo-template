# Accounts and authentication

Built on `@nestjs/authentication`; everything it stores is in PostgreSQL
(`DrizzleAuthenticationStore`, `iam/auth/`), checked against the package's
store contract (`apps/api/test/stores.e2e-spec.ts`).

## Users

| Need | Route |
| --- | --- |
| Sign in / out | `POST /v1/auth/sign-in`, `POST /v1/auth/sign-out` |
| Who am I, what may I do | `GET /v1/auth/me` (`can`: every `Subject.action`) |
| Name, language, time zone | `PATCH /v1/auth/me` |
| Sign-up (when `AUTH_SIGN_UP=on`) | `POST /v1/auth/sign-up` |
| Sign-in options for the page | `GET /v1/auth/methods` |
| Which switches are on (a signed-in client) | `GET /v1/features`: [configuration](configuration.md#which-switches-are-on-get-v1features) |
| Forgot / reset password | `POST /v1/auth/password/forgot`, `POST /v1/auth/password/reset` |
| Change password | `POST /v1/auth/password/change` (others signed out; [step-up](#step-up-recent-authentication)) |
| Verify email | `POST /v1/auth/email/verify`, resend: `POST /v1/auth/email/verification` (signed in), `POST /v1/auth/email/verification/resend { email }` (no session) |
| Sessions (each with how it was signed in, and its device) | `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/{id}`, `POST /v1/auth/sign-out-everywhere` |
| Re-authenticate for a sensitive action | `GET /v1/auth/reauthenticate` (how, until when), `POST /v1/auth/reauthenticate`: see [Step-up](#step-up-recent-authentication) |
| Two-factor (TOTP) | `GET /v1/auth/mfa` (status), `POST /v1/auth/mfa/enroll`, `/confirm` (recovery codes), `/verify` (sign-in), `/recovery-codes`, `DELETE /v1/auth/mfa` |
| Magic link | `POST /v1/auth/magic-link`, `POST /v1/auth/magic-link/verify` |
| Passkeys | `GET /v1/auth/passkeys`, `POST /v1/auth/passkeys/registration/options` → `POST /v1/auth/passkeys`, `PATCH`/`DELETE /v1/auth/passkeys/{id}`; sign in: `POST /v1/auth/passkeys/sign-in/options` → `/sign-in` (a browser) or `/token` (an app); see [Passkeys](#passkeys) |
| Google, Microsoft, GitHub | `GET /v1/auth/oidc/{provider}/login` → `/callback`; linked: `GET /v1/auth/identities`, unlink: `DELETE /v1/auth/identities/{provider}` |
| Mobile apps | `POST /v1/auth/token` (`tenantId`: the tenant the tokens act in), `/token/refresh`, `/token/revoke` |
| A tenant's own identity provider (SAML, OpenID Connect) | `POST /v1/auth/sso/discover { email }` → `loginUrl`, `GET /v1/auth/sso/{tenantId}/{connectionId}/login`; set up with `/v1/sso/…`, SCIM at `/v1/scim`: see [Enterprise SSO](#enterprise-sso) |
| Your tenants, and acting in another | `GET /v1/auth/tenants`, `POST /v1/auth/tenant { tenantId }` (re-issues the session): [tenancy](tenancy.md) |

- **Email links** open pages of the web app (`WEB_URL/reset-password`,
  `/verify-email`, `/magic-link`) that POST the token back: mail scanners
  follow GET links. Links are single-use and short-lived.
- **`redirectTo`** (`POST /v1/auth/magic-link`,
  `GET /v1/auth/oidc/{provider}/login`) is a path of the web app, never
  another site: one leading `/`, printable ASCII only (no space, tab,
  newline or other control), no `\`, no scheme (`https:`, `javascript:`),
  at most 2,048 characters, and the same once percent-decoded (`/%09/x`,
  `/%5Cx`); resolved against `WEB_URL` it must stay on its origin
  (`core/http/redirect-path.ts`: `redirectPath`, `isSafeRedirectPath`,
  `webAppUrl`). The magic link refuses anything else (400
  `validation_failed`); the OIDC login, which the browser navigates to,
  ignores it (the web app's root). A stored value is checked again before
  it is answered (`magic-link/verify`'s `redirectTo`) or redirected to (the
  OIDC callback, which lands on `WEB_URL` + the path): one stored before
  the rule falls back to the default.
- **Accounts are global, memberships per tenant** ([tenancy](tenancy.md)):
  one account per address, in every tenant it belongs to; a session acts in
  one (`GET /v1/auth/me`'s `tenant`; its `operator` is true in the
  operator tenant, where the operators' routes answer), the last chosen at sign-in. A
  tenant's administrators manage its memberships (`PATCH` deactivates the
  membership, never the account) and never set or change anyone's password
  or name.
- **Invitations (the default way in; [identity](identity.md) lists the other modes):** `POST /v1/access/users` (202) mails the
  address a link (`WEB_URL/accept-invitation`), or with `send: false`
  prepares the member and mails nothing until `POST /v1/access/invitations/{id}/send`; nothing about an account is
  read, changed or returned until its owner accepts at
  `POST /v1/auth/invitations/accept`: a new address chooses its password
  there, an existing account accepts signed in as itself
  ([tenancy](tenancy.md), "Accounts and sessions").
- **A proved address** (`emailVerified`) is wanted to link a provider or
  enrol two-factor (403 `email_unverified`).
- **Sign-up: verify first** (`AUTH_SIGN_UP=on`). `POST /v1/auth/sign-up` makes
  the account and mails a verification link; it makes no session. Its
  password signs in (session or token) only once the address is proved:
  before, the right password gets 403 `email_unverified` (a wrong one the
  usual 401). Proving it takes the link **and** that password
  (`POST /v1/auth/email/verify { token, password }`; without it 400
  `password_required`, a wrong one 403, the link usable again either way):
  the link proves the mailbox, not who chose the password, so whoever signed
  up someone else's address can't have its owner verify it for them and
  sign in as the owner. The owner of such an address uses
  "forgot password" instead: the reset link proves the address and replaces
  the password. **A lost link** is sent again without a session:
  `POST /v1/auth/email/verification/resend { email }` (the sign-up's "check
  your mailbox" screen, the sign-in page's `email_unverified`). Shaped like
  forgot password: always 202 `{ accepted: true }`, at once, whether the
  address has an unproved account, a proved one or none; the account is
  looked up after the answer (`VerificationRequests`,
  `iam/account/verification-requests.service.ts`), and only an active
  account with a password whose address is unproved gets a new link, at
  most one a minute (the sign-up's own counts), through the mail queue.
  Limited to 5 per email and IP in 15 minutes, with the bot check (action
  `resend-verification`). Signed in, `POST /v1/auth/email/verification`
  (no body) does the same for the user's own address. The account joins no tenant (a tenant invites it); with
  `TENANCY=single` it joins the one tenant, and with `TENANT_SIGN_UP=on` it
  makes its own (`tenantName`) and administers it
  ([tenancy](tenancy.md), "Tenants made at sign-up"). A provider sign-in that asserts the address is verified
  already; invitations prove it with their link.
- **Account linking** by verified email only, or from a signed-in session
  (`?link=true`): never by an unverified address.
- **Two-factor** secrets are encrypted at rest (`MFA_ENCRYPTION_KEYS`); a code
  works once; failures lock out for 15 minutes.
- **Refresh tokens** rotate; one presented twice revokes its whole family.
- **New passwords** are 12 to 128 characters (a tenant may ask for more:
  [Policies](#policies)) and not found in data breaches: see
  [Passwords](#passwords).
- **Account emails** are rendered in the user's language and time zone and
  sent through the mail queue (workers).

### Passwords

NIST SP 800-63B: length, no composition rules, and no password from a
breach corpus. Every place a password is **set** checks it against Have I
Been Pwned's [Pwned Passwords](https://haveibeenpwned.com/API/v3#PwnedPasswords)
(`BreachedPasswordsService`, `iam/account/breached-passwords.service.ts`):
sign-up, a reset link (`POST /v1/auth/password/reset`), an invitation's
acceptance (`POST /v1/auth/invitations/accept`) and
`POST /v1/auth/password/change`. Administrators set no passwords.

- **k-anonymity:** the password's SHA-1 is computed here; only its first 5
  hex characters go to `GET <PASSWORD_BREACH_API_URL>/range/{prefix}`, with
  `Add-Padding: true` (the answer is padded with count-0 lines, so its size
  says nothing); the other 35 are compared here. Neither the password nor
  its full hash is ever sent or logged.
- **Refused:** 400 `password_breached`, with the field in `errors`
  (`password`, or `newPassword` on a change), translated; nothing else
  (not how often it was seen). The current password of a change is checked
  first (403), and a refused reset leaves its link working.
- **The API unreachable** (`PASSWORD_BREACH_TIMEOUT_MS`, 2 s, one attempt:
  the user waits on it): `PASSWORD_BREACH_ON_ERROR=allow` (the default)
  lets the password through and logs a warning; `reject` answers 503
  `password_check_unavailable` (`Retry-After: 60`). Fail-open is the
  default because the check is a second line of defence (the length rule,
  rate limits, hashing and two-factor stay): an outage of a third-party API
  must not stop people from resetting a password or an administrator from
  inviting someone. Choose `reject` when a policy requires the check.
- **Settings:** `PASSWORD_BREACH_CHECK` (`on` by default, so in production;
  `off` in the e2e tests but `apps/api/test/breached-passwords.e2e-spec.ts`, which
  runs it against a stub on loopback), `PASSWORD_BREACH_MIN_COUNT` (1: a
  password seen fewer times passes), `PASSWORD_BREACH_API_URL` (a
  self-hosted mirror of the range API for air-gapped deployments, e.g. one
  served from the downloadable corpus), `PASSWORD_BREACH_RECHECK_DAYS` (30:
  how long a sign-in's password counts as checked). `compose.prod.yaml`
  passes all six to the containers: set them in `.env`.
- **`ADMIN_PASSWORD`** is only warned about (an error in the log on the
  first start): refusing it would leave the deployment without an
  administrator. A generated one isn't checked.
- **Password history** (`auth.passwordHistory`, a tenant setting, 0 to 24,
  `0` = off, the default): a new password may not repeat the account's
  last N, the current one included: 422 `password_reused` (`history`, the
  field in `errors`: `newPassword` on a change, `password` on a reset),
  translated. Checked on a change and a reset link (before the link is
  spent, so a refused password leaves it working), after the length and
  before the breach check; sign-up and invitations make a first password and
  have nothing to compare. A person in several tenants meets the strictest
  (like the minimum length). Only **hashes** are kept, never a password:
  `password_history` (`iam/iam.tables.ts`, global like the account, deleted
  with it, never in the data export) takes the hash a change or reset
  replaces, in the same transaction, and is pruned to N - 1 rows. While no
  tenant asks for a history nothing is kept, and the next change drops what
  was (so turning it on starts from the current password, and the account
  gets the full history only as it changes passwords). The comparison is a
  scrypt verification per kept hash, **all under one hashing slot** in
  turn (`PasswordHistoryService`, `iam/account/password-history.service.ts`,
  `limiter.run()`; the limit of 24 bounds the work): never N parallel
  hashes, and a full queue answers 503 `server_busy` before anything is
  spent. A sign-in's rehash and an operator's `ops` reset don't touch it.
- **Hashing:** scrypt from @nestjs/authentication's `PasswordHasher`
  (N = 2^17, r = 8, p = 1: 128 MiB and ~0.4 s of CPU per hash; stored as
  `$scrypt$ln=17,r=8,p=1$…`, so a hash keeps verifying when the parameters
  change, and sign-in rehashes it). At most `PASSWORD_HASH_CONCURRENCY` run
  at once per process (`iam/account/password-hashing.ts`, every sign-in,
  token, re-authentication, change, reset and seed); the next wait, and past
  `PASSWORD_HASH_MAX_QUEUE` or `PASSWORD_HASH_QUEUE_TIMEOUT_MS` they answer
  503 `server_busy` (`Retry-After: 1`). An unknown email waits and hashes
  like a known one. A reset or invitation link takes its slot before the
  package consumes the token (`limiter.run()` around `reset()`, re-entrant),
  so a busy answer leaves the link working; any new flow that spends
  something and then hashes must do the same. Sizing: [deployment.md](deployment.md#resource-limits).
- **At sign-in too, never in its way** (`SignInPasswordCheck`,
  `iam/account/sign-in-password-check.ts`): a password set before it
  appeared in a breach (or before the check existed) is caught at a later
  sign-in, by password, in a browser or a token client
  (`POST /v1/auth/token`). Once the password is verified, the check starts
  and the sign-in answers without waiting for it: a slow or unreachable API
  never delays or fails a sign-in, whatever `PASSWORD_BREACH_ON_ERROR` says,
  and any failure (the API, Redis, the database) is logged by kind only. The
  plaintext is split into its hash prefix and suffix at once and dropped;
  the same k-anonymity range query runs. In-process, not a queue job, on
  purpose: a job would store the password's unsalted SHA-1 in Redis until a
  worker ran it. A breached password is audited (`auth.password-breached`,
  the account as actor and target) and its owner told,
  `security.passwordBreached` (mandatory: in-app at once, by mail
  immediately; [Security notifications](#security-notifications)), asking
  for a change, linking to `/account/security`. Changing the password or
  resetting it marks the unread alert read in the same transaction. The sign-in still goes through: a deployment that wants a
  forced change must add it (nothing in `GET /v1/auth/me` says so yet).
- **Checked once per password, then every `PASSWORD_BREACH_RECHECK_DAYS`**
  (30): a Redis key per account and stored hash
  (`password-breach:<user id>:<16 characters of the SHA-256 of the scrypt
  hash>`, `SET NX EX`, so concurrent sign-ins check once). The scrypt hash
  is salted and changes with every new password (and every rehash), so a new
  password is checked at its first sign-in without anything to clear, and a
  breached one that isn't changed is told about again after the period (the
  corpus grows). A check the API couldn't answer drops its key: the next
  sign-in tries again.

### Your data, your account's deletion, consents (`/v1/account`)

| Need | Route |
| --- | --- |
| A pending deletion, what you agreed to | `GET /v1/account` |
| A copy of everything held about you | `POST /v1/account/export { format? }` → 202 `{ id, status }`, then `GET /v1/data/transfers/{id}` for the file (one row per record: `kind`, `id`, `data`; the account's own records, then, after a `membership` row, each tenant's) |
| The copies you asked for | `GET /v1/account/exports?limit=&cursor=` (below) |
| Delete your account | `POST /v1/account/deletion { password? }` (your password when the account has one: `hasPassword` of `GET /v1/auth/me`; and a recent sign-in: [step-up](#step-up-recent-authentication)) → carried out after `ACCOUNT_DELETION_GRACE_DAYS`, a mail says when; your other sessions are signed out (below); `DELETE /v1/account/deletion` cancels, and so does the mail's link, without a sign-in (below), until the job starts on it |
| The kinds of consent asked for | `GET /v1/account/consent-kinds` (public: `kind`, current `version`, `required`, `label`, `description`) |
| Terms, privacy policy, marketing | `POST /v1/account/consents { kind, version }` (a declared kind, its current version), `DELETE /v1/account/consents/{kind}` (withdraw), `GET /v1/account/consents` (the latest of each kind, with `withdrawnAt`; every acceptance kept as proof) |

**Consents** are declared, not free text: `CONSENT_KINDS`
(`platform/account/consent-kinds.ts`, handed over in `app.module.ts` as
`PlatformModule.forRoot({ consents })`) names each kind, its current
`version` and whether it is `required`; the texts are the catalogs'
`auth.consentKinds.<kind>.label` and `.description` (the start fails
without the English ones). The template asks for `terms` and `privacy`
(required) and `marketing` (optional), version `2026-01`. Publish a new
text: bump the version; a user whose latest acceptance is of another
version is asked again (the client compares it with `GET
/v1/account/consent-kinds`, public so a sign-up page can show them too).
Accepting anything else (an unknown kind, an older or newer version) is a
400 `validation_failed` naming `kind` or `version`.

- **Kept as proof:** every acceptance is a row (`consents`: kind, version,
  time, address), never overwritten or deleted while the account lives;
  accepting again adds one. `GET /v1/account/consents` shows the latest
  per kind; the account export holds them all.
- **Withdrawing** (GDPR Art. 7(3): as easy as giving it) is one request
  with no password and no step-up, as accepting is: `DELETE
  /v1/account/consents/{kind}` stamps the kind's acceptances still in force
  with `withdrawn_at` and the address (`withdrawal_ip`), in one transaction
  with its audit entry (`account.consent-withdrawn`, `details: { kind,
  version }`), and answers the kind's state. Nothing in force: 404.
  Accepting again gives it anew (a new row; the withdrawn one stays). A
  kind no longer declared can still be withdrawn.
- **A required kind can't be withdrawn** (409 `consent_required`): the terms
  and the privacy policy are the contract the service runs on (GDPR Art.
  6(1)(b)), not a consent one withdraws while keeping the account; the way
  out is deleting the account. Process anything on consent (Art. 6(1)(a)),
  such as marketing, under an optional kind, and check it is in force
  (`withdrawnAt` null) before acting on it.

**The account exports list** (`GET /v1/account/exports`): the caller's own
account exports, newest first, by cursor (`limit`, `cursor` = the previous
`nextCursor`), each as `GET /v1/data/transfers/{id}` tells it (`status`,
`createdAt`, `finishedAt`, `expiresAt`, the result's link, valid 30 minutes
from the answer). Kept as long as BullMQ keeps the job, 7 days after it ends
(`expiresAt`), then gone: ask for a new one. Account-level, like the export:
the same in any tenant or none, indexed under the account
(`account:jobs:data-transfers:account:<principal key>`, `JobIndex`), each
job's principal checked again; never while impersonating (403), never
another user's. `GET /v1/data/transfers` stays the tenant's transfers.

**Deletion and sessions.** A new request signs out every other session and
every token client (their refresh tokens; an access token lives until it
expires), as a password change does, after the request commits; the
session that asked keeps going, to cancel. The audit entry
(`account.deletion-requested`) counts them (`details.signedOut: {
sessions, tokens }`). Cancelling needs no session anyway: the person can
sign in again while the request is pending (the account stays active until
the job runs), or use the mail's link. Asking again while one is pending
returns that request as is: no new mail, nothing signed out.

The nightly job anonymizes a due account (`UsersRepository.anonymize`):
placeholder address and name, no password (nor its history,
`password_history`), sign-in methods, sessions,
tokens, memberships (with their roles and units); its notifications,
preferences and settings go;
its audit entries keep the actor key, labelled "Deleted user". Records
the person created stay, owned by an account that is nobody's. A legal hold on the person
(subject `User`, [retention.md](retention.md)) in any of their tenants keeps the job from
starting: the request stays open and cancellable. A feature
holding personal data registers a `PersonalDataSource` (`rows()` for the
export, `erase()` for what must go with the person; `note.transfer.ts`).
**The cancel link** in the deletion mail (`WEB_URL/cancel-deletion?token=…`;
the web app's page POSTs the token to the public
`POST /v1/account/deletion/cancel { token }`, 204; a GET would let a mail
scanner that follows links cancel it) needs no sign-in: the person may have
lost their password, or never asked and wants it stopped at once. The
token (`platform/account/deletion-cancel-links.ts`) is a JWT signed with
@nestjs/authentication's `JwtSigner`, with a key derived from `JWT_SECRET`
(HKDF, a label of its own: an access token's key never verifies it, nor
it an access token), its own audience and `typ`; it names the user and
the request, and expires a day after the scheduled date (the job runs
nightly). It works **once**: the route cancels only a request still
pending and not yet started, in one conditional `UPDATE` under the
account's lock (`UsersRepository.lockAccount()`), so a second use, the link
of an earlier request, or one after the deletion ran finds nothing. The job
claims a due request under the same lock (`started_at`) before it erases
the person tenant by tenant: from then on neither route cancels it, so no
cancel lands between one tenant's erasure and the next (a run that fails
part-way carries on the next night). Every refusal is the same 400
(`auth.invalidLink`), saying neither why nor whether the account exists;
10 attempts per address in 15 minutes. The route needs no tenant: the
cancel and its audit entry are account-level (`account.deletion-cancelled`,
the user's own, `details.via: link`, in no tenant's log). The token travels in the mail job's `token`
field, which the log redaction masks. Proof:
`account-lifecycle.e2e-spec.ts`, `security.e2e-spec.ts` ("the deletion
mail's cancel link"), `deletion-cancel-links.spec.ts`.

All of it is audited (`account.deletion-requested`, `-cancelled`,
`account.deleted`, `account.consented`, `account.consent-withdrawn`); `account.deleted` is the job's,
the system principal `system:account-deletion`. Never while impersonating.

**Across tenants** ([tenancy](tenancy.md)): the account is the person's,
not a tenant's. Its entries above are account-level (no tenant: no
tenant's administrator reads them), whichever tenant the session is in.
The export (queued in no tenant, so an account with none has one too,
filed under `accounts/<user id>/`) reads each tenant the person belongs to
in that tenant's scope: everything it holds about them for an active
membership, only what is personal (the membership, audit entries
about them) for a tenant they left, never its business records. Account
data (`GET /v1/account`, consents, notification preferences, the
account's own notifications) stays hidden while impersonating. The deletion erases their data in
each of those tenants (`PersonalDataSource.erase` per tenant, one
transaction each), then anonymizes the account outside any tenant. A run
cut short leaves the request open, and the next night finishes it.

## Step-up (recent authentication)

Sensitive actions want the user to have proved who they are in the last
`REAUTHENTICATION_MAX_AGE_MINUTES` (10): a sign-in, or a re-authentication.
Older, the route answers 403 `reauthentication_required`; the client
re-authenticates and retries. The second factor's own step-up
(`@Authenticate({ mfa: true })`, the package's) stays where it was.

### How each session was signed in

Every session's metadata (the package's `SessionRecord.metadata`, the
`sessions.metadata` column) records, next to the user agent and address:

| Key | What |
| --- | --- |
| `method` | `password`, `magic-link`, `oidc`, `passkey`, `sso` (a tenant's connection, [Enterprise SSO](#enterprise-sso)); `impersonation` for an administrator's session as the user |
| `provider` | the OIDC provider (`google`), or the SSO connection's id |
| `authenticatedAt` | the sign-in, then each re-authentication (ISO 8601); dropped by a tenant switch (`POST /v1/auth/tenant`), so a step-up proven in one tenant never authorizes a sensitive action in another: the new tenant asks again (#738) |

The second factor is the session's own `mfa` (`verified`). Both keys are
written by `session.metadata` (IamModule), the package's hook that every
sign-in passes through, in the same row write as the rest: the app's own
sign-ins pass the method with `signInOptions()`
(`iam/auth/authentication-method.ts`); the package's (a magic link's
`consume()`, the OIDC callback's `finish()`) take no metadata, so the route
runs them in `SignInContext.run('magic-link', …)`
(`iam/auth/sign-in-context.ts`), a CLS context the hook reads the method
from. A new sign-in method calls `SignInService.signIn(userId,
signInOptions('passkey'))` (or `sso:<id>`), or runs the package's call in
`SignInContext.run()`.

- **Two-factor:** the password sets `authenticatedAt`; the session is
  `mfa: pending` until the code, and the package's `completeMfa()` rotates
  it copying that time. `AccountService.completeMfa()` stamps the new
  session with now (one atomic merge): the sign-in completed then.
- **A provider** may sign the user in from its own session without asking
  again, so the callback's time proves nothing by itself. `OidcAccounts`
  (the resolver) takes the ID token's `auth_time` (OpenID Connect; Google
  and Microsoft send it) as `authenticatedAt`, through
  `SignInContext.authenticatedAt()`. A provider without it (GitHub: OAuth
  2.0, no ID token) records now: a weaker guarantee. So does a tenant's
  OAuth 2.0 SSO connection (Lark and the like, [OAuth 2.0
  connections](#oauth-20-connections)). A step-up through
  a provider asks it for a fresh login (`?reauthenticate=true`, below).
- **An impersonation** session never counts as recent, whatever its
  metadata says (`isRecent()`, `authentication-method.ts`): nobody signed
  in to it.

`GET /v1/auth/sessions` lists `method`, `provider`, `mfa` and
`authenticatedAt` per session, and a readable `device` ("Chrome on macOS",
null when no user agent was recorded) next to the raw `userAgent`; it is the
summary the security alerts use (`deviceLabel()`, `iam/account/devices.ts`),
so clients don't parse user agents; `GET /v1/auth/me` has the current
credential's `authentication` (`via`: `session` or `token`) and
`recentUntil`.

Token clients (`POST /v1/auth/token`) carry it in the access token: `amr`
(RFC 8176: `pwd`, `pop` for a passkey, and `mfa` from the package) and `auth_time` (OpenID
Connect, epoch seconds), fixed for the refresh family's life
(`RefreshTokenRecord.claims`), with `sid`, the family's own id (random, per
sign-in): revoking the family disconnects the realtime sockets its access
tokens opened, and they open no new one; a socket also ends at its access
token's `exp` ([realtime](webhooks-and-realtime.md#realtime)). The package has no listing of refresh
families, so they aren't in the sessions list.

**Families from before `sid`.** A refresh copies the family's stored
claims, so a family signed in before the release that added `sid` never
gets one, for its whole life (a family lasts up to 90 days): revoking
it still refuses its refreshes, but its realtime sockets are not
disconnected at once and a reconnect with its unexpired access token is not
refused. Nothing revokes those families on upgrade (that would sign every
app out). Each is covered from its next sign-in. To end them sooner: the
person signs out everywhere (`POST /v1/auth/sign-out-everywhere`, every
browser and app), an operator resets one account (`user:reset-password`,
[deployment](deployment.md#operator-cli)), or, for the whole deployment,
revoking the families without one signs those apps out (their users sign in
again):

```sql
update refresh_tokens set revoked = true where not revoked and claims ->> 'sid' is null;
```

Their live sockets end at the next restart of the API (a deploy restarts
it), and a reconnect then finds the family revoked.

### Requiring it on a route

```ts
@RecentAuthentication()                        // REAUTHENTICATION_MAX_AGE_MINUTES
@RecentAuthentication({ maxAgeMinutes: 5 })    // stricter for this route
@RecentAuthentication({ when: (req) => req.body?.password !== undefined })
```

`iam/auth/recent-authentication.ts`: a guard after the global
authentication and authorization guards (a caller without the permission
gets that 403 first). An API client has no sign-in to repeat: not checked.
Nobody signed in (a route with an optional session): 401. Any other kind
of principal (a `system`, PR #38) has nothing to prove with: 403. Never
while impersonating: 403 `forbidden`, whatever the session says.
`recentUntil` (`GET /v1/auth/me`, `GET /v1/auth/reauthenticate`) is
computed with the default window: a route with its own `maxAgeMinutes`
may want a re-authentication sooner, and says so with the problem's
`maxAge`.

The problem tells the client what to do:

```json
{
  "status": 403,
  "code": "reauthentication_required",
  "detail": "For this, confirm it's you: sign in again or re-authenticate",
  "maxAge": 600,
  "authenticatedAt": "2026-10-16T09:12:03.000Z",
  "methods": ["password", "magic-link", "oidc:google"],
  "mfaRequired": true
}
```

`methods`: `password`, `totp` and `passkey` re-authenticate in place
(`POST /v1/auth/reauthenticate`); `magic-link` and `oidc:<provider>` by
signing in again (the new session is recent): for a provider, the browser
navigates to `GET /v1/auth/oidc/{provider}/login?reauthenticate=true`
([below](#re-authenticating-through-a-provider)). `mfaRequired`: a code goes
with the password (and with a token client's passkey).

### The protected routes

| Route | Why |
| --- | --- |
| `POST /v1/auth/password/change` | a new password; an account without one gets its first here, with no current password to check (the current one is still asked when there is one, ASVS V6.2.3) |
| `POST /v1/auth/mfa/enroll` | a thief's authenticator would lock the owner out |
| `POST /v1/auth/mfa/recovery-codes`, `DELETE /v1/auth/mfa` | new codes are credentials; two-factor off weakens the account (both also want `mfa: verified`) |
| `GET /v1/auth/oidc/{provider}/login?link=true` | a linked provider lets whoever linked it back in at will (a plain sign-in isn't asked). The browser navigates here, so a stale session isn't answered with the 403 problem but sent to the web app: `redirectTo` (else its root) with `?error=reauthentication_required`; the frontend asks `GET /v1/auth/reauthenticate` before it starts a link, and spares the round trip. Nobody signed in: 401 |
| `DELETE /v1/auth/identities/{provider}` | removes a way to sign in |
| `POST /v1/auth/passkeys/registration/options`, `POST /v1/auth/passkeys` | a stolen session must not add its own passkey, a way back in at will |
| `PATCH /v1/auth/passkeys/{id}` | the name is what the owner reads in alerts and lists: a stolen session must not relabel its own passkey as the owner's |
| `DELETE /v1/auth/passkeys/{id}` | removes a way to sign in |
| `POST /v1/account/deletion` | irreversible after the grace period. The password stays required too (when the account has one): within the window a stolen session can enrol its own authenticator, and re-authenticating with that must not be enough to lock the owner out of "sign in and cancel". Passwordless accounts: step-up alone |
| `POST /v1/access/clients`, `POST /v1/access/clients/{id}/rotate` | a new API key is a new credential |
| `PATCH /v1/access/clients/{id}`, only with `roleIds` or `active: true` | roles are privileges; reactivating brings its keys back (revoking, a quota aren't asked) |
| `POST /v1/access/users`, only with non-empty `roleIds` | an invitation with privileges (one without roles isn't asked) |
| `POST /v1/access/invitations/{id}/send` | a link to a membership with the invitation's roles (the route can't tell from its request whether it has any, so it always asks) |
| `PATCH /v1/access/invitations/{id}`, only with `roleIds` or `email` | roles are privileges; a new address sends them to another mailbox |
| `PATCH /v1/access/users/{id}`, only with `roleIds` or `active: true` | roles are privileges; reactivating brings their access back (a deactivation isn't asked) |
| `POST /v1/access/users/{id}/impersonate` | acting as someone |
| `POST /v1/tenants/{id}/export`, `POST /v1/tenants/{id}/deletion` | the operators' copy of every record of a tenant; a tenant erased after its grace period ([tenancy](tenancy.md)) |
| `POST /v1/tenants/{id}/break-glass` | an operator reading a tenant that never invited them ([tenancy](tenancy.md#break-glass)) |
| `POST /v1/sso/connections`, `PATCH`/`DELETE /v1/sso/connections/{id}`, `POST /v1/sso/domains`, `DELETE /v1/sso/domains/{id}`, `PUT /v1/sso/policy`, `PUT`/`DELETE /v1/sso/exemptions/{userId}` | who may sign in to the tenant, and how ([Enterprise SSO](#enterprise-sso)) |
| `POST /v1/access/clients/{clientId}/webhook-endpoints`, `…/{id}/rotate-secret`; `POST /v1/webhook-senders`, `…/{id}/rotate-secret` | where a client's events go, and who may write into the tenant's webhooks: a new destination or secret ([webhooks-and-realtime](webhooks-and-realtime.md)) |

Not protected, on purpose: signing out (sessions, everywhere), data export
(a user can read their data anyway), consents, the profile, role
definitions and invitations without roles (frequent administration, behind
permissions and audited; add the decorator if a project wants them).
There is no route to change the address or to remove the password yet:
they take the decorator when they come.

### Re-authenticating

`POST /v1/auth/reauthenticate { password?, code?, recoveryCode?, passkey?, refreshToken? }`,
from a session or a token client (`GET` says how and until when):

- **What the account signs in with:** its password, and a code (or a
  recovery code) when two-factor is on; an account without a password but
  with two-factor, a code alone (`totp`). Or a **passkey**: the assertion
  of one of the account's passkeys, from
  `POST /v1/auth/passkeys/reauthentication/options` (a challenge bound to
  this session and user), with user verification (`uv`): it stands for
  the password and, from a session, for the code (the session becomes
  `mfa: verified`); a token client still sends a code with it when
  two-factor is on (the package's `issue()` takes no passkey as a second
  factor). None of these (an account that signs in only by link or
  provider): 409 `reauthentication_unavailable` with `methods`: sign in
  again.
- **The deletion's password** (`POST /v1/account/deletion`): wrong, 403
  `forbidden` (not the sign-in's 401, which a web app reads as signed
  out), audited as `account.deletion-refused` by the user; limited like
  this route (5 per address, 10 per account).
- **Missing:** 400 `validation_failed` naming `password` or `code`
  (`errors[].message` translated, `auth.required`). **Wrong:** 403
  `reauthentication_failed`; a wrong code counts towards the two-factor
  lockout.
- **A session** gets a new id (the cookie changes) with `authenticatedAt`
  now, and `mfa: verified` when a code was given. Two re-authentications
  submitted at once: the second carries the old cookie and gets 401 (the
  session was rotated meanwhile); the browser has the new cookie by then.
  Realtime connections (socket.io) authenticated with the cookie were
  opened under the old id: reconnect after re-authenticating. **A token
  client** gets new tokens (`tokens`) whose `auth_time` is now; its old
  access token keeps its time until it expires, and the family of the
  `refreshToken` it sent with the proof is revoked (an unknown one is
  ignored, RFC 7009). Without `refreshToken`, revoke the old one yourself
  (`POST /v1/auth/token/revoke`).
- **Rate-limited** like signing in: 5 per address in 15 minutes
  (`AppThrottlerGuard`), and 10 per account from anywhere
  (`@UserThrottle()`, `iam/auth/user-throttle.guard.ts`: the body names no
  email for the global guard to count by, so the signed-in user's id is
  the key; 429 `rate_limited` with `Retry-After-user`).
- **Audited:** `auth.reauthenticated` (`details.method`: `password`,
  `totp` or `passkey`, `mfa`, `via: token`) and
  `auth.reauthentication-failed` (`details.reason`: `password`, `code`,
  `impersonating`, `passkey:<why>`: `challenge`, `user-verification`,
  `counter`…).
- **Never while impersonating** (403, audited).

Signing in again by email link or with a provider re-authenticates too:
a link proves the mailbox now; a provider's sign-in counts from its ID
token's `auth_time` (above), so a plain one the provider did silently from
its own old session stays stale. Hence the step-up below.

#### Re-authenticating through a provider

`GET /v1/auth/oidc/{provider}/login?reauthenticate=true` (`redirectTo`
optional), navigated to from a signed-in session (none: 401; while
impersonating: 403; an unproved address: 403 `email_unverified`, as for
linking; with `link=true` too: 400):

- **The provider is asked for a fresh login**: the package's
  authorization URL (`OidcService.start()`: PKCE, `state`, `nonce`) gets
  `prompt=login` and `max_age=0` (`reauthenticationUrl()`,
  `iam/account/oidc-reauthentication.ts`). Custom: `start()` takes no
  per-request parameters and its `authorizationParams` are per provider,
  so setting them there would make every sign-in ask. Which of the two a
  provider honours is its own (Microsoft Entra ID, Keycloak and Okta take
  both; GitHub, OAuth 2.0, neither): the check below doesn't rely on it.
- **The callback checks it, since the parameters travel through the
  browser and are hints**: the login's `state` is remembered in Redis as a
  step-up of this user, from now (10 minutes), and the browser gets a
  cookie naming it (`__Host-oidc_reauth`, HttpOnly, SameSite=Lax). On the
  callback `OidcAccounts` accepts only an identity already connected to
  that user (no new account, no link by address, nobody else's), and an ID
  token `auth_time` from after the start (30 s of clock tolerance, the
  package's own for ID tokens). An OpenID Connect provider must send
  `auth_time` (`max_age` makes it required): a login without one is
  refused. Only a plain OAuth 2.0 provider (GitHub: no ID token) is
  accepted without it, as now, the weaker guarantee above.
- **The step-up can't be skipped**: the callback reads the remembered
  step-up and forgets it only once the login was judged, so a callback the
  package refuses (someone else's request with a `state` they learnt, no
  transaction cookie) leaves it for the browser that started it. A
  callback that carries the step-up cookie but whose step-up is gone is
  refused (`reason: expired`, audited anonymously), never finished as a
  plain sign-in.
- **Accepted**: the browser gets a new session, recent from `auth_time`
  (with two-factor on, pending its code as any sign-in), **in the tenant
  the re-authenticated session acted in** (remembered with the `state`;
  the user's last chosen tenant if the membership ended meanwhile), audited
  `auth.reauthenticated` (`method: oidc`, `provider`). **Refused**: no
  sign-in happens (the browser keeps its session) and it lands on the web
  app (`redirectTo`, else its root) with
  `?error=reauthentication_failed`, audited
  `auth.reauthentication-failed` (`reason`: `account`, `stale` or
  `expired`). Both
  entries are account-level, as every sign-in's: in no tenant's log.
- `?link=true` keeps the plain login: a link needs a recent session
  already.
- Proof: `oidc-reauthentication.e2e-spec.ts` (a configured GitHub, whose
  login URL needs no discovery; the callback's `finish()` replaced by one
  running the real resolver), `oidc-reauthentication.spec.ts`.

**SSO** re-authenticates by signing in again
(`sso:<connection>` in `methods`); "SSO required" refuses (403
`sso_required`) the sessions whose method is not `sso`, on every request
([SSO required](#sso-required)). A sign-in through an OAuth 2.0 connection
has no `auth_time`: it counts as authenticated at the callback, the weaker
guarantee above (the provider may have signed the person in silently from
its own session), and it satisfies "SSO required" as any connection's.

## Security notifications

IAM tells people about changes to their account's security, through the
platform's notifications (in-app, realtime, mail; see
[notifications.md](notifications.md)). The types are `IAM_NOTIFICATIONS`
(`iam/iam-notifications.ts`, texts under `security` in
`i18n/<locale>/notifications.json`), handed to the platform in
`app.module.ts`; `SecurityAlertsService` stores each one in the transaction
of the change's audit entry. All are mandatory: the mail can go hourly or
daily, never off.

| Type | When | `data` |
| --- | --- | --- |
| `security.newSignIn` | a sign-in from a new device, by any method: password (a browser or a token client), email link, passkey, Google / Microsoft / GitHub, a tenant's SSO (even with two-factor still to do) | `device` ("Chrome on macOS"), `ip`, `at` |
| `security.passwordChanged` | `POST /auth/password/change`, or a reset link when the account was used before (any audit entry as its actor: not an invitation's first password) | `via` (`change` \| `reset`), `ip` |
| `security.passwordBreached` | a password sign-in (browser or token) whose password is in the breach corpus, once per password per `PASSWORD_BREACH_RECHECK_DAYS` ([Passwords](#passwords)) | `at`, `ip` (the sign-in's) |
| `security.mfaChanged` | two-factor confirmed on, or turned off | `enabled`, `ip` |
| `security.passkeyAdded`, `security.passkeyRemoved` | a passkey registered, or removed | `name`, `ip` |
| `security.apiKeyRotated` | to the API client: `POST /access/clients/{id}/rotate` (webhook) | `clientId`, `keyId`, `previousKeysEnd` |
| `security.breakGlassStarted` | to each administrator of a tenant an operator opened with break-glass, in that tenant ([tenancy](tenancy.md#break-glass)) | `operator` (their address), `reason`, `expiresAt`, `ip` |

- **A device** is the user agent without its version numbers (a browser
  update is the same browser) plus the network: an IPv4 address whole, an
  IPv6 address by its /64 prefix (privacy extensions change the rest
  daily), hashed (`account/devices.ts`); `data.ip` and the audit entry keep
  the full address (`::ffff:` dropped). Each `auth.signed-in` audit entry keeps it in
  `details.device`. A sign-in is from a **new device** when the account
  signed in before but not with this hash in the last 30 days. The very
  first sign-in tells nobody. Repeats from one new device collapse into one
  notification (key `security.newSignIn:<hash>`), counted up. A wrong
  password records no sign-in and tells nobody.
- The orchestration is `AccountService` (`signInWithPassword`,
  `changePassword`, `enableMfa`, `disableMfa`, `passwordWasReset`): the
  write (the password hash, two-factor off with its recovery codes), its
  audit entry and the notification are one transaction: the package's
  store (`DrizzleAuthenticationStore`) joins it through the transaction
  host. Two exceptions: the code that confirms two-factor is checked
  before the transaction (a wrong one is counted towards the lockout and
  then refused; a rollback would forget the count), and sessions and
  tokens are revoked after the commit.
- Every sign-in writes one `auth.signed-in` entry (`details.method`:
  `password`, `magic-link`, `passkey` (with `passkey`, its id, and
  `userVerified`), `oidc:google`, `sso:<connection id>`; `via: token` for a token client), from
  the service that signs in (`signInWithPassword`, `issueTokens`,
  `signInWithMagicLink`, `PasskeysService`). The OIDC callback is signed in
  inside the package (`OidcService.finish`), so `SecurityAlertsService`
  hears its `sign-in` event instead and records it right after; its
  bookkeeping still running is awaited on shutdown (`settled()`).

### Sign-in log (tenant administrators)

`auth.signed-in` belongs to the person and sits in no tenant (docs/tenancy.md),
so no tenant's administrator reads it. Each sign-in also writes a second entry
in the tenant it lands in (a token's `tenantId`, else the member's last chosen
tenant): `member.signed-in`, with `details.method` (and `via`, `userAgent`).
A wrong password to a real account writes `member.sign-in-failed` the same
way, in that account's default tenant, after the 401 is sent and not waited
for (an unknown address has no tenant, and the two must take the same time).
So does a token sign-in (`POST /v1/auth/token`, `/v1/auth/passkeys/token`)
whose credentials held but whose `tenantId` names a tenant the user isn't a
member of (`details.reason: tenant`), next to an account-level
`auth.sign-in-failed` that names the tenant asked for; never in the tenant
named, whose administrators learn nothing of someone who isn't theirs
(`SignInLog.tenantRefused`).
`SignInLog` writes them. Not logged: wrong passkey assertions, magic links and
provider failures (no account is known), a wrong second factor.

`GET /v1/access/sign-ins` (`Access.readAudit`, the audit log's permission)
reads them, newest first: filter by `user` (`user:<id>`), `method`,
`result` (`success`/`failure`), `ip` and `at`; `GET /v1/lists/SignIn`
describes it. Row-level security keeps it to the caller's tenant. They age
out with the audit log (its retention).

## Passkeys

WebAuthn credentials (`@simplewebauthn/server`; `@nestjs/authentication`
has no WebAuthn), several per account, each named by its owner. On by
default (`PASSKEYS`); `GET /v1/auth/methods` says `passkeys: true`.
`iam/account/passkeys.service.ts`, `passkeys.controller.ts`; the table
`passkeys` is global (a user's, not a tenant's: users are global; no
`tenant_id`, no row-level security, [tenancy.md](tenancy.md)).

| Need | Route |
| --- | --- |
| Your passkeys | `GET /v1/auth/passkeys` (name, `deviceType`, `backedUp`, transports, last use) |
| Register one | `POST /v1/auth/passkeys/registration/options` → `navigator.credentials.create()` (or @simplewebauthn/browser `startRegistration`) → `POST /v1/auth/passkeys { name, response }`; both want a recent sign-in ([step-up](#step-up-recent-authentication)) |
| Rename, remove | `PATCH /v1/auth/passkeys/{id} { name }`, `DELETE /v1/auth/passkeys/{id}` (step-up; not the last way to sign in) |
| Sign in (browser) | `POST /v1/auth/passkeys/sign-in/options { email? }` → `navigator.credentials.get()` → `POST /v1/auth/passkeys/sign-in { response }` (the session cookie) |
| Sign in (app) | the same options → `POST /v1/auth/passkeys/token { response, code?, tenantId? }` (tokens) |
| Re-authenticate | `POST /v1/auth/passkeys/reauthentication/options` → `POST /v1/auth/reauthenticate { passkey }` |

- **The relying party** is configuration ([configuration.md](configuration.md)):
  the RP ID is `PASSKEY_RP_ID`, by default `WEB_URL`'s host (else
  `APP_URL`'s), one for the deployment (roadmap decision 1: one origin).
  Every credential is bound to it: **never change it once passkeys
  exist**. The origins a ceremony may run on are `WEB_URL`'s,
  `PASSKEY_ORIGINS` and the Android apps' `android:apk-key-hash:` origins.
  The app refuses to start when an origin is not the RP ID or under it,
  and in production when the RP ID is `localhost` or an IP address or an
  origin is not `https` (`env.ts`, `passkeyEnvIssues()`).
- **Challenges** are one-time and short-lived: 32 random bytes, kept in
  Redis for `PASSKEY_CHALLENGE_TTL_SECONDS` (120) and taken with `GETDEL`,
  so a second answer to one finds nothing, on any replica. Each remembers
  its ceremony (registration, sign-in, re-authentication: one can't finish
  another), the user and session it was made for, and the page's `Origin`
  header: the request that finishes it must come from the same session and
  origin. That header narrows the configured origins, never widens them:
  the library checks `clientDataJSON.origin` and the RP ID hash against
  configuration.
- **Never in a frame.** A ceremony whose `clientDataJSON` says
  `crossOrigin: true`, or names a `topOrigin`, ran in an iframe of another
  page (which could frame the real origin) and is refused, registering
  (400, `reason: cross-origin`) and signing in or re-authenticating (401 /
  403), after its challenge is spent (`isCrossOriginCeremony()`). Custom:
  @simplewebauthn/server checks `topOrigin` only for assertions (refused
  without `expectedTopOrigin`, which is never given), accepts
  `crossOrigin: true` without one (Safari sends none) and checks neither
  when registering.
- **User verification.** Every ceremony asks for it (`required`).
  Registering wants the `uv` flag (a passkey that can't verify its user
  could never be a second factor: 400 `passkey_invalid`, `reason:
  user-verification`). At sign-in, an assertion **with** `uv` counts for
  both factors: with two-factor on, the session is `mfa: verified` at once;
  one **without** it is the first factor only (`mfaRequired`, finish with
  `POST /v1/auth/mfa/verify`). Re-authenticating wants `uv`. A token client
  with two-factor on sends a code with its passkey: the package's
  `TokenService.issue()` takes no passkey as a second factor (it keeps the
  `amr` values meaning one for itself); its tokens carry `amr: ["pop"]`.
- **Tenants.** A passkey sign-in starts its session as a password's does:
  in the last chosen tenant, else the oldest membership
  (`metadata.tenantId`, set by the store), or none for a user without a
  tenant (who still signs in). The token route takes `tenantId` like
  `POST /v1/auth/token`: a tenant the user isn't a member of is the same
  401 as a refused assertion, audited as a failed sign-in with `reason:
  tenant` ([sign-in log](#sign-in-log-tenant-administrators)); the tokens
  carry it as `tid`.
- **Verify first.** An account whose address was never proved (a self
  sign-up) can't register a passkey (403 `email_unverified`, as for
  two-factor and providers), and a passkey never signs it in (403
  `email_unverified` after the assertion, as its password is refused).
- **The session** records `method: passkey` (via `signInOptions('passkey')`);
  the sign-in is audited (`auth.signed-in`, with the passkey's id and
  `userVerified`) and a new device is told as for any sign-in. A refused
  assertion is a 401 that says nothing more, audited as
  `auth.sign-in-failed` with `details.reason` (`challenge`, `origin`,
  `cross-origin`, `user`, `unknown`, `counter`, `invalid`…).
- **Usernameless or with an email.** Without an email, the options list no
  credentials and the browser offers the site's discoverable ones; the
  user handle (the user id's 16 bytes, no personal data) must match the
  credential's owner. With an email, the account's credentials are listed
  and the challenge is bound to the account. An address without an account,
  or without passkeys, gets one or two decoy credentials (HMACs of the
  address under a key derived from `JWT_SECRET`, the same every time, with
  the id lengths and sorted transports real authenticators have), after the
  same queries, so the answer doesn't say whether the address has an
  account or passkeys. What still shows: an account with three passkeys or
  more, or ids of unusual lengths, is a real one; with `AUTH_SIGN_UP=on`,
  sign-up's 409 says whether an account exists anyway.
- **The counter.** A device-bound authenticator counts its uses; an
  assertion whose counter isn't above the one stored is refused (a cloned
  authenticator, or one restored from a backup), logged as a warning when
  its signature is genuine, and the owner removes and registers the passkey
  again. Synced passkeys (iCloud Keychain, Google Password Manager) keep 0,
  which is accepted. The update is a compare-and-set: two assertions at
  once can't move it back.
- **No attestation** (`attestationType: 'none'`): the authenticator's
  model is nobody's business here, and `none` never prompts for consent.
- **Limits.** The public ceremonies (`/sign-in/options`, `/sign-in`,
  `/token`) share a budget of 30 requests per address in 15 minutes
  (`@AddressThrottle({ name: 'passkey' })`, `iam/auth/address-throttle.guard.ts`):
  the global guard keys by `email|address`, which a usernameless sign-in
  can't use and one naming a new email each time would dodge. The answers
  are also limited to 10 per address in 15 minutes, and carry the same
  bot check as the password sign-in (`@Captcha({ action: 'sign-in' })`,
  failures counted per address). Re-authentication's options: 10 per
  account in 15 minutes. At most 20 passkeys per account (409
  `passkey_limit`).
- **The last way to sign in.** Removing a passkey, or unlinking a
  provider, is refused with 409 `last_sign_in_method` when it would leave
  the account with no password, no passkey and no provider
  (`iam/account/sign-in-methods.ts`, counted under the account's row lock,
  so two removals at once can't both pass).
- **Audited and told:** `auth.passkey-added`, `auth.passkey-renamed`,
  `auth.passkey-removed`; the owner gets `security.passkeyAdded` and
  `security.passkeyRemoved` (mandatory). All account-level (no tenant,
  like a sign-in's): in no tenant's `GET /v1/access/audit`, and the
  notifications are the person's in every tenant.
- **While impersonating:** the list is empty (account-level data, as the
  sessions list shows only the impersonation's own), and registering,
  renaming, removing and re-authenticating are refused (403).
- **Your data:** passkeys are in the account-level part of the data export
  (`accounts/<user id>/`; kind `passkey`: name, credential id, device type,
  dates; not the public key) and erased with the account
  (`UsersRepository.anonymize`).
- **Native apps** use the passkeys of the RP ID when the operating system
  finds the app listed on the RP ID's host: `GET /.well-known/assetlinks.json`
  (Android Digital Asset Links, from `PASSKEY_ANDROID_APPS`:
  `package.name:AA:BB:…`, the signing certificate's SHA-256 fingerprint as
  `keytool` or the Play Console print it, 32 colon-separated hex pairs) and
  `GET /.well-known/apple-app-site-association` (`webcredentials`, from
  `PASSKEY_APPLE_APPS`: `TEAMID.bundle.id`). JSON, not in OpenAPI, 404 when
  none is configured. With one origin (Caddy in front of the API), they are
  served on the RP ID's host as they must be; a web app on another host
  serves them itself, or proxies them here.
- **Tests:** `apps/api/test/passkeys.e2e-spec.ts` drives the routes with a
  software authenticator (`test/software-authenticator.ts`: ES256 keys,
  `none` attestation, authenticator data and signatures as the spec lays
  them out): registration, both sign-ins, the decoy, challenge replay and
  binding, wrong origins, user verification and two-factor, the counter,
  the last-method checks, re-authentication, tokens, the limits, the
  export and the association files; `security.e2e-spec.ts` has the races
  (one challenge answered twice at once, a passkey and a provider removed
  at once), a forged user handle, cross-origin ceremonies, a stale rename
  and the audited foreign-tenant token sign-in; `passkeys.config.spec.ts` and
  `env.spec.ts` the configuration checks.

## Enterprise SSO

A tenant signs its people in through its own identity provider: SAML 2.0,
OpenID Connect, or plain OAuth 2.0 (providers without OpenID Connect, such as
Lark/Feishu), one or more **connections** per tenant
(`iam/sso`). Nothing is set in the environment: an administrator with
`Access.manageSso` sets it up over the API, and every connection starts
**off**.

1. **Verify the email domains** (`POST /v1/sso/domains`): the answer names
   a TXT record (`_sso-verification.<domain>`, value
   `sso-verification=…`); once it is published, `POST
   /v1/sso/domains/{id}/verify` looks it up on the queue (`GET` shows
   `verified`, or `lastError`). Only addresses of verified domains sign in
   or are provisioned: a tenant can't claim someone else's addresses.
2. **Add a connection** (`POST /v1/sso/connections`, recent sign-in):
   - `protocol: "saml"`: the IdP's entity id, its SSO URL (HTTP-Redirect
     binding) and one or two signing certificates (two while it rotates).
     Give the IdP our SP metadata (`saml.metadataUrl`): the entity id (that
     URL), the ACS (`saml.acsUrl`, HTTP-POST), signed assertions wanted.
   - `protocol: "oidc"`: the issuer, client id and secret. Register
     `oidc.redirectUri` at the IdP. The discovery document is fetched on
     the queue (`oidc.metadataFetchedAt`, `oidc.metadataError`; `POST
     …/{id}/refresh` again).
   - `protocol: "oauth2"`: the provider's endpoints, client id and secret,
     and a `mapping` of its user-info answer, or a `preset` (`lark`) that
     fills them. Register `oauth2.redirectUri` at the provider. No discovery:
     usable as soon as it is on ([OAuth 2.0 connections](#oauth-20-connections)).
   - `jitProvisioning`: a person of a verified domain who isn't a member
     becomes one at their first sign-in, with the connection's
     `defaultRoleIds` (none by default). Off by default.
   - `roleMappings` and `groupsAttribute`: roles from the IdP's groups
     (below, "Roles from the IdP").
3. **Turn it on** (`PATCH`, `enabled: true`) and link people to
   `loginUrl` (`/v1/auth/sso/{tenantId}/{connectionId}/login`, with
   `?redirectTo=/path` of the web app). Every outcome lands on the web app:
   signed in, or `?error=sso_failed` (`sso_unavailable` while an OIDC
   discovery document hasn't arrived). Why a sign-in failed is in the
   audit log (`auth.sign-in-failed`, `reason`), never in the URL.

The session records `method: sso`, `provider: <connection id>` and the
IdP's `auth_time` or `AuthnInstant` as `authenticatedAt` (step-up reads
them; an OAuth 2.0 provider tells none, so the sign-in's own time), and it
acts in the connection's tenant.

### OAuth 2.0 connections

For a provider that speaks OAuth 2.0 but not OpenID Connect: no
`/.well-known/openid-configuration`, no ID token, the person read from a
separate user-info call (Lark/Feishu, GitHub, GitLab, Slack, an in-house
OAuth server). The connection holds the endpoints and a declarative
**mapping** of the user-info answer, so a provider needs no code
(`iam/sso/oauth2-mapping.ts`, `oauth2-sso.service.ts`).

```json
{
  "protocol": "oauth2",
  "name": "Lark",
  "preset": { "name": "lark", "region": "lark" },
  "clientId": "cli_a1b2c3",
  "clientSecret": "…",
  "jitProvisioning": true
}
```

- **Fields.** `authorizationEndpoint`, `tokenEndpoint`, `userinfoEndpoint`:
  https only (http, and loopback hosts, only with `SSO_ALLOW_LOOPBACK=on`);
  an IP address that is private, link-local, a cloud metadata address or
  reserved is refused when saved (400), and every host is checked where it
  resolves to at each request (see "What is checked"). `clientId`,
  `clientSecret` (encrypted, never answered), `tokenEndpointAuthMethod`:
  `client_secret_basic` (the default, RFC 6749), `client_secret_post`, or
  `none` (a public client, no secret). PKCE (S256) is always on. `scopes`:
  asked for as given (none by default).
- **The mapping.** Dot paths (`data.open_id`; a numeric segment indexes an
  array; never `__proto__`, `prototype` or `constructor`; own fields only):
  - `root`: where the user object is in the answer (the whole answer when
    absent). `subject` (required), `email`, `name`, `picture` (read, not
    stored: accounts have no picture), `groups` are read in it.
  - `subject` must be a non-empty string or a finite number (made a
    string); none: refused, `no_stable_subject`. It keys the identity
    (`sso:<connection id>` + subject), so map the provider's stable id,
    never an address.
  - `errorCode`: a field of the whole answer that marks a failure (Lark
    answers 200 with `code` not 0): a non-zero number or any other truthy
    value refuses the sign-in (`userinfo_error:<value>`).
  - `groups`: an array of strings, read for `roleMappings` ("Roles from the
    IdP"); anything else counts as no groups. `groupsAttribute` is not an
    OAuth 2.0 connection's (400): its groups are `mapping.groups`. Without
    it, a member provisioned just in time gets `defaultRoleIds` only.
  - `emailVerified`, whether the provider vouches for the address:
    `{ "path": "…" }` (a field of the user object that must be the boolean
    `true`; a string `"true"` is not), `"verified-domains"` (the address is
    trusted because its domain is one the tenant verified, the trust a SAML
    assertion gets), or `"never"`, the default: a first sign-in is then
    refused (`email_unverified`), as an OpenID Connect one without
    `email_verified`. Every mode still needs a verified domain, and an
    existing account is linked only when it proved its own address ("What
    is checked").
- **A preset** fills these fields at creation (each field sent overrides
  its default); it is data, not a code path, and is shown on the connection
  (`oauth2.preset`). `PATCH` changes the fields themselves, never the
  protocol nor the preset.
- **The sign-in.** `login` sends the browser to `authorizationEndpoint`
  with `state` (bound to the browser, `__Host-sso_tx`), the PKCE challenge
  and the scopes, no `nonce`; the provider sends it back to
  `/v1/auth/sso/{tenantId}/{connectionId}/oauth2/callback`. There
  openid-client exchanges the code (the configured client authentication,
  the verifier) and the app makes **one** GET of `userinfoEndpoint` with the
  access token as bearer, then applies the mapping. A non-2xx (a redirect
  included: never followed), malformed JSON, an `errorCode` hit, no subject,
  a refused destination, a timeout (10 s) or more than 512 KiB: no sign-in,
  `?error=sso_failed`, and the reason in the audit log
  (`auth.sign-in-failed`: `token_rejected:<why>`, `userinfo_failed:<status
  or why>`, `userinfo_malformed`, `userinfo_error:<code>`,
  `no_stable_subject`), never in the URL.
- **Weaker than OpenID Connect**, and said so: no ID token (nothing signed
  by the provider; the user info is trusted because it came over TLS from
  the endpoint the administrator named, with our access token), no
  `auth_time` (the session counts from the callback: step-up's weaker
  guarantee), no `nonce`, no `iss` check (each connection has its own
  redirect URI, so a code can't be replayed through another one), and
  groups only if the provider lists them and the mapping names them.
- **No discovery.** `POST …/{id}/refresh` answers 409 `sso_no_discovery`:
  the endpoints are the connection's own fields.
- **Lark/Feishu (v2), the worked example.** The `lark` preset
  (`region: "lark"`, larksuite.com, or `"feishu"`, feishu.cn) sets
  `https://accounts.larksuite.com/open-apis/authen/v1/authorize`,
  `https://open.larksuite.com/open-apis/authen/v2/oauth/token` (RFC 6749,
  `client_secret_post`, PKCE) and
  `https://open.larksuite.com/open-apis/authen/v1/user_info`, which answers
  `{ code, msg, data: { open_id, union_id, user_id, tenant_key, name,
  avatar_url, email, enterprise_email } }`. The mapping: `root: data`,
  `subject: open_id`, `email: enterprise_email` (the address the Lark
  tenant's administrator assigns, in the tenant's own domain),
  `emailVerified: "verified-domains"`, `errorCode: code`. The personal
  `email` is never taken as verified. Give the Lark app the permission to
  read the enterprise address, verify that address's domain here, and add
  the redirect URI to the app's security settings. The provider's docs:
  [token](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token),
  [user info](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get),
  [login flow](https://open.larksuite.com/document/common-capabilities/sso/web-application-sso/web-app-overview?lang=en-US).
- **Not built**: providers whose code exchange isn't standard OAuth 2.0
  need a coded preset (the `preset` enum is open for them): WeCom (a
  corporate token, then a user lookup), WeChat (credentials in the query
  string, `openid` in the token answer), Lark's old v1 flow (an
  `app_access_token` header).
- **Proof:** `iam/sso/oauth2-mapping.spec.ts`, `test/sso.e2e-spec.ts`
  (a Lark-shaped provider), `test/security.e2e-spec.ts` ("OAuth 2.0 SSO
  connections").

### Importing an IdP's metadata

`POST /v1/sso/saml/metadata { "url" }` (`Access.manageSso`, recent sign-in,
10 a minute) fetches a SAML IdP's metadata and answers `idpEntityId`,
`idpSsoUrl` (the HTTP-Redirect `SingleSignOnService`) and `idpCertificates`
(PEM, the `signing` keys, expired ones skipped), the fields of `POST
/v1/sso/connections` for a SAML connection: the web form fills them in.
**Nothing is stored**; the administrator reviews and creates the connection.

- **SSRF.** Through `core/http/safe-fetch.ts`, as the OIDC issuer (see "What
  is checked"): https only (`SSO_ALLOW_LOOPBACK=on`, development and tests,
  allows http on loopback), every resolved address checked in the socket's
  lookup, no credentials in the URL, no redirects, 10 s, 512 KiB. 422
  `saml_metadata_url_refused`, `saml_metadata_unreachable` (also a non-200
  or a redirect), `saml_metadata_too_large`, `saml_metadata_invalid`
  (`message` says why: no HTTP-Redirect service, no signing certificate,
  more than two, `validUntil` passed, several IdPs in one document, a
  DOCTYPE). The answer never carries what the destination returned.
- **Parsing.** `iam/sso/saml-metadata.ts`, with the strict namespace-aware
  xmldom parser of `saml-algorithms.ts`: @node-saml/node-saml only generates
  SP metadata, it has no IdP metadata parser.
- **Trust.** The metadata's own signature is not checked; its trust is the
  https origin the administrator named, as for certificates pasted by hand.
  Assertions are still verified against the certificates (see above).
- It runs in the request (the administrator waits for the fields, the fetch is
  bounded and rate limited) rather than on the queue.
- **Proof:** `iam/sso/saml-metadata.spec.ts`, `test/sso.e2e-spec.ts`.

### Roles from the IdP

A connection may give roles (all optional, set on `POST /v1/sso/connections`
and `PATCH /v1/sso/connections/{id}`):

- `defaultRoleIds`: the roles a member it provisions just in time gets at
  their first sign-in, once. Theirs to keep, as an invitation's roles.
- `roleMappings` (`[{ group, roleId }]`) with `groupsAttribute` (the SAML
  attribute or ID token claim listing the groups, or an OAuth 2.0
  connection's `mapping.groups`; `groups` when null, and
  for SAML also Entra ID's `http://schemas.microsoft.com/ws/2008/06/identity/claims/groups`):
  at **each** sign-in the person gets the roles of the groups the IdP
  lists (compared exactly: Entra ID sends group ids), and loses those a
  mapping of this connection gave whose group it no longer lists. Only
  those: a role an administrator gave stays, listed or not, and a role
  they set again (`PATCH /v1/access/users/{id}` `roleIds`) becomes theirs
  (`sso_role_grants` marks what a mapping gave). Taking back the tenant's
  last administrator role is skipped (audited as `keptLastAdministrator`).
  Without group mappings nothing is synced.
- **Who may map.** Whoever sets a mapping or a default role must be able
  to grant that role (the access API's rule, 403 otherwise): else
  `Access.manageSso` and an IdP of one's own would hand out any role.
- Each change is audited (`sso.roles-synced`: `added`, `removed`), with the
  connection; a role deleted takes its mappings with it.

### Locked out

Nobody can sign in, or the only administrator can't act: `pnpm ops`, the
operator CLI ([deployment](deployment.md), "Operator CLI"), runs on the
server and needs no SQL. A policy that locks everyone out
(`auth.requireMfa` on, [policies](#policies)): `setting:delete
auth.requireMfa --tenant <slug>`. A lost password: `user:reset-password
<email>` (a one-time password, every session ended). A lost authenticator
and recovery codes: `user:remove-mfa <email>`. Failed second-factor codes
locking the account for 15 minutes: `user:unlock <email>`. No administrator
left: `admin:create <email> --tenant <slug>`. Each is confirmed first,
audited as `system:ops` with the operator's OS user and host, and tells the
account's owner.

### SSO required

`PUT /v1/sso/policy { "requireSso": true }` (`Access.manageSso`, recent
sign-in): the tenant's members act in it only through one of its own
connections.

- **Sign-in.** A password or passkey sign-in (browser or tokens) lands in
  the user's last chosen tenant when that tenant allows it, else in the
  next of their tenants that does; when none does, or the token route's
  `tenantId` doesn't, it answers **403 `sso_required`** (after the
  credential checked out: nothing is told to a wrong password).
- **Every request.** A session or token in the tenant not signed in
  through one of its connections (a password, passkey, magic link or
  Google session, an access token, a switch into the tenant) gets 403
  `sso_required` everywhere but `GET /v1/auth/me`, signing out, `GET
  /v1/auth/tenants`, `POST /v1/auth/tenant` and accepting an invitation
  (`SsoRequiredGuard`, `iam/sso/sso-required.guard.ts`, after the
  two-factor guard). Nothing is stored on the session: turning the policy
  on restricts sessions already open, turning it off frees them. Never
  restricted: API clients (SCIM's token included), impersonations.
- **Exemptions (the tenant's own break-glass members; not the operators'
  read-only break-glass access of docs/tenancy.md).** `PUT
  /v1/sso/exemptions/{userId} { reason }` exempts an active member: their password and passkey still sign in (when the IdP is
  down or misconfigured), each use audited (`sso.exemption-used`). Only a
  member with two-factor set up (409 `sso_exemption_needs_mfa`; not asked
  with `AUTH_MFA=off`, where nobody can). `DELETE` ends it.
- **No lockout.** Turning it on needs an enabled connection (409
  `sso_connection_required`), and an administrator signed in through one
  of them or exempted (409 `sso_lockout`); nobody removes their own
  exemption while it is how they are signed in.
- **Proof:** `test/sso-policy.e2e-spec.ts`.

### Finding the connection by address

`POST /v1/auth/sso/discover { "email": "…" }` (public, 10 a minute per IP
address) answers `{ "loginUrl": "…" }`, the login URL of an enabled
connection of the tenant that verified the address's domain, or `{
"loginUrl": null }`. The sign-in page sends the browser there. It doesn't
enumerate accounts: only the domain is read (never the local part, never
the accounts), every address of a domain gets the same answer, and no
tenant name or id is told beyond the URL the browser goes to. That a domain
uses SSO is what its verification's DNS record publishes anyway. Several
(two tenants verified the domain, a tenant has two connections): the
tenant that verified it first, its oldest connection on. The lookup is
global (`sso_domain_routes`, docs/tenancy.md), kept with the
verification; a domain verified before it existed is added at its next
`POST /v1/sso/domains/{id}/verify`.

### What is checked

- **SAML** (@node-saml/node-saml, never a hand-written signature check):
  the Response **and** its assertion must be signed, against the
  connection's certificates (`wantAuthnResponseSigned`,
  `wantAssertionsSigned`), so an encrypted assertion is authenticated
  before it is decrypted. Then every signature, digest and encryption
  algorithm must be on an allowlist (`iam/sso/saml-algorithms.ts`, read
  with a namespace-aware parser): RSA or ECDSA with SHA-256/384/512,
  SHA-2 digests, AES-CBC or AES-GCM with RSA-OAEP; SHA-1 (which xml-crypto
  still accepts), RSA PKCS#1 v1.5 and 3DES are refused, and anything
  unknown fails closed. Each connection has its own key pair
  (`saml.spCertificate`, RSA-3072, five years, the key in an encrypted
  column): it signs our AuthnRequests (HTTP-Redirect `SigAlg`/`Signature`)
  and decrypts assertions the IdP encrypts to it, both in our metadata;
  `requireEncryptedAssertions` refuses a plain one. Also checked:
  audience (our entity id), `NotBefore`/`NotOnOrAfter` with two minutes of
  clock skew, the assertion's age (ten minutes), and the `Issuer`. SP-
  initiated by default: `InResponseTo` must name a request **this browser**
  started (a cookie bound to it, `__Host-sso_tx`), so another browser's
  assertion is refused (login CSRF). `allowIdpInitiated` accepts
  unsolicited responses, a login-CSRF vector: off by default. Each
  assertion's ID is kept until it expires: a replay is refused. A transient
  NameID is refused (an identity needs a stable subject).
- **OpenID Connect** (openid-client): the authorization code flow with
  PKCE, `state` (the browser's binding) and `nonce`; the ID token's
  signature, `iss`, `aud`, `exp`; `email_verified` must be `true`.
- **OAuth 2.0** (openid-client, no discovery): the authorization code flow
  with PKCE and `state` (the browser's binding), the configured client
  authentication; one user-info GET, mapped by the connection
  ([OAuth 2.0 connections](#oauth-20-connections)): a stable subject, and
  the address vouched for as its `emailVerified` says. No ID token, so
  nothing the provider signed: what is weaker is listed there.
- **No account takeover.** An identity is keyed by the IdP's subject under
  `sso:<connection id>` (never shared between tenants). A first sign-in
  links an existing account only when its address is in a domain the tenant
  verified and the account proved its address (else whoever registered it
  first, with a password of their choosing, would get the person's
  sign-ins); a deactivated account or membership is refused.
- **SSRF.** The issuer, its discovery document, keys and token endpoint,
  and an OAuth 2.0 connection's token and user-info endpoints, are
  fetched through `core/http/safe-fetch.ts`: https only, every resolved
  address checked in the socket's own lookup (link-local, metadata,
  private and reserved ranges refused), no redirects, 10 s and 512 KiB.
  `SSO_ALLOW_LOOPBACK=on` (development and tests only) allows `http://` on
  loopback and private networks.
- **Secrets.** The OIDC or OAuth 2.0 client secret is an encrypted column
  (docs/encryption.md: `DATA_ENCRYPTION_KEYS` is required at boot), never
  answered. Requests' PKCE verifiers and bindings live ten minutes;
  bindings are stored as their SHA-256.
- **The ACS** is a cross-site form POST by design: it is exempt from the
  CSRF check (`http-setup.ts`), signs nobody in, and hands over to `GET
  …/saml/complete` (same site, the same browser's binding, two minutes,
  once), which does.

### SCIM provisioning

The IdP provisions people and groups over SCIM 2.0 (RFC 7643, 7644) at
`{APP_URL}/v1/scim`: `Users`, `Groups`, `ServiceProviderConfig`,
`ResourceTypes`. The **SCIM token** is an API client's key (stored as its
SHA-256, rotated as any key, metered by usage) whose role holds
`Access.provisionScim`: make a role with that one permission, an API
client with it, and give the IdP the key. Its tenant is the client's.
Errors are SCIM's (`application/scim+json`, `scimType`), not problem
details.

- **Users.** `POST` provisions an address of a verified domain: the account
  with that address is linked (when its address is proved) or made (no
  password: it signs in through SSO), and made a member; an existing member
  with that address is linked too, and the IdP deprovisions them from then
  on. `PUT`, `PATCH`
  (scim-patch) and `GET` with `filter` (`eq` on `userName`, `externalId`,
  `id`, `emails.value`, `active`, joined with `and`), `startIndex` and
  `count` (at most 200). What the IdP sends is kept and answered; SCIM
  never changes an account's name or address (they are the person's, in
  every tenant).
- **Deprovisioning.** `active: false` (Azure's `"False"` too) or `DELETE`
  deactivates the membership as an administrator would: that tenant's
  sessions and tokens end, what waits on the person moves on (approvals,
  delegations), and at least one administrator remains. `DELETE` answers
  204 and also forgets the link: the user is then a 404 (RFC 7644 §3.6:
  a resource kept after a DELETE answers 404 and leaves query results),
  and a later `POST` provisions them again. After `active: false` the user
  is still the SCIM client's: `GET` answers it with `active: false`.
  Their other tenants are untouched.
- **The account when no membership remains** (the owner's decision:
  deactivated, never deleted). When deprovisioning leaves the account no
  active membership in any tenant, the account is deactivated in the same
  transaction (`users.active` off, `users.deprovisioned_at` set, audited
  as `scim.account-deactivated`): every session and token family it has,
  in any tenant or none, ends, and it can't sign in by any method. Nothing
  is deleted: its memberships and roles (inactive), the records it owns,
  its audit history and any legal hold stay. A membership active again
  brings back the same account, its password, passkeys and data: the IdP
  provisioning it again (`POST`) or `active: true`
  (`scim.account-reactivated`), or an administrator turning a membership
  back on (`user.account-reactivated`). Only an account deprovisioning
  deactivated comes back this way; a deleted one never does. An
  administrator deactivating a membership leaves the account as it is.
  The account's lock and its memberships read `for update` keep two
  tenants' changes from both missing the other.
- **Groups** are organizational units: a group the IdP creates is a
  top-level unit of type `team`, its members those of the unit. Only the
  units it created and the users it provisioned are the SCIM client's: it
  never reaches the units and members administrators manage. No roles are granted over SCIM (map groups to
  roles on the SSO connection instead). The units it manages are
  read-only in the app (`managedByScim` on `GET /v1/access/organizational-units`):
  renaming, moving, deleting one or changing its members there is a 409
  `unit_managed_by_scim`.
- **Rate.** `/v1/scim` allows 6000 requests a minute per IP address, ten
  times the default: an IdP's full sync comes from a handful of addresses.
  The client's daily quota still meters it; an unknown token is throttled
  the same.

Every change is audited with the API client as actor (`scim.user-*`,
`scim.group-*`).

## Bot protection

The public routes bots go for (`POST /v1/auth/sign-in`, `/token`, the second step `/mfa/verify`, `/sign-up`,
`/magic-link`, `/password/forgot`, `/email/verification/resend`, and the passkey sign-ins `/passkeys/sign-in`
and `/passkeys/token`, which count their failures per address, and a public form's
`POST /v1/public/forms/submit`, action `public-form`: [forms](forms.md#public-forms)) can ask for a challenge token, verified
server-side with Cloudflare Turnstile. **Off by default**: without
`CAPTCHA_MODE` and the keys, nothing changes for an existing deployment.

- **The token** is what the Turnstile widget on the page produced, sent in
  the **`X-Captcha-Token` header** (an OpenAPI header parameter on those
  routes, so the bodies and the typed client stay as they are). The
  frontend reads `GET /v1/auth/methods` → `captcha` (`provider`, `siteKey`,
  `mode`; `null`: off), renders the widget with the site key and the route's
  action (`data-action`: `sign-in`, `sign-up`, `magic-link`,
  `forgot-password`, `resend-verification`), and sends the token with the request. A token is good
  **once**, for one route.
- **Modes** (`CAPTCHA_MODE`): `always`; `after-failures`: a token once
  `CAPTCHA_FAILURES` (3) attempts in `CAPTCHA_FAILURES_WINDOW_MINUTES` (15)
  failed from the address, **or** for the email and address; `off`. The
  two sign-ins (`/sign-in`, `/token`) count their 4xx answers (a wrong
  password, an unknown account: the same 401), and so does **the second
  factor**: a wrong code (or recovery code) at `/mfa/verify`, or sent to
  `/token`, is a failed sign-in, counted on the same address and
  `email|address` keys (on `/mfa/verify` the email is the pending
  session's account; without a session, the address alone) and challenged
  the same way, in either mode (the code page renders the widget, action
  `sign-in`, when a 403 asks, or always with `always`). The right password
  is no failure: the browser's 200 `mfaRequired` and the token route's 401
  `mfa_required` (no code sent) give the attempt back. The right password
  of an unproved address (403 `email_unverified`, refused before any second
  factor) stays counted, like a wrong one: the challenge comes at the same
  attempt, with the same problem, whether the address is unproved, has an
  account, or none. Sign-up, the magic-link
  request, forgot password and the verification resend count every request, since their answers
  reveal nothing. The counts live in Redis, keyed by a hash of the address
  or of `email|address` (**the same keys on every guarded route**: a bot
  alternating `/sign-in` and `/token` from one address trips the challenge
  on both), in a **fixed window** that starts with the first attempt
  (`EXPIRE NX`) and are kept **identically whether or not the account
  exists**: the third wrong password for `nobody@example.com` and for a real
  account get the same 403, so the challenge never says which addresses
  have accounts. Each attempt is counted **before** it is judged
  (atomically, `INCR` in a Lua script), so a parallel burst from one
  address, on any replica, gets at most N through without a token; a
  sign-in route reserves the attempt and gives it back when the answer is
  no 4xx (a dropped connection keeps the reservation).
- **The problems** (403, `code` stable, `detail` in en, de, ar, ms, zh):
  `captcha_required` (no token, one is wanted) and `captcha_invalid` (the
  token was refused; `reason`: `invalid`, `duplicate` (used before, here or
  at the provider), `hostname` (the widget ran on another site), `action`
  (minted for another route)); both carry `provider`, `siteKey` and
  `action`, so the client can render the widget and retry. Never a 5xx for
  a bad token.
- **Verification** (`TurnstileVerifier`, `iam/captcha/`): `POST` to
  `CAPTCHA_VERIFY_URL` (Cloudflare's siteverify) with the secret, the token,
  and the caller's address, through `@nestjs/http-client` (no
  `idempotency_key`: there is one attempt, and a second presentation of a
  token is a replay here); the answer's `hostname` must be one of
  `CAPTCHA_HOSTNAMES` (default: `WEB_URL`'s host) and its `action` the
  route's: **the widget must set `data-action`**, a token without one is
  refused (`reason: action`). The provider-side error codes
  (`invalid-input-secret`, `missing-input-secret`, `bad-request`,
  `internal-error`, which siteverify answers as a 200 with `success:
  false`) are an **outage**, not an invalid token: a mis-rotated secret or a
  Cloudflare incident trips the breaker and the alert instead of locking
  everyone out with a 403. Around it, `@nestjs/resilience`
  (`CaptchaService`): **one attempt within `CAPTCHA_TIMEOUT_MS` (2 s)** and
  a **circuit breaker** (`captcha`: opens when half of the last 10 calls
  failed, 5 at least, for 30 s; visible on `GET /v1/ops/events`), so a
  provider that is down costs nobody the timeout for long. The breaker is
  **per process**: each api replica opens its own after its own failures.
- **Replay:** every token's SHA-256 goes into a Redis set for 300 s (a
  Turnstile token's life) before it is verified; one seen before is refused
  as `duplicate` without asking the provider (one longer than 2048
  characters as `invalid`, also without asking). A token the provider never
  judged (an outage) is taken out of the set again, so the retry a 503
  suggests can present it. It matters most while the
  provider is down (below), when its own replay check is out of reach.
- **The provider down** (timeout, error, a 4xx to our request, circuit
  open), `CAPTCHA_ON_ERROR`:
  - `allow` (the default, **fail-open, which is not "unprotected"**): the
    request is served unverified, but under a **stricter tier**:
    `CAPTCHA_DEGRADED_LIMIT` (2) requests per address, and per email and
    address, in the window (counted in the throttler's storage, throttler
    `captcha-degraded`), then 429 `rate_limited` with `Retry-After`. While
    the breaker is open, a request **without** a token is served the same
    way: the widget can't mint one while Cloudflare is down. Each failure
    counts in `captcha_verifications_total{outcome="unavailable"}` and is
    logged as a warning; the alert `CaptchaProviderUnavailable` fires after
    5 minutes of them ([deployment.md](deployment.md), "Alerting").
  - `reject` (fail-closed): 503 `captcha_unavailable` with `Retry-After: 30`.
    Choose it when a policy says no unverified sign-in ever.
- **Native and mobile apps** (`POST /v1/auth/token`, the same email and
  password, the same `AccountService` path) are guarded like the browser's
  sign-in, with the same counters and the same action (`sign-in`): in
  `after-failures` mode an app signs in without a widget until a 403
  `captcha_required` asks, then renders the Turnstile widget (its site key,
  action `sign-in`) in a web view once and retries with the token in
  `X-Captcha-Token`; in `always` mode every token sign-in brings one. Until
  app attestation (App Attest, Play Integrity) exists, this is what keeps a
  bot from taking the token route around the challenge. API clients never
  sign in on these routes (keys go in `Authorization`), so nothing changes
  for them. `/password/reset`, `/magic-link/verify` and `/email/verify`
  take single-use tokens the attacker doesn't have, and keep their rate
  limits.
- **Configuration:** `TURNSTILE_SITE_KEY` (public) and
  `TURNSTILE_SECRET_KEY` (a secret: `TURNSTILE_SECRET_KEY_FILE` works, and
  `compose.prod.yaml` mounts it; [configuration.md](configuration.md),
  "Secrets") from the Cloudflare dashboard's widget, with the web app's
  hosts. The app refuses to start with the mode on and a key missing. Keep
  the global rate limits: the throttler runs before the guard, so a flood
  is refused before any token is verified.
- **Another provider** (hCaptcha, reCAPTCHA): a class implementing
  `CaptchaVerifier` (`iam/captcha/captcha-verifier.ts`: `verify()` answers
  a verdict or throws when the provider couldn't be asked) and a case in
  `createCaptchaVerifier()` (`captcha.providers.ts`); the policy, the
  counters, the header and the problems stay.
- **Tests:** `apps/api/test/bot-protection*.e2e-spec.ts` run the real
  verifier against a siteverify stand-in on loopback
  (`test/captcha-stand-in.ts`; never Cloudflare), one file per mode: each
  mode, the existence-independent counting (on both sign-ins), wrong
  two-factor codes on `/mfa/verify` and `/token` (counted and challenged
  like wrong passwords, `mfa_required` not counted), a bot
  alternating `/sign-in` and `/token`, a parallel burst, the replay
  refusal, hostname and action, provider-side error codes, the timeout and
  fail-open / fail-closed behaviour. The unit
  test `captcha.providers.spec.ts` proves the production configuration
  resolves `TurnstileVerifier`, never the stub, and that the stub is refused
  with `NODE_ENV=production` (any `APP_ENV` but exactly `loadtest`, with or
  without a secret).

**The load-test hook.** `CAPTCHA_PROVIDER=stub` replaces the provider with
`StubCaptchaVerifier`, which judges by the token's text and calls nothing:
`X-Captcha-Token: stub:pass:<anything unique>` passes (the replay set still
refuses a repeat, so send a fresh suffix per request), `stub:fail`,
`stub:spent`, `stub:elsewhere`, `stub:other-action` are refused with that
reason, `stub:down` and `stub:slow` play an outage and a hang (the real
timeout and fail-open / fail-closed policy run around them). It exists for
the load tests (roadmap item 17: `LOADTEST_CAPTCHA=always loadtest/run.sh`
measures the routes with the guard in place) and the
e2e tests; **production refuses it** at startup: `NODE_ENV=production`
(unless `APP_ENV=loadtest`, the load test's stack, which runs the production
image: [development](development.md), "Load tests"), an `APP_ENV` that names
production (`prod…`), or a `TURNSTILE_SECRET_KEY` in place (a stub next to a
real key is a switch someone forgot). A bare `node
dist/main` outside Compose must set `NODE_ENV=production` itself
([deployment.md](deployment.md), "The image"). `compose.prod.yaml` pins
`turnstile`, and `GET /v1/auth/methods` shows `provider: stub` so nobody
mistakes such a stack for a protected one. For a
manual try against Cloudflare, Turnstile's documented test keys (its docs,
"Testing") always pass, always block, or answer "already spent".

## Switches

Three deployment switches (env, `iam.env.ts`) turn a capability off. A
refused route answers **404 `feature_off`** (the route does not exist for
this deployment, as with `PASSKEYS=off`), after authentication: a caller
who is not signed in still gets 401. The routes stay in the OpenAPI document
and the typed client either way (each lists the 404).

| Switch | Default | Off |
| --- | --- | --- |
| `IMPERSONATION` | `off` | `POST /v1/access/users/{id}/impersonate` and `POST /v1/auth/impersonation/stop` answer 404. A running impersonation ends at its next request (401): the session is refused while the switch is off; the administrator signs in again. |
| `AUTH_MFA` | `on` | `POST /v1/auth/mfa/enroll` and `/confirm` answer 404: nobody can set two-factor up. Accounts that **already have it** are still asked for a code at sign-in and can still use their recovery codes or turn it off themselves (`GET`, `/verify`, `/recovery-codes`, `DELETE`): switching it off never weakens an account silently. |
| `API_CLIENTS` | `on` | `/v1/access/clients…` (list, read one, create, rotate, revoke a key, change, delete) and a client's usage answer 404, and a bearer key (`sk_…`) no longer authenticates (401, as a revoked one). Users are unaffected. Clients and keys stay stored and work again when it is turned on. |

Impersonation is a privileged support tool, so it is opt in: set
`IMPERSONATION=on` (the development example does).

## Administrator onboarding

The first administrator is made from `ADMIN_EMAIL` (default
`admin@example.com`, an address nobody reads) and `ADMIN_PASSWORD` (generated
and logged once when unset). Left like that, no reset mail reaches the only
administrator. So the seed marks the account (`users.onboarding_email` for a
placeholder address, `users.onboarding_password` for a generated password;
`ADMIN_ONBOARDING=off` marks nothing: tests, scripted installs, local
development) and `OnboardingGuard` (a global guard after
`MfaEnrollmentGuard`) answers 403 `onboarding_required` on every route but
those marked `@DuringOnboarding()`, until both are done. Nothing is stored on
the session: it is a normal one the moment the last step is.

An administrator seeded before onboarding existed (or with
`ADMIN_ONBOARDING=off`, since turned `on`) is never seeded again, so every
start also checks: when `ADMIN_EMAIL` is a placeholder, the verified account
on exactly that address gets `onboarding_email` (a `user.onboarding-required`
audit entry; a no-op once the address is changed, so a finished onboarding is
not reopened). Only the address: a generated password can't be told from a
chosen one afterwards. `ADMIN_ONBOARDING=off` keeps it from being flagged.

- `GET /v1/auth/me` has `onboardingRequired`: `{ email, password }` while
  something is pending, `null` otherwise.
- `POST /v1/auth/email/change { email, currentPassword }` (202): the address
  changes at once, unproved, and the verification link goes to it
  (`POST /v1/auth/email/verify`). 409 when no email step is pending; 400
  `placeholder_email` for another placeholder (`example.*`, `.test`, `.invalid`,
  `localhost`). Signing in with the unproved address stays possible while the
  step is pending, so a typo is corrected, not a lock-out.
- `POST /v1/auth/password/change` ends the password step (so does a reset link
  and the ops CLI's password reset; the sign-in's silent rehash of the same
  password, after the scrypt cost was raised, does not).
- Reachable meanwhile: `me`, sign-out, the features, the email and password
  routes above, re-authentication, the two-factor routes (`/auth/mfa`) and
  the passkey registration routes, switching tenant. The routes shared with
  the two-factor enrolment (`auth.requireMfa`) carry both decorators, so
  the two guards never lock each other out.
- API clients and impersonations are never restricted.
- `pnpm setup` warns when a production `ADMIN_EMAIL` is a placeholder.

## Policies

Auth rules a tenant's administrators change at runtime, as settings
(`PUT /v1/settings/auth.*`, `Access.manageSettings`; the keys:
[settings.md](settings.md#iams-auth-policies-auth)). **The environment is
the ceiling:** a setting may only tighten what the deployment allows,
never loosen it. Unset, every policy is today's behaviour.

| Setting | Scopes | Does | Ceiling |
| --- | --- | --- | --- |
| `auth.requireMfa` | tenant, unit | users it applies to who have no authenticator must set one up before anything else (below) | `AUTH_MFA=off`: refused when set (400 `setting_not_allowed`); a stored `true` has no effect |
| `auth.allowBreakGlass` | tenant | whether the deployment's operators may open the tenant with break-glass (default `true`; `false`: new grants are refused, running ones stop: [tenancy](tenancy.md#break-glass)) | none |
| `auth.passwordHistory` | tenant | the last N passwords of the account (0 to 24, `0` off) can't be used again on a change or a reset link: 422 `password_reused`; hashes only ([Passwords](#passwords)) | the upper limit of 24; none else |
| `auth.passwordMinLength` | tenant | a new password (change, reset link, an invitation's acceptance, a sign-up with `TENANCY=single`) is at least this long: 400 `password_too_short` (`minLength`, the field in `errors`), checked before the breach check | never under 12 (the floor) nor over 64; 128 stays the maximum |
| `auth.sessionIdleMinutes` | tenant | a browser session ends after this many minutes without a request (5 to 10080; [below](#session-lifetime)) | `SESSION_IDLE_MINUTES` (120): a longer value is refused (400 `setting_not_allowed`) |
| `auth.sessionMaxHours` | tenant | a browser session, and a token client's refresh-token family, ends this many hours after the sign-in, however active (1 to 720) | `SESSION_MAX_HOURS` (12): a longer value is refused |

- **Two-factor required.** The first factor signs in as usual (no code
  is asked: there is no authenticator yet), but the session or token is
  restricted: every route answers 403 `mfa_enrollment_required` except
  `GET /v1/auth/me` (its `mfaEnrollmentRequired: true` tells the web app to
  show the set-up), `/v1/auth/mfa…` (status, `enroll`, `confirm`),
  `/v1/auth/reauthenticate` (enrolling wants a recent sign-in),
  `GET /v1/features` (the deployment-wide switches the web app reads to
  draw the set-up, e.g. `mfa`; any signed-in caller sees them anyway), signing out
  (`/sign-out`, `/sign-out-everywhere`), `GET /v1/auth/tenants`,
  `POST /v1/auth/tenant` (another tenant may not require it) and
  accepting an invitation. Once `confirm` succeeds the same session is a
  normal one, and later sign-ins ask for the code as for anyone enrolled.
  Checked on every request (`MfaEnrollmentGuard`, `iam/auth/mfa-enrollment.guard.ts`,
  a global guard between authentication and authorization), so turning it
  on restricts sessions already signed in, and turning it off frees them.
  Never restricted: API clients, the system principal, an impersonation
  (the administrator signed in, not the user). The package's second factor
  covers enrolled users only (a pending session, `@Authenticate({ mfa: true })`)
  and has no hook to make a user enroll, hence the guard.
- **No locking yourself out.** Requiring it of a scope that covers the
  caller while they have no authenticator (`PUT /v1/settings/auth.requireMfa`
  at the tenant scope or a unit they belong to, or `…/platform`) is
  refused with 409 `mfa_enroll_first`: set up two-factor first
  (`SettingsAuthPolicy`, through `SettingsService.guardWrite()`). Turning it
  off, or requiring it of other units, is never refused.
- **Session lifetime.** <a id="session-lifetime"></a>The deployment sets
  the ceiling (`SESSION_IDLE_MINUTES`, default 120, at least 5;
  `SESSION_MAX_HOURS`, default 12), which the package enforces itself
  (`session.idleTtl`, `session.absoluteTtl`). A tenant may only shorten
  them (`auth.sessionIdleMinutes`, `auth.sessionMaxHours`; a setting left
  at its default, the largest allowed, is no choice), checked on every
  request by `SessionAuth` through `SessionLifetime`
  (`iam/auth/session-lifetime.ts`): a session older than the maximum, or
  idle longer than the timeout *before this request*, answers 401 and is
  deleted (the store hands over the activity before the request moved it:
  `sessionExtra.previousActiveAt`). A policy that is turned off frees only
  sessions not yet ended. The session's tenant decides (a switch of tenant
  re-issues it, under the new one's policy); an impersonation has its own
  time (`IMPERSONATION_TTL_MINUTES`) and is left out.
  **Token clients:** a refresh-token family keeps its own 90 days and has no
  idle timeout, unless the tenant chose: then `POST /v1/auth/token/refresh`
  refuses (401, as an expired token) and revokes a family older than
  `auth.sessionMaxHours` since its sign-in, or not refreshed within
  `auth.sessionIdleMinutes` plus the access token's 15 minutes (a client
  working on its access token has not refreshed yet). An access token
  already issued works until it expires (15 minutes). The tenant of a
  family is the token's (`tid`).
  `GET /v1/auth/me` has `session { idleMinutes, lastActiveAt, expiresAt }`
  for a browser session (null for a token or an impersonation): the web app
  (`SessionIdleWarning`) counts the user's own activity (pointer, keys,
  scrolling), tells the API about it with a `me` request at most once a
  minute, and with no input for `idleMinutes - 2` shows a dialog that
  counts down and offers "Stay signed in" (another `me` request). Nothing else in
  the signed-in layout may ask the API on a timer for an unattended tab (every
  authenticated request is activity): the deployment mode's watch
  (`useModeWatch`, [monorepo](monorepo.md), "Maintenance and read-only mode")
  has no timer while the mode is `normal` for this reason, and without realtime
  the menu's approvals count and the breached-password alert are asked again on
  the window's focus and on the user's input (`useRefreshOnInput`), not every
  minute. The inbox pages, open and watched, still poll.
- **Who meets a minimum length.** A password is the account's, in every
  tenant: the strictest of the tenants it is an active member of; an
  invitation's new address, the inviting tenant's. A reset link is read
  without being spent (`UsersRepository.pendingReset()`), so a refused
  password leaves it working.
- **Before signing in there is no tenant.** Settings are rows of a tenant,
  under row-level security, so a pre-authentication flow (sign-up, the
  sign-in's bot check) has none to read: with `TENANCY=multi` they keep the
  environment's policy. With `TENANCY=single` the one tenant's settings
  apply to them too (a sign-up meets its `auth.passwordMinLength`).
- **Per-tenant sign-up and bot protection** (`auth.signUp`,
  `auth.captchaMode`) are **deferred**: they could only apply with
  `TENANCY=single` (both are pre-authentication), where the one tenant's
  operator also sets the environment (`AUTH_SIGN_UP`, `CAPTCHA_MODE` and
  the Turnstile keys, which must be there anyway), so a runtime setting
  that may only tighten the env adds little for the complexity of a
  second, request-time source for `GET /v1/auth/methods`, the sign-up
  route and the captcha guard.
- **How it is built.** IAM can't import the platform, where settings live:
  `AUTH_POLICY` (`iam/auth/auth-policy.ts`) is a port the platform
  provides (`SettingsAuthPolicy`, `platform/auth-policy/`), injected
  optionally by `AuthPolicyService`, which applies the ceiling on what it
  returns (so a source can't loosen the env) and, without one (IAM alone),
  answers with the environment alone. Not a default provider under the
  same token: Nest resolves a module's own provider before a global
  one's, so IAM's would always win over the platform's.
- **Proof:** `test/auth-policies.e2e-spec.ts` (a unit's requirement until
  enrolled, off again, a tenant's requirement with a unit's `false`, API
  clients, the `AUTH_MFA=off` ceiling, minimum lengths on change, reset and
  invitation, per tenant), `iam/auth/auth-policy.spec.ts` (the ceiling),
  `test/session-lifetime.e2e-spec.ts` (idle and maximum, per tenant, the
  ceiling, token families), `iam/auth/session-lifetime.spec.ts`.

## Impersonation (support)

Within one tenant ([tenancy](tenancy.md)): the administrator's current
tenant, whose member the user must be; the impersonation session stays in
it (no switching, no profile change) and ends when either membership does.

`POST /v1/access/users/{id}/impersonate` (the `Access.impersonate`
permission, a session) replaces the administrator's session with the user's
for `IMPERSONATION_TTL_MINUTES`. Everything done meanwhile is audited as
`admin@… as user@…`; `GET /v1/auth/me` shows the `impersonator`. Never an
administrator, never nested, never the account's credentials (password,
two-factor, sessions). Starting one wants the administrator's recent
sign-in ([step-up](#step-up-recent-authentication)); the impersonation's
session records `method: impersonation` and no `authenticatedAt`, and never
satisfies step-up, nor can it re-authenticate. `POST
/v1/auth/impersonation/stop` gives the administrator their own session
back, with their own sign-in's method and time.

## API clients

Each belongs to one tenant and acts in it alone ([tenancy](tenancy.md)).
Systems call the API with keys (`sk_<id>_<secret>`; only the SHA-256 is
stored). `POST /v1/access/clients` (the key is shown once),
`POST /v1/access/clients/{id}/rotate { graceSeconds }` (the old key keeps
working for the grace period; both want a recent sign-in), `DELETE /v1/access/clients/{id}/keys/{keyId}`,
`PATCH /v1/access/clients/{id} { active, roleIds }`. Keys may expire and
record their last use. A revoked key's realtime sockets are disconnected at
once, an expired key's at its expiry, and a socket of a key that stopped
otherwise (a rotation's grace period, a revoked client) within 10 minutes
([realtime](webhooks-and-realtime.md#realtime)). A client may do what every client may
(`clientPermissions`) and what its roles grant. `POST` takes its
`roleIds` (with `roleExpiresAt`) and `dailyQuota` too, all in the client's
transaction; `GET /v1/access/clients/{id}` reads one (never a key).

**Revoke or delete.** `PATCH { active: false }` revokes a client: its keys
are refused from the next request, and `active: true` brings them back.
`DELETE /v1/access/clients/{id}` (204) deletes it for good: its keys stop at
once, its role grants and usage go with its row (foreign keys), its webhook
endpoints and live connections after the commit
(`ApiClientLifecycleRegistry`: the platform's webhooks and realtime listen);
`client.deleted` is audited in the deletion's transaction, with its name.
A hard delete, as for roles, organizational units and invitations, rather than the
recycle bin: the bin is for records people delete by mistake, and a
client already has its reversible state (revoked); the audit log keeps
what it did (`client:<id>`). Both want authority over the client (you hold
every permission its roles give, 403 `authority_required`), as rotating
its key does; neither asks a recent sign-in (they only take access away).

**IP allowlist.** `allowedCidrs` (on `POST` and `PATCH /v1/access/clients/{id}`;
IPv4 and IPv6 CIDRs, a bare address is `/32` or `/128`, stored canonical;
empty: any address) restricts where a client's keys work. A request from
outside gets 403 `client_ip_not_allowed`, checked after the secret is
verified (a wrong key is a plain 401), and audited as `client.ip-denied`
once per client and address an hour (Redis `NX`). A malformed CIDR is a 400
`invalid_cidr`; a change is audited as `client.allowlist-changed`. Matching
is Node's `net.BlockList` (an IPv4-mapped IPv6 address, `::ffff:203.0.113.9`,
matches IPv4 rules). The address is the request's `req.ip`: the app trusts
`X-Forwarded-For` only from loopback and private networks (the adapter's
`trustProxy`, `core/http/http-setup.ts`), so it must run behind a proxy that sets the
header, as the bundled Caddy does, and that proxy must be the only way in. A
header the caller adds is ignored: the address is the last one a trusted
hop did not vouch for. Direct to the app, without a proxy, the peer's own
address is used. The editor on `/api-clients/$id` is a frontend follow-up.

Each client's requests are counted per day and route, and a `dailyQuota`
(`PATCH /v1/access/clients/{id}`) caps them (429 `quota_exceeded`): see
[usage.md](usage.md).

Rename the key prefix per project: `API_KEY_PREFIX` in `iam/auth/api-keys.ts`.
