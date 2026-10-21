# Notifications

How a feature tells a person (or a system) that something happened, once,
and the platform delivers it: stored to read later, pushed to open
connections, mailed at once or in a digest, pushed to a phone or texted, sent to an API client as a
webhook, as the recipient prefers. The code is in `apps/api/src/platform/notifications/`;
notes is the example (`features/notes/note-events.ts`).

`REALTIME=off` ([configuration.md](configuration.md#deployment-switches))
removes the live push only: notifications are still stored and mailed (and sent as
webhooks), the realtime channel just has no connection to reach. `WEBHOOKS=off`
removes the webhook endpoint API and the delivery worker; the outbox relay stays.

## How it works

1. A feature **declares its types** and hands them to the platform:

   ```ts
   // features/notes/note-events.ts: a domain event, declared once for its channels
   export const NOTE_EVENTS = defineDomainEvents([
     { type: 'note.published', webhook: true, notification: { channels: { email: 'immediate', webhook: true }, data: z.object({ noteId: z.uuid(), title: z.string() }) } },
     { type: 'note.deleted', webhook: true, notification: { channels: { email: 'immediate', webhook: true }, mandatory: true, data: … } },
   ]);
   // notes.feature.ts: defineFeature({ …, events: NOTE_EVENTS })
   ```

   The same declaration also gives the event's outgoing webhook type (`webhook`) and
   realtime event (`realtime`): [webhooks-and-realtime.md](webhooks-and-realtime.md),
   "Domain events". `defineNotifications()` with the feature's `notifications` list, or
   `PlatformModule.forRoot({ notifications })`, still works for a type with no other channel.

   `channels` are the defaults the recipient may change (`email`: `false` |
   `immediate` | `hourly` | `daily`, for users; `webhook`: for API clients;
   a channel left out is off). In-app and realtime are always on.
   `mandatory`: the recipient may change a frequency, never switch a channel
   off. `collapse`: one notification per recipient for this type, counted up.
   `data` is checked when sending; its keys are the texts' placeholders.
   IAM declares its own mandatory types, `IAM_NOTIFICATIONS` (`security.newSignIn`,
   `security.passwordChanged`, `security.passwordBreached`, `security.mfaChanged`,
   `security.passkeyAdded`, `security.passkeyRemoved`, `security.apiKeyRotated`,
   `security.breakGlassStarted`;
   [auth.md](auth.md), "Security notifications"), passed before the features'.
2. Its **texts** live in `apps/api/src/i18n/<locale>/notifications.json`, under the
   type's segments, for every locale (`catalogs.spec.ts` checks them):

   ```json
   { "note": { "published": { "label": "Note published", "title": "Note published",
     "body": { "one": "\"{title}\" is now published.", "other": "{count} of your notes were published; …" } } } }
   ```

   `label` names the type to people (the preferences UI); `title` and
   `body` are rendered from `data`, with `count` (collapsed) picking the
   plural form. A type the English catalog lacks doesn't compile; no
   segment of a type is named `label`.
3. The service **sends**, inside the change's transaction, so the
   notification exists if and only if the change committed:

   ```ts
   await this.notifications.notify(tx, { type: 'note.published', to: row.ownerId, data: { noteId, title }, link: `/notes/${id}` });
   …
   this.notifications.deliverNow(); // after the commit: skip the relay's poll
   ```

   `to`: principals or their keys (`user:<id>`, `client:<id>`), at most
   500 per call (chunk a broadcast through a queue job). `key`: a newer
   notification with the same key replaces the older one, counted up,
   unread again, newest (a new id: the old one is gone). `link`: a path of
   the web app, made absolute with `WEB_URL` in mail.
4. A **worker delivers** it (`notification-delivery.handler.ts`, an outbox
   handler), in the tenant the outbox message names (the payload's
   `tenantId`, [tenancy](tenancy.md)): the recipient as they are now
   (nothing for a deactivated one, or one no longer a member of that
   tenant), their preferences, the texts in their language, then each channel.
   Effects that must commit with the delivery (the webhook through the
   outbox, a digest flag) run in its transaction; a socket emit after it.
   Exactly once per notification; a failure retries, then dead-letters
   (`GET /v1/ops/outbox`, which also counts `notifications.undelivered`:
   older than ten minutes and not delivered, the number to alert on).

## For clients

Every route is about the caller's own (a user's or an API client's); no
permission is needed. In a tenant, that is the tenant's notifications and
the account's own (stored outside any tenant, `tenant_id` null: the
security notifications of a sign-in), which row-level security gives
([tenancy](tenancy.md)); another tenant's never show, even the same
person's. Preferences are the person's, the same in every tenant.
While an administrator impersonates the person, they see the tenant's
notifications only (never the account's own), and nothing changes: marking
read, removing and the preferences answer 403 (the preferences are not even
shown). A collapsed notification replaces the older one of its key in the
same tenant only (or among the account's own).

| Route | Does |
| --- | --- |
| `GET /v1/notifications` | newest first, texts in the request's language; `?read=false`, `?type=`, `?key=`, `?createdAt.gte=`, `?sort=`, cursor pages |
| `GET /v1/notifications/unread-count` | `{ unread }` |
| `POST /v1/notifications/{id}/read` | marks one read (again: no change) |
| `POST /v1/notifications/read-all { before? }` | marks all read, or those created before `before` (what the client has shown) |
| `DELETE /v1/notifications/{id}` | removes one |
| `GET /v1/notifications/types` | the types: label, `mandatory`, the defaults of the channels the caller may set |
| `GET /v1/notifications/preferences` | the caller's effective settings per type |
| `POST /v1/notifications/unsubscribe/{token}` | public; the one-click unsubscribe of a mail's `List-Unsubscribe` link (below); 204 |
| `PUT /v1/notifications/preferences` | replaces the caller's overrides: `{ "note.published": { "email": "daily" } }`; a type or channel left out goes back to its default; a mandatory type refuses `false`; audited (`notificationPreferences.updated`) |
| `POST /v1/notifications/test` | development and tests only: sends the caller a `system.test` notification, answers `{ id }` |

- **The shapes** (typed in the OpenAPI document and so in the client): the
  settings of one type are `{ email?: false | 'immediate' | 'hourly' | 'daily',
  webhook?: boolean }`. `GET /types` returns `{ items: [{ type, label,
  mandatory, channels }] }`, `channels` being the type's defaults for the
  channels the caller may set (`email` for a user, `webhook` for an API client;
  in-app and realtime are always on and never listed). `GET /preferences` and
  `PUT /preferences` return `{ types: { [type]: settings } }`, the effective
  value of every declared type; `PUT` takes the overrides, `{ [type]:
  settings }`. A value a channel doesn't take (`email: 'often'`, `webhook:
  'yes'`) is a 400 `validation_failed` naming `<type>.<channel>`, as are an
  unknown type or channel, a channel the caller's kind can't set, and a
  mandatory type switched off. The schemas are in `notification.schemas.ts`;
  the channels' own (`emailSettingSchema`, `webhookSettingSchema`) are the ones
  they validate with, so a channel you add documents its setting there.
- An item: `{ id, type, title, body, data, link, key, count, read, readAt, createdAt, updatedAt }`.
  `type` and `data` are the contract for programs; `title` and `body` are for people.
- **Realtime**: every connection of the recipient hears `notification`
  with the item (in the recipient's language) as soon as it is delivered,
  and keeps up with changes made elsewhere (another tab, another device):
  `notification.read { id, readAt }`, `notifications.read-all { before,
  updated }`, `notification.removed { id }`, and after each of these and
  each delivery `notifications.unread-count { unread }` for the badge.
- **Webhook** (API clients): the event `notification.created`, with the
  item as `data`. Subscribe at `POST /v1/webhook-endpoints`. A client that
  also subscribes to a feature's own event (`note.published`) gets both.
- **Mail** (users): `immediate` sends one mail per notification; `hourly`
  and `daily` bundle them (one mail listing them, times in the user's
  zone), the daily one at `NOTIFICATIONS_DIGEST_HOUR` in the user's time
  zone. After downtime, everything due goes in the next run.
- **Unsubscribe** (RFC 8058, which Gmail and Yahoo require of bulk senders):
  every notification and digest mail carries `List-Unsubscribe: <https://…/v1/notifications/unsubscribe/{token}>`
  (and a `mailto:` when `MAIL_UNSUBSCRIBE_MAILTO` is set), `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
  and an "Unsubscribe" link in the footer (to `WEB_URL/unsubscribe?token=…`, the web app's
  `unsubscribe` page, no sign-in: a button POSTs the token; a GET changes nothing, since mail
  scanners follow links). The mail client
  POSTs the form `List-Unsubscribe=One-Click` to the https URL, with no sign-in: the
  `{token}` is a JWT (`notification-unsubscribe.ts`) signed with a key derived
  from `JWT_SECRET` (HKDF, labelled, own audience and `typ`), naming the user and
  what to switch off, valid for a year, so it can't be forged, changed or
  taken from another kind of token. It turns the preference `email` of that type off
  (a digest's token: of every type the user gets in that digest's modes), audited
  (`notificationPreferences.updated`, `via: unsubscribe`); repeating it changes
  nothing. **Essential mail is excluded**: a `mandatory` type's mail carries
  no headers and no link, and its token would not switch it off. Every refusal
  (forged, expired, account gone) is the same 400, as a wrong body is a 400
  `validation_failed`. The headers need an https `APP_URL` (the RFC says so);
  with http (development) mail has the footer link only. See
  [deliverability.md](deliverability.md), "Unsubscribe headers (RFC 8058)".
- **Export**: `POST /v1/data/exports { name: 'notifications' }` (CSV, JSON
  or Excel of the caller's own; see [data-transfer.md](data-transfer.md)).

## Trying it in development

`POST /v1/notifications/test` (no body, no target: the caller's own) sends a
`system.test` notification the way a feature's goes: stored in the caller's
tenant, delivered by the worker to every channel the caller has on (the bell
and the realtime push always; mail `immediate` unless they changed it, for a
user; the `notification.created` webhook, for an API client), subject to the
caller's preferences for that type. Call it as often as you like to try the
bell, the live count and the mail; each call is a notification of its own.
Not while an administrator acts as the person (403).

It exists only where the demo seed's NODE_ENV check passes (`development` or
`test`, set explicitly: `nodeEnvRefusal()` in `src/demo/demo-guard.ts`).
Elsewhere the controller and the `system.test` type are left out of the module
graph when the app is built (`inDevelopment()`, `notification-test.ts`, as the
deployment switches leave out their routes): the route answers 404 like any
missing one, the type is not in `GET /types` or the preferences, and the
route is not in the served OpenAPI document. The committed document and the
typed client (generated with `NODE_ENV=test`) do list it, so a development
frontend can call it. It uses the global rate limit and has no bypass.
Tested in `test/notifications.e2e-spec.ts` and, under `NODE_ENV=production`,
`test/notifications-test-route-production.e2e-spec.ts`.

## Watching records

A principal follows a record and is told when it changes
(`apps/api/src/platform/subscriptions/`). The feature decides who may watch
(whoever may read the record), watches creators by default, and tells
the watchers in each change's transaction:

```ts
await this.subscriptions.subscribe(owner, { subject: 'Note', recordId: row.id });        // on create, in its transaction
await this.subscriptions.notifyWatchers(tx, { subject: 'Note', recordId, type: 'note.changed', data, key: `note.changed:${id}`, link, except: by });
const to = [row.ownerId, ...(await this.subscriptions.watchers({ subject: 'Note', recordId }))];   // when notifying by hand
```

`except` leaves out the one who made the change; a `key` collapses
repeated changes into one notification per record. Routes:
`POST`/`DELETE /v1/notes/{id}/watch` (the feature's), `GET /v1/subscriptions`
(what the caller watches), `DELETE /v1/subscriptions/{subject}/{recordId}`.
`?include=watching` on a record's detail and list routes adds `watching`
to each record (whether the caller watches it; one query per page,
`SubscriptionsService.watching()`, the platform's `RecordPresenter` does it
for every feature with the `watch` capability).
A deleted account watches nothing (`erase`); a record purged from its
recycle bin is forgotten by the purge itself (`RecordPurgeRegistry`), one
deleted outright by the feature calling `forget`.

## Push and SMS

Two more channels, `push` and `sms`, for users (roadmap item 11). Code:
`apps/api/src/platform/messaging/`. **Both providers are off** (`PUSH_PROVIDER`,
`SMS_PROVIDER`; [configuration.md](configuration.md)): while a provider is off its
channel is not offered at all (not in `GET /notifications/types`, not a preference).
Phone numbers and push tokens are personal data: encrypted columns with a blind
index ([encryption.md](encryption.md)), so `DATA_ENCRYPTION_KEYS` and `BLIND_INDEX_KEYS`
are required. Nothing here returns a token, and the number only masked.

**How a message goes.** The channel (`SmsChannel`, `PushChannel`) runs in the
delivery like the email channel and only queues a job on the `messaging` queue
(job id from the notification, so a retried delivery queues it once; push: one job
per device). `MessagingProcessor` sends, on a worker, as `system:messaging`, in
the notification's tenant. A transient provider failure is retried by the queue
(backoff); a permanent one fails the job.

| Route | Does |
| --- | --- |
| `PUT /v1/devices { platform, name, token }` | registers a device, or refreshes it (call it when the app opens: the last-seen time moves); a token another person had moves to the caller |
| `GET /v1/devices`, `DELETE /v1/devices/{id}` | the caller's devices; removing deletes the token |
| `GET /v1/messaging/phone` | the number masked, `verified`, `optedOut` |
| `PUT /v1/messaging/phone { phone }` | sets the number (E.164; only `SMS_ALLOWED_PREFIXES` countries, else 400 `phone_country_not_allowed`), texts a six-digit code; a different number starts unverified |
| `POST /v1/messaging/phone/verify { code }` | confirms it (ten minutes, void after five wrong guesses) |
| `DELETE /v1/messaging/phone` | removes it |
| `POST /v1/webhooks/sms/twilio` | public; the provider's inbound messages (below) |

These are a person's own: an API client gets 403, and so does an administrator
acting as the person. Registrations and number changes are audited
(`device.registered`, `device.removed`, `phone.set`, `phone.verified`,
`phone.removed`, `phone.optedOut`, `phone.optedIn`).

**Devices have their own lifecycle**, not the session's (a web session ends at
12 hours): a device is deleted when the person removes it, when the provider says
its token is dead (Web Push 404/410), after `DEVICES_RETENTION_DAYS` without being
seen (nightly), and with the account (a `PersonalDataSource`: both devices and
number are in the data export).

**Preferences.** `sms` and `push` are booleans per type in
`PUT /notifications/preferences`, off unless a declaration's `channels` says
`{ sms: true }`. SMS also needs a verified number that has not opted out; push needs a
registered device. API clients cannot set them (400 naming `<type>.sms`).

**Toll-fraud caps.** Applied by the worker right before each SMS (verification codes
included), so they hold whatever queued it:

- the destination must start with a prefix of `SMS_ALLOWED_PREFIXES` (`+1,+44`);
  empty means none, so nothing is sent until the deployment names its countries;
  checked when the number is set and again at send time;
- per UTC day, at most `SMS_DAILY_LIMIT_PER_TENANT` in a tenant,
  `SMS_DAILY_LIMIT_PER_PREFIX` to one prefix in a tenant and
  `SMS_DAILY_LIMIT_PER_USER` to one user. The counters (`messaging_usage`) are
  incremented in one transaction with an atomic upsert, which rolls back when a cap
  is hit, so a refused SMS uses none of the allowance and concurrent workers cannot
  overshoot;
- per client IP, the routes that text a code are throttled (5 per 10 minutes);
- a refusal is counted (`blocked:<reason>`), logged as an error and shown by the
  gauges `sms_sent_today` and `sms_blocked_today{reason}` on the workers'
  `/metrics`; alert on a rising `sms_blocked_today` or on `sms_sent_today` beyond what
  you expect (no rule ships yet);
- the **kill switch** is the flag `messaging.sms` (on by default). The operators
  switch it off for every tenant with `PUT /v1/settings/messaging.sms/platform
  { "value": false, "enforced": true }`; a tenant's administrator can switch off
  their own tenant. A job meeting it is skipped (`switched_off`), not retried.

The caps count messages, not money: a spend ceiling would need the provider's prices.

**STOP and START.** Point the provider's inbound webhook at
`https://<APP_DOMAIN>/v1/webhooks/sms/twilio`. The adapter verifies Twilio's
`X-Twilio-Signature` (HMAC-SHA1 of the URL and the sorted fields with the auth
token; `TWILIO_WEBHOOK_URL` when a proxy changes the URL) on the raw bytes, so
nothing unsigned is acted on (401 `sms_signature_invalid`). A message that is
exactly `STOP` (or `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`, any case) opts
the number out for every user who has it (found by the blind index): no SMS is
queued, a job already queued is skipped when it runs, and the verification code is
not sent either. `START` (`YES`, `UNSTOP`) re-enables a number that opted out and
does nothing for one that did not. Other texts are ignored. Twilio enforces STOP at
its end as well (it refuses to send to the number, error 21610, which the adapter also
records as an opt-out). The route answers 204 and writes in the request only the
opt-out row and its audit entry.

**Providers** are interfaces (`SmsProvider`, `PushProvider` in
`messaging/providers/`) chosen by the environment; `memory` keeps what it would send
(tests; never receives inbound). Twilio is written over `fetch` and `node:crypto`
(two calls, as the SendGrid intake does for its signature), Web Push uses the pinned
`web-push` library (VAPID, payload encryption). APNs and FCM are further adapters of
`PushProvider` (iOS and Android devices are stored but have no provider yet); another
SMS provider implements `SmsProvider.send` and `parseInbound`.

**Limits.** An SMS is cut to `SMS_MAX_LENGTH` characters; a push payload to
`PUSH_MAX_PAYLOAD_BYTES` (the body gives way).

## Adding a channel

A provider that implements `NotificationChannel` and registers itself;
nothing in the platform changes:

```ts
declare module '../../platform/notifications/notification.types.js' {
  interface NotificationChannelSettings { chat: boolean }   // what declarations and preferences may set
}
@Injectable()
export class ChatChannel implements NotificationChannel<boolean> {
  readonly name = 'chat';
  readonly settings = { schema: z.boolean(), off: false };   // leave out: always on, not a preference
  constructor(registry: NotificationChannelRegistry, private readonly chat: ChatClient) { registry.register(this); }
  supports(recipient: Principal) { return recipient.kind === 'user'; }
  async afterCommit({ recipient, rendered }: NotificationDelivery) { await this.chat.send(…, rendered.title); }
}
```

`inTransaction(delivery, tx)` for effects that must commit with the
delivery (a queue add with a deterministic job id, an outbox message);
`afterCommit(delivery)` for what can't roll back. The recipient's
preferences and `GET /notifications/types` take the new channel up by
themselves; declarations set its default under `channels.chat`.

## Housekeeping

- `NOTIFICATIONS_RETENTION_DAYS` (90): read notifications older than this
  are deleted nightly; `NOTIFICATIONS_MAX_AGE_DAYS` (365): any. Both jobs
  run on one instance (`@OnOneInstance`); the retention is one sweep by age
  of every tenant's rows under the worker's row-level security bypass.
- **Digests** are one mail per person whatever the tenants: the hourly job
  reads every tenant's due rows under the bypass, lists only the account's
  own and those of tenants the person is still an active member of (the
  others are unflagged, unsent), and logs the tenants it mailed for.
- Texts render when read, not when stored: a language change or a reworded
  catalog applies to old notifications too. A type removed from the
  declarations shows as its name; its undelivered messages dead-letter.
- The realtime push is best-effort (a retried delivery may emit twice);
  the stored notification, the mail and the webhook are exactly once.
