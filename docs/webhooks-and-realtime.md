# Webhooks and realtime

How the API tells other systems and connected clients that something
happened, and how it accepts webhooks from others. Built on
`@nestjs/webhooks`, `@nestjs/outbox` and socket.io (`platform/`).

## Outgoing webhooks

Per API client: the client is the tenant (`tenant` = its id), so a client
sees and receives only its own. Every route takes the client's API key.

| Need | Route |
| --- | --- |
| Subscribe, list, read, change, remove | `POST/GET /v1/webhook-endpoints`, `GET/PATCH/DELETE /v1/webhook-endpoints/{id}` |
| A new secret (the old one keeps signing for 24 hours) | `POST /v1/webhook-endpoints/{id}/rotate-secret` |
| Deliveries | `GET /v1/webhook-deliveries`, `GET /v1/webhook-deliveries/{id}` |
| Retry one, or every failed one since an outage | `POST /v1/webhook-deliveries/{id}/retry`, `POST /v1/webhook-deliveries/retry` |

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
