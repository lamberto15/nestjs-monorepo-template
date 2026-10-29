# Personal work surfaces

Three small surfaces that help a person get back to and finish their work: a
**work inbox** (what waits on me), **recent records** (what I opened lately)
and **record presence** (who else is on this record). Each is the caller's own
or permission-scoped, and each reads existing state instead of keeping a copy.

Code: `platform/inbox`, `platform/recents`, `platform/presence`; the web app's
`features/inbox`, `features/recents`, `features/presence`.

## Work inbox

`GET /v1/inbox` (anyone signed in) is one list of what waits on the caller in
the current tenant, newest first, cursor pages (`?limit=`, `?cursor=`;
`?source=` narrows to one source).

| Source | Kind | Waits on me when | Done by |
| --- | --- | --- | --- |
| `approval` | `approval.decide` | a request's current stage is assigned to me, or to someone I stand in for | deciding it (not dismissable) |
| `approval` | `approval.revise` | an approver sent my own request back for changes | resubmitting or withdrawing it |
| `mention` | `mention` | an unread `comment.mentioned` notification of mine, on a record I can still read | `POST /v1/inbox/dismiss` `{ key }` (marks the notification read) |

- **Registry:** a source implements `InboxSource` (`inbox.registry.ts`) and
  registers from its constructor (`inbox.register(this)`), as the other
  registries do. The approvals source is `approvals/approval.inbox.ts`, the
  mentions source `comments/mention.inbox.ts`. A new kind of work is a new
  source, nothing in the inbox changes. Not yet sources: assigned or watched
  records (the template has no assignee field; watchers are notified through
  the notification system already).
- **Authoritative state:** a source reads its own tables now, so an item is
  there exactly while the work is open (decide an approval, in the inbox or
  anywhere else, and it is gone). A mention is checked against the record's
  read permission each time, so a title or excerpt of a record the person lost
  access to is never shown.
- **Order and pages:** every source's ids are UUIDv7, so one order serves the
  whole list. The cursor holds where each source stopped; it is opaque. Two
  entries with the same `dedupe` (one piece of work reported twice) show once.
- **Each item** carries `key` (`<source>:<id>`), `kind`, `at`, `dueAt` (an
  approval stage's deadline), `link` (a path of the web app), the record's
  `subject` and `recordId`, a small `data` object the client words the item
  with, and `canDismiss`.
- **Tenant:** an approval and a notification belong to a tenant, so the inbox
  is the current tenant's; switching tenant shows the other's.

## Recent records

`platform/recents`, every route for the caller's own list:

| Route | Does |
| --- | --- |
| `GET /v1/recents` | Newest first, without what you no longer see |
| `POST /v1/recents` `{ subject, recordId, label }` | Notes that you opened a record; opening it again moves it up |
| `DELETE /v1/recents/{id}` | Removes one |
| `DELETE /v1/recents` | Clears your history in this tenant |

- **Bounded:** at most 20 per person and tenant (the oldest drops out) and
  none older than 30 days (`RECENTS_RETENTION_DAYS`).
- **Privacy:** the row holds the record's subject and id and the title the
  page showed (`label`, at most 120 characters), never a field's content, and
  clients send the title only. Noting a record needs the same permission as
  watching it (the subject's `SubscriptionTarget`), and the list checks again:
  a record deleted or no longer readable is left out before its title is shown.
- **Retention:** `RecentsRetentionJob` deletes entries older than 30 days every
  night at 03:40 (`APP_TIMEZONE`), for every tenant. The history is cleared at
  any time by its owner, erased with the person's account, and removed when a
  record is purged from the recycle bin. It is in the person's data export
  (`recent`). It is not a tenant retention rule (`docs/retention.md`): it is
  the person's own convenience list, with a fixed bound.
- **Tenants:** `recent_records` is a tenant table (RLS, `docs/tenancy.md`): a
  person's list in one tenant never shows another's.

## Record presence

Who is viewing or editing a record now, so two people do not unknowingly edit
the same one. Ephemeral and advisory.

| Route | Does |
| --- | --- |
| `PUT /v1/presence/{subject}/{recordId}` `{ mode }` | `viewing` or `editing`; a beat. Answers with the list |
| `GET /v1/presence/{subject}/{recordId}` | Who is on it |
| `DELETE /v1/presence/{subject}/{recordId}` | Leave |

- **Expiry:** pages beat every 15 seconds; an entry lives 45 seconds in Redis
  (`tenant:<id>:presence:<subject>:<recordId>`, a hash per record), so a closed
  tab or a dropped connection disappears by itself. Redis unavailable: no
  presence, nothing else breaks.
- **Realtime:** when someone arrives, leaves or changes mode, the people on
  the record get `record.presence` (`{ subject, recordId }`, ids only) in their
  room and fetch the list. The mode is all that is stored or sent: never what
  is being typed.
- **Who sees whom:** every route needs the caller to read the record (the
  subject's `SubscriptionTarget`, a 404 otherwise), so who is on a record is
  never told to someone who cannot see it, nor in another tenant (the Redis
  key and the socket room carry the tenant). Every entry is checked again as its
  person when listing and when pushing: someone whose access was revoked drops
  out at once, not after the 45 seconds.
- **Advisory:** presence never blocks a save. The record's ETag (`If-Match`)
  still decides whether a write is current.

## The web app

- **Inbox** (`/inbox`, in the menu for everyone): the list with an item per
  line, its link, deadline and a Dismiss button where allowed; it reloads
  when a notification arrives.
- **Recent** (sidebar group, hidden while empty): the person's recent records
  under the menu entry their subject's read permission gates, with a "Clear
  history" action. A record page notes itself with `useRecordRecent()`.
- **Presence:** `PresenceIndicator` on a record page shows the other people
  there (and a warning when someone is editing); `usePresence()` beats while
  the page is open.
