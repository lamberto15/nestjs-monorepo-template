# Approvals

"This action on this record needs approval": declared once by the
feature, and the platform runs the whole process: who decides, in which
stages, by when, reminders and escalation, delegation while someone is
away, the inbox, notifications, webhooks, realtime, the audit log, and
then the feature's own effect ("publish the note") once approved. The
code is in `apps/api/src/platform/approvals/`; publishing a note is the
worked example (`features/notes/note-approvals.ts`).

## Concepts

- **An approvable action** (`Note.publish`): a subject, an action on it, the
  proposed change a request carries (`payload`, a Zod schema), a default
  **policy**, and optionally a setting that switches it on.
- **A policy**: an optional condition (`when`: is approval needed at all?)
  and **stages** in order. Each stage names its approvers with **approver
  rules**, completes by its **mode** (`any`, `all`, `quorum`), and may have
  a reminder, a deadline and an escalation.
- **A request**: one per action asked for on a record, with a copy of the
  policy it runs under (`policyVersion`). Status: `pending`,
  `changes_requested` (both open), `approved`, `rejected`, `cancelled`,
  `expired`, `failed` (a stage found too few approvers, or the record
  changed before the outcome was applied).
- **Assignments**: the approvers of a stage, resolved **when the stage
  starts** and stored, so a role taken away later doesn't change who
  decides a running stage (the next stage resolves again). The requester
  is never an approver: no self-approval. Only active members of the
  request's tenant are approvers, or delegates: a rule naming a user of
  another tenant names nobody here. Requests, policies and delegations are
  each tenant's own.
