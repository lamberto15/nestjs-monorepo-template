# The monorepo

One repository, one lockfile: a [pnpm workspace](https://pnpm.io/workspaces)
whose tasks [Turborepo](https://turborepo.dev) runs. The layout is in
[architecture](architecture.md), "The repository".

| Package                                | Where                 | What                                                              |
| -------------------------------------- | --------------------- | ----------------------------------------------------------------- |
| `@nestjs-monorepo-template/api`        | `apps/api`            | the NestJS app (API, workers, migrations)                         |
| `@nestjs-monorepo-template/api-client` | `packages/api-client` | the typed client, for frontends and scripts                       |
| `@nestjs-monorepo-template/web`        | `apps/web`            | the web app: React, Vite, TanStack Router and Query               |
| `@nestjs-monorepo-template/web-e2e`    | `apps/web-e2e`        | the web app's Playwright tests (browser end-to-end, axe)          |
| `@nestjs-monorepo-template/ui`         | `packages/ui`         | shared components: shadcn/ui (Base UI) and Dice UI, as source     |
| the root (`nestjs-monorepo-template`)  | `.`                   | the scripts, tooling (Turborepo, oxlint, Prettier), Compose, docs |

## Commands

Run everything from the root. The root's scripts keep their names; each hands
its work to the packages:

| Root script                                                                                                                        | Runs                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`                                                                            | `turbo run <task>`: the task in every package that has it, dependencies first                                                                   |
| `pnpm dev`, `pnpm dev:api`, `pnpm dev:web`                                                                                         | `turbo run dev --env-mode=loose` in every app, or `--filter` one: the API's `nest start --watch` and the web's `vite` (the client builds first) |
| `pnpm start:dev`, `pnpm start:debug`, `pnpm db:*`, `pnpm migrate`, `pnpm openapi:dump`                                             | `pnpm --filter @nestjs-monorepo-template/api <script>`, in `apps/api`                                                                           |
| `pnpm client:generate`, `pnpm client:check`                                                                                        | the API's dump, then the client's generator                                                                                                     |
| `pnpm changeset`, `pnpm client:publish`, `pnpm release:notes`                                                                      | the client's changesets and its publish (CI's), a template release's notes ([releases](releases.md))                                            |
| `pnpm services:up` / `services:down`, `pnpm format`                                                                                | at the root                                                                                                                                     |
| `pnpm setup`, `pnpm feature:add` / `feature:sync` / `feature:remove`, `pnpm deploy:rolling` / `deploy:blue-green` / `deploy:swarm` | Node scripts in `tools/` (the first-run wizard, the feature generator, the zero-downtime deploys)                                               |

- **One package:** `pnpm --filter <name> <script>`, e.g. `pnpm --filter
@nestjs-monorepo-template/api test src/core/http/route-key.spec.ts`.
- **Nest CLI:** inside the app, `cd apps/api && pnpm exec nest g service
features/x`. `nest g library` writes `apps/api/libs/` and its alias into
  `apps/api/tsconfig.json`, which the build and Vitest both read.
- **Dependencies:** `pnpm add <pkg> --filter @nestjs-monorepo-template/api`
  (or the package you're in). The root holds tooling only (`pnpm add -D -w`).
  The lockfile pins every version; Dependabot updates the whole workspace.

## Turborepo

`turbo.json` declares the tasks:

| Task       | Before it                                          | Cached                                          |
| ---------- | -------------------------------------------------- | ----------------------------------------------- |
| `build`    | the dependencies' `build` (`^build`)               | `dist/**`; tests and docs don't change its hash |
| `lint`     | `^build` (the API's tests read the client's types) | yes                                             |
| `test`     | `^build`                                           | yes                                             |
| `test:e2e` | `^build` (the API's e2e imports the built client)  | no: it needs Docker or the services             |
| `dev`      | `^build` (the apps run on the built client)        | no: persistent, it runs until stopped           |

- A task whose inputs (its package's files, its dependencies' builds, the
  lockfile, `.oxlintrc.json`) didn't change is replayed from `.turbo/cache`:
  `pnpm build` twice ends with `FULL TURBO`. `--force` runs it anyway.
- The cache is per checkout (`cacheDir` is set): a worktree doesn't replay
  another's outputs.
- **Environment:** Turborepo hands a task only the variables it declares
  (strict mode), plus the system's (`PATH`, `HOME`, `DOCKER_*`, `CI`…).
  `test:e2e` passes `REDIS_URL`, `TEST_DATABASE_URL`, `TEST_LOGS`. A
  frontend's build-time variable (`VITE_API_URL`…) goes into its task's
  `env`, so a change rebuilds it. The `pnpm --filter` scripts (`start:dev`,
  `migrate`) see the whole shell, and so do the `dev` scripts: they pass
  `--env-mode=loose` (Turborepo's flag for it), because the `dev` task is
  never cached, so there's no hash to protect, and the API reads well over
  a hundred variables (each feature may add more) that a shell or the
  devcontainer sets over `apps/api/.env.development`: a `passThroughEnv`
  list would drift. In strict mode they'd vanish (`DATABASE_URL: expected
string`).
- CI keeps the cache between runs (`actions/cache`, `.github/workflows/ci.yml`).

## The web app

`apps/web` is a React single-page app on the typed client; `packages/ui`
holds its components. It talks to the API only through REST and socket.io,
same-origin: in development through Vite's proxy, in production through
Caddy.

### Running it

```bash
pnpm services:up          # PostgreSQL, Redis, Mailpit, Floci, Gotenberg
pnpm dev                  # the API on :3000 and the web app on http://localhost:5173
pnpm db:seed:demo         # optional, from a second terminal: the demo tenant and its members
```

`pnpm dev` runs Turborepo's `dev` task in both apps (the client is built
first); `pnpm dev:api` or `pnpm dev:web` runs one. Every screen of the
web app needs the API, so `dev:web` alone suits an API already running.

- **Open http://localhost:5173**, not the API's port: Vite's `server.proxy`
  (`vite.config.ts`) sends `/v1`, `/health` and `/socket.io` (`ws: true`) to
  `http://localhost:3000` (`API_URL` in the environment points it at another
  port: the browser tests do), so the `__Host-sid` cookie is the app's own.
  Swagger UI stays at http://localhost:3000/api.
- **Signing in:** the administrator the API's first start creates
  (`ADMIN_EMAIL`, `admin@example.com` unless set; the password is
  `ADMIN_PASSWORD` in `apps/api/.env.development` when `pnpm setup` wrote it,
  otherwise logged once in the API's output). That account is in the
  operators' tenant, which holds no demo data. For a populated app, run
  `pnpm db:seed:demo` and sign in as one of the members it prints
  (`<first>.<last>@demo.example.com`, passwords printed once): the
  administrator sees every screen, the editors and the viewer see what their
  roles allow ([development](development.md), "Demo data").
- **Mail** (invitations, magic links, password resets, verification) is in
  Mailpit, http://localhost:8025; its links open the web app (`WEB_URL`,
  `http://localhost:5173` in `apps/api/env.development.example`).
- **What shows** follows the API: `GET /v1/features` (the deployment
  switches, `REPORTS=off` hides the reports page…) and `GET /v1/auth/me`'s
  `can` (the permissions). Hiding is for the user; the API refuses either way.
- **In the devcontainer** `pnpm dev` runs it too, at the same address
  (port 5173 is forwarded; [development](development.md), "Devcontainer").

### What's in it

| Area           | Routes (`src/routes`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Code                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed out     | `/sign-in` (password, magic link, passkey, the providers, two-factor, Turnstile when on), `/sign-up`, `/forgot-password`, `/reset-password`, `/magic-link`, `/verify-email`, `/accept-invitation`, `/cancel-deletion`                                                                                                                                                                                                                                                                                                                 | `components/auth`, `lib/sign-in.ts`, `lib/passkeys.ts`                                                                                                                    |
| Account        | `/account/profile` (name, language, time zone), `/account/security` (two-factor, password, passkeys, sessions), `/account/notifications` (notification preferences), `/account/preferences` (the settings a user sets for themself), `/account/privacy` (data export, consents, account deletion), `/account/watching` (the records watched, with a stop button)                                                                                                                                                                      | `routes/_app/account`, `components/account`, `features/notifications`, `features/settings`, `features/watching`                                                           |
| Workspace      | `/notes` (list, detail, new, edit; the example), `/notifications` (inbox; the bell, live over realtime), `/approvals` (inbox and detail: approve, reject, request changes, resubmit, cancel, abandon; delegations), `/transfers` and `/transfers/import`, `/reports`                                                                                                                                                                                                                                                                  | `features/*`                                                                                                                                                              |
| Administration | `/access/users` (members, invitations, roles and grants, impersonation), `/access/roles`, `/access/teams`, `/api-clients` (keys, quotas) and `/api-clients/usage`, `/webhooks` (per API client: endpoints, deliveries), `/audit`, `/settings` (values, overrides, feature flags), `/tenants` (operators only, multi-tenant deployments: list, create), `/custom-fields` (define, order, deactivate), `/approval-policies` (the approvable actions: a policy's stages, approver rules, modes, conditions; reset to the code's default) | `features/access`, `features/api-clients`, `features/webhooks`, `features/audit`, `features/settings`, `features/tenants`, `features/custom-fields`, `features/approvals` |
| Everywhere     | the search palette (Cmd/Ctrl+K), the tenant switcher, the impersonation banner, the re-authenticate dialog (step-up)                                                                                                                                                                                                                                                                                                                                                                                                                  | `features/search`, `components/`                                                                                                                                          |

### How it's built

- **Stack:** Vite, TanStack Router (file routes in `src/routes`, code
  splitting, `routeTree.gen.ts` written by its Vite plugin and committed),
  TanStack Query, TanStack Form (`lib/form.tsx`), TanStack Table under Dice
  UI's data table, nuqs (URL state), react-i18next, Tailwind 4, sonner
  (toasts), zod (imported from `@/lib/zod`, see [deployment](deployment.md),
  "Caddy serves the web app too").
- **Calls the API** through `src/lib/api.ts`: the typed client with `baseUrl:
''` and `credentials: 'include'`, plus a middleware that answers 403
  `reauthentication_required` with the re-authenticate dialog and retries.
  Errors go through `lib/errors.ts` (TanStack Query's cache `onError`): a 401
  while signed in ends the session (to sign-in, back to the page after),
  anything else is a toast with the problem's `detail` unless the query sets
  `meta: { errorToast: false }`.
- **Routes:** `__root.tsx` (router context `{ queryClient, session }`),
  `_app.tsx` (the signed-in layout and its guard, shadcn's `sidebar-07`
  block), `_app/index.tsx` (dashboard), the signed-out pages beside them. A
  new page is a file there.
- **Menu:** a feature's entries are `features/<feature>/nav.ts` (default
  export: one entry or an array; `group`, `order`, `to`, an i18n `label`,
  `icon`, optional `feature`, `permission` (one, or a list: any of them)
  and `badge`, a hook giving a count). `src/nav.ts` collects them (`import.meta.glob`) into the groups
  `workspace`, `administration`, `operators` (sorted by `order`; a group with
  nothing visible is hidden), so a feature never edits a shared file.
- **Gates:** `useFeature('<switch>')` and `<Feature>`, `useCan('<Subject>.<action>')`
  (`lib/features.tsx`), from `GET /v1/features` and `/v1/auth/me`. A route's
  `beforeLoad: requirePermission(...permissions)` (`features/access/gate.ts`)
  admits whoever holds any of them: the users page is for whoever manages
  users or teams or impersonates (the API's `AccessPolicy.open`), read-only
  without manageUsers; the teams page for whoever manages teams or users.
- **Resending the verification email** (`components/auth/resend-verification.tsx`):
  `POST /v1/auth/email/verification` needs a session, so the button is for
  a signed-in user whose `emailVerified` is false: a banner in the signed-in
  layout and the verify-email page. A toast on success; a 429 turns the
  button off for the limit's 15 minutes. Nobody signed in has no session to
  ask with (sign-in refuses an unproved password account), so the sign-up and
  sign-in pages cannot offer it until the API has a public resend.
- **Realtime** (`lib/realtime.tsx`): one socket per signed-in session when
  `realtime` is on, reopened when the session changes (tenant switch,
  re-authentication, impersonation); `useRealtimeEvent()` reads it. The
  notifications are refetched on every reconnect.
- **Lists** (`components/list-page.tsx`): `<ListPage subject path columns
title …>` is a server-paginated, filterable, sortable list of any subject;
  its filters, sorts, custom-field columns and tag filter come from
  `GET /v1/lists/{subject}`, its state is in the URL
  ([api-conventions](api-conventions.md), "Using it from a data table").
  A field with a `ref` (`lib/list-refs.tsx`) gets a picker instead of a text
  box, by its kind: `tag` (the subject's tags), `team` (`GET /v1/access/teams`;
  without access to it, only "is empty"), `principal` (users searched by name,
  `GET /v1/people`). One the caller declared no column for is added: filter
  only when `fields=` can't pick it (`tag`), else a column hidden at first
  showing names (`ownerId`, `teamId`; the value itself when its name is
  unknown). Labels: `list.fields.<name>` in `common`. Another `ref` (a
  record's subject) keeps the field's own filter.

- **Webhooks** (`features/webhooks`): managed per API client, as the API's
  `/v1/access/clients/{clientId}/webhook-endpoints` and `…/webhook-deliveries`
  routes are (`Access.manageClients`, WEBHOOKS and API_CLIENTS on).
  `/webhooks` picks the client, `/webhooks/{clientId}` lists its endpoints,
  `/webhooks/{clientId}/{id}` is one endpoint with its paged deliveries. The
  signing secret (create, rotate) is shown once in a dialog and kept in no
  cache (`gcTime: 0`, reset on close). A delivery's payload, headers and the
  receiver's response are remote text: rendered in `<pre>`, never as markup.
  The deliveries are not a `ListPage` (their route takes a `clientId` and the
  API has no `GET /v1/lists/WebhookDelivery`): a status filter and numbered
  pages over `page` and `count`.

### Languages

`src/locales/<lng>/<ns>.json` for the API's five locales (`en`, `de`, `ar`,
`zh`, `ms`); every file is the namespace `<ns>` (loaded eagerly,
`import.meta.glob` in `i18n.ts`). A feature's texts:
`locales/<lng>/<feature>.json`, used with `useTranslation('<feature>')`;
`common` is the default; `nav` holds the group titles. A key missing in a
language falls back to `en`. `en` is complete; the others are copies of it
until translated. `<html lang>` and `dir` (`rtl` for `ar`) follow the language; the
theme (light, dark, system) is a class on `<html>`.

### Components

Components come from the CLIs, never by hand: run them in `apps/web`
and the files land in `packages/ui/src/components` (imports
`@nestjs-monorepo-template/ui/components/<name>`):

```bash
cd apps/web
pnpm dlx shadcn@4.22.0 add button          # shadcn/ui, style base-nova (Base UI)
pnpm dlx shadcn@4.22.0 add @diceui/<name>  # Dice UI (https://diceui.com): look here first
```

Both packages have a `components.json` with the same style, icon library
and base colour. Prettier skips `packages/ui` and the lint rules are
relaxed there, so a CLI update stays a clean diff.

### Record pages

What a feature's record pages share; `features/notes` and
`routes/_app/notes/` are the example to follow.

- **What one record allows** (`useRecordCan('<Subject>')` in `lib/records.ts`):
  read records with `?include=can` (detail and list, see `features/notes/api.ts`)
  and gate edit, delete and restore on `canOf(record)`, which is the record's
  own `can` (a published note an editor may no longer change) and falls back to
  `/me.can` for a record read without it. A create answers with the ETag a read
  would: `seedCreatedNote()` puts the note and that ETag in the cache, so the
  page it opens and a first edit (`If-Match`) need no second read. Text limits
  (`NOTE_LIMITS`) mirror the schema's `maxLength`; a test compares them with
  `packages/api-client/openapi.json` (importing that 1 MB file would bloat the
  bundle).
- **Custom fields in a record form and view** (`components/records/custom-field-inputs.tsx`,
  `custom-field-values.tsx`, `lib/custom-values.ts`): `GET /v1/custom-fields?subject=`
  (any reader of the subject) gives the active definitions. `<CustomFieldInputs
fields value onChange errors />` is a typed input per field (the drafts and
  their checks, `draftErrors`, `customBody`, are in `lib/custom-values.ts`: a
  create sends the values that differ from the defaults, an edit only the keys
  that changed, `null` for one emptied; the API's `custom.<key>` errors map back
  with `serverErrors`), and `<CustomFieldValues subject values />` the values as
  detail items. The notes form and page are the example. The admin page is
  `features/custom-fields`: a feature that takes custom fields registers its
  subject in `features/<feature>/custom-fields.ts` (default export), as the API has
  no list of them yet.
- **Record panels** (`components/records/panels/`): comments with
  @mentions, attachments, tags and revisions on a record's detail page. A
  feature mounts them with one element, each panel shown only when the
  subject takes it and the user may read the record (writes need
  `<Subject>.update`):

  ```tsx
  <RecordPanels
    subject="Note"
    path="/v1/notes/{id}"
    id={note.id}
    tags={note.tags}
    canUpdate={canUpdate}
  />
  ```

  Which panels a subject takes is the API's `capabilities` in
  `GET /v1/lists/{subject}` (from its `<item>.record.ts`), and uploads are
  held to its `attachmentLimits` (size, types). @mentions search
  `GET /v1/people?q=` (any member) and write `@user:<id>`; authors are the
  API's `authorName` and `changedByName`. Comments and files reload on the
  realtime events `record.commented` and `record.attachments.changed`
  (polled only without realtime). Texts are in the `records` namespace. Pass
  `canUpdate` (the record's own `can.update`) when the page has it: the
  panels' writes take the record's PATCH check, conditions included. Tests:
  `usePanelsApi()` (`test/panels-api.ts`) serves the panels' routes for a
  test-only subject; a feature's test description spreads
  `panelsDescription()`.

- **Watching** (`components/records/watch-button.tsx`, `features/watching`):
  `<WatchButton subject path id />` in a record page's header is the
  Watch / Stop watching toggle, shown only when the subject's `capabilities.watch`
  is true and the user may read the record; it calls the record's
  `POST`/`DELETE …/watch`. The record carries no "watching" flag, so the state
  is `GET /v1/subscriptions?subject=&recordId=`. `/account/watching` lists
  `GET /v1/subscriptions` (cursor pages) with `DELETE
/v1/subscriptions/{subject}/{recordId}`. The list knows only a subject and an
  id: a feature with record pages registers where a record opens and how to
  name it in `features/<feature>/record-link.ts` (default export
  `{ subject, path(id), title(id) }`, as `nav.ts` registers the menu); without
  it a row shows the subject and the id. Tests: `subscriptionsHandlers()`
  (`test/subscriptions.ts`), and `panelsDescription({ watch: true })` for a
  subject that takes it. Texts are in the `watching` namespace.
- **Data transfer and bulk work on a list page** (`routes/_app/notes/index.tsx`
  is the example): `ListPage`'s `listActions` gets the list's `params`, for
  `<ExportButton exporter="notes" filters={exportFilters(params)} />` and
  `<ScheduleReportButton …/>` (each shown only when `GET /v1/data` lists the
  export); `<ImportButton importer="notes" />` links to `/transfers/import`.
  `bulkActions` turns on row selection and Dice UI's action bar:
  `useBulkActions('/v1/notes/bulk', specs)` gives its `render` and the
  `dialogs` to mount next to the list (confirmation, then the run: 200 at
  once or a 202 job polled at `GET /v1/bulk/{id}`). Selecting the whole page
  of a filtered list offers "all N matching", a run by the list's filter.
  `/transfers` lists the exports and imports this browser started (the API
  has no list of them yet), `/reports` the scheduled reports (`REPORTS=off`
  hides it).
- **Picking people and API clients** (`components/principal-picker.tsx`,
  `lib/principals.ts`): `<PrincipalPicker>` searches
  `GET /v1/access/principals?q=` as one types (Dice UI's combobox); its value
  is the principal's `key` (a setting's `scopeId`) or, with `by="id"`, the
  user's id. `principalDirectoryQuery()`
  reads them all to name ids (comment authors, mentions, a setting's
  overrides). The route answers only callers who may list users or clients;
  for anyone else the picker says so and the directory is empty. In tests,
  `principalsHandler()` (`test/principals.ts`) answers it.
- **Picking a member, for any member** (`components/person-picker.tsx`,
  `lib/people.ts`): `<PersonPicker>` searches `GET /v1/people?q=` (active
  members, a key and a name; every member may read it), the same combobox;
  its value is the key, `user:<id>` (`personUserId()` strips the prefix). The
  approvals' delegate picker and the comments' @mentions use it. In tests,
  `peopleHandler()` (`test/people.ts`) answers it.
- **Search palette** (`features/search`): the header's search button and
  Cmd/Ctrl+K open it. Typing calls `GET /v1/search` (debounced, grouped by
  subject); `>` lists the nav entries the user sees. Snippets keep only
  `<b>` (as `<mark>`, everything else stays text) and a hit's `link` is
  followed only when it is a path of this app. A searchable feature names
  its group in `locales/<lng>/search.json`, `subjects.<Subject>`; without
  it the subject itself is shown.
- **Audit log** (`features/audit`, `/audit`): `GET /v1/access/audit` with
  filters and server paging, for `Access.readAudit` only (nav entry and
  route gate).

### Tests

`pnpm test` runs them with every package's; one package or one file:

```bash
pnpm --filter @nestjs-monorepo-template/web test
pnpm --filter @nestjs-monorepo-template/web test src/features/notes/notes.test.tsx
```

Vitest in jsdom with Testing Library and [msw](https://mswjs.io): tests sit
next to the code (`*.test.ts(x)`); most render the whole app at a path
rather than a component alone.

- **`renderApp(path)`** (`src/test/render-app.tsx`): the app with every
  provider, the router on a memory history, English texts, queries without
  retries; returns `{ router, queryClient, history }`. It waits for the first
  navigation (the session) before rendering.
- **The API is msw** (`src/test/server.ts`): the defaults answer as nobody
  signed in; a test overrides with `server.use(http.get(…))`. A request no
  handler answers fails the test (`onUnhandledFrame: 'error'`). Helpers:
  `signedInUser`, `allFeatures`, `allMethods`, `problem(status, code)`;
  `useSignedIn(can)` (`test/signed-in.ts`: signed in with these permissions,
  and what every page asks), `panelHandlers()` / `usePanelsApi()`
  (`test/panels-api.ts`, on the test-only record `TEST_RECORD` unless given a
  feature's), `principalsHandler()` (`test/principals.ts`),
  `peopleHandler()` (`test/people.ts`),
  `createFakeRealtime()` (`test/fake-realtime.ts`: emit what the API would push).
- **`renderComponent(ui, { can })`** (`src/test/render-component.tsx`): one
  shared component with the app's providers and a router for its links, no
  page around it. Shared code is tested this way on a test-only subject
  (`TestItem`, `/v1/test-items`), as the API's tests are, so it needs no
  feature; a feature's pages are tested in its own folder
  (`features/notes/notes.test.tsx`, its helpers in `features/notes/test/`),
  which `pnpm feature:remove` takes with it.
- **`findToast(text)`** (`src/test/toast.ts`) waits until a sonner toast is
  visible: sonner mounts it hidden, so `findByText` alone may return it
  before `toBeVisible()` holds.
- **Timing** (`vitest.config.ts`, `src/test/setup.ts`): `maxWorkers: '50%'`,
  because `pnpm test` runs every package's Vitest at once; `testTimeout`
  15 s and Testing Library's `asyncUtilTimeout` 3 s, headroom for a loaded
  machine; `fsModuleCache: false`, since Vitest's module cache kept stale
  `import.meta.glob` results (the nav and the locales). The setup also stubs
  what jsdom lacks (`matchMedia`, pointer capture, `ResizeObserver`,
  `scrollIntoView`) and dismisses toasts between tests.

### Adding a page for a feature

`pnpm feature:add` writes the API side only; the web side is written by
hand, after `pnpm client:generate` (the client then types the new routes):

1. `features/<feature>/`: its queries (`api.ts`, as `features/notes/api.ts`:
   `?include=can`, the keys of `lib/records.ts`), its forms and its
   `nav.ts`.
2. `routes/_app/<plural>/`: `index.tsx` (a `ListPage`), `$id/index.tsx`
   (the detail with `RecordPanels`), `new.tsx`, `$id/edit.tsx`. The router's
   plugin rewrites `routeTree.gen.ts` while `pnpm dev:web` or the build runs;
   commit it.
3. `locales/<lng>/<feature>.json` in every language, and the group name in
   `search.json` if it is searchable.
4. A test with `renderApp()` and msw handlers for its routes, in
   `features/<feature>/` with its helpers (`features/<feature>/test/`).

`pnpm feature:remove <plural>` takes these paths, by this convention, with
the API's part (docs/adding-a-feature.md).

### Scripts and production

- **Scripts:** `dev` (`vite`), `build` (`vite build && tsc -b`, to `dist/`:
  Vite first, as TanStack Router's examples do, since its plugin regenerates
  `routeTree.gen.ts` that the type check reads),
  `preview`, `lint` (type-aware oxlint), `test` (`vitest run`). Turborepo
  builds the client first. `packages/ui` has `lint` and `typecheck`.
- **Production:** `caddy/Dockerfile` builds the app into the Caddy image,
  which serves it next to the API ([deployment](deployment.md)). The API's
  image leaves `apps/web` and `packages/ui` out (`.dockerignore`).

## Adding another frontend app

Any framework fits the same way.

1. **Create it in `apps/`** with its own tool (`pnpm create vite apps/admin`,
   `pnpm create next-app apps/admin`…), `"private": true`, named
   `@nestjs-monorepo-template/<name>`.
2. **Depend on the client** (and `@nestjs-monorepo-template/ui` for the
   components) through the workspace, then `pnpm install`:

   ```json
   "dependencies": {
     "@nestjs-monorepo-template/api-client": "workspace:*",
     "socket.io-client": "4.8.4"
   }
   ```

   `socket.io-client` only for realtime (`createRealtime()`). Nothing is
   published: pnpm links the package.

3. **Scripts:** `build`, `lint`, `test` as the framework names them;
   Turborepo builds the client first (`^build`). Add the framework's output
   to `build.outputs` in `turbo.json` when it isn't `dist/` (Next.js:
   `".next/**", "!.next/cache/**"`). The `dev` task exists
   (`{ "dependsOn": ["^build"], "cache": false, "persistent": true }`): give
   the app a `dev` script and `pnpm dev` starts it with the others; add a
   root script like `dev:web` to run it alone. A build-time variable
   (`VITE_API_URL`…) goes into the build task's `env`.
4. **Call the API** with the typed client
   ([its README](../packages/api-client/README.md)):

   ```ts
   import {
     createApiClient,
     unwrap,
   } from '@nestjs-monorepo-template/api-client';

   const api = createApiClient({ baseUrl: '', credentials: 'include' });
   const note = await unwrap(
     api.GET('/v1/notes/{id}', { params: { path: { id } } }),
   );
   ```

   Paths, parameters and answers are checked by TypeScript (`moduleResolution`
   `bundler` or `nodenext`).

5. **Origins:** in development a dev-server proxy to `http://localhost:3000`
   (as `apps/web`), or call the API directly with the app's origin in
   `CORS_ORIGINS` and `WEB_URL` (`apps/api/.env.development`; the example has
   `http://localhost:5173`). In production, `CORS_ORIGINS` and `WEB_URL` in
   `.env`, or serve it from Caddy like `apps/web`.
6. **Keep the client current:** after a route change, `pnpm
client:generate` (commit `packages/api-client/openapi.json` and
   `src/schema.ts`), then `pnpm build`: the frontend's type check shows what
   the change broke. A running dev server sees the client's new `dist/`
   after `pnpm --filter @nestjs-monorepo-template/api-client build`.
7. **Deploy it** on its own (its image, a static host, a platform), or into
   Caddy's image as `apps/web` is. The API's image is unaffected: `pnpm
deploy` takes only the API's dependencies.

## A checkout from before the monorepo

The app's own files moved into `apps/api`. Once, from the root:

```bash
mv .env.development apps/api/   # the development settings, if you have them
mv .data apps/api/              # local files and mail written in development, if any
pnpm install
```

The old root `dist/` is unused (delete it). The production `.env` stays at
the root, and `docker compose up -d --build` deploys as before.
