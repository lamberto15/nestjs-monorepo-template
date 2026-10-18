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
`REALTIME=off`: no `/realtime` gateway; `Realtime` pushes do nothing.

Per API client, by design: the client is the package's tenant (`tenant` =
its id), so a client sees and receives only its own. There are no endpoints of
a whole tenant: what a webhook carries is what its client may read. The
client's own routes take its API key:

| Need | Route |
| --- | --- |
| Subscribe, list, read, change, remove | `POST/GET /v1/webhook-endpoints`, `GET/PATCH/DELETE /v1/webhook-endpoints/{id}` |
| A new secret (the old one keeps signing for 24 hours) | `POST /v1/webhook-endpoints/{id}/rotate-secret` |
| A test event to one endpoint | `POST /v1/webhook-endpoints/{id}/test` (202, the delivery) |
| Deliveries (paged) | `GET /v1/webhook-deliveries`, `GET /v1/webhook-deliveries/{id}` |
| Retry one, or every failed one since an outage | `POST /v1/webhook-deliveries/{id}/retry`, `POST /v1/webhook-deliveries/retry` |
| What may be subscribed to, by feature | `GET /v1/webhook-event-types` (an API key or a user) |

### Managed by an administrator

A signed-in user manages a chosen client's webhooks on its behalf, under
`/v1/access/clients/{clientId}/`: `webhook-endpoints…` and
`webhook-deliveries…`, the same routes as above
(`platform/webhooks/client-webhooks.controller.ts`; one
`WebhookManagementService` behind both doors). Each route wants:

- a user (a session or a user token; an API key is a 401) with
  `Access.manageClients` (never while impersonating), and API_CLIENTS on;
- a client of the caller's tenant (another tenant's is a 404) over which the
  caller has authority, as for rotating its key (403 `authority_required`);
- a recent sign-in to create an endpoint or rotate its secret: both return a
  secret (403 `reauthentication_required`, [auth](auth.md)).

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
  records' `events` declare theirs.
- **Test event:** the reserved `webhook.test` (`data`: `{ endpointId, test: true }`)
  goes to that endpoint alone, whatever it subscribed to, signed and retried
  as any delivery. Subscribing to it is a 400, as any unknown type.
- **The delivery log** pages by cursor with the list query of every list
  ([api-conventions](api-conventions.md)): `limit`, `cursor`, `count=true`,
  flat filters (`status`, `endpointId`, `type`, `attempts`, `createdAt` in
  ISO 8601), `filter`, `sort`, `fields`. Items show times in epoch
  milliseconds, as the package does. One delivery adds `durationMs` (every
  attempt together) and `lastRequest`: the headers of the latest attempt as
  sent (`webhook-id`, `webhook-timestamp`, `webhook-signature`, content type,
  user agent; never a secret). The recording transport
  (`recording.transport.ts`) writes them to `webhook_delivery_requests`
  before each attempt, around the package's own HTTP transport.
- **`description`:** `null` clears it on PATCH; an empty string is a 400.

- **Signatures:** Standard Webhooks (`webhook-id`, `webhook-timestamp`,
  `webhook-signature`), with the endpoint's `whsec_…` secret, shown once at
  creation and at rotation.
- **Retries:** 10 attempts with backoff, from 5 s growing to a 1 hour cap;
  an endpoint that fails every attempt for 5 days is switched off
  (`platform/webhooks/webhooks.config.ts`).
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
record; `data` is the record as `GET /<x>/{id}` shows it to that client.

From a feature, dispatch in the change's transaction, so the webhook goes out
if and only if the change commits (`features/notes/note-publisher.service.ts`):

```ts
await this.webhooks.dispatch(tx, { type: 'note.published', tenant: clientId, data });
```

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

A sender that doesn't sign with an HMAC scheme keeps a route of its own:
SES's bounces and complaints arrive as SNS notifications, RSA-signed with
a certificate the message names, at `POST /v1/webhooks/mail/ses`
([deliverability.md](deliverability.md)).

## Ops

For users with the `Ops` permissions (a session or a user token):

| Need | Route |
| --- | --- |
| Outbox lag and dead letters | `GET /v1/ops/outbox` |
| Every engine's events, live (SSE) | `GET /v1/ops/events` |
| Dead letters | `POST /v1/ops/dead-letters/requeue`, `POST /v1/ops/dead-letters/purge` |
| Queues | `GET /v1/ops/queues`, `POST /v1/ops/queues/{name}/retry-failed` |

## Realtime

socket.io, namespace `/realtime` (`platform/realtime/`). Users connect with
their session cookie, API clients with their key. Anyone else is refused
at the handshake: `connect_error` with the message `unauthorized`, which
socket.io doesn't retry (`socket.active` is false; sign in, then
`socket.connect()`):

```ts
// A browser
io('https://api.example.com/realtime', { withCredentials: true, transports: ['websocket'] });
// An API client
io('https://api.example.com/realtime', { auth: { token: 'sk_…' }, transports: ['websocket'] });

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
Every message is authenticated again, so a revoked session or key stops
working mid-connection.

Across instances, the Redis adapter fans events out. Long-polling needs one
replica per client: Caddy's `lb_replica` cookie keeps it there
(`caddy/Caddyfile`); `transports: ['websocket']` avoids polling altogether.

## Health

`GET /health` is readiness (database and Redis; 503 while shutting down),
`GET /health/live` is liveness. Neither has a version or a rate limit.
