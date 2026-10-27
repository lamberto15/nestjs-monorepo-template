# Background work

Anything slow or heavy leaves the request: the request answers at once (202
when the client should wait for a result), a **worker** does the work
(`APP_ROLE=worker`, or `all` in development). Pick the tool by what the work is:

| Work | Tool | Why |
| --- | --- | --- |
| A change must trigger something reliably (a webhook, an event) | **outbox** (`@nestjs/outbox`) | written in the change's transaction: it happens if and only if the change commits |
| A process over days (wait, then publish) | **workflow** (`@nestjs/workflows`) | durable steps, timers and signals that survive restarts and deploys |
| "This action needs approval": stages, approvers, reminders, escalation | **approvals** (`approvals.request()`, [approvals.md](approvals.md)) | declared once; one durable workflow per request, decisions under a row lock |
| Heavy or slow work on demand (exports, imports, images, reports) | **queue** (`@nestjs/bullmq`) | retries with backoff, on any worker, never in the request; images: the thumbnails and previews of attachments ([attachments.md](attachments.md#image-renditions)) |
| A PDF of a record (an invoice, a note) | **documents** (`DocumentsService.request()`, [documents.md](documents.md)) | a queue job renders it in Gotenberg; issued as a locked attachment of the record |
| Email | **mail queue** (`MailQueue.send()`) | rendered in the request, sent by a worker, retried for hours |
| Every night at 03:00 | **cron** (`@Cron` + `@OnOneInstance`) | runs on one instance, never overlapping (`@WithoutOverlapping`) |
| An export every Monday at 08:00, mailed to a team | **scheduled reports** ([reports.md](reports.md)) | the hourly `ReportRunnerJob` starts it as its owner; the mail follows the file |
| Tell a connected client | **realtime** (`Realtime.toPrincipal()`) | socket.io, fanned out through Redis to every instance |
| Tell a person (or a client system) something they can read later | **notifications** (`NotificationsService.notify()`, [notifications.md](notifications.md)) | stored, then realtime, mail or webhook as they prefer, through the outbox |

## Queues

```ts
// Declare it: PlatformModule.forRoot({ queues: ['thumbnails'] })
constructor(@InjectQueue('thumbnails') private readonly queue: Queue) {}
await this.queue.add('make', withTenant({ fileKey }), { jobId: randomUUID() });

@Processor('thumbnails', { concurrency: 4 })
export class ThumbnailProcessor extends TenantWorkerHost<{ fileKey: string }> {
  async handle(job: Job<{ fileKey: string } & TenantEnvelope>) { … }
}
```

A job carries its tenant (`TenantEnvelope`, `core/tenancy/tenant-job.ts`):
`withTenant(data)` fills it from the scope, and `TenantWorkerHost` restores it
before `handle()`. A payload without it is refused. A job that acts for a
queued principal calls `stillActive()` first (`platform/queues/still-active.ts`):
a user must still be an active member of the job's tenant, an API client's
tenant must still be active ([tenancy](tenancy.md), "Async carries the tenant by type").

Producers work in every process; processors only run on workers (BullMQ's
manual registration). **Queues fail fast, workers wait** (BullMQ's
[production guide](https://docs.bullmq.io/guide/going-to-production)):
the queues' connection has no offline queue and `maxRetriesPerRequest: 1`
(`producerRedisOptions()`), so `queue.add()` with Redis unreachable rejects
at once instead of being buffered and sent when Redis returns (an abandoned
request leaves no job behind); a worker's connections keep
`maxRetriesPerRequest: null` and wait out an outage (`QueueWorker`). The
callers' own retry (the outbox relay, a job's attempts, the user's retry)
absorbs the rejection. An add already on the wire when a caller gives up
(`abortable()`) may still land: give it a deterministic `jobId`. Defaults: 3 attempts with exponential backoff; finished
jobs kept a day, failed ones a week. Each queue's concurrency (jobs at once per worker) is
`QUEUE_CONCURRENCY_<QUEUE>`, set on the running worker by `QueueWorkers`
(BullMQ's settable `worker.concurrency`; the `@Processor` value is the
fallback): [configuration](configuration.md). `GET /v1/ops/queues` shows counts and
failures; `POST /v1/ops/queues/{name}/retry-failed` runs them again. The
ops API (`/v1/ops`) sees every tenant's work: it answers only the
deployment's operators (the operator tenant, `@OperatorOnly()`,
[tenancy](tenancy.md)), on top of `Ops.view` / `Ops.manage`.

## Mail

```ts
await this.mailQueue.send(WelcomeMail, {
  to: { name: user.name, address: user.email },
  data: { … },
  locale: user.locale ?? undefined,
});
```

A mail class implements `Mailable` (subject from the i18n catalog, template
`apps/api/src/mail/templates/<name>[.<locale>].html`, wrapped in `layout.html`).
`MAIL_TRANSPORT`: `file` and `log` in development (or Mailpit through
`smtp`), `smtp`, `resend`, `postmark`, `sendgrid`, `ses` in production.
The worker asks the **suppression list** before sending
([deliverability.md](deliverability.md)): addresses that bounced or
complained are left out (`@EssentialMail()` on a class the person asked
for, such as the password reset, still reaches one that complained), and
the job's result says who was skipped and why.

The job id is the mail's idempotency key: adding a job whose id already
exists is a no-op, but only while that job is still in Redis. Mail therefore
keeps its finished jobs **7 days (at most 50,000)**, not the default day /
1,000 (`MAIL_JOB_OPTIONS`), so a dead letter replayed within a week doesn't
send twice. The price is Redis memory: a job holds the rendered mail (a few
KB), tens of MB at the cap. A replay later than that, or after more than
50,000 newer mails, can send again; a durable idempotency record per mail
would close that at a database write per mail, which a replay that comes
within days doesn't justify. Raise the age or count in `MAIL_JOB_OPTIONS`
(`core/queues/queues.ts`) if your replays come later.

## Cron jobs and locks

```ts
@Cron('15 3 * * *', { timeZone: process.env.APP_TIMEZONE || 'UTC' })
@OnOneInstance({ key: 'iam:audit-retention' })
@WithoutOverlapping()
run() {
  return this.system.run(AUDIT_RETENTION_JOB, async (system, tx) => { … });
}
```

Every job without a user runs as **the system principal** of a declared
job (`defineSystemJob()`, [permissions](permissions.md#the-system-principal)):
cron jobs, the outbox relay's notification delivery
(`system:notification-delivery`), and workflow steps (the approvals
workflow as `system:approvals`, the notes' publication as
`system:note-publication`). `SystemContext.run()` gives the work a CLS
context and a transaction (`{ transaction: false }` for a batch job that
commits its own); its audit entries name the job (`system:audit-retention`),
and it may do what the job declares, nothing more. Queue jobs (exports,
imports, bulk) are different: they act for the user or client that asked
(their payload carries it), never the system.

**Tenants** ([tenancy](tenancy.md)): a cron job starts in no tenant, and
tenant tables are out of its reach until it picks one. A job that acts on
tenants' data walks them, `Tenancy.forEachTenant(job, work)` (each tenant
in its own scope and transactions, logged with the tenant; one tenant's
failure doesn't stop the others, nor the job's pass outside any tenant: the
failures are reported together at the end, `TenantRunsFailed`; retention
sweeps pass `{ includeInactive: true }`, so a deactivated tenant's old rows
still go), so what it records lands in that
tenant's audit log: the recycle bin purge (`records.purged`), the audit
retention (`audit.pruned` per tenant, then a pass outside any tenant for
the account-level entries), the account deletion (a person's data in each
tenant they belonged to, then the account). The unverified sign-ups' tenants'
sweep (`SignUpTenantSweepJob`) works on global tables only, outside any
tenant, and audits each deletion there ([tenancy](tenancy.md), "Tenants made
at sign-up"), and so does the tenant deletion (`TenantDeletionJob`: a
tenant's files, jobs and workflows, then its row: [tenancy](tenancy.md),
"Deleting a tenant"). `Tenancy.bypass(job, work)`
sweeps every tenant at once, as the maintenance role (`BYPASSRLS`,
`DATABASE_MAINTENANCE_URL`, workers only: [tenancy](tenancy.md), "The
bypass"), for a whole-table delete by age that records nothing per tenant;
it runs only in a worker and never inside a request. A job on global tables only (the mail events'
retention, the exchange rates) says so: `system.run(job, work, { tenantId: null })`.

**Workflows carry their tenant by type**: an instance's input and every
signal sent to it have `tenantId` (`TenantEnvelope`,
`core/tenancy/tenant-job.ts`), and each step runs in it
(`system.run(job, work, { tenantId: input.tenantId })`, or
`inTenantOf(input, work)` for a step without a system principal). The
approvals workflow starts with `{ requestId, tenantId }`, the notes'
publication with `{ noteId, tenantId }`; both are taken from the row the
transaction that starts them wrote.

Locks live in PostgreSQL (`DrizzleLockStore`: fencing tokens, the database's
clock). `Locks.withLock(key, fn)` for your own critical sections.
`SCHEDULER=off` leaves cron jobs out of a process. The deployment switches
([configuration.md](configuration.md#deployment-switches)) leave a module's
own workers and jobs out: `WEBHOOKS=off` the webhook delivery worker (the
outbox relay stays: notification delivery uses it), `REPORTS=off` the report
runner, `USAGE=off` the usage roll-up, `REALTIME=off` the gateway. A Redis lock store (in
the NestJS locks docs) is one provider away, for locks on hot request paths.

## Calling other services

`HttpClientModule.register({ name, baseUrl })` in a feature (defaults: a
user-agent, 10 s timeout, retries of idempotent requests), and a resilience
preset per dependency (`PlatformModule.forRoot({ resiliencePresets })`):
`@Resilience('carrier')` on a route, `resilience.preset('carrier')` in a
service: timeouts, retries, circuit breakers, bulkheads.

## Observing

`GET /v1/ops/events` streams the engines' events (workflows, webhooks, the
outbox, idempotency, locks, mail, resilience) as Server-Sent Events;
`GET /v1/ops/outbox` shows lag and dead letters; `GET /metrics` gives
Prometheus the queue depths, outbox lag and HTTP timings
(`apps/api/src/core/metrics/`, [deployment](deployment.md#metrics)). With `OBSERVE_APP_KEY` and
`OBSERVE_APP_SECRET`, NestJS Observe traces requests, jobs and outgoing calls.
