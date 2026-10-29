# Webhooks and realtime

How the API tells other systems and connected clients that something
happened, and how it accepts webhooks from others. Built on
`@nestjs/webhooks`, `@nestjs/outbox` and socket.io (`platform/`).

## Outgoing webhooks

`WEBHOOKS=off` ([configuration.md](configuration.md#deployment-switches)):
the endpoint and delivery routes answer 404 and the delivery worker does not
run. The webhooks package stays registered, so incoming webhooks are unchanged
and the code that dispatches (notifications, approvals, your features) does not
fail; the outbox relay keeps running because notification delivery uses it.
Deliveries to endpoints created earlier wait until it is turned on again.
`REALTIME=off`: no `/realtime` gateway; `Realtime` pushes do nothing. They
do nothing either in a standalone application context (the demo seed, a
script): NestJS gives a gateway its socket server only in an HTTP app
(the API and the worker both are one).

Per API client, by design: the client is the package's tenant (`tenant` =
its id), so a client sees and manages only its own endpoints and deliveries.
There are no endpoints of a whole tenant: what a webhook carries is what its
client may read. By default a client receives events about the records it
owns; an administrator can widen that to its tenant's records it may read
("Subscriber scope" below). The client's own routes take its API key:

| Need                                                  | Route                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| Subscribe, list, read, change, remove                 | `POST/GET /v1/webhook-endpoints`, `GET/PATCH/DELETE /v1/webhook-endpoints/{id}` |
| A new secret (the old one keeps signing for 24 hours) | `POST /v1/webhook-endpoints/{id}/rotate-secret`                                 |
| A test event to one endpoint                          | `POST /v1/webhook-endpoints/{id}/test` (202, the delivery)                      |
| Deliveries (paged)                                    | `GET /v1/webhook-deliveries`, `GET /v1/webhook-deliveries/{id}`                 |
| Retry one, or every failed one since an outage        | `POST /v1/webhook-deliveries/{id}/retry`, `POST /v1/webhook-deliveries/retry`   |
| What may be subscribed to, by feature                 | `GET /v1/webhook-event-types` (an API key or a user)                            |

### Managed by an administrator

A signed-in user manages a chosen client's webhooks on its behalf, under
`/v1/access/clients/{clientId}/`: `webhook-endpoints…` and
`webhook-deliveries…`, the same routes as above
(`platform/webhooks/client-webhooks.controller.ts`; one
`WebhookManagementService` behind both doors). In the web app,
`/webhooks` is the **outgoing** endpoint setup: when no API client exists it
links to `/api-clients` to create one first. `/webhooks/senders` is the
separate **incoming** sender setup. An API client's daily request quota applies
to HTTP API calls made with that client's key; it does not meter outgoing
webhook deliveries or retries.

Each route wants:

- a user (a session or a user token; an API key is a 401) with
  `Access.manageClients` (never while impersonating), and API_CLIENTS on;
- a client of the caller's tenant (another tenant's is a 404) over which the
  caller has authority, as for rotating its key (403 `authority_required`);
- a recent sign-in to create an endpoint or rotate its secret: both return a
  secret, and to set the client's subscriber scope (403
  `reauthentication_required`, [auth](auth.md)).

The client's subscriber scope is set here alone, never with its own key:
`GET/PUT /v1/access/clients/{clientId}/webhook-scope` (`{ "scope": "own" | "tenant" }`).

A chooser of clients needs no request per client: `GET /v1/access/clients` (and
`GET /v1/access/clients/{id}`) carry `webhookEndpoints`, how many endpoints the
client has, from one grouped query on the package's table
(`ApiClientCountsRegistry`: IAM can't import the platform, so the webhooks
register the count). With `WEBHOOKS=off` it is absent, not 0: the client's
endpoints may exist, they only receive nothing.

Changes (create, update, delete, rotate, test, retry) are audited as the
user's, with the client as the target (`webhook-endpoint.created`, …); a
client's own changes through its key are not. The package keeps endpoints in
its own store, on its own connection, so the audit entry is written after its
change succeeded, not in one transaction with it.

### Details

- **Event types catalog:** `GET /v1/webhook-event-types` groups the declared
  types by feature (`group`: the first segment unless declared). A feature
  declares a description with `{ type, description, group? }` in
  `PlatformModule.forRoot({ eventTypes })` (a plain string still works);
  records' `events` declare theirs. It is the same list for every caller
  and every client: there is no `?clientId=`. An endpoint gets every message
  addressed to its client that it subscribed to (`dispatch()` picks endpoints
  by tenant and type only); who a record's message is addressed to, and what
  it carries, is the subscriber scope below. An approval or a notification
  goes to the client it is for.
