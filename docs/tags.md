# Tags: labels on records

`Urgent`, `Q3`, `Waiting on client`: labels administrators define per
subject, which records carry, show and are filtered by.
`apps/api/src/platform/tags/`; notes carry tags as the example
(`features/notes/note-tags.ts`, `tagRoutes()` in `notes.module.ts`).

```ts
// features/notes/note-tags.ts: the feature registers its records
@Injectable()
export class NoteTags implements TagTarget {
  readonly subject = 'Note';
  constructor(private readonly notes: NotesService, private readonly policy: NotePolicy, registry: TagsRegistry) { registry.register(this); }
  async canTag(p, id) { return this.policy.update(p, await this.notes.findOne(id)); }   // 404 when missing
}
// its list: ?tag=<id>, ?tag.in=<id>,<id> (an EXISTS on record_tags)
export const NOTE_LIST = listQuery({ ...tagFilter('Note', notes.id), … });
// its responses: one query per page, never per row
const tags = await this.tags.tagsOf('Note', rows.map((row) => row.id)); // Map<id, { id, name, color }[]>
```

| Route | Does |
| --- | --- |
| `GET /v1/tags` | anyone signed in; cursor pages, newest first; `?subject=Note` (optional: a management screen lists every subject), `?name=` (whatever the case), `?name.contains=`, `?sort=name` (whatever the case) |
| `POST /v1/tags { subject, name, color?, description? }` | `Access.manageTags`; 201; the subject must be registered (400 otherwise); the name is unique per subject whatever its case (409 `conflict`); `color` is `#rrggbb` (stored in lower case) |
| `PATCH /v1/tags/{id}` | `Access.manageTags`; only what is sent changes, `null` clears `color` or `description` |
| `DELETE /v1/tags/{id}` | `Access.manageTags`; 204; every record loses the tag (the links cascade) |
| `PUT /v1/notes/{id}/tags { tagIds }` | whoever may change the note (`canTag`: `Note.update`); replaces the whole set, `[]` removes all; an id that isn't a tag of the subject is a 400 `validation_failed` naming `tagIds.<i>`; answers `{ items: [{ id, name, color }] }` |

- **Showing**: notes carry `tags: [{ id, name, color }]` (by name) in
  `GET /v1/notes/{id}`, the list and every response with the note;
  `fields=tags` picks them. The export has a `tags` column, the names
  joined by `, ` (generated records with `tags` and `transfer` get it from
  the platform); an import ignores that column.
- **Audit**: `tag.created`, `tag.updated` (what changed), `tag.deleted`;
  a record's set changing is one `tags.changed` entry, the record as
  target (`note`), `from`, `to`, `added`, `removed` (tag ids).
- **Permission**: `Access.manageTags`, users only (as every Access
  action); the built-in administrator holds it.
- A record deleted for good: its tag links go in the same transaction.
  The soft-delete purge does it by itself (`RecordPurgeRegistry`); a
  feature that deletes outright calls `tags.forget(tx, record)`. A note in
  the recycle bin keeps its tags.
