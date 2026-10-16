# Record revisions: history, diff, restore

Each saved state of a record, numbered 1, 2, 3… per record: its changeable
fields after the change (`snapshot`, custom values included) and what
changed (`changes`, from → to, the audit log's diff: `custom.<key>` per
custom value). `apps/api/src/platform/revisions/`; notes keep revisions as the
example (`features/notes/note-revisions.ts`, `note-revisions.controller.ts`).

```ts
// features/notes/note-revisions.ts: the feature registers its records
@Injectable()
export class NoteRevisions implements RevisionTarget {
  readonly subject = 'Note';
  async canRead(p, id) { … this.policy.read(p, note) }       // false when missing: 404
  async canRestore(p, id) { … this.policy.update(p, note) }  // 403
  snapshot(note) { return noteSnapshot(note); }             // { title, body, custom }
  async apply(p, id, fields, { ip, restoredFrom }) { … this.notes.update(p, note, changed, ip, { restoredFrom }) }
  async shown(p, id) { … }                                   // the note as GET answers it (ETag)
  async redact?(p, id, items) { … }                          // field-level and deactivated custom fields, in snapshots and changes
}
// in NotesService.create (no `before`) and .update, after the audit entry, in the same transaction:
await this.revisions.record(tx, 'Note', note.id, { snapshot: noteSnapshot(row), before: noteSnapshot(note), by, restoredFrom });
```

| Route | Does |
| --- | --- |
| `GET /v1/notes/{id}/revisions` | whoever may read the note; newest first, cursor pages; `?changedBy=`, `?number.gte=`, `?createdAt.gte=` |
| `GET /v1/notes/{id}/revisions/{number}` | one; 404 for a number the note doesn't have |
| `GET /v1/notes/{id}/revisions/{a}/diff/{b}` | `{ from: a, to: b, changes: { field: { from, to } } }`, from `a`'s values to `b`'s (either order) |
| `POST /v1/notes/{id}/revisions/{number}/restore` | whoever may change the note (`Note.update`, field-level checks as a PATCH: `field_forbidden`); `If-Match` with the note's ETag (412 `precondition_failed` when it changed); answers the note as `GET /v1/notes/{id}` does, with its ETag |

- **Numbering**: `record()` takes the next number under an advisory
  transaction lock on `subject:recordId`, so concurrent changes of one
  record take turns; the unique index `(subject, record_id, number)` is
  the invariant. A write that changes nothing adds no revision.
- **Revision 1 on create**, with `changes: null`, so the first state can be
  restored too. A record written before its feature kept revisions gets,
  on its next change, revision 1 from `before` (its state then, by
  `unknown`, `changes: null`) and revision 2 with the change.
- **Restore** goes through the feature's own update: audited
  `note.updated`, watchers told, and a new revision with
  `restoredFrom: <number>`. Custom values of active fields are set back
  (one the revision lacks is removed); those of fields deactivated since
  stay. The values pass the update's schema again: one today's rules
  refuse (an option removed, a shorter limit) is a 400 `validation_failed`.
  Restoring the current state writes nothing.
- **Who sees what**: a reader who may not read the note gets 404 (as the
  attachments routes: its existence stays hidden); the text and custom
  values are left out of snapshots, changes and diffs as in
  `GET /v1/notes/{id}`, and so are custom fields deactivated since. A reader
  who may not see a field still sees that a revision happened (number, who,
  when), with `changes` empty when only that field changed.
- **Retention**: `REVISIONS_RETENTION_DAYS` (365); `revisions-retention`
  runs every night at 03:25 in APP_TIMEZONE on one instance and deletes
  the older revisions, but always keeps each record's latest (the next
  change is diffed against it). `run()` returns the count.
- **Personal data**: none of the person's own (a revisions source exports
  nothing); an account's deletion sets `changedBy` to `anonymized`.
- A record deleted for good: its revisions go in the same transaction.
  The soft-delete purge does it by itself (`RecordPurgeRegistry`, with
  comments, tag links and watchers); a feature that deletes outright calls
  `revisions.forget(tx, record)`.
