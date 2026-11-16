# AI helper

`platform/ai`: ask a model about a record (summarize it, classify it) and get
a structured answer. Off unless `ANTHROPIC_API_KEY` is set, and then off for a
tenant until an administrator sets `ai.enabled`. The real API is never called
in tests: they use `FakeModel` from `@nestjs/ai/testing`.

A client learns whether it is on without clicking: `GET /v1/features` `ai` is
true with a provider, and `ai.enabled` is a public setting, so every signed-in
user reads it in `GET /v1/settings`. The web app hides its panel on either.

## How it works

| Route                                           | What                                                                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/ai/runs` `{ source, recordId, task }` | 202 `{ id, status: 'queued' }`; `task` is `summarize` or `classify`; throttled to 20 a minute per user                                                                               |
| `GET /v1/ai/runs/{id}`                          | the run: `status` (`queued` → `running` → `completed` or `failed`), `model`, `promptVersion`, tokens, `cached`, `error`, and `output` while it is kept; only the principal who asked |

- **On a queue worker, never in the request.** The `ai` queue
  (`AiProcessor`, two at a time per worker) restores the tenant and the
  requester, checks the requester is still active, and calls the model.
  `lockDuration` is 3 minutes, longer than the longest call (`AI_TIMEOUT_MS`
  is at most 2 minutes), so a slow call is never seen as stalled and paid for
  twice. The queue retries a transient failure (`AI_ATTEMPTS` tries, backoff
  from 2 s); a failure that is not
  retryable (a 400, a refusal) fails the run at once, and the package's own
  retries are off, so two layers never retry the same call.
- **The requester hears** `ai.ready { id, subject, recordId, task }` or
  `ai.failed { id, subject, recordId, error }` over realtime.
- **Features register a source.** An `AiSource` (`ai.registry.ts`, like a
  `DocumentSource`) names a kind of record, says who may use the helper on it
  (`canUse`), and gives the record's fields **as the requester may read them**
  (`content`: policy `read`, then `AccessService.redact`). Only that reaches
  the provider; a field the caller can't read is never sent. `NoteAi` is the
  example (`features/notes/note-ai.ts`), registered in the notes module.
- **Audited:** `ai.requested`, `ai.completed`, `ai.failed`, with source,
  record, task, model, prompt version and tokens, never prompt or output.

## Model

`AiModule` from [`@nestjs/ai`](https://docs.nestjs.com/ai/overview) is
registered in `PlatformModule` with two Anthropic models from
`@ai-sdk/anthropic` (`ai-models.ts`): `default` (`AI_MODEL`) and `cheap`
(`AI_MODEL_CHEAP`), pinned ids, never `latest`. `AiService` here calls the
package's `generateObject()` with the task's Zod schema: the model is sent its
JSON Schema and answers as structured output. The package's retries are off
and each attempt is limited by `AI_TIMEOUT_MS`; `AI_BASE_URL` is the host of
an Anthropic-compatible endpoint (`/v1` is added). The helper is on while
`ANTHROPIC_API_KEY` is set (`aiEnabled()`); unset, nothing is sent and
requests get 503 `ai_unavailable`. Tokens come from the call's `usage`.
Failures: a retryable provider error (429, 5xx, network, timeout) is
retried by the queue; a non-retryable one fails the run as `rejected`. The
package's own schema check is bypassed on purpose: an answer that does not
match its schema carries no token count, and the run must still count the
tokens it spent, so the run validates the answer itself.
A project that wants another provider changes `aiModuleOptions()`.

## Prompt injection

The record's content is data: it is framed between `<record>` tags with `<`
escaped so it can't close the tag, and the system prompt says to ignore
instructions inside it. The real mitigation is structural: the model is sent only
the answer schema, and its answer is validated again with the task's **Zod
schema** (`ai-tasks.ts`), and what fails is a failed run (`AI_ERRORS.invalid`,
not retried, tokens still counted). The output is only ever shown to the
requester; nothing the model says is executed or followed.

## Versions, cache, quota

- **Model and prompt versions.** Every task pins a `version` (bump it with any
  change to its prompt or schema). `ai_runs` stores the model id that answered
  and the prompt version on every run.
- **Cache.** An identical prompt is answered from Redis for
  `AI_CACHE_TTL_SECONDS` (0: never). The key is
  `tenant:<id>:ai:cache:` plus a hash of task, prompt version, model and the
  exact prompt, so tenants never share an answer and neither do callers who
  can read different fields. A cached run costs no tokens (`cached: true`).
- **Quota.** `AI_TENANT_DAILY_TOKENS` (default 500 000; 0 is no cap) is the
  tenant's input plus output tokens per UTC day, summed from `ai_runs`; past
  it, 429 `ai_quota_exceeded`. A check at request time: runs already queued
  may overshoot it by their own cost.
- **Other errors:** 503 `ai_unavailable` (no key), 403 `ai_disabled`
  (tenant has not opted in), 409 `ai_pending` (your run of this record and
  task is open), 404 for an unknown source or a record you can't read.

## Personal data

A record's fields are personal data once they are in a prompt. The platform
stores **no prompt and no output**: `ai_runs` is a usage record (ids, model,
prompt version, tokens, status). The output lives in the queue's result for an
hour (`OUTPUT_KEPT_SECONDS`), in the tenant's Redis, readable by the requester
only, and is removed with the tenant's jobs (the `ai` queue is in
`PLATFORM_QUEUES`). The cache holds the output for `AI_CACHE_TTL_SECONDS`.
Account deletion anonymizes `requested_by` and the data export lists the
user's runs (`PersonalDataSource`). `prompt`, `systemPrompt` and
`completion` are declared to log redaction. The encrypted-column registry
([encryption.md](encryption.md)) is not used here: nothing of the prompt or
output is stored in a column.

The prompt is sent to Anthropic: say so in your privacy notice, and keep the
opt-in (`ai.enabled`) off until a tenant has agreed.

## Adding a task or a source

- **Task:** add it to `AI_TASKS` in `ai-tasks.ts` with its `version`, tier,
  prompt and Zod schema; it appears in the request's `task` enum.
- **Source:** implement `AiSource` for your feature and register it from the
  constructor (`registry.register(this)`), as `NoteAi` does. Apply field-level
  access before returning fields.
