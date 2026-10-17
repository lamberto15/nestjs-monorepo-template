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
| Forgot / reset password | `POST /v1/auth/password/forgot`, `POST /v1/auth/password/reset` |
| Change password | `POST /v1/auth/password/change` (others signed out; [step-up](#step-up-recent-authentication)) |
| Verify email | `POST /v1/auth/email/verify`, resend: `POST /v1/auth/email/verification` |
| Sessions (each with how it was signed in) | `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/{id}`, `POST /v1/auth/sign-out-everywhere` |
| Re-authenticate for a sensitive action | `GET /v1/auth/reauthenticate` (how, until when), `POST /v1/auth/reauthenticate`: see [Step-up](#step-up-recent-authentication) |
| Two-factor (TOTP) | `GET /v1/auth/mfa` (status), `POST /v1/auth/mfa/enroll`, `/confirm` (recovery codes), `/verify` (sign-in), `/recovery-codes`, `DELETE /v1/auth/mfa` |
| Magic link | `POST /v1/auth/magic-link`, `POST /v1/auth/magic-link/verify` |
| Google, Microsoft, GitHub | `GET /v1/auth/oidc/{provider}/login` → `/callback`; linked: `GET /v1/auth/identities`, unlink: `DELETE /v1/auth/identities/{provider}` |
| Mobile apps | `POST /v1/auth/token` (`tenantId`: the tenant the tokens act in), `/token/refresh`, `/token/revoke` |
| Your tenants, and acting in another | `GET /v1/auth/tenants`, `POST /v1/auth/tenant { tenantId }` (re-issues the session): [tenancy](tenancy.md) |

- **Email links** open pages of the web app (`WEB_URL/reset-password`,
  `/verify-email`, `/magic-link`) that POST the token back: mail scanners
  follow GET links. Links are single-use and short-lived.
- **Accounts are global, memberships per tenant** ([tenancy](tenancy.md)):
  one account per address, in every tenant it belongs to; a session acts in
  one (`GET /v1/auth/me`'s `tenant`), the last chosen at sign-in. A
  tenant's administrators manage its memberships (`PATCH` deactivates the
  membership, never the account) and never set or change anyone's password
  or name.
- **Invitations (invite-only):** `POST /v1/access/users` (202) mails the
  address a link (`WEB_URL/accept-invitation`); nothing about an account is
  read, changed or returned until its owner accepts at
  `POST /v1/auth/invitations/accept`: a new address chooses its password
  there, an existing account accepts signed in as itself
  ([tenancy](tenancy.md), "Accounts and sessions").
- **A proved address** (`emailVerified`) is wanted to link a provider or
  enrol two-factor (403 `email_unverified`).
- **Account linking** by verified email only, or from a signed-in session
  (`?link=true`): never by an unverified address.
- **Two-factor** secrets are encrypted at rest (`MFA_ENCRYPTION_KEYS`); a code
  works once; failures lock out for 15 minutes.
- **Refresh tokens** rotate; one presented twice revokes its whole family.
- **New passwords** are 12 to 128 characters and not found in data
  breaches: see [Passwords](#passwords).
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
  served from the downloadable corpus). `compose.prod.yaml` passes all
  five to the containers: set them in `.env`.
- **`ADMIN_PASSWORD`** is only warned about (an error in the log on the
  first start): refusing it would leave the deployment without an
  administrator. A generated one isn't checked.
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
- **Not checked: sign-in** with an existing password. A possible follow-up:
  check it at sign-in (the plaintext is there) and ask the user to change
  it, or flag the account, without blocking the sign-in.

### Your data, your account's deletion, consents (`/v1/account`)

| Need | Route |
| --- | --- |
| A pending deletion, what you agreed to | `GET /v1/account` |
| A copy of everything held about you | `POST /v1/account/export { format? }` → 202, then `GET /v1/data/transfers/{id}` for the file (one row per record: `kind`, `id`, `data`; the account's own records, then, after a `membership` row, each tenant's) |
| Delete your account | `POST /v1/account/deletion { password? }` (your password when the account has one, and a recent sign-in: [step-up](#step-up-recent-authentication)) → carried out after `ACCOUNT_DELETION_GRACE_DAYS`, a mail says when; `DELETE /v1/account/deletion` cancels |
| Terms, privacy policy, marketing | `POST /v1/account/consents { kind, version }`, `GET /v1/account/consents` (the latest of each kind; kept as proof) |

The nightly job anonymizes a due account (`UsersRepository.anonymize`):
placeholder address and name, no password, sign-in methods, sessions,
tokens, memberships (with their roles and units); its notifications,
preferences and settings go;
its audit entries keep the actor key, labelled "Deleted user". Records
the person created stay, owned by an account that is nobody's. A feature
holding personal data registers a `PersonalDataSource` (`rows()` for the
export, `erase()` for what must go with the person; `note.transfer.ts`).
All of it is audited (`account.deletion-requested`, `-cancelled`,
`account.deleted`, `account.consented`); `account.deleted` is the job's,
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
| `method` | `password`, `magic-link`, `oidc`; `sso` and `passkey` are reserved for roadmap items 2 and 3; `impersonation` for an administrator's session as the user |
| `provider` | the OIDC provider (`google`), later the SSO connection |
| `authenticatedAt` | the sign-in, then each re-authentication (ISO 8601) |

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
  2.0, no ID token) records now: a weaker guarantee, documented here so a
  project that needs better asks the provider for `prompt=login` /
  `max_age` (the package's `authorizationParams` are per provider).
- **An impersonation** session never counts as recent, whatever its
  metadata says (`isRecent()`, `authentication-method.ts`): nobody signed
  in to it.

`GET /v1/auth/sessions` lists `method`, `provider`, `mfa` and
`authenticatedAt` per session; `GET /v1/auth/me` has the current
credential's `authentication` (`via`: `session` or `token`) and
`recentUntil`.

Token clients (`POST /v1/auth/token`) carry it in the access token: `amr`
(RFC 8176: `pwd`, and `mfa` from the package) and `auth_time` (OpenID
Connect, epoch seconds), fixed for the refresh family's life
(`RefreshTokenRecord.claims`). The package has no listing of refresh
families, so they aren't in the sessions list.

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

`methods`: `password` and `totp` re-authenticate in place
(`POST /v1/auth/reauthenticate`); `magic-link` and `oidc:<provider>` by
signing in again (the new session is recent). `mfaRequired`: a code goes
with the password.

### The protected routes

| Route | Why |
| --- | --- |
| `POST /v1/auth/password/change` | a new password; an account without one gets its first here, with no current password to check (the current one is still asked when there is one, ASVS V6.2.3) |
| `POST /v1/auth/mfa/enroll` | a thief's authenticator would lock the owner out |
| `POST /v1/auth/mfa/recovery-codes`, `DELETE /v1/auth/mfa` | new codes are credentials; two-factor off weakens the account (both also want `mfa: verified`) |
| `GET /v1/auth/oidc/{provider}/login?link=true` | a linked provider lets whoever linked it back in at will (a plain sign-in isn't asked). The browser navigates here, so a stale session isn't answered with the 403 problem but sent to the web app: `redirectTo` (else its root) with `?error=reauthentication_required`; the frontend asks `GET /v1/auth/reauthenticate` before it starts a link, and spares the round trip. Nobody signed in: 401 |
| `DELETE /v1/auth/identities/{provider}` | removes a way to sign in |
| `POST /v1/account/deletion` | irreversible after the grace period. The password stays required too (when the account has one): within the window a stolen session can enrol its own authenticator, and re-authenticating with that must not be enough to lock the owner out of "sign in and cancel". Passwordless accounts: step-up alone |
| `POST /v1/access/clients`, `POST /v1/access/clients/{id}/rotate` | a new API key is a new credential |
| `PATCH /v1/access/clients/{id}`, only with `roleIds` or `active: true` | roles are privileges; reactivating brings its keys back (revoking, a quota aren't asked) |
| `POST /v1/access/users`, only with non-empty `roleIds` | an invitation with privileges (one without roles isn't asked) |
| `PATCH /v1/access/users/{id}`, only with `roleIds` or `active: true` | roles are privileges; reactivating brings their access back (a deactivation isn't asked) |
| `POST /v1/access/users/{id}/impersonate` | acting as someone |

Not protected, on purpose: signing out (sessions, everywhere), data export
(a user can read their data anyway), consents, the profile, role
definitions and invitations without roles (frequent administration, behind
permissions and audited; add the decorator if a project wants them).
There is no route to change the address or to remove the password yet:
they take the decorator when they come.

### Re-authenticating

`POST /v1/auth/reauthenticate { password?, code?, recoveryCode?, refreshToken? }`,
from a session or a token client (`GET` says how and until when):

- **What the account signs in with:** its password, and a code (or a
  recovery code) when two-factor is on; an account without a password but
  with two-factor, a code alone (`totp`). Neither (an account that signs in
  only by link or provider): 409 `reauthentication_unavailable` with
  `methods`: sign in again.
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
- **Audited:** `auth.reauthenticated` (`details.method`: `password` or
  `totp`, `mfa`, `via: token`) and `auth.reauthentication-failed`
  (`details.reason`: `password`, `code`, `impersonating`).
- **Never while impersonating** (403, audited).

Signing in again by email link or with a provider re-authenticates too:
a link proves the mailbox now; a provider's sign-in counts from its ID
token's `auth_time` (above), so one the provider did silently from its own
old session stays stale, and the user re-authenticates in place or signs
out of the provider first. Mind the other side of it: an account that
signs in only with a provider that always sends `auth_time` (Keycloak,
Okta, Microsoft) can't become recent by signing in again while the
provider's own session lives: the user signs out of the provider (or ends
its session there) first. The package's `OidcService.start()` takes no
per-request `prompt=login` or `max_age`; `authorizationParams` are per
provider, so a project can set `prompt=login` for such a provider, at the
cost of every sign-in asking (a per-request `prompt` for the link and
re-authentication flows is a follow-up).

**Passkeys (item 3)** plug in as another proof of
`ReauthenticationService.reauthenticate()` (an assertion with user
verification counts for both factors) and a `passkey` entry in
`options()`. **SSO (item 2)** re-authenticates by signing in again
(`sso:<connection>` in `methods`); "SSO required" revokes the sessions
whose `metadata->>'method'` is not `sso`. Mind that the package drops
`hwk` from `claims.amr` (it means a second factor): a passkey token
sign-in records itself another way.

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
| `security.newSignIn` | a sign-in from a new device, by any method: password (a browser or a token client), email link, Google / Microsoft / GitHub (even with two-factor still to do) | `device` ("Chrome on macOS"), `ip`, `at` |
| `security.passwordChanged` | `POST /auth/password/change`, or a reset link when the account was used before (any audit entry as its actor: not an invitation's first password) | `via` (`change` \| `reset`), `ip` |
| `security.mfaChanged` | two-factor confirmed on, or turned off | `enabled`, `ip` |
| `security.apiKeyRotated` | to the API client: `POST /access/clients/{id}/rotate` (webhook) | `clientId`, `keyId`, `previousKeysEnd` |

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
  `password`, `magic-link`, `oidc:google`; `via: token` for a token
  client), from the service that signs in (`signInWithPassword`,
  `issueTokens`, `signInWithMagicLink`). The OIDC callback is signed in
  inside the package (`OidcService.finish`), so `SecurityAlertsService`
  hears its `sign-in` event instead and records it right after; its
  bookkeeping still running is awaited on shutdown (`settled()`).

## Bot protection

The public routes bots go for (`POST /v1/auth/sign-in`, `/token`, `/sign-up`,
`/magic-link`, `/password/forgot`) can ask for a challenge token, verified
server-side with Cloudflare Turnstile. **Off by default**: without
`CAPTCHA_MODE` and the keys, nothing changes for an existing deployment.

- **The token** is what the Turnstile widget on the page produced, sent in
  the **`X-Captcha-Token` header** (an OpenAPI header parameter on those
  routes, so the bodies and the typed client stay as they are). The
  frontend reads `GET /v1/auth/methods` → `captcha` (`provider`, `siteKey`,
  `mode`; `null`: off), renders the widget with the site key and the route's
  action (`data-action`: `sign-in`, `sign-up`, `magic-link`,
  `forgot-password`), and sends the token with the request. A token is good
  **once**, for one route.
- **Modes** (`CAPTCHA_MODE`): `always`; `after-failures`: a token once
  `CAPTCHA_FAILURES` (3) attempts in `CAPTCHA_FAILURES_WINDOW_MINUTES` (15)
  failed from the address, **or** for the email and address; `off`. The
  two sign-ins (`/sign-in`, `/token`) count their 4xx answers (a wrong
  password, an unknown account: the same 401); sign-up, the magic-link
  request and forgot password count every request, since their answers
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
  for them. `/mfa/verify`, `/password/reset`, `/magic-link/verify` and
  `/email/verify` take single-use tokens the attacker doesn't have, and
  keep their rate limits.
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
  mode, the existence-independent counting (on both sign-ins), a bot
  alternating `/sign-in` and `/token`, a parallel burst, the replay
  refusal, hostname and action, provider-side error codes, the timeout and
  fail-open / fail-closed behaviour. The unit
  test `captcha.providers.spec.ts` proves the production configuration
  resolves `TurnstileVerifier`, never the stub, and that the stub is refused
  with `NODE_ENV=production`.

**The load-test hook.** `CAPTCHA_PROVIDER=stub` replaces the provider with
`StubCaptchaVerifier`, which judges by the token's text and calls nothing:
`X-Captcha-Token: stub:pass:<anything unique>` passes (the replay set still
refuses a repeat, so send a fresh suffix per request), `stub:fail`,
`stub:spent`, `stub:elsewhere`, `stub:other-action` are refused with that
reason, `stub:down` and `stub:slow` play an outage and a hang (the real
timeout and fail-open / fail-closed policy run around them). It exists for
the load tests (roadmap item 17: a staging run with `CAPTCHA_MODE=always
CAPTCHA_PROVIDER=stub` measures the routes with the guard in place) and the
e2e tests; **production refuses it** at startup: `NODE_ENV=production`, an
`APP_ENV` that names production (`prod…`), or a `TURNSTILE_SECRET_KEY` in
place (a stub next to a real key is a switch someone forgot). A bare `node
dist/main` outside Compose must set `NODE_ENV=production` itself
([deployment.md](deployment.md), "The image"). `compose.prod.yaml` pins
`turnstile`, and `GET /v1/auth/methods` shows `provider: stub` so nobody
mistakes such a stack for a protected one. For a
manual try against Cloudflare, Turnstile's documented test keys (its docs,
"Testing") always pass, always block, or answer "already spent".

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
record their last use. A client may do what every client may
(`clientPermissions`) and what its roles grant.

Each client's requests are counted per day and route, and a `dailyQuota`
(`PATCH /v1/access/clients/{id}`) caps them (429 `quota_exceeded`): see
[usage.md](usage.md).

Rename the key prefix per project: `API_KEY_PREFIX` in `iam/auth/api-keys.ts`.