- **Subscriber scope: who receives a record's event, and what.** A record
  event (`note.created`, `note.published`, `note.deleted`, a generated
  feature's `<item>.created|updated|deleted|restored`) is produced whoever
  made the change: a signed-in user, an API client, a workflow. It is then
  addressed by `RecordWebhooks` (`platform/webhooks/record-webhooks.service.ts`,
  used by the records' `events` and by `note-publisher.service.ts`), in the
  write's transaction (the outbox: sent if and only if it commits, with the
  package's retries and per-endpoint idempotency), one message per receiver:

  | Receiver                                                                     | Gets it when                                                                                 |
  | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
  | The client that owns the record (`ownerId` `client:<id>`)                    | always (scope `own`, the default, and `tenant`)                                              |
  | Another active client of the **record's tenant** with scope `tenant`         | its own ability may `read` that record (roles, conditions, units; for a deletion, as it was) |
  | Any other client: scope `own`, without `read` on that record, another tenant | never                                                                                        |

  A record's `data` is what a read of it shows (no tenant id, only the
  active custom fields' values: one function for both), then each
  message's is redacted by its receiver's field-level `read`
  (`AccessService.redact`: the fields it may not read are left out), and
  never carries an encrypted column. So a note a user writes in the web app
  reaches no client by default; it reaches a `tenant`-scope client that may
  read it. The scope is per client, not per endpoint: the package fans a
  message out to every subscribed endpoint of its client, so all of a
  client's endpoints see what the client sees. It lives in
  `webhook_client_scopes` (a tenant table: row-level security, a composite
  key to the client, which takes it along when deleted) and is set only by an
  administrator with `Access.manageClients`, authority over the client (they
  hold every permission it has) and a recent sign-in, audited as
  `webhook-scope.updated`; a client can't widen its own. Routing never uses a
  broad tenant id: the candidates are read in the record's tenant only, and
  each is checked against that one record. Covered by
  `test/features/notes/notes.e2e-spec.ts` and the records' capability tests
  (`test/record-capabilities.ts`).

- **Test event:** the reserved `webhook.test` (`data`: `{ endpointId, test: true }`)
  goes to that endpoint alone, whatever it subscribed to, signed and retried
  as any delivery. Subscribing to it is a 400, as any unknown type.
- **The delivery log** pages by cursor with the list query of every list
  ([api-conventions](api-conventions.md)): `limit`, `cursor`, `count=true`,
  flat filters (`status`, `endpointId`, `type`, `attempts`, `createdAt` in
  ISO 8601), `filter`, `sort`, `fields`. Every time is an ISO 8601 string
  (`createdAt`, `nextAttemptAt`, `lastAttemptAt`, `completedAt`; in one
  delivery also the message's `createdAt`, each attempt's `at` and
  `lastRequest.sentAt`), like the rest of the API; the package keeps epoch
  milliseconds, converted on the way out
  (`webhook-management.service.ts`). One delivery adds `durationMs` (every
  attempt together) and `lastRequest`: the headers of the latest attempt as
  sent (`webhook-id`, `webhook-timestamp`, `webhook-signature`, content type,
  user agent; never a secret) and `signedWith` (below). The recording transport
  (`recording.transport.ts`) writes them to `webhook_delivery_requests`
  before each attempt, around the package's own HTTP transport.
- **The list, described:** `GET /v1/lists/WebhookDelivery` describes the
  delivery log as every list is ([api-conventions](api-conventions.md),
  "List metadata"): the filters and their operators, the sorts, `select`, the
  limits, from `DELIVERY_LIST`, the declaration both delivery routes validate
  with. It describes the list, not one client's: the client stays in the path
  (`/v1/access/clients/{clientId}/webhook-deliveries`) or is the caller (an
  API key), and is no filter. It is for whoever may call a delivery route: an
  API client, or a user with `Access.manageClients` (a delivery has no CASL
  subject to `read`, so the registration carries its own check,
  `platform/webhooks/webhook-lists.ts`); 403 to others, 404 with
  `WEBHOOKS=off`. `defaultSort` is null: without `sort` it is newest first
  (by id), which `sort` cannot ask for by `createdAt`.
- **Which secret signed it:** `lastRequest.signedWith` lists the secrets that
  signed the latest attempt, newest first, in the order of the `v1,…`
  signatures in `webhook-signature`: `{ createdAt, expiresAt }` for each, ISO 8601. A secret has no id of its own: when it was made (the endpoint's
  creation, or the rotation that issued it) identifies it, and `expiresAt` is
  null for the current one and 24 hours after the rotation for the old one,
  so right after a rotation there are two. Never the secret. The package
  signs with every live secret and does not tell the transport which, so the
  recording transport reads the endpoint's live secrets as it records (the
  same, unless one expired or was rotated in between) and matches them to the
  signatures by count; a count that differs records null, as does a delivery
  from before this was kept. Only the latest attempt is kept, like the
  request.
- **`description`:** `null` clears it on PATCH; an empty string is a 400.

### Retention

Deliveries, their messages and attempt logs live in the package's
`nest_webhooks` schema, and one `webhook_delivery_requests` row per delivery
keeps its latest request's headers. `WebhookDeliveryRetentionJob`
(`platform/webhooks/webhook-delivery-retention.job.ts`, 03:35 in
`APP_TIMEZONE`, one instance, `system:webhook-delivery-retention`) keeps
both from growing for ever:

1. It calls the package's `WebhookDeliveries.prune()` with
   `WEBHOOKS_DELIVERY_RETENTION_DAYS` (30, at least 1). That deletes the
   deliveries that **succeeded or failed for good** and finished
   (`completedAt`) before the cutoff, their attempt logs, and the messages
   left without a delivery. A delivery still `pending` (waiting for a retry
   or being sent) is never deleted, however old; the retry schedule above
   ends within two days anyway. A failed delivery retried by hand is pending
   again and so kept.
2. It then deletes the `webhook_delivery_requests` rows whose delivery no
   longer exists.

Both tables are global, so one rule covers every tenant (no tenant context,
no row-level security bypass). It returns `{ deliveries, requests }`, what it
deleted, and logs it. With `WEBHOOKS=off` the job is left out, like the
delivery worker ([configuration](configuration.md#deployment-switches)).

- **Signatures:** Standard Webhooks (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`), with the endpoint's `whsec_…` secret, shown once at
  creation and at rotation.
- **Retries:** up to 50 attempts, waiting 5 s, 20 s, 80 s, 5 min 20 s and
  21 min 20 s (each four times the last), then 1 hour (the cap) for the
  remaining 44 waits. Each wait is jittered to between half and all of that,
  so a delivery that never succeeds is given up on after at most about 44.5
  hours (160,105 s of waiting, plus up to a 15 s timeout per attempt) and 33
  hours on average. An endpoint that fails every attempt for 5 days is
  switched off (`platform/webhooks/webhooks.config.ts`, `retry` and
  `disableEndpointAfter`).
- **Secrets at rest** are encrypted with `WEBHOOKS_ENCRYPTION_KEYS`; unset,
  they are stored unencrypted.
- **Event types** are declared by features (`PlatformModule.forRoot({ eventTypes })`);
  `dispatch()` refuses any other. The platform adds `notification.created`
  ([notifications](notifications.md) to an API client) and the approvals'
  `approval.requested`, `.approved`, `.rejected`… to the requesting client
  ([approvals](approvals.md)).

A record that takes the `events` capability ([adding a feature](adding-a-feature.md))
declares and dispatches `<item>.created`, `.updated`, `.deleted` (and
`.restored`) itself, through `RecordLifecycle`, to the client that owns the
record; `data` is the record as `GET /<x>/{id}` shows it to that client,
without any encrypted column ([encryption.md](encryption.md)); a hand-written
`dispatch()` of a row calls `withoutEncrypted(data)` itself.

From a feature, dispatch in the change's transaction, so the webhook goes out
if and only if the change commits (`features/notes/note-publisher.service.ts`):

```ts
await this.webhooks.dispatch(tx, {
  type: 'note.published',
  tenant: clientId,
  data,
});
```

### A receiver on your machine (development)

By default an endpoint is a public `https://` URL, and private, loopback and
cloud-metadata addresses are refused, when it is created and again when a
delivery is sent (a name that resolves to one is refused too). To try a
receiver running locally, set `WEBHOOKS_ALLOW_LOOPBACK=on` in the API's
environment (`apps/api/.env.development`; off by default, **never in
production**, where it would also accept plain `http://`):

- `http://127.0.0.1:<port>/…` and `http://localhost:<port>/…` (`localhost`
  and `*.localhost` always mean 127.0.0.1) are accepted. Only that address:
  `http://192.168.x.x`, `http://[::1]` and other private ranges stay refused,
  and so does `host.docker.internal`.
- From a container, `localhost` is the container itself: run the API on the
  host (`pnpm dev`) to reach a receiver there.
- The e2e tests set it, and `webhookReceiver()` (`apps/api/test/support.ts`)
  is a receiver on loopback.

```bash
# .env.development: WEBHOOKS_ALLOW_LOOPBACK=on, then restart the API
curl -s -X POST http://localhost:3000/v1/webhook-endpoints \
  -H "Authorization: Bearer $API_KEY" -H 'Content-Type: application/json' \
  -d '{ "url": "http://127.0.0.1:4000/hooks", "eventTypes": ["*"] }'
curl -s -X POST http://localhost:3000/v1/webhook-endpoints/$ID/test \
  -H "Authorization: Bearer $API_KEY"   # 202; the receiver gets webhook.test
```

Without it, creating `http://127.0.0.1:4000/hooks` is a 400 (only https:
URLs are accepted). A tunnel (an `https://` address that forwards to your
machine) works without the flag.

## Incoming webhooks

1. Declare the sender in `PlatformModule.forRoot({ incomingWebhooks })`:
   `{ name, scheme: 'standard' | 'stripe', header?, secretEnv }`. Unset, the
   secret is created on the first start and kept in the database.
2. On the route: `@Public()`, `@VerifyWebhook(name)`, and
   `@IncomingWebhook()` for the verified payload. A bad or stale signature
   is a 401.
3. Process it with `webhook.processInTransaction(tx, …)`: the inbox record
   and the change commit together.

A redelivered event id is answered 200 by the package before the handler
runs. Model: `features/notes/example-sender-webhook.controller.ts`.

### Incoming webhooks of a tenant

The senders above are deployment-wide: one secret, no tenant. A **tenant
registers its own senders** (a CRM, a payment provider), each with its own
secret, so the receiver knows the tenant of the work
(`platform/webhooks/incoming-senders.*`, `tenant-webhook-receiver.controller.ts`).

| Need                                                                            | Route                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Register, list, read, describe or disable, remove                               | `POST/GET /v1/webhook-senders`, `GET/PATCH/DELETE /v1/webhook-senders/{id}` |
| A new secret (the old one keeps verifying for `graceSeconds`, default 24 hours) | `POST /v1/webhook-senders/{id}/rotate-secret`                               |
| The sender's calls                                                              | `POST /v1/webhooks/tenants/{tenantId}/senders/{name}` (public, signed)      |

- **Who manages:** a user (a session or a user token; an API key is a 401) with
  `Access.manageClients`, in the tenant they act in (a sender is a system, as an API
  client is). Registering and rotating return the `whsec_…` secret, this once, and
  want a recent sign-in (403 `reauthentication_required`). Every change is audited
  (`webhookSender.created`, `.updated`, `.secret-rotated`, `.deleted`); an entry
  never carries a secret. `name` is lower-case letters, digits and hyphens, unique
  per tenant; the answer's `path` is the sender's URL.
- **The tenant is in the URL, the wall finds the sender.** The sender is looked up
  inside the tenant the URL names (`incoming_webhook_senders` is a tenant table,
  [tenancy](tenancy.md)), so a sender of another tenant is invisible there even with
  the same name. `TenantSenderGuard` resolves it before the signature check and sets
  the request's tenant: the handler, its transactions and the inbox run in that
  tenant. An unknown or deactivated tenant, an unknown or disabled sender, another
  tenant's secret and a bad, tampered or stale signature (5 minutes) are all the same
  401, so nothing says which exists.
- **Signatures:** Standard Webhooks (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`) with the sender's secret, or its previous one while the grace
  period of a rotation lasts. `TenantSenderScheme` plugs into the package's receiver
  (`tenant-senders`), so the tolerance, the deduplication of a redelivered `webhook-id`
  (200, the handler not run again) and `processInTransaction()` are the package's; the
  signatures compare in constant time. The deduplication key is `<sender id>:<webhook-id>`
  (the `id` a handler sees), so two tenants' senders never share an id.
- **Secrets at rest:** sealed as the outgoing endpoints' are: `WEBHOOKS_ENCRYPTION_KEYS`,
  AES-256-GCM with the sender's id as additional data (a sealed secret copied to another
  row fails to open), the same `sealed.v1.…` format and keys (unset: stored as they are).
  Never in a list or a get, the audit log or a tenant export (`secret`, `previousSecret`
  are hidden from it). The package's `SecretCipher` isn't exported, so
  `incoming-sender-secrets.ts` implements the same format.
- **The body** is `{ "type": "…", "data": … }`. The `type` picks the handler a feature
  registered in its constructor with `IncomingEventHandlers.register(type, handler)`
  (the notes' `note.publish-requested` is the model; the handler gets
  `{ tenantId, sender, webhook }` and runs in the tenant). The answer is
  `{ received, duplicate, handled }`: a type nobody handles is acknowledged
  (`handled: false`) so the sender doesn't retry; a body that is not an event is a 400.
- **Not behind `WEBHOOKS=off`** (that switch is for the outgoing webhooks), like the
  deployment-wide senders.

**The incoming event catalog** is the counterpart of
`GET /v1/webhook-event-types` (the _outgoing_ events an endpoint receives): the
events a sender may _send in_. `GET /v1/webhook-incoming-event-types` lists, for
users with `Access.manageClients` (an API key is a 401), each registered type with
its `description`, `dataSchema` (JSON Schema of `data`), a complete `example` body
and the `delivery` semantics. A feature declares all of it once, next to its
handler: `IncomingEventHandlers.register(type, { description, dataSchema,
example, delivery }, handler)`. The receiver validates `data` with the same
`dataSchema` (a mismatch is a 400 `validation_failed`, paths under `data.`, before the
handler runs), and the catalog is generated from the registry, so neither drifts from
the handler. A type in the catalog is documentation, **not a permission**: the
signature of a registered sender is what lets it call, there is no per-sender
allowlist yet, and each handler authorizes its work in the sender's tenant. A type
nobody handles stays `200 { received: true, duplicate: false, handled: false }`.

A complete call, signed per Standard Webhooks with the sender's `whsec_…` secret:

```http
POST /v1/webhooks/tenants/{tenantId}/senders/crm
webhook-id: msg_2Lt…   webhook-timestamp: 1735689600   webhook-signature: v1,…
{ "type": "note.publish-requested", "data": { "noteId": "<note uuid>" } }
```

A sender that doesn't sign with an HMAC scheme keeps a route of its own:
SES's bounces and complaints arrive as SNS notifications, RSA-signed with
a certificate the message names, at `POST /v1/webhooks/mail/ses`
([deliverability.md](deliverability.md)).

## Ops

For users with the `Ops` permissions (a session or a user token):

| Need                              | Route                                                                  |
| --------------------------------- | ---------------------------------------------------------------------- |
| Outbox lag and dead letters       | `GET /v1/ops/outbox`                                                   |
| Every engine's events, live (SSE) | `GET /v1/ops/events`                                                   |
| Dead letters                      | `POST /v1/ops/dead-letters/requeue`, `POST /v1/ops/dead-letters/purge` |
| Queues                            | `GET /v1/ops/queues`, `POST /v1/ops/queues/{name}/retry-failed`        |

Every answer is typed: `apps/api/src/platform/ops/ops.schemas.ts` declares it
once, the routes send their answers through it (a `StandardSchemaSerializerInterceptor`
on the JSON routes, `opsEvent()` on the stream), and the OpenAPI document and
the typed client read the same schemas, so a frontend needs no hand-written
types. `POST …/retry-failed`, `…/requeue` and `…/purge` answer `{ retried }`,
`{ requeued }` and `{ purged }`.

`GET /v1/ops/events` sends one JSON `data` per message, a union by `source`
(`workflow`, `webhooks`, `outbox`, `idempotency`, `locks`, `mail`,
`resilience`), then by `type`, each with `at` (epoch ms). The resilience events'
own `source` (what a policy guards) is `origin`, so the tag stays the engine.
An event the schema doesn't know (an engine update added one) is logged and
left out of the stream, not sent loosely typed.

**What reaches the browser is masked.** An engine holds what it was given: an
error's message, a message's payload and headers, a job's failure reason. All
of it goes through the log-redaction registry first
([Log redaction](deployment.md#log-redaction)): a header or field named like a
secret (`Authorization`, `password`, `apiKey`…) becomes `[REDACTED]` at any
depth, the text patterns mask a credential inside a string, a text is cut at
1000 characters, and nesting, list length and object count are bounded. An
error is sent as `{ name, message }`: never a stack trace, and the frames of
one inside a text are dropped. This holds for the dead letters (`payload`,
`headers`, `lastError`, `history`), the stream and the queues' `reason`. It
costs nothing to extend: `logRedaction.declareFields()` protects the logs and
this API at once.

## Realtime

socket.io, namespace `/realtime` (`platform/realtime/`). Users connect with
their session cookie (or a token client's access token, `auth: { token }`),
API clients with their key. Anyone else is refused
at the handshake: `connect_error` with the message `unauthorized`, which
socket.io doesn't retry (`socket.active` is false; sign in, then
`socket.connect()`):

```ts
// A browser
io('https://api.example.com/realtime', {
  withCredentials: true,
  transports: ['websocket'],
});
// An API client
io('https://api.example.com/realtime', {
  auth: { token: 'sk_…' },
  transports: ['websocket'],
});

await socket.emitWithAck('whoami'); // { kind, id, tenantId, rooms }
```

Each connection joins its principal's room **in its tenant**
(`tenant:<tenantId>:principal:<user|client>:<id>`: the session's or the
key's tenant, [tenancy](tenancy.md)) before the client hears it's connected
(authentication runs in socket.io's middleware), so nothing sent to it from
that moment is missed. A user's connection also joins their account room
(`principal:user:<id>`), for what is the person's own in every tenant (a
security notification sent at sign-in, outside any tenant). A feature pushes
with `Realtime.toPrincipal(principal, event, data)`, after the change
committed: the room is the current context's tenant's (a request's, a job's
restored from its envelope), so an event of tenant A never reaches a socket
opened in tenant B, even the same person's; outside any tenant it goes to the
user's account room (an API client always has a tenant). A tenant switch
issues a new session: sockets opened before stay in the old tenant's room
until they reconnect. Each message runs in a CLS context with its
principal's tenant (`ClsInterceptor` on the gateway, set up in CoreModule:
gateways get no global middleware).
To tell a person something they can also read later (and get by mail), send
a [notification](notifications.md) instead: its `notification` event comes
through the same connection.
Every message is authenticated again. A browser socket also joins a private
room for its session; sign-out, session revocation, rotation and bulk sign-out
disconnect that session's sockets across API replicas through the Redis
adapter. A token client's socket joins one for its refresh family
(`token:<sid>`, the access token's `sid` claim, [auth.md](auth.md)): revoking
the family (`POST /v1/auth/token/revoke`, a reused refresh token, a
re-authentication, a password change or any other sign-out everywhere)
disconnects it the same way, and the handshake refuses an access token of a
revoked family, which would otherwise pass until it expires (asked again
once the socket is in its room, so a revocation in between is not missed;
families from before `sid`: [auth.md](auth.md)). A deactivated account,
membership or tenant, a SCIM deprovisioning and an account's deletion end
their sockets the same way, after the change commits. A process without a
socket server (the operator CLI, `pnpm ops`) ends them through
`@socket.io/redis-emitter` (`RealtimeEmitter`), on the channels the API
replicas' Redis adapter listens to. A failure of the server's own during
the handshake is `connect_error` `unavailable` (logged; the client never
sees its text). An API client's socket joins a private room for its key
(`key:<id>`, the key's public id, `sk_<id>_…`): revoking the key (`DELETE
/v1/access/clients/{id}/keys/{keyId}`, a rotation with `graceSeconds: 0`)
disconnects it the same way, after the commit, and the client's other keys'
sockets stay.

**A socket ends when its credential does.** socket.io has no expiry for a
connection's credential (its documented way is a timer per connection,
"Handling session expiration" in socket.io's how-to on sessions), so the
gateway keeps one per socket (`Realtime.schedule()`), cleared when the socket
disconnects (`handleDisconnect`):

- an access token's socket ends at the token's `exp`; the app refreshes its
  tokens and connects again with the new access token;
- an API key's socket asks for its key again once it is in its rooms (a
  revocation in between is not missed), then every 10 minutes
  (`KEY_RECHECK_MS`), and ends at the key's `expiresAt` when it has one, or
  once a check finds the key revoked, expired or its client or tenant
  deactivated. A key without an expiry stays connected while it works:
  what is reported (a revocation, the client's deletion, the tenant's
  deactivation) ends it at once; what is not (a rotation's grace period
  running out, `PATCH { active: false }`) at the next check.

The server ends these sockets itself (`io server disconnect`), which
socket.io's client does not retry: connect again (`socket.connect()`) with a
credential that works. A browser socket follows its session (sign-out,
revocation), not a timer.

### The event manifest

Every event the API pushes is declared once in `platform/realtime/realtime-events.ts`
(`REALTIME_EVENTS`: name, description, a Zod payload schema). `Realtime.toPrincipal()`
types its payload from it (an undeclared name still compiles, untyped, and is not in the
client). The OpenAPI document publishes the manifest as `x-realtime-events` (each payload
a `Realtime…Event` component), so `client:check` diffs it and oasdiff reports a removed
event or a changed payload like a changed response. The typed client's
`src/realtime-events.ts` (`RealtimeEventPayloads`) is generated from it by `pnpm
client:generate`; `RealtimeEvents` in `realtime.ts` is built on that map. Add an event:
declare it in the manifest, push it, run `pnpm client:generate`.

A feature declares its own events in its `<x>.feature.ts`: `realtimeEvents:
defineRealtimeEvents({ 'thumbnail.ready': defineRealtimeEvent('RealtimeThumbnailReadyEvent',
'A thumbnail is ready.', z.object({ fileKey: z.string() })) })`. They join the document,
the generated client and the check below. In development and tests
`Realtime.toPrincipal()` throws for an event no manifest declares and for a payload that
doesn't parse against its schema; production sends what it is given.

### Domain events

A domain event is declared once, for the channels that carry it
(`platform/events/domain-event.ts`, `defineDomainEvents()`), in the feature's
`events` (`defineFeature`):

```ts
export const NOTE_EVENTS = defineDomainEvents([
  {
    type: 'note.published',
    webhook: { description: 'A note was published.' }, // or `true`: an outgoing webhook type
    notification: { channels: { email: 'immediate', webhook: true }, data: z.object({ … }) }, // a notification type
    realtime: { id: 'RealtimeNotePublishedEvent', description: '…', payload: z.object({ … }) }, // a realtime event of the same name
  },
]);
```

`featureDeclarations` splits them into the platform's own options (`eventTypes`,
`notifications`, `realtimeEvents`), so nothing downstream changed: the separate lists on
`defineFeature` and `PlatformModule.forRoot` still work. A notification's `type` must be a
key of `i18n/en/notifications.json` (a compile error otherwise). A record's capabilities
declare theirs the same way: `events` brings `<item>.created`, `.updated`, `.deleted`
(`.restored`) as webhook types and comments bring the `<item>.commented` notification, so
`pnpm feature:add` and `pnpm feature:sync` (whose feature file declares only `record`) need
no event lines of their own.

### Record events

A record page reloads a panel when it hears of a change on it, instead of
polling (`RecordActivity`, `platform/realtime/record-activity.ts`):

| Event                        | When                                                                                                                            | Data                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `record.commented`           | a comment added, edited or removed                                                                                              | `{ subject, recordId, commentId, action }` (`added`, `edited`, `removed`)                  |
| `record.attachments.changed` | an attachment uploaded, removed, scanned clean, processed (an image's renditions are made, or it could not be), or a PDF issued | `{ subject, recordId, attachmentId, action }` (`added`, `removed`, `scanned`, `processed`) |

- **To whom:** the record's watchers (`…/{id}/watch`, the creator and
  commenters watch by default) and the one who made the change (their
  other tabs), in their room of the record's tenant, and only those who
  may read the record when it is sent (the feature's `canRead`, asked as
  each of them): a watcher who lost access hears nothing.
- **Ids only**, never the content: the page fetches the panel with its
  own permissions.
- After the commit, not awaited by the request; a failure is logged.
  `REALTIME=off`: nothing is sent, and no check runs.

Across instances, the Redis adapter fans events out. Long-polling needs one
replica per client: Caddy's `lb_replica` cookie keeps it there
(`caddy/Caddyfile`); `transports: ['websocket']` avoids polling altogether.

## Health

`GET /health` is readiness (database and Redis; 503 while shutting down),
`GET /health/live` is liveness. Neither has a version or a rate limit.
