# Automation rules

A tenant's own business rules, without code: when a record is created or
changed and matches some conditions, do a few things to it.
`apps/api/src/platform/automations/`; a feature opts in with the
`automation` capability (its `<item>.record.ts`, [adding a feature](adding-a-feature.md));
the notes example takes it (`features/notes/note-automation.ts`). The web
app's page is `/automations`.

```http
POST /v1/automation-rules
{ "name": "Tag urgent notes", "subject": "Note", "trigger": "created",
  "filters": { "title.contains": "urgent" },
  "actions": [{ "type": "addTag", "tagId": "…" }, { "type": "notify", "userIds": ["…"] }] }
```

| Route                                              | Does                                                                                   |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /v1/automation-rules`                         | the rules (cursor pages; `?status=`, `?subject=`, `?name.contains=`)                   |
| `GET /v1/automation-rules/subjects`                | the subjects that take rules, their fields, which ones `setField` may set, tags or not |
| `POST /v1/automation-rules`                        | a draft (201, audited `automation-rule.created`)                                       |
| `GET`, `PATCH`, `DELETE /v1/automation-rules/{id}` | one rule; `automation-rule.updated`, `automation-rule.deleted` (its runs go with it)   |
| `POST /v1/automation-rules/simulate`               | what a draft would do now, without doing it (below)                                    |
| `POST /v1/automation-rules/{id}/activate`          | it runs from now on, as you (`automation-rule.activated`)                              |
| `POST /v1/automation-rules/{id}/disable`           | it stops at once (`automation-rule.disabled`, reason `manual`)                         |
| `GET /v1/automation-rules/{id}/runs`               | what each run did, or why it failed (`?status=failed`, `?recordId=`), newest first     |

## A rule

- **Trigger:** `created` or `updated` on the subject; with `updated`, an
  optional `field`: only when that field's value changed.
- **Conditions** (`filters`): the subject's list filters, exactly as its
  list route takes them (`{ "status": "draft", "title.contains": "x" }`,
  `filter` for and/or groups: [api-conventions](api-conventions.md)).
  Paging, sorting and `fields` are refused (400 `filters.<key>`). A
  condition on a field your permissions hide is a 403 `field_forbidden`,
  as on the list.
- **Actions** (at most 5), a closed set the platform does itself, never
  code or a URL of the rule's own:

  | `type`     | Does                                                                                                                                                    |
  | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `setField` | `{ field, value }`: changes the record as its `PATCH` route would (a plain field: text, number, boolean, choice; never a reference, money or JSON)      |
  | `addTag`   | `{ tagId }`: adds a tag of the subject (`GET /v1/tags`)                                                                                                 |
  | `notify`   | `{ userIds }` (at most 10): the `automation.notified` notification, to those of them who may read the record                                            |
  | `webhook`  | `{ clientId }`: the `automation.matched` webhook to that API client's endpoints, `{ subject, record }`, the record as the client may read it, if it may |

- **Versions:** a change of the trigger, conditions or actions is a new
  `version`, and an active rule becomes a `draft` again: it takes effect
  only once activated (and so, in the web app, simulated) again. A name
  change keeps it active. Each run records the version it ran.

## Who it runs as

The rule runs as **the user who activated it** (`owner`), with their
permissions as they are at each run, as a scheduled report runs as its
owner ([reports](reports.md)). Every run checks again, as them: the record
matches among those they may read (their read filter, in SQL), the
conditions use no field hidden from them, `setField` and `addTag` need
`update` on that record and no field-level refusal, `notify` tells only
recipients who may read it, `webhook` sends only to a client that may.
What the actions change is audited as the owner, as their own route would
audit it (the record's update, `tags.changed`).

- **Permissions:** `AutomationRule.read` (see rules and runs) and
  `AutomationRule.manage` (create, change, simulate, activate, disable,
  delete); granted by no seed role, so administrators hold them and choose
  whom else ([permissions](permissions.md)). Users only, and `manage` never
  while impersonating: a rule must not run as someone who never chose it.
- **The runner** is `system:automations` ([permissions](permissions.md#the-system-principal)):
  it records the runs and disables a rule (`automation-rule.disabled`,
  actor `system:automations`); it never does a rule's actions itself.

## How it runs

1. A feature's create or update calls `AutomationsService.changed()` in its
   transaction (RecordLifecycle does for a declared record; `NotesService`
   for notes). It reads the subject's active rules for that trigger (the
   partial index `automation_rules_active_idx`) and, for each one whose
   watched field changed, adds an outbox message (`automations.run`): the
   run happens if and only if the write commits ([background-work](background-work.md)).
2. On a worker, the outbox relay hands each message to
   `AutomationRunHandler`, in the message's tenant. It reads the rule as it
   is now: disabled, deleted or a newer version since, it does nothing.
3. The evaluator (`evaluate()`) matches the record against the conditions
   as the owner; `plan()` checks each action. Any action refused fails the
   whole run: nothing is half done. Otherwise every action and the run's
   record commit in one transaction with the consumer's inbox record, so a
   redelivery does nothing twice.

**Bounds:**

| Bound         | Value                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------- |
| Loops         | the writes a rule's actions make trigger no rule, the same or another (`AUTOMATING`): depth 1 |
| Active rules  | at most 20 per tenant (400 on activate): a write queues at most 20 runs                       |
| Actions       | at most 5 per rule; `notify` at most 10 people                                                |
| Runs per hour | 100 per rule: past it the rule is disabled (`run_limit`)                                      |
| Failures      | 5 failed runs in a row disable it (`failing`)                                                 |
| Owner         | no longer an active member of the tenant: disabled (`owner_inactive`)                         |
| Batch writes  | imports and bulk changes (`createMany`, `updateMany`) trigger no rule                         |

**Failures are visible:** a refused run is kept (`status: failed`, `error`
such as `notify: no_recipient`, and each action's `allowed` and `reason`);
the rule shows `lastStatus`, `lastRunAt` and `failures` in a row, and
`disabledReason` once disabled. An error that may pass (the database away)
is not a failure: the outbox retries the message, then keeps it as a dead
letter (`GET /v1/ops/outbox`).

## Simulating a rule

`POST /v1/automation-rules/simulate` takes a rule's definition (a draft, or
a stored rule's) and answers what it would do now, **without doing any of
it**: no write, no notification, no webhook, no run recorded.

```json
{
  "subject": "Note",
  "trigger": "created",
  "filters": { "title.contains": "urgent" },
  "actions": [{ "type": "setField", "field": "title", "value": "Urgent" }],
  "limit": 20
}
```

- **The same evaluator** as a run: `evaluate()` and `plan()`, without
  `apply`, run as you (the owner the rule would have once you activate it).
  `test/automations.e2e-spec.ts` checks that the actions a run records are
  the ones the simulation showed.
- **Visibility:** only records you may read; a condition on a field hidden
  from you is a 403; a record's `title` is shown only when your
  permissions show it.
- **Sample limit, disclosed:** the most recently changed records that
  match, at most `limit` (default 20, at most 50), or only the
  `recordIds` named (up to 50). `matched` counts what is shown, and
  `truncated: true` says the limit was reached and more may match.
  `triggerSimulated: false` with a `field` trigger: no change is replayed,
  records are checked as they are now, as if that field had just changed.

## Open questions

- Runs are kept until their rule is deleted; a retention of runs is not
  decided.
- Rules on custom fields (`custom.<key>` conditions, setting a custom
  value) are not supported yet: the conditions are the subject's declared
  list.
- The active-rule limit is checked without a lock: two activations at the
  same moment may pass it by one.
