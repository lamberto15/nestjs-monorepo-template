# Background work

Anything slow or heavy leaves the request: the request answers at once (202
when the client should wait for a result), a **worker** does the work
(`APP_ROLE=worker`, or `all` in development). Pick the tool by what the work is:

| Work | Tool | Why |
| --- | --- | --- |
| A change must trigger something reliably (a webhook, an event) | **outbox** (`@nestjs/outbox`) | written in the change's transaction: it happens if and only if the change commits |
| A process over days (wait, then publish) | **workflow** (`@nestjs/workflows`) | durable steps, timers and signals that survive restarts and deploys |
| "This action needs approval": stages, approvers, reminders, escalation | **approvals** (`approvals.request()`, [approvals.md](approvals.md)) | declared once; one durable workflow per request, decisions under a row lock |
| Heavy or slow work on demand (exports, imports, images, reports) | **queue** (`@nestjs/bullmq`) | retries with backoff, on any worker, never in the request |
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
await this.queue.add('make', { fileKey }, { jobId: randomUUID() });

@Processor('thumbnails', { concurrency: 4 })
export class ThumbnailProcessor extends WorkerHost {
  async process(job: Job<{ fileKey: string }>) { … }
}
```

Producers work in every process; processors only run on workers (BullMQ's
manual registration). Defaults: 3 attempts with exponential backoff; finished
jobs kept a day, failed ones a week. `GET /v1/ops/queues` shows counts and
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
failure doesn't stop the others), so what it records lands in that
tenant's audit log: the recycle bin purge (`records.purged`), the audit
retention (`audit.pruned` per tenant, then a pass outside any tenant for
the account-level entries), the account deletion (a person's data in each
tenant they belonged to, then the account). `Tenancy.bypass(job, work)`
(`app.bypass_rls`) sweeps every tenant at once, for a whole-table delete
by age that records nothing per tenant; it runs only in a worker and
never inside a request. A job on global tables only (the mail events'
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
`SCHEDULER=off` leaves cron jobs out of a process. A Redis lock store (in
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
