# Comments and @mentions

Conversations on any feature's records: people comment, mention each
other, and the record's watchers hear of it. `apps/api/src/platform/comments/`;
notes take comments as the example (`features/notes/note-comments.ts`,
`commentRoutes()` in `notes.module.ts`).

```ts
// features/notes/note-comments.ts: the feature registers its records
@Injectable()
export class NoteComments implements CommentTarget {
  readonly subject = 'Note';
  readonly commentedType = 'note.commented';   // what watchers get (declared in note-notifications.ts)
  constructor(private readonly notes: NotesService, private readonly policy: NotePolicy, registry: CommentsRegistry) { registry.register(this); }
  async canRead(p, id) { return this.policy.read(p, await this.notes.findOne(id)); }      // 404 when missing
  async canModerate(p, id) { return this.policy.update(p, await this.notes.findOne(id)); }
  link(id) { return `/notes/${id}`; }
  async title(id) { return (await this.notes.findOne(id)).title; }
}
// its controller: HTTP only, CommentsService checks canRead
this.comments.add(user, { subject: 'Note', recordId: id }, dto.body, ip);
```

| Route | Does |
| --- | --- |
| `GET /v1/notes/{id}/comments` | oldest first, cursor pages; `?sort=-createdAt`, `?author=`, `?createdAt.gte=` |
| `POST /v1/notes/{id}/comments { body }` | 201; 1 to 10 000 characters |
| `PATCH /v1/notes/{id}/comments/{commentId} { body }` | the author only (403); sets `editedAt` |
| `DELETE /v1/notes/{id}/comments/{commentId}` | the author, or a moderator (`canModerate`: for notes, `Note.update`, so with the seeded editor role an owner moderates their drafts, not their published notes); for good |

- **Who**: whoever may read the record reads and writes its comments
  (403 otherwise, 404 when the record doesn't exist).
- **Mentions**: `@ada@example.com` or `@user:<id>` in the body. Active
  users who may read the record are stored in `mentions` and get
  `comment.mentioned` (email at once by default; not mandatory); anyone
  else is dropped silently, so a mention never reveals who exists (a
  draft only its owner reads mentions nobody else). An address's local
  part may hold dots (`@maya.patel@demo.example.com`). An edit tells only
  the people it newly mentions. Autocomplete searches `GET /v1/people?q=`
  ([permissions.md](permissions.md), "The people directory"), open to
  every member. The web app's box shows the chosen person's name and sends
  `@user:<id>` in its place; a client writes `@user:<id>` itself.
- **Names**: each comment carries `authorName` beside `author`, and
  `mentionNames` beside `mentions` (`{ "user:<id>": "Maya Patel" }`, a
  key for each mention; a mention written as an address,
  `@Maya@Example.com`, is named under that address too, lower-cased:
  `"maya@example.com": "Maya Patel"`, so a client can show the name where
  the body has the address; an address that mentioned nobody, say one of a
  person who can't read the record, has no entry: the entry exists only
  where the mention resolved, and is read from the user's current address),
  the names every member sees
  (`PeopleService.names()`): a page's authors and mentioned people in
  one query, whatever its size. Only the tenant's people have a name
  here: one who left it (an inactive membership) keeps theirs on what
  they wrote and where they're mentioned; `anonymous`, or a key of
  someone the tenant never had, is null. The personal-data export
  leaves `mentionNames` out (other people's data; the keys stay). A
  `@user:<id>` the API dropped (the author's own, a person who can't read
  the record) has no entry, and a client that wants the name asks
  `GET /v1/people?key=` (the web app does).
- **Watchers** (subscriptions) get the feature's `<subject>.commented`,
  collapsed per record, but the author and those mentioned. The author
  watches the record from their first comment on it (while an earlier
  comment of theirs remains, unwatching sticks).
- **Realtime**: after each add, edit or removal, `record.commented`
  (`{ subject, recordId, commentId, action }`) reaches the watchers and
  the author's other tabs who may read the record
  ([webhooks-and-realtime.md](webhooks-and-realtime.md), "Record events"),
  so an open page reloads the panel instead of polling.
- **Audit**: `comment.added`, `comment.edited`, `comment.removed`, the
  comment as target, `subject` and `recordId` in the details (never the
  text: the log outlives the author's account).
- **Personal data**: a user's comments are in their export
  (`POST /v1/account/export`, kind `comments`). Their account's deletion
  keeps the comments, so the conversation keeps its shape, but replaces
  the text with `[deleted]` and the author with `anonymous`; where
  others mentioned them, the mention goes and their address or
  `@user:<id>` in the text becomes `@[deleted]`.
- A record deleted for good: its comments go in the same transaction.
  The soft-delete purge does it by itself (`RecordPurgeRegistry`); a
  feature that deletes outright calls `comments.forget(tx, record)`.