- **The engine**: one durable workflow per request (`@nestjs/workflows`,
  instance `approval-<id>`, input `{ requestId, tenantId }`: every step
  runs in the request's tenant, [tenancy](tenancy.md)). People's decisions happen in their HTTP
  requests, in one transaction under the request's row lock, where the
  stage's mode says whether the stage is decided; the workflow is told by a
  signal. The workflow owns time and effects: it starts each stage, reminds,
  escalates, expires, and runs the feature's outcome handler, each in a
  step. It survives restarts and deploys.

## Declaring an action

```ts
// features/notes/note-approvals.ts
export const NOTE_PUBLISH_APPROVAL = defineApproval({
  subject: 'Note',
  action: 'publish',
  label: 'Publish a note',
  payload: z.object({ title: z.string().max(200) }),
  setting: NOTE_PUBLISH_APPROVAL_FLAG, // notes.publishApproval: off by default, scopes ['global', 'team']
  policy: {
    stages: [{ name: 'Editor review', approvers: [{ type: 'role', role: 'editor' }], mode: { type: 'any' } }],
  },
});

@Injectable()
export class NotePublishApproval implements ApprovalHandler<{ title: string }> {
  readonly approval = NOTE_PUBLISH_APPROVAL;
  constructor(registry: ApprovalsRegistry, private readonly notes: NotesService, private readonly publisher: NotePublisher) {
    registry.handle(this);
  }
  record(id: string) { return this.notes.findOne(id); }              // for the permission rule and conditions
  async describe(id: string, { title }) { return { title, link: `/notes/${id}` }; }
  async payload(id: string) { return { title: (await this.notes.findOne(id)).title }; } // optional: read from the record
  async fingerprint(id: string) { /* a hash of the note's content */ }                   // optional: checked before applying
  async onApproved({ request, actor }) { await this.publisher.publish(request.recordId, actor); } // actor: system:approvals (the workflow); a person for a request they concluded (abandon → onFailed)
  // onRejected, onChangesRequested, onCancelled, onExpired, onFailed: optional
}

// app.module.ts
PlatformModule.forRoot({ …, approvals: [NOTE_PUBLISH_APPROVAL] })
```

- The handlers run as **workflow steps, at least once**: make each
  idempotent (do nothing when the effect is already there; pass
  `idempotencyKey` to an external system).
- At startup, every declared action needs its handler and a default policy
  the registered types accept, or the app refuses to start. So does an
  action whose `setting` takes the `user` scope (`flag()`'s default): a
  requester could switch their own approval off. Declare it with
  `scopes: ['global', 'team']`.
- **What is approved is what is applied**: `payload()` reads the proposed
  change from the record, so callers can't send one (400); `fingerprint()`
  is taken with the request and compared before `onApproved`; a record
  that changed meanwhile isn't applied (the request ends as `failed`,
  `record_changed`, and `onFailed` runs). Both optional; use them when the
  record is the change.

## Asking for approval (the feature's service)

```ts
const result = await this.approvals.request(principal /* or 'user:<id>' */, {
  subject: 'Note', recordId: note.id, action: 'publish', // payload: { … } when the handler has no payload()
  comment: 'Ready for review', idempotencyKey, // optional: a retry returns the same request
});
if (!result.required) { /* no approval needed: do it now */ }

await this.approvals.assertNotPending('Note', note.id); // in a write's transaction: 409 approval_pending while pending, or approved and not applied yet
await this.approvals.withdraw(tx, by, 'Note', note.id);  // deleting the record: its open requests are cancelled
await this.approvals.pending('Note', note.id);           // the record's open requests
```

`request()` answers `{ required: false }` when the policy is off
(`enabled: false`), the action's setting is off for the requester, or
`when` doesn't hold. Otherwise it creates the request and its workflow in
one transaction (the audit entry, the timeline, the `approval.requested`
webhook with it); the workflow assigns the first stage. It refuses with
409 `approval_pending` while the same action on the record has an open
request, and 422 `approval_no_approvers` when a stage would find too few
approvers for its mode (checked for every stage up front, so nobody waits
on a request that can't be decided). A stage that later finds too few
(roles changed since) ends the request as `failed` (`outcomeReason:
no_approvers`), and the requester is told.

**The record's lock.** `request()` (and a resubmission) reads the record
(its payload, its fingerprint) and creates the request under an advisory
lock of the record (`subject:recordId`); `assertNotPending()` takes the
same lock. So a request and a write to the record take turns: the write
waits and is then refused, or the request waits and then proposes what
the write saved. Call `assertNotPending()` inside the write's
transaction: outside one it throws (a programming error), since its lock
would end at once and protect nothing. While a request's own outcome
handler runs (`onApproved`…, flagged in the call's CLS context), that
request doesn't block: a handler may apply the change through the
feature's normal, guarded write path.

## Approver rules

| Rule | Who | Example |
| --- | --- | --- |
| `role` | users holding a role (by key or id) | `{ "type": "role", "role": "editor" }` |
| `teamRole` | users holding a role in the requester's team; with `nearest` (default) the nearest unit above that has someone other than the requester, so a lead's own request goes to the lead above; `levelsUp: 1` starts at the parent unit ("the next level") | `{ "type": "teamRole", "role": "team-lead" }` |
| `permission` | users who may do an action on the record (CASL, conditions included), from the feature's `record()` | `{ "type": "permission", "action": "update" }` |
| `users` | named users | `{ "type": "users", "userIds": ["…"] }` |

A stage's approvers are everyone any of its rules names, active, minus the
requester. There is no "manager" field: "the lead of my unit" is
`teamRole` with the lead's role.

## Stages, modes, time

```json
{
  "when": { "type": "payload", "path": "amount", "op": "gt", "value": 1000 },
  "stages": [
    { "name": "Lead", "approvers": [{ "type": "teamRole", "role": "team-lead" }], "mode": { "type": "any" },
      "remindAfter": "1d", "dueAfter": "3d", "onOverdue": "escalate",
      "escalateTo": [{ "type": "teamRole", "role": "team-lead", "levelsUp": 1 }], "escalationDueAfter": "2d" },
    { "name": "Finance", "approvers": [{ "type": "role", "role": "finance" }], "mode": { "type": "quorum", "n": 2 } }
  ],
  "resubmitWithin": "30d"
}
```

- **Modes**: `any` (the first decision decides the stage, whatever it is),
  `all` (everyone approves; one rejection or request for changes decides),
  `quorum` (`n` people approve; once `n` is out of reach the stage is
  rejected when someone rejected, otherwise the request fails as
  `no_approvers`; never lowered: a stage with fewer than `n` approvers is
  refused, 422, or fails). A request for changes sends the request back
  in every built-in mode. A mode may answer `unreachable` (nobody left to
  decide): the request fails.
- **One person, one decision per stage**: a decision covers every
  assignment of the stage the person holds or stands in for (their own,
  and each delegator's, recorded `onBehalfOf`); a quorum counts people,
  not assignments.
- **Conditions** (`when`): `payload` (`eq`, `ne`, `gt`, `gte`, `lt`, `lte`,
  `in`, `notIn`, `exists` at a dotted path), and `all` / `any` / `not` of
  others, 5 deep at most.
- **Time**: `remindAfter` reminds the approvers who haven't decided (once);
  `dueAfter` makes the stage overdue: `onOverdue: expire` (the default)
  expires the request, `escalate` hands the stage's undecided part to the
  `escalateTo` approvers (told by `approval.escalated`): those who didn't
  answer in time are closed out, the decisions already made still count
  (so an `all` stage waits for the escalation, not for whoever was away),
  and with `escalationDueAfter` it expires then. The stage is settled
  again right away: an escalation that leaves a quorum out of reach
  decides it (rejected, or failed when nobody rejected).
- **Approvers removed**: a deactivated or deleted account's pending
  assignments are closed out and its stages settled again (an `all` stage
  goes on without them; one left with nobody fails as `no_approvers`);
  its delegations end. The actor of `approver_removed` and of the
  endings is who did it: the administrator deactivating the account over
  HTTP, or `system:account-deletion` inside the deletion job; the system
  principal never acts within a request. This can never refuse the deactivation: the
  listeners of the endings it causes run in a savepoint, and one that
  throws is logged and skipped. Requests are locked in id order, so two
  deactivations at once don't deadlock. What those endings tell
  (notifications, webhooks) runs in a savepoint too.
  After a request for changes, the requester has `resubmitWithin` (30 days)
  before it expires. Durations: `30m`, `8h`, `2d`, `1w`. Timers are the
  workflow's: durable, counted from the stage's start, the manual clock in
  tests. A stage without `dueAfter` waits until decided or cancelled.

## Policies at runtime

Code declares the default (version 0). Administrators with
`Approval.managePolicies` store versions of their own, validated against
the registered rule, mode and condition types: a 400 `validation_failed`
names each wrong path (`stages.0.approvers.1.role`).

| Route | Does |
| --- | --- |
| `GET /v1/approvals/policies` | every action: its policy in force, `version`, `source` (`code` or `override`), the code's `default`, its `setting`, the `payloadSchema` (JSON Schema) |
| `GET /v1/approvals/policies/{key}` | one (`Note.publish`), with an ETag |
| `PUT /v1/approvals/policies/{key}` | a new version (If-Match); audited `approvalPolicy.updated` |
| `DELETE /v1/approvals/policies/{key}` | back to the code's default, as a new version; audited `approvalPolicy.reset` |
| `GET /v1/approvals/policy-types` | the registered rules, modes and conditions, with their parameters' JSON Schema |

New requests run under the newest version; a running request keeps the
copy it started with (`policyVersion`), resubmissions included.
`enabled: false` switches an action off for everyone; the feature's
setting (a flag: globally, per team, rollouts; never per user)
switches it per requester.

## The API

| Route | Does |
| --- | --- |
| `GET /v1/approvals` | the inbox: `?assignedToMe=true` (pending on you now, yours and those of people you stand in for), `?requestedByMe=true`, `status`, `subject`, `action`, `recordId`, `dueAt`, `createdAt`, `updatedAt`; cursor pages; ETag |
| `GET /v1/approvals/{id}` | the request: `stages` (their state in the current round), `assignments` (every round), `timeline`, and `can` (`decide`, `cancel`, `resubmit`); ETag |
| `POST /v1/approvals/{id}/approve` | `{ comment? }`: for your assignment and those of the people you stand in for |
| `POST /v1/approvals/{id}/reject` | `{ comment }` (required) |
| `POST /v1/approvals/{id}/request-changes` | `{ comment }` (required): back to the requester |
| `POST /v1/approvals/{id}/resubmit` | the requester, after changes were requested: `{ payload?, comment? }` (no `payload` for an action that reads it from the record); a new round from the first stage, approvers resolved again |
| `POST /v1/approvals/{id}/cancel` | the requester, or `Approval.cancel`: `{ reason? }` |
| `POST /v1/approvals/{id}/abandon` | `Approval.manage`, `If-Match`: an approved request whose workflow ended without applying it ends as `failed` (`abandoned`), unlocking its record, and `onFailed` runs; 409 `approval_not_stuck` otherwise (its workflow still runs or retries, or it isn't approved-and-unapplied) |
| `GET/POST /v1/approvals/delegations`, `DELETE /v1/approvals/delegations/{id}` | out of office (below) |

Every decision route takes `If-Match` (412 `precondition_failed` when the
request changed since read) and answers the request as `GET` does.

- **Who sees what**: anyone reads the requests they made, are or were
  assigned to, decided, or may decide now as a delegate; `Approval.read`
  (condition `ofSubject`) shows the others. Anything else is a 404: a
  request's existence stays hidden. `Approval.read` shows the requests'
  **payloads and titles whatever the subject's own read conditions say**
  (an `Approval.read` on `Expense` sees the amounts of expenses its holder
  couldn't open): grant it as you would read access to those records.
- **Impersonation**: nobody decides, cancels, resubmits, or creates or ends
  a delegation while acting as someone else (403 `approval_impersonation`):
  an administrator could otherwise approve their own request as an
  approver, or delegate someone's approvals to themselves.
- **API clients as requesters**: a user who may manage API clients
  (`Access.manageClients`) can request as a client they control and then
  approve as themselves (the requester is the client, not them). Projects
  that care restrict which clients may request (the feature's own check
  before `request()`, or a `requested` listener that refuses).
- **Cancelled by someone else** (`Approval.cancel`), the requester is told
  (`approval.cancelled`) along with the approvers still waiting.
- **Who decides**: being assigned to the current stage, or standing in for
  someone who is. A role alone never decides (an administrator gets 403
  `approval_not_assignee`); the requester gets 403 `approval_self_approval`.
- **Concurrency**: decisions take turns on the request's row lock. In an
  `any` stage two approvers at once: one wins, the other gets 409
  (`approval_already_decided`, or `approval_closed` once the request
  ended). Deciding again the same way changes nothing; differently is
  409 `approval_already_decided` (one person, one decision per stage,
  standing in for others included). `If-Match` is checked under the same
  lock. Resubmitting what wasn't sent back: 409
  `approval_not_changes_requested`, before anything else is checked.

Resubmission keeps the request (one history, one timeline) rather than
making a new one: the round counts it, every assignment says its round.

## Delegation

`POST /v1/approvals/delegations { toUserId, startsAt, endsAt, subject? }`
(users only): between `startsAt` and `endsAt` the delegate may decide
the approvals assigned to you, of every subject or of `subject`. They are
told of new assignments and reminders with you, find them under
`assignedToMe`, and their decision is recorded as theirs, `onBehalfOf`
you (`decidedBy` and `onBehalfOf` on the assignment, the timeline, the
audit entry). One decision of theirs covers their own assignment too,
when they have one in the stage: it counts once. You may still decide
yourself. Outside the period they take no part (404). A delegation lasts
at most `approvals.maxDelegationDays` (a setting, 90 days by default;
400 beyond it), and ends with either account. `GET` lists the
delegations you gave and hold (`active`: now); `DELETE` ends one you
gave. Audited; refused while impersonating.

## What it tells

| Channel | What |
| --- | --- |
| Notifications | `approval.requested` (to a stage's approvers and their delegates), `approval.reminder`, `approval.escalated`, `approval.approved` / `.rejected` / `.changesRequested` / `.expired` / `.failed` (to the requester), `approval.cancelled` (to the approvers still waiting). Texts in every catalog, under `approval` |
| Realtime | `approval.assigned { id, subject, recordId, action, stage }`, `approval.decided { id, status, round, stage, decision }` (one per change: a decision, or the request's end) |
| Webhooks | `approval.requested`, `.approved`, `.rejected`, `.changes-requested`, `.cancelled`, `.expired`, `.failed`, to the requesting API client (the tenant), `data: { requestId, subject, recordId, action, status }`, through the outbox |
| Audit | `approval.requested`, `.decided`, `.approved`, `.rejected`, `.changes_requested`, `.resubmitted`, `.cancelled`, `.expired`, `.escalated`, `.failed`; the workflow's own as the system principal `system:approvals` ([permissions](permissions.md#the-system-principal)), and so are what the outcome handlers record (`outcome.actor`); what a request causes (an administrator deactivating an approver, abandoning a stuck request) as the request's principal, never the system |
| Timeline | `GET /v1/approvals/{id}`: `requested`, `stage_started`, `decided`, `stage_approved`, `reminded`, `escalated`, `approver_removed`, `resubmitted`, and the ending |

A record purged from its recycle bin takes its requests with it
(`RecordPurgeRegistry`), and the open ones' workflows are cancelled in the
same transaction. A feature deleting a record calls `withdraw()`: its open
requests end as `cancelled` (`outcomeReason: record_deleted`).

## The notes example

With `notes.publishApproval` on (`PUT /v1/settings/notes.publishApproval
{ "value": true }`, default off), the publication workflow asks for
approval instead of publishing, as the note's owner; any other editor
decides; meanwhile `PATCH` and `DELETE` of the note answer 409
`approval_pending` (and still until the approval is applied); once
approved, the approval's workflow runs `onApproved`, which publishes it
(never a deleted note). The payload is read from the note, and its
content's hash is compared before publishing: a note changed behind the
approvers isn't published (`failed`, `record_changed`). A rejected note
stays a draft; deleting one sent back for changes withdraws its request.
The tests: `apps/api/test/approvals.e2e-spec.ts`.

## When the outcome won't apply

An approved request's handler runs as a step with eight attempts over
about twenty minutes. Meanwhile the record stays locked, and
`approvals_unapplied_seconds` on `/metrics` (with the `ApprovalsNotApplied`
alert past an hour) says how long the oldest has waited. When the
attempts run out, the request ends as `failed` (`apply_failed`): the
record is unlocked, the requester told, `onFailed` and the listeners run.
When the workflow itself is gone without applying it (terminated,
deleted, or failed and never retried), an administrator with
`Approval.manage` ends it with `POST /v1/approvals/{id}/abandon`
(`failed`, `abandoned`; `onFailed` and the listeners run; audited; never
while impersonating). While the workflow still runs or retries it's
refused (409 `approval_not_stuck`): its handler may be applying the
outcome at that moment. And `conclude` marks an outcome applied only
while the request still has that status, so nothing ended meanwhile is
marked applied.

## Durable steps

Every step of the workflow runs at least once: an attempt can commit and
die before its result is journaled, and runs again. So each step answers
from the request's state, not from what it expected: a retried
escalation finds itself done (`escalated`), a retried expiry the request
expired, a stage start the request failed; a step that finds the
request ended concludes with that status, never a guess. Feature
handlers follow the same rule (idempotent: do nothing when the effect
is there). `outcomeAppliedAt` marks a final outcome of the round it
concludes (a request sent back for changes isn't applied; a
resubmission clears it), so a request approved in a later round is
applied too.

## Extending

Rules, modes, conditions and listeners register into `ApprovalsRegistry`
from a provider's constructor, as the built-in ones do: nothing in the
platform changes, and a policy (in code or stored) names them by `type`.

**An approver rule**: who, from the request (an HR system's manager, a
cost center's owner).

```ts
@Injectable()
export class CostCenterOwnerRule implements ApproverRule<{ center?: string }> {
  readonly type = 'costCenterOwner';
  readonly label = 'The owner of the cost center';
  readonly schema = z.object({ center: z.string().optional() }).strict();
  constructor(registry: ApprovalsRegistry, private readonly centers: CostCentersService) {
    registry.addRule(this);
  }
  async resolve({ params, payload }) {
    return [await this.centers.ownerOf(params.center ?? (payload.costCenter as string))]; // user ids
  }
}
// a provider of the feature's module; a policy: { "type": "costCenterOwner" }
```

**A stage mode**: how a stage completes, a pure function of its votes.

```ts
export const WEIGHTED: StageMode<{ threshold: number; weights: Record<string, number> }> = {
  type: 'weighted',
  label: 'Weighted vote',
  schema: z.object({ threshold: z.number().positive(), weights: z.record(z.uuid(), z.number()) }),
  outcome({ params, votes }) {
    const live = votes.filter((v) => v.status !== 'closed');
    if (!live.length) return 'unreachable';
    // A person counts once (their own assignment and those they stood in for).
    const weight = (status: string) => {
      const people = new Map(live.filter((v) => v.status === status).map((v) => [v.decidedBy ?? v.approverId, v]));
      return [...people.values()].reduce((sum, v) => sum + (params.weights[v.approverId] ?? 1), 0);
    };
    if (weight('approved') >= params.threshold) return 'approved';
    return weight('rejected') >= params.threshold ? 'rejected' : 'pending';
  },
};
// in any provider's constructor: registry.addMode(WEIGHTED);
```

A **condition** is the same with `evaluate(context) → boolean` and
`registry.addCondition()`; it may read `payload`, `requester` and
`await record()`.

**A lifecycle hook**: `requested`, `stageStarted`, `assigned`, `decided`,
`reminded`, `escalated`, `approved`, `rejected`, `changesRequested`,
`resubmitted`, `cancelled`, `expired`, `failed`. Each runs in the
transaction of the change: what it writes commits with it, and throwing
refuses the change (an extra check). Keep it quick; slow work goes to the
outbox or a queue.

```ts
@Injectable()
export class ErpSync implements ApprovalListener {
  readonly subjects = ['Expense'];
  constructor(registry: ApprovalsRegistry, private readonly outbox: Outbox<Transaction>) {
    registry.listen(this);
  }
  async approved({ request }: ApprovalLifecycleEvent, tx: Transaction) {
    await this.outbox.add(tx, [{ topic: 'erp.expense-approved', payload: { id: request.recordId } }]);
  }
}
```

**Approvals for a new feature**, in five steps:

1. Declare the action: `defineApproval({ subject, action, label, payload,
   policy, setting? })` in `<item>-approvals.ts`; a flag in
   `<x>-settings.ts` (scopes `global`, `team`: never `user`) if it
   should be switchable.
2. Write its handler (`ApprovalHandler`: `describe`, `record`,
   `onApproved`, the others as needed; `payload` and `fingerprint` when the
   record is the change), idempotent, registered with
   `registry.handle(this)`, a provider of the feature's module.
3. Add the declaration to `PlatformModule.forRoot({ approvals })` in
   `app.module.ts`.
4. Where the action is asked for, call `approvals.request()`; do the action
   yourself on `{ required: false }`. In the writes that must wait, call
   `approvals.assertNotPending(subject, id)` in their transaction; on delete,
   `approvals.withdraw(tx, by, subject, id)`. Handlers check the record
   still allows the effect (not deleted).
5. Test it: turn its setting on, `node.worker.drain()` to let the workflow
   assign, decide over HTTP, drain again for the handler
   (`apps/api/test/approvals.e2e-spec.ts`).

**Personal data**: a person's export (`POST /v1/account/export`) has the
requests they made and their decisions (kind `approvals`). Their account's
deletion keeps both, as others' records depend on them, but the names
copied onto them become "Deleted user", their pending assignments close
(their stages settled again), and their delegations end.
