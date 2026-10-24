# @nestjs-monorepo-template/api-client

## 0.2.0

### Minor Changes

- ef9a0aa: Access administration: `GET /v1/access/users/{id}`, `GET /v1/access/roles/{id}` and `GET /v1/access/clients/{id}`; `?teamId=` (and `teamId.in`) on `GET /v1/access/users`; `POST /v1/access/invitations/{id}/resend` and `roleExpiresAt` on the pending invitations; `dailyQuota` on `POST /v1/access/clients`; `DELETE /v1/access/clients/{id}`; `GET /v1/lists/User`. The catalog's labels follow the request's language.
- 7ad49e7: `GET /v1/auth/me` has `onboardingRequired` (the first administrator's pending steps), and `POST /v1/auth/email/change` replaces the placeholder address.
- 5f0c33d: Approvals: `outcomeAppliedAt` (ISO datetime, or null) on every approval (`GET /v1/approvals`, `GET /v1/approvals/{id}`, the decision routes): null while an approved request's outcome hasn't been applied yet (and again after a resubmission), so a record banner can show "approved, applying". The realtime event `approval.applied { id, subject, recordId, outcomeAppliedAt }` reaches the requester and the round's approvers once it is applied.
- 067f8d2: `GET /v1/approvals`: each item has the `can` (`decide`, `cancel`, `resubmit`) and the `etag` its `GET /v1/approvals/{id}` would give you, so an inbox row can decide with `If-Match` without reading the request first (`?fields=` keeps both). A `decidedByMe` filter (`?decidedByMe=true`, or in `filter=`) lists what you decided, yourself or standing in for someone: the inbox's history.
- 4930785: Attachments carry `scanStatus` (`pending` | `clean`): with `MALWARE_SCANNER` on, an upload is `pending` until scanned and its download answers 409 `attachment_scan_pending`. `record.attachments.changed` has a new action, `scanned`.
- dc60ade: Audit log: `actorLabel` filters on `GET /v1/access/audit` (`actorLabel`, `actorLabel.contains`, `actorLabel.startsWith`: who acted, by a member's name or address or an API client's name) and `GET /v1/lists/Audit`. Search: each hit of `GET /v1/search` carries `subjectLabel` (`{ singular, plural }`, in the response's language).
- 63d9400: Break-glass for operators: `POST /v1/tenants/{id}/break-glass { reason, minutes? }` opens a tenant read only for an hour at most (send the grant's id as the `Break-Glass` header of GET requests), `GET /v1/tenants/{id}/break-glass` lists your grants, `DELETE /v1/tenants/{id}/break-glass/{grantId}` ends one. New permission `Platform.breakGlass`, notification `security.breakGlassStarted`, tenant setting `auth.allowBreakGlass`.
- 09956cb: `createApiClient` looks up `globalThis.fetch` on every request instead of keeping the one it saw at creation, so a fetch replaced later (msw, instrumentation) is used; a `fetch` option still wins. `unwrap()` returns `undefined` for a 2xx without a body (204: sign-out, deletes, `POST /v1/auth/tenant`) instead of throwing `empty_response`, and is typed `undefined` for those operations; a 304 still throws `not_modified`. Each item of `GET /v1/auth/sessions` has a readable `device` ("Chrome on macOS", null when no user agent was recorded).
- 2cf361f: Comments (`GET`, `POST` and `PATCH` on `/v1/{feature}/{id}/comments`) carry `mentionNames`, the name of each key in `mentions` (`{ "user:<id>": "Maya Patel" }`), as every member sees it: a person who left the tenant keeps their name, as `authorName` does; null for anyone the tenant never had. `?fields=mentionNames` picks it.
- 5a2e98b: Custom fields administration: `GET /v1/custom-fields/subjects` lists the subjects that take custom fields, each with its `label` (`singular`, `plural`) in the request's language and only those whose fields you may read; `GET /v1/custom-fields?include=counts` (managers only) adds `valueCount` and `deletedValueCount` to each field: how many records of your tenant hold a value of it, and how many of those are in the recycle bin. A definition's 400 `validation_failed` names `options.<i>.value` for each repeated or comma-bearing option value (it named `options`).
- 130322b: `GET /v1/data` has a response schema: `exports` (`name`, `columns`, `formats`) and `imports` (`name`, `formats`, `columns` with `type`, `required`, `min`, `max`, `options`, `example`…, `template`), so the client types it instead of `unknown`. New lists of your own background work in the current tenant, newest first, by cursor (`{ items, nextCursor }`): `GET /v1/data/transfers` (`?kind=export|import`; each item as `GET /v1/data/transfers/{id}` answers it) and `GET /v1/bulk` (each run as `GET /v1/bulk/{id}` answers it, with the result's counts but not the result per item).
- 4352ae4: Uploads straight to the object store with `STORAGE_DRIVER=s3`: `POST /v1/<records>/{id}/attachments/presign` (name, size and type in; a signed `PUT` URL, its headers and an `uploadId` out) and `POST …/attachments/complete` (`uploadId` in; the attachment out, after the server checked the object's size, type and first bytes). `GET /v1/features` has a new `presignedUploads` flag; with another driver the routes answer 503 `presigned_uploads_unavailable`.
- 0b29f74: Documents: `GET /v1/notes/{id}/documents` (and `/{id}/documents` on every record with PDFs) lists a record's documents, in progress ones too (`RecordDocumentPage`: `template`, `language`, `issuedBy { key, name }`, `finishedAt`, `attachmentId`); `GET /v1/lists/{subject}` has `documentTemplates: [{ id, language }]`; `POST …/{id}/pdf` declares `?lang=` (an enum of the shipped languages); a record's `can` (`?include=can`) has `issue` where it takes PDFs. `GET /v1/attachments/{id}/download?inline=true` shows a PDF in the browser. The audit log is typed as `AuditPage` of `AuditEntry`, whose entries gain `actorName`; `GET /v1/teams` documents its `limit` (50 by default, 100 at most).
- a960c35: Enterprise SSO, part 2: `groupsAttribute`, `roleMappings` and `defaultRoleIds` on SSO connections (roles from the IdP's groups, and for just-in-time members); `saml.requireEncryptedAssertions` and `saml.spCertificate` (our certificate: signed AuthnRequests, encrypted assertions); `GET`/`PUT /v1/sso/policy` ("SSO required") and `PUT`/`DELETE /v1/sso/exemptions/{userId}` (break-glass); `POST /v1/auth/sso/discover` (an address's SSO login URL); `managedByScim` on `GET /v1/access/teams`. New problem codes: `sso_required`, `sso_lockout`, `sso_connection_required`, `sso_exemption_needs_mfa`, `team_managed_by_scim`.
- 6cce8d2: Enterprise SSO: a tenant's SAML and OpenID Connect connections (`GET/POST /v1/sso/connections`, `GET/PATCH/DELETE /v1/sso/connections/{id}`, `POST …/{id}/refresh`) and verified email domains (`GET/POST /v1/sso/domains`, `POST /v1/sso/domains/{id}/verify`, `DELETE /v1/sso/domains/{id}`), with the browser routes under `/v1/auth/sso/{tenantId}/{connectionId}`. SCIM 2.0 provisioning at `/v1/scim` (`Users`, `Groups`, `ServiceProviderConfig`, `ResourceTypes`). New permissions `Access.manageSso` and `Access.provisionScim`; sessions may now report `method: "sso"`.
- f7deea1: `GET /v1/features` says which deployment switches are on, for a client that
  hides what is turned off: `realtime`, `webhooks`, `reports`, `usage`,
  `impersonation`, `mfa`, `apiClients`, `passkeys`, `signUp`, `magicLink`,
  `documents`, `tenancy` and `locales`. Any signed-in caller may read it.
- 77dec20: `GET /v1/features` answers `exchangeRates`: whether the deployment fetches exchange rates (`EXCHANGE_RATES_FETCH`).
- b0892f2: Image attachments (JPEG, PNG, WebP, GIF) carry `renditionStatus` (`pending` | `ready` | `failed`, null for anything else) and `renditions` (`thumb` and `preview`: width, height, size, contentType), and `GET /v1/attachments/{id}/download?rendition=thumb|preview` links to them (404 `attachment_rendition_not_found` when there is none). `record.attachments.changed` has a new action, `processed`.
- 29b1667: `?include=watching` (beside `include=can`) on the detail and list routes of every record with the `watch` capability adds `watching: boolean` to each record: whether the caller watches it, answered from one query per page. A record page needs no extra `GET /v1/subscriptions` request, and a list can show a watching marker. Left out by default; not part of the ETag; a 400 on a record that cannot be watched.
- b17332e: `GET /v1/lists/{subject}`: a field whose values are ids of something has an optional `ref` (`tag`, `team`, `principal` for an owner's `user:<id>` / `client:<id>` key, or a record's subject), so a client renders a picker instead of guessing from the field's name.
- c5f9793: `GET /v1/lists/{subject}`: a list described at runtime (its filterable and sortable fields with their operators, enum options, the tenant's custom fields, `fields=` names, search, the recycle bin and the list limits), as the caller's permissions let them see it.
- 4f7e164: List query parameters are typed from the list's schema on every list, not only those with `@Query({ schema })`: `GET …/comments`, `…/revisions`, `/v1/approvals` and `/v1/notes` (and the lists generated features have) now type `limit` and `page` as `number` (`limit` documented 1 to 100, default 50), a flat enum filter as its values (`status?: 'pending' | 'approved' | …`), `count`, `deleted` and the boolean filters as `'true' | 'false'`. Breaking only for callers that passed strings: `limit: '50'` is now a type error, send `limit: 50` (openapi-fetch serializes it the same). Nothing changes on the wire.
- a14f32f: `GET /v1/people?key=user:<id>,client:<id>` names up to 20 principal keys for any member (a member or former member of the tenant, an API client of it; any other key is left out), for the names behind a list's `ref: principal` values. `GET /v1/teams` is a teams lookup any member may read (`id`, `name`, `parentId`, `depth`; `q`, `id=`, cursor pages), for a list's `ref: team` fields. The list metadata's `ref` description points at both.
- ccfc29b: The notification preferences are typed. `GET /v1/notifications/types` (`channels`), `GET` and `PUT /v1/notifications/preferences` describe each channel's setting instead of `{ [key: string]: unknown }`: `email?: 'immediate' | 'hourly' | 'daily' | false` (users) and `webhook?: boolean` (API clients); in-app and realtime are always on and not settings. New `POST /v1/notifications/test` (development and tests only, absent in production) sends the caller a `system.test` notification through every channel they have on and answers `{ id }`.
- 2e3d0c8: New public, read-only endpoint `GET /v1/notifications/unsubscribe/{token}`: says what a mail's unsubscribe link would stop, without changing anything. It answers `{ kind: 'type', label }` (the notification type's label in the request's language, or `null` when the link would change nothing) or `{ kind: 'digest', modes }`, and the same 400 as the `POST` for an invalid, expired or foreign link. Additive: nothing existing changes.
- 2b59265: New public endpoint `POST /v1/notifications/unsubscribe/{token}`: the one-click unsubscribe (RFC 8058) behind the `List-Unsubscribe` header of notification and digest mail. It takes the form `List-Unsubscribe=One-Click` (JSON with the same field works too), answers 204 and switches that notification type (or a digest's types) off in the mail preferences, and answers 400 for any invalid, expired or foreign link.
- 517de0e: The record panels' shared shapes are named components in the document, so `components['schemas']` always has `Comment`, `CommentPage`, `Attachment`, `AttachmentPage`, `TagRef`, `TagRefList`, `Tag`, `TagPage`, `Revision`, `RevisionPage` and `RevisionDiff`, even when no feature has a comments, attachments, tags or revisions panel. Every feature's panel routes reference them (`$ref`), so their `paths` types are the same shapes as before, now `components['schemas'][…]`. The notes' `tags` field is a `TagRef` too.
- 02c2a5e: Consents can be withdrawn and their kinds are declared: `DELETE /v1/account/consents/{kind}` withdraws one (200 with its state; 409 `consent_required` for a required kind, 404 when none is in force), each consent has `withdrawnAt` (null: in force), and `GET /v1/account/consent-kinds` (public) lists the kinds asked for (`kind`, current `version`, `required`, `label`, `description`). `POST /v1/account/consents` now accepts only those kinds at their current version (400 `validation_failed` otherwise). `POST /v1/account/export` declares its 202 body (`{ id, status }`), and `GET /v1/account/exports` lists your account exports, newest first, by cursor. Every transfer status (`GET /v1/data/transfers`, `/{id}`) gains `createdAt`, `finishedAt` and `expiresAt`. `GET /v1/auth/me` gains `hasPassword`: whether asking for the account's deletion wants the password.
- e4a66e0: `POST /v1/auth/email/verification/resend { email }`: send the verification link again without a session (a sign-up whose address is not proved yet). Always 202 `{ accepted: true }`; bot check action `resend-verification`. Additive: nothing existing changes.
- e71a268: Push and SMS: `PUT/GET /v1/devices` and `DELETE /v1/devices/{id}` (push devices), `GET/PUT/DELETE /v1/messaging/phone` and `POST /v1/messaging/phone/verify` (the SMS number, masked, confirmed by a texted code), and `POST /v1/webhooks/sms/{provider}` (the provider's signed STOP/START). Notification preferences take `sms` and `push` (booleans per type) when the providers are configured.
- 29bc561: Quiet hours: `GET`, `PUT` and `DELETE /v1/notifications/quiet-hours`, and `urgent` on the notification types of `GET /v1/notifications/types`.
- 7763a97: Record pages: `GET /v1/notes/{id}` and `GET /v1/notes` take `?include=can`,
  which adds `can: { update, delete, restore }` to each note (what its routes
  would allow you now; not part of the ETag). `POST /v1/notes` and
  `POST /v1/notes/{id}/restore` answer with the strong ETag `GET` sends, good
  as `If-Match` at once. Notes no longer carry `tenantId` (it was never in the
  schema). CORS exposes `ETag`, `Location` and `Idempotent-Replayed` to
  browser apps on `CORS_ORIGINS`.
- cbb7b50: Record panels: `GET /v1/lists/{subject}` answers `capabilities` (tags,
  comments, attachments, revisions, pdf, bulk, watch, search, transfer,
  custom, events, numbered, approvals), so a client shows only the panels a
  subject has, and `attachmentLimits: { maxBytes, maxMb, types }` (null
  without attachments), the limits the upload enforces. New `GET /v1/people?q=` (key and
  name of the tenant's active members, for any member: @mention
  autocomplete). Comments carry `authorName`, revisions `changedByName`.
  Realtime: `record.commented` and `record.attachments.changed` reach a
  record's watchers who may read it.
- fadfb7f: Saved views of lists: `GET/POST /v1/views`, `GET/PATCH/DELETE /v1/views/{id}` and `GET /v1/views/{id}/apply` (a list's filters, sort and columns under a name; private, team or tenant-wide). New permission `Access.manageViews`.
- f500677: Session lifetime policy: tenant settings `auth.sessionIdleMinutes` and `auth.sessionMaxHours` (under the deployment's `SESSION_IDLE_MINUTES` and `SESSION_MAX_HOURS`) end browser sessions and token clients' refresh-token families sooner. `GET /v1/auth/me` has a new `session { idleMinutes, lastActiveAt, expiresAt }` for a browser session.
- 8f65f9f: Settings describe their values and who may set them; the access API's read routes are typed (#111).

  - `GET /v1/settings` and `/v1/settings/{key}`: each setting adds `type` (`boolean | number | string | enum | json`), `options` (enums), `min`/`max`/`integer` (numbers), `maxLength` (strings) and `schema` (its JSON Schema), generated from the declaration's Zod schema; `canEdit` (you may set its value for the tenant, a team or a principal) and `canSetMine` (you may set your own).
  - New `GET /v1/access/principals?q=&kind=user|client`: the tenant's users and API clients searched by name or address, as principal keys (`user:<id>`, `client:<id>`), cursor-paged; for those who may list users and clients.
  - `GET /v1/access/users`, `/v1/access/roles` (and `POST`), `/v1/access/catalog` and `/v1/access/audit` declare their responses: no longer `never`. The users list no longer carries `tenantId` (always null).
  - `DELETE /v1/settings/{key}` was already a typed 204 (`unwrap()` returns `undefined`); a test now holds it.

- 7c7e54c: Enterprise SSO: plain OAuth 2.0 connections (`protocol: "oauth2"`, for providers without OpenID Connect such as Lark/Feishu) on `POST /v1/sso/connections` and `PATCH /v1/sso/connections/{id}`: `authorizationEndpoint`, `tokenEndpoint`, `userinfoEndpoint`, `clientId`, `clientSecret`, `tokenEndpointAuthMethod`, `scopes`, a declarative `mapping` of the user-info answer, and `preset` (`{ name: "lark", region }`) on creation. Connections answer an `oauth2` block (`null` for the other protocols) and `protocol` may be `oauth2`. The provider sends the browser back to `GET /v1/auth/sso/{tenantId}/{connectionId}/oauth2/callback`. `POST /v1/sso/connections/{id}/refresh` answers 409 `sso_no_discovery` for an OAuth 2.0 connection.
- 68d245d: Tenant branding: `GET /v1/branding` (colour, mail sender name, logo path, `locked`, `canEdit`), `PUT /v1/branding` (`primaryColor` as `#rrggbb`, `mailFromName`; `null` removes), `POST /v1/branding/logo` (multipart `file`, PNG/JPEG/WebP up to 512 KB), `DELETE /v1/branding/logo`, and the public `GET /v1/branding/{tenantId}/logo` (the image). Settings `branding.primaryColor`, `branding.mailFromName` and the operators' `branding.locked` (409 `branding_locked` while on).
- b5eecde: Tenants (operators): `POST /v1/tenants/{id}/export { format? }` (202, a data transfer followed at `GET /v1/data/transfers/{id}`; `Idempotency-Key`, a recent sign-in); `POST /v1/tenants/{id}/deletion { slug }` (deactivates now, erased after `TENANT_DELETION_GRACE_DAYS`; a recent sign-in) and `DELETE /v1/tenants/{id}/deletion` (cancels until the erase starts). A tenant has `deletionRequestedAt`, `deletionScheduledFor` and `deletionStartedAt` (ISO datetimes, or null). `PATCH /v1/tenants/{id} { active: true }` answers 409 `tenant_deletion_pending` while a deletion is pending.
- 1365cc2: Tenant quotas: `PUT /v1/tenants/{id}/quotas` (operators) sets a tenant's `maxMembers`, `maxApiClients`, `maxStorageBytes` and `maxRecords` per feature; `GET /v1/tenants/{id}/usage` (operators) and `GET /v1/tenant/usage` (administrators) show use against the limits. Creating past a limit answers 422 `quota_exceeded` with `quota: { resource, limit, used }`. Defaults are the `quotas.*` platform settings.
- b8821ff: `POST /v1/auth/sign-up` takes an optional `tenantName`, and `GET /v1/auth/methods` says `tenantSignUp` (optional in the type, always sent): with `TENANT_SIGN_UP=on` a sign-up makes its own tenant, the new account its administrator. The operators' tenants carry `createdBySignUp` (optional in the type, always sent). Additive: nothing existing changes.
- 6943bfc: Tenant tree (holding groups): a tenant's `parentId` on `GET/PATCH /v1/tenants/{id}`, `POST /v1/tenants` and the `GET /v1/tenants` list (filter `parentId`, `parentId.isNull`); `GET /v1/access/consolidated/tenants` (the subtree a consolidated read spans) and `GET /v1/access/consolidated/audit` (the audit log of your tenant and the tenants below it), with the `Access.readConsolidated` permission. New 409 codes: `tenant_tree_cycle`, `tenant_has_children`.
- b4a9eeb: A tenant registers its own senders of incoming webhooks: `GET/POST /v1/webhook-senders`, `GET/PATCH/DELETE /v1/webhook-senders/{id}` and `POST /v1/webhook-senders/{id}/rotate-secret` (the secret is in the create and rotate answers only), and the senders POST signed events to `POST /v1/webhooks/tenants/{tenantId}/senders/{name}`. Additive: nothing existing changes.
- 9a42bed: Tenants for operators: `GET /v1/auth/me`'s `tenant` gains `operator` (true in the operator tenant, where the operators' routes answer). `GET /v1/tenants` is a page (`nextCursor`, and `page`, `total` on request) with `listQuery()` filters (`name`, `slug`, `active`, `operator`, `createdAt`, `updatedAt`), `sort` and `fields`, newest first (it was every tenant, oldest first), described at `GET /v1/lists/Tenant`. New `GET /v1/tenants/{id}` (with an ETag) and `PATCH /v1/tenants/{id} { name?, slug?, active? }` (If-Match; 409 `operator_tenant` when deactivating the operator tenant). 409 `tenant_slug_taken` carries `errors: [{ path: 'slug' }]`. `POST /v1/tenants` answers the tenant with `administrator: { email, status: 'invited', expiresAt }`.
- 52344e8: `GET /v1/auth/tenants` items have `operator` (an operator tenant: the only one whose session can turn `platform.mode` off). `GET /v1/auth/tenants` and `POST /v1/auth/tenant` also answer while the deployment is in maintenance mode, so an operator who is in another tenant can switch back and end it.
- e72481c: Bulk runs carry their times: `createdAt`, `startedAt` and `finishedAt` (ISO datetimes; the last two null until a worker takes the run up and until it ends) on every item of `GET /v1/bulk` and on `GET /v1/bulk/{id}`. `GET /v1/bulk` takes `?status=queued|running|completed|failed` and `?kind=delete|restore|update` (the action; 400 for any other word), and `GET /v1/data/transfers` takes `?status=` too; a filtered page may hold fewer than `limit` items while `nextCursor` is set, so follow it until it is null. A comment's `mentionNames` also names a mention written as an address (`@maya@example.com`) under that address, lower-cased, besides its `user:<id>` key; an address that mentioned nobody gets no entry.
- f908acc: The operations routes are typed: `GET /v1/ops/outbox` (`stats`, `deadLetters`, `notifications`, `canManage`), `GET /v1/ops/queues`, the `retried`, `requeued` and `purged` counts of `POST /v1/ops/queues/{name}/retry-failed`, `POST /v1/ops/dead-letters/requeue` and `…/purge`, and the `data` of `GET /v1/ops/events` as a union by `source` (workflow, webhooks, outbox, idempotency, locks, mail, resilience), then by `type`. Error messages, payloads and headers are masked as in the logs and cut before they reach the browser, and a stack trace never does: an event's `error` is `{ name?, message }`. A resilience event's own `source` is now `origin` (it used to overwrite the stream's `source` tag).
- 46edfae: User pictures. `PUT /v1/account/avatar` (multipart, field `file`: a PNG, JPEG, WebP or GIF, at most 2 MB; answers `{ avatarUrl }`) and `DELETE /v1/account/avatar` set and remove the signed-in user's picture. `avatarUrl` (a path for an `<img>`, or null) is now on `GET /v1/auth/me`'s `user`, on every person `GET /v1/people` returns and on the access user list; `GET /v1/people/{id}/avatar` answers with the picture itself (an image, not a redirect) for a member of the tenant.
- 00980c1: Webhook deliveries (#187). **Breaking for the delivery time fields:** `createdAt`, `nextAttemptAt`, `lastAttemptAt` and `completedAt` of a delivery (`GET /v1/webhook-deliveries`, `…/{id}`, `POST …/webhook-endpoints/{id}/test`, and the `/v1/access/clients/{clientId}/…` twins), the message's `createdAt`, each attempt's `at` and `lastRequest.sentAt` are now ISO 8601 strings (`2026-10-20T08:30:00.000Z`), no longer epoch milliseconds, like the rest of the API; an endpoint's `createdAt`, `updatedAt` and `failingSince` are still epoch milliseconds. New: `GET /v1/lists/WebhookDelivery` describes the delivery log's filters, sorts and limits (for an API client, or a user with `Access.manageClients`; the client stays in the path); `GET /v1/access/clients` and `GET /v1/access/clients/{id}` carry `webhookEndpoints`, the client's number of endpoints (absent with `WEBHOOKS=off`); `lastRequest.signedWith` on one delivery lists the secrets that signed the latest attempt (`{ createdAt, expiresAt }` each, newest first: two during the 24 hours after a rotation; null for deliveries from before), never the secrets.
- 8f0d9a8: Webhooks for signed-in administrators, the event types catalog, a test event and a paged delivery log (#124).

  - New `/v1/access/clients/{clientId}/webhook-endpoints…` and `…/webhook-deliveries…`: the same routes as an API client's own, for a user with `Access.manageClients` acting on a client of their tenant; creating an endpoint and rotating its secret want a recent sign-in.
  - New `GET /v1/webhook-event-types`: the declared types, grouped by feature, with descriptions.
  - New `POST /v1/webhook-endpoints/{id}/test` (and its delegated twin): sends `webhook.test` to one endpoint, 202 with the delivery.
  - `GET /v1/webhook-deliveries` is cursor-paged (`limit`, `cursor`, `count`, `nextCursor`), with the list query's filters (`status`, `endpointId`, `type`, `attempts`, `createdAt`), `filter`, `sort` and `fields`.
  - `GET /v1/webhook-deliveries/{id}` adds `durationMs` and `lastRequest` (the headers sent with the latest attempt).
  - An endpoint's `description` may not be an empty string (400); `null` clears it on PATCH.

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
- 1c59b6a: `PUT /v1/settings/{key}` and `PUT /v1/settings/{key}/platform` may answer 409 `mfa_enroll_first` (requiring two-factor of a caller who has no authenticator). `GET /v1/features` stays reachable while a user is enrolling.
- fc61f9a: `RealtimeEvents` types the record events: `record.commented`
  (`{ subject, recordId, commentId, action }`) and
  `record.attachments.changed` (`{ subject, recordId, attachmentId, action }`),
  so `realtime.on('record.commented', …)` is typed.
- de31246: `redirectTo` (`POST /v1/auth/magic-link`, `GET /v1/auth/oidc/{provider}/login`): a path of the web app only (one leading `/`, printable ASCII, no `\`, at most 2,048 characters), with the pattern in the schema; anything else is a 400 on the magic link and ignored by the OIDC login.
- 778c5a9: Swagger descriptions for the Resend mail-event intake.

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
