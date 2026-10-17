---
name: add-feature
description: Add a new feature (a resource with its routes, permissions, table and tests) to this template, or change one (add a field, add tags, comments, attachments, revisions, a PDF, bulk, watch, search, custom fields, export, webhooks for its changes or human-readable numbers), the standard way. Asks what is wanted, runs `pnpm feature:add` or edits the feature's `<item>.record.ts` and runs `pnpm feature:sync`, then writes only the business logic. Use whenever the user wants to add or change a feature, resource, entity, module, CRUD or "something to manage" (invoices, customers, tickets…), even if they don't name the generator.
---

# Add a feature

Every feature in this template has the same standard parts, written by
`pnpm feature:add` (tools/feature, docs/adding-a-feature.md). Your job:
understand the feature, run the generator with the right options, then write
the business logic only. Never copy `features/notes/` by hand and never
hand-write what the generator or the platform provides.

## 1. Interview (one round, grouped; skip what the user already said)

Ask with AskUserQuestion where it fits, in at most two rounds:

1. **What is it, and its name.** Plural, lowercase, dash-separated (`invoices`,
   `support-tickets`). If the singular can't be derived (`people`), ask for it
   (`--singular person`).
2. **Its fields.** Map each to a generator type; say which you picked:
   - short text → `string`; long text → `text`; whole number → `int`;
     exact decimal (rates, quantities) → `decimal`; an amount of money →
     `money` (never a decimal: docs/money.md);
   - yes/no → `bool`; a day → `date`; a moment → `datetime`; one of a fixed
     list → `enum(a|b|c)`; free structure → `json`;
   - a link to another feature's record → `ref(<feature>)?` (optional for
     now; the other feature must exist and be referenceable);
   - `?` optional, `!unique` unique per tenant (string, int).
   Don't add `id`, `ownerId`, `teamId`, timestamps or `deletedAt`: every
   feature has them.
3. **Who sees what.** By default the creator owns a record (`mine`); editors
   change their own, viewers read all. Ask if records belong to the creator's
   team (`--team`, the `inMyTeams` condition) and whether deleting should go
   to a recycle bin (default) or be final (`--no-soft-delete`).
4. **What it needs** (`--with`): tags, comments, attachments, revisions
   (history and restore), pdf (a document of a record), bulk (act on many),
   watch (be notified of changes), search, transfer (CSV/Excel export and
   import), custom (fields administrators add at runtime, no migration).
   Only what they need. Ask two more, by name:
   - **"Do API clients need webhooks for its changes?"** → `events`
     (`<item>.created`, `.updated`, `.deleted`, `.restored` webhooks, sent to
     the API client that owns the record).
   - **"Human-readable numbers?"** (`INV-2026-00042`, gapless per tenant) →
     `numbered`; ask the prefix (default: the name's first letters) and
     whether the year restarts it, and set `number: { prefix, perYear, width }`
     in the declaration.
5. **Business rules.** What must be true on create and update, what happens
   after (notifications, webhooks, workflows, approvals), anything slow
   (that goes to a queue worker, never the request: CLAUDE.md).

## 2. Confirm the command

Show the exact command and what it will write, e.g.:

```bash
pnpm feature:add invoices --team --with comments,attachments,pdf \
  --fields "number:string!unique,customerId:ref(customers)?,total:money,dueOn:date,status:enum(draft|sent|paid)" \
  --description "Invoices sent to customers"
```

Wait for the user's go-ahead.

## 3. Generate, in a worktree

Follow CLAUDE.md's git workflow (a branch in a worktree, never `main`), then:

```bash
pnpm feature:add <name> …      # the standard parts, appended to features/index.ts
pnpm db:generate               # its migration: review the SQL, commit apps/api/drizzle/
pnpm client:generate           # the typed client
```

The generator prints the texts it added in English to other locales: tell
the user they are to translate.

## 4. Write the business logic, and only that

- In `<x>.service.ts`, where it says `// Business logic:` (before the
  transaction, inside it, before an update). Keep writes in the one
  transaction with the audit entry.
- Use the template's tools instead of new code; CLAUDE.md's map points to
  each doc: notifications (`docs/notifications.md`), outgoing webhook events
  and workflows (`docs/background-work.md`), approvals (`docs/approvals.md`),
  settings and flags (`docs/settings.md`), numbers (`docs/sequences.md`),
  money (`docs/money.md`), custom fields (`docs/custom-fields.md`).
- New rules on fields (lengths, formats, examples) go in `<item>.schemas.ts`;
  extra filters in `<item>.list.ts`; field-level permissions and conditions
  in `<item>.policy.ts`.
- Add tests for each rule to the generated `test/<x>.e2e-spec.ts`.

## Changing an existing feature

When the feature exists ("add a due date to invoices", "add tags to
tickets"), don't regenerate it and don't edit its table, schemas, list or
module: its `features/<x>/<item>.record.ts` declares its fields and
capabilities, and everything else derives from it.

1. Ask only what's missing (the field's type, optional or a default; which
   capability).
2. Edit the declaration: a field line (`dueOn: field.date().optional()`), or a
   name in `capabilities` (search: mark searched fields `.searchable()`; pdf
   needs attachments; numbered: a `number: { prefix: 'INV' }` line, and
   the records already there stay without a number).
3. `pnpm feature:sync`: it writes the texts and OpenAPI paths, and its guard
   refuses a new required field without `.default(…)`, an optional field made
   required, or a removed field. Follow what it says (expand/contract for
   removals: docs/pitfalls.md); never force past it.
4. `pnpm db:generate` and `pnpm client:generate` when it says so; review the
   SQL.
5. Business rules for the new field or capability go in the service as in
   step 4 below; the capability's tests come with it
   (`describeCapabilities` in the feature's e2e spec).

## 5. Check and hand back

Run the check before every commit (CLAUDE.md: build, lint, test, test:e2e,
db:check, client:check), commit, push, open the pull request. Tell the user
what was generated, what you wrote by hand, and which texts await
translation.
