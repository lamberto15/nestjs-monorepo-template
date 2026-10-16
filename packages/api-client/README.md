# @nestjs-monorepo-template/api-client

The typed client of this API, for web apps, mobile apps and scripts:

- **REST**: [openapi-fetch](https://openapi-ts.dev/openapi-fetch/) on types
  generated from the API's OpenAPI document (`src/schema.ts`, from
  `openapi.json`). Paths, parameters, bodies and answers are checked by
  TypeScript; nothing is generated at runtime.
- **Realtime**: socket.io (`/realtime`) with every event the API pushes typed.

No NestJS in it: it builds on its own (`pnpm --filter
@nestjs-monorepo-template/api-client build`, to `dist/`; `pnpm build` builds
it before whatever depends on it). `socket.io-client` is a peer dependency,
needed only for `createRealtime()`.

An app of this repository uses it through the workspace, unpublished:
`"@nestjs-monorepo-template/api-client": "workspace:*"` in its package.json
([adding a frontend app](../../docs/monorepo.md#adding-a-frontend-app)).
The API's own e2e tests do the same.

## Keeping it current

`openapi.json` and `src/schema.ts` are generated and committed: the contract.

```bash
pnpm client:generate   # (repository root) dump the document, generate the types
pnpm client:check      # fails when either is stale (CI)
```

The document is made without a server or database (NestJS's preview mode,
`apps/api/src/openapi-dump.ts`), with a fixed environment, so it is the same on every
machine. `apps/api/test/api-client.e2e-spec.ts` checks it equals what `/api-json`
serves.

## What the client does for you

| Convention ([api-conventions](../../docs/api-conventions.md)) | The client |
| --- | --- |
| Credentials | `credentials: 'include'` (session cookie), `{ apiKey }` or `{ token }` (`Authorization: Bearer`; a function for a token that renews) |
| Languages | `language` → `Accept-Language` (after the user's saved one), `lang` → `X-Lang` (before it) |
| Idempotency | every `POST` without an `Idempotency-Key` gets a fresh `crypto.randomUUID()` (routes that don't take one ignore it); the types make the header optional. To retry an operation safely, pass the same key yourself: `params: { header: { 'Idempotency-Key': key } }` |
| Errors (RFC 9457) | an answer that isn't 2xx or 304 is **thrown** as `ApiError { status, code, detail, errors?, requestId, problem }`; `error` of openapi-fetch's `{ data, error }` is never set. `unwrap(call)` gives the data |
| Cursor pagination | `api.pages(path, query)` and `api.items(path, query)`: async iterators that follow `nextCursor` |
| ETags | `etagOf(result)`; send it as `If-Match` on `PATCH`/`DELETE` (412 `precondition_failed` when it changed) or `If-None-Match` on a `GET`: `notModified(result)` is true on 304 |
| Filters | the flat ones (`status.in`, `title.contains`…) are typed query parameters; `filterParam({ and: [...] })` makes `?filter=`, `sortParam('-createdAt')` `?sort=` |

Node 20+ and every current browser have `fetch` and `crypto.randomUUID`;
React Native needs a `randomUUID` polyfill or `idempotencyKey: () => …`.

## A browser app (session cookie)

```ts
import { createApiClient, createRealtime, isApiError, unwrap } from '@nestjs-monorepo-template/api-client';

const api = createApiClient({
  baseUrl: 'https://api.example.com',
  credentials: 'include',            // its origin must be in the API's CORS_ORIGINS
  language: navigator.language,
});

await api.POST('/v1/auth/sign-in', { body: { email, password } });
try {
  const note = await unwrap(api.POST('/v1/notes', { body: { title: 'Hello', body: '' } }));
} catch (error) {
  if (isApiError(error) && error.code === 'validation_failed') {
    showFieldErrors(error.errors);    // [{ path, message }], in the user's language
  }
}

// Optimistic concurrency: read, then write only if nobody changed it.
const read = await api.GET('/v1/notes/{id}', { params: { path: { id } } });
await api.PATCH('/v1/notes/{id}', {
  params: { path: { id }, header: { 'If-Match': etagOf(read) } },
  body: { title: 'Renamed' },
});

const realtime = createRealtime({ url: 'https://api.example.com' }); // the cookie
```

## A Node script (API key)

```ts
import { createApiClient, filterParam } from '@nestjs-monorepo-template/api-client';

const api = createApiClient({
  baseUrl: process.env.API_URL!,
  credentials: { apiKey: process.env.API_KEY! },   // sk_<id>_<secret>
});

// Everything changed since the last sync, page after page.
for await (const note of api.items('/v1/notes', {
  limit: '200',
  sort: 'updatedAt',
  'updatedAt.gte': lastSync,
  filter: filterParam({ field: 'status', op: 'in', value: ['draft', 'published'] }),
})) {
  await save(note);
}
```

## A mobile app (user token)

```ts
const api = createApiClient({
  baseUrl: 'https://api.example.com',
  credentials: { token: () => tokens.current() },  // asked before every request
  lang: user.language,
});
const realtime = createRealtime({
  url: 'https://api.example.com',
  token: () => tokens.current(),                    // asked on every (re)connection
});
```

`tokens.current()` is yours: it returns the access token from `POST
/v1/auth/token`, renewed with `POST /v1/auth/token/refresh` before its 15
minutes are up.

## The bell icon

The count from the API once, then the events keep it current: no polling.

```ts
import { createRealtime, unwrap, watchNotifications } from '@nestjs-monorepo-template/api-client';

let unread = (await unwrap(api.GET('/v1/notifications/unread-count'))).unread;
let loadedAt = new Date().toISOString();
let items = (await unwrap(api.GET('/v1/notifications', { params: { query: { limit: 20 } } }))).items;

const realtime = createRealtime({ url: 'https://api.example.com' });
const stop = watchNotifications(realtime, {
  onUnread: (count) => (unread = count),            // after every change and delivery
  onItem: (item) => {
    items = [item, ...items];
    loadedAt = item.createdAt;
  },
  onRead: ({ id, readAt }) => (items = items.map((n) => (n.id === id ? { ...n, read: true, readAt } : n))),
  onReadAll: () => (items = items.map((n) => ({ ...n, read: true }))),
  onRemoved: (id) => (items = items.filter((n) => n.id !== id)),
});

// Opening the panel: mark what it shows as read (not what arrives meanwhile).
await api.POST('/v1/notifications/read-all', { body: { before: loadedAt } });

// Leaving the page
stop();
realtime.close();
```

In React, Vue or Svelte, put the setters of your state in the handlers and
call `stop()` on unmount. After a reconnection (`realtime.socket.on('connect', …)`),
read the count again: events sent while offline are not replayed.

## Realtime events

`RealtimeEvents` types each one; `realtime.on(event, handler)` returns the
function that removes it.

| Event | Payload |
| --- | --- |
| `notification` | a notification, as `GET /v1/notifications` lists it |
| `notification.read` | `{ id, readAt }` |
| `notifications.read-all` | `{ before, updated }` |
| `notification.removed` | `{ id }` |
| `notifications.unread-count` | `{ unread }` |
| `data.export-ready` | `{ id, name, rows, url }` |
| `data.import-finished` | `{ id, name, rows, imported, failed }` |
| `bulk.finished` | `{ id, name, action, done, failed }` (results: `GET /v1/bulk/{id}`) |
| `approval.assigned` | `{ id, subject, recordId, action, stage }`: a request waits for you (or someone you stand in for) |
| `approval.decided` | `{ id, status, round, stage, decision }`: a decision on a request you made or decide, or its end |

`await realtime.whoami()` says who the connection acts as. A feature that
pushes a new event (`Realtime.toPrincipal()`) adds it to `RealtimeEvents`
in `src/realtime.ts`.
