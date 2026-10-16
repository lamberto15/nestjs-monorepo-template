# API usage and quotas

What each API client calls, per UTC day and route, and an optional daily
quota per client. `apps/api/src/platform/usage/`; nothing for a feature to declare:
every route is metered.

| Route | Does |
| --- | --- |
| `GET /v1/access/clients/{id}/usage?from=&to=` | `Access.manageClients`; 404 for an unknown client |
| `GET /v1/usage?from=&to=` | the calling API client's own; a user gets a 403 |
| `PATCH /v1/access/clients/{id} { dailyQuota }` | `Access.manageClients`; an integer ≥ 1, `null` removes it; audited as `client.quota-changed`; clients' responses show `dailyQuota` |

Both usage routes answer `{ from, to, days: [{ day, total, routes: { "GET /v1/notes/{id}": 2, … } }], total }`:
UTC days (`yyyy-mm-dd`), both ends included, every day of the range (zeros
too), oldest first. Default: the last 30 days, today included; at most 400
days (400 `validation_failed` otherwise, or when `from` is after `to`).

- **Counting** (`UsageInterceptor`, global): a request authenticated with an
  API key, once its response is done (or the caller hung up), `HINCRBY`s the Redis hash
  `<REDIS_PREFIX>:usage:<clientId>:<yyyy-mm-dd>` (field: `<METHOD> <route pattern>`,
  never the URL, and `_total`), in one pipeline, the TTL (3 days) set by the
  day's first count. Fire and forget: an error is logged, the request never
  fails. Users, guests, `/health` and `/api` are not counted; neither are
  requests refused before the handler (401, 403, 429).
- **Quota**: a client with a `dailyQuota` gets `X-Quota-Limit` and
  `X-Quota-Remaining` on every response; once today's total reaches it, 429
  `quota_exceeded` with `X-Quota-Remaining: 0`, `X-Quota-Reset` (seconds to
  midnight UTC) and `Retry-After`. The quota comes with the principal (the
  key's lookup loads the client row), so a change applies on the next
  request. The quota is exact: a request takes its place in the total on
  entry, atomically, so parallel requests never pass it; a refused one is
  given back. Redis unreachable (or slower than 500 ms) lets requests
  through, logged.
  Metering runs before idempotency: a replayed `Idempotency-Key` response
  is counted, and past the quota answers 429 too; a quota 429 is never
  stored, so the retry after the reset runs.
- **Roll-up** (`UsageRollupJob`, cron `usage-rollup`, 00:20 UTC, one
  instance): copies every day before today still in Redis into `api_usage`
  (one row per client, day and route; a rerun overwrites), deletes those
  counters, then the rows older than `USAGE_RETENTION_DAYS` (400).
  `run(day)` rolls up one day (today's counters are copied and kept).
  Reports merge the rows with the live counters (the larger count per route
  wins), so today, and a day not rolled up yet, are always included.
