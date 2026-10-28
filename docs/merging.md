# Duplicates and merging

Find records that are likely the same, then merge one into the other: the
survivor keeps its id and takes the values you choose from the duplicate,
gains its tags, comments, attachments, watchers and the references to it,
and the duplicate goes to the recycle bin. The capability is `merge`
(`apps/api/src/platform/merge/`), tested on test items
(`apps/api/test/merge.e2e-spec.ts`). Notes take it too, hand-wired
(`features/notes/note-merge.ts`: a `Merges` with its own source, provided as
`MERGES` next to `mergeRoutes(NOTE_ROUTES, …)`). Background scans for duplicates
belong to data quality, not here: this finds them when a record is created
or changed, or on demand.

## Declaring it

```ts
export const CONTACT = defineRecord({
  // …
  softDelete: true, // required: the duplicate goes to the recycle bin
  duplicates: [['email'], ['firstName', 'lastName']],
  capabilities: ['merge' /* … */],
});
```

`pnpm feature:add contacts --fields "…" --with merge` (or `merge` added to an existing
`<item>.record.ts`, then `pnpm feature:sync` and `pnpm client:generate`).

- **Rules (`duplicates`):** two records are likely duplicates when every
  field of one rule matches. Text (string, text) matches without case or
  surrounding spaces; other fields match exactly. Money and JSON fields
  can't be in a rule. Left out: the record's title field alone (its first
  searchable or string field).
- `merge` needs `softDelete`: a merge must be reversible.

## For clients

| Route                             | Does                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `POST /v1/<x>/duplicates`         | `{ values, excludeId? }`: the records these values would duplicate (before a create, a PATCH) |
| `GET /v1/<x>/{id}/duplicates`     | a record's likely duplicates                                                                  |
| `POST /v1/<x>/{id}/merge/preview` | `{ duplicateId, fields }`: what the merge would do; changes nothing                           |
| `POST /v1/<x>/{id}/merge`         | the merge; answers the survivor                                                               |

`{id}` is the survivor. `fields` names whose value each field keeps:
`{ "email": "duplicate" }` takes the duplicate's email; any field left out
keeps the survivor's. A list answers `{ items: [{ id, matched, record }] }`,
newest first, at most 20; `matched` names the rules each one matched.

The preview answers both records, `fields` (each field you may choose:
both values, whether they differ, whose is kept), `result` (the survivor
once merged) and `moves` (how many tags, comments, attachments, watchers
and referring records move).

## What it checks

- **Only what you may read:** duplicates come from the records you may
  read in your tenant, and a match by a field hidden from you on a record
  (field-level permissions) is no match: it would tell the hidden value.
  The preview shows each record as you may read it; you choose only fields
  you may read on both and change on the survivor (else 403
  `field_forbidden`).
- **Who may merge:** whoever may change the survivor and delete the
  duplicate (`<Subject>.update`, `<Subject>.delete`, with their conditions).
  Every record referring to the duplicate, in the recycle bin too, must be
  one you may change (403 `merge_references_forbidden`).
- **Constraints:** a duplicate under a legal hold stays (409 `legal_hold`,
  [retention](retention.md)); an approval pending on either record refuses
  it (409 `approval_pending`); a unique value is free for the survivor once
  the duplicate is in the bin, and the survivor can't end up referring to
  the duplicate (422 `merge_self_reference`) or itself (422
  `merge_same_record`).

## What happens

In one transaction, all of it or none of it:

1. The records referring to the duplicate (its relations,
   [adding a feature](adding-a-feature.md), "Relationships") point at the
   survivor, those in the recycle bin too.
2. Its comments and attachments move to the survivor; its tags and
   watchers are added to the survivor's.
3. The duplicate goes to the recycle bin through the feature's delete
   (`<item>.deleted` audited, its `events` webhook).
4. The survivor takes the chosen values through the feature's update
   (`<item>.updated` audited with what changed, a revision, its webhook).
5. `<item>.merged` is audited on the survivor: the duplicate, the fields
   taken, and the ids of the comments, attachments, tags and referring
   records that moved.

The duplicate's revisions stay with it. A repeat of the same merge finds
the duplicate gone (404), so it changes nothing twice.

**Undoing one:** restore the duplicate from the recycle bin
(`POST /v1/<x>/{id}/restore`, refused with a 409 while the survivor holds
one of its unique values); the `.merged` entry names what moved, to move
back by hand. There is no automatic unmerge.

## In the web app

A record's page shows a **Duplicates** tab when its subject takes `merge`
(`RecordPanels`): the likely duplicates, and to whoever may change the
record, a merge into it: the fields that differ (ticked ones take the
duplicate's value) and what moves, then **Merge**.
