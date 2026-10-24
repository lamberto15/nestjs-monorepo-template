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
| `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm test:e2e`, `pnpm test:e2e:web`                                                                            | `turbo run <task>`: the task in every package that has it, dependencies first                                                                   |
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
| `build`    | the dependencies' `build` (`^build`)               | `dist/**`, `*.tsbuildinfo`; tests and docs don't change its hash |
| `lint`     | `^build` (the API's tests read the client's types) | yes                                             |
| `test`     | `^build`                                           | yes                                             |
| `test:e2e` | `^build` (the API's e2e imports the built client)  | no: it needs Docker or the services             |
| `test:browser` | the API's and the web app's `build`            | no: the Playwright tests of `apps/web-e2e`      |
| `dev`      | `^build` (the apps run on the built client)        | no: persistent, it runs until stopped           |

- A task whose inputs (its package's files, its dependencies' builds, the
  lockfile, `.oxlintrc.json`) didn't change is replayed from `.turbo/cache`:
  `pnpm build` twice ends with `FULL TURBO`. `--force` runs it anyway.
- The cache is per checkout (`cacheDir` is set): a worktree doesn't replay
  another's outputs.
- **Environment:** Turborepo hands a task only the variables it declares
  (strict mode), plus the system's (`PATH`, `HOME`, `DOCKER_*`, `CI`…).
  `test:e2e` passes `REDIS_URL`, `TEST_DATABASE_URL`, `PGPASSWORD`, `TEST_LOGS`. A
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

Every production web build also writes `apps/web/.bundle-analysis/bundle.json`
outside `dist/`. It records each JavaScript chunk's raw/gzip/Brotli size and
the rendered bytes of its modules, so it is measurement evidence rather than a
deployed asset. The Web workflow shows the largest chunks/modules in its job
summary and uploads the complete report for 14 days. The existing Size Limit
budget remains the blocking aggregate guard; use the report before choosing a
manual chunk boundary instead of raising Vite's warning limit blindly.

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
  (`dev-proxy.ts`, used by `vite.config.ts`) sends `/v1`, `/health`, `/files`
  and `/socket.io` (`ws: true`) to `http://localhost:3000` (`API_URL` in the
  environment points it at another port: the browser tests do), so the
  `__Host-sid` cookie is the app's own. A redirect from `/v1` to the API's own
  address (the signed link an attachment's download, thumbnail or preview
  answers with: `APP_URL`, `http://localhost:3000` by default) is rewritten to
  the page's origin (`autoRewrite`), and `/files` serves it: an `<img>` could
  not load a link on the API's port, whose responses are `same-origin` for
  `Cross-Origin-Resource-Policy`. Swagger UI stays at http://localhost:3000/api.
- **Signing in:** the administrator the API's first start creates
  (`ADMIN_EMAIL`, `admin@example.com` unless set; the password is
  `ADMIN_PASSWORD` in `apps/api/.env.development` when `pnpm setup` wrote it,
  otherwise logged once in the API's output). That account is in the
  operators' tenant, which holds no demo data. In production the first
  sign-in is the onboarding step (docs/auth.md); locally
  `ADMIN_ONBOARDING=off` skips it. For a populated app, run
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

| Area           | Routes (`src/routes`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Code                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed out     | `/sign-in` (password, magic link, passkey, the providers, SSO by email, two-factor, Turnstile when on), `/sign-up` (with `tenantSignUp` in `GET /v1/auth/methods` it also asks for the new tenant's name, sent as `tenantName` and omitted when empty; sign-in then starts in the account's only tenant), `/forgot-password`, `/reset-password`, `/magic-link`, `/verify-email`, `/accept-invitation`, `/cancel-deletion`, `/unsubscribe` (the mail footer's link: says which mail it stops, and a button that POSTs the token)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `components/auth`, `lib/sign-in.ts`, `lib/passkeys.ts`                                                                                                                                                                              |
| Account        | `/account/profile` (name, language, time zone), `/account/security` (two-factor, password, passkeys, connected sign-in providers, sessions), `/account/notifications` (notification preferences, the SMS number with its confirmation code, the push devices), `/account/preferences` (the settings a user sets for themself), `/account/privacy` (data export, consents, account deletion), `/account/watching` (the records the user watches)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `routes/_app/account`, `components/account`, `features/notifications`, `features/settings`                                                                                                                                          |
| Workspace      | `/notes` (list, detail with the AI helper's Summarize and Classify (`features/ai`, [ai](ai.md)), new, edit; the example), `/notifications` (inbox; the bell, live over realtime), `/approvals` (inbox and detail: approve, reject, request changes, resubmit, cancel, abandon; delegations), `/transfers` and `/transfers/import`, `/reports`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `features/*`                                                                                                                                                                                                                        |
| Administration | `/access/users` (members, invitations, roles and grants, impersonation), `/access/roles`, `/access/teams`, `/api-clients` (keys, quotas), `/api-clients/$id` and `/api-clients/usage`, `/webhooks` (per API client: endpoints, deliveries) and `/webhooks/senders` (incoming-webhook senders), `/audit` (with sub-tenants' entries under `Access.readConsolidated`), `/sign-ins` (sign-in history, `Access.readAudit`), `/retention` (retention rules), `/settings` (values, overrides, feature flags), `/tenants` and `/tenants/$id` (operators only, multi-tenant deployments: list with a deletion-pending badge, create, rename, slug, deactivate and reactivate with `If-Match`, export the tenant's data as a file, delete it after a grace period by typing its slug, and cancel that; the operator tenant has no delete; break-glass access with `Platform.breakGlass`), `/ops` (operators only: job queues, the outbox and its dead letters, a live event log), `/mail-suppressions` (the mail suppression list: filter by address, reason and status, add an address, remove one after a confirmation; operators' tenant with `MailSuppression.view`, any tenancy), `/custom-fields` (define, order, deactivate), `/tags` (rename, recolour, describe, delete; `Access.manageTags`), `/naming-series` (Numbering: the number formats of numbered records, the default, a live preview, the counter; `Access.manageNamingSeries`), `/approval-policies` (the approvable actions: a policy's stages, approver rules, modes, conditions; reset to the code's default), `/sso` (single sign-on, `Access.manageSso`: tabs for the identity-provider connections (with each one's group-to-role mappings), the email domains, the policy (with granting and ending exemptions) and SCIM), `/legal-holds` (`Access.manageLegalHolds`: active and released holds filtered by status and subject, a hold's detail, place one on a record or a whole subject, release one with a note; [retention](retention.md)) | `features/access`, `features/api-clients`, `features/webhooks`, `features/audit`, `features/settings`, `features/tenants`, `features/ops`, `features/suppressions`, `features/custom-fields`, `features/tags`, `features/naming-series`, `features/approvals`, `features/sso`, `features/legal-holds`, `features/sign-ins`, `features/retention` |
| Everywhere     | the search palette (Cmd/Ctrl+K), the tenant switcher, the impersonation banner, the read-only banner and the maintenance notice, the re-authenticate dialog (step-up)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `features/search`, `components/`                                                                                                                                                                                                    |

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
  `icon`, optional `feature`, `permission` (one, or a list: any of them),
  `operator` (operators, multi-tenant deployments), `operatorTenant` (users
  acting in the operator tenant, either tenancy) and `badge`, a hook giving a
  count). `src/nav.ts` collects them (`import.meta.glob`) into the groups
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
  button off for the limit's 15 minutes. Nobody signed in has no session, so
  the sign-up "check your mailbox" screen and the sign-in page (after a 403
  `email_unverified`) use `ResendVerificationByEmail` instead:
  `POST /v1/auth/email/verification/resend { email }`, always 202, so one
  neutral line ("If this address has an account waiting for confirmation, we
  sent a new link"); Turnstile action `resend-verification` through
  `useCaptcha`; a 429 locks the button for that address for 15 minutes.
- **The unsubscribe page** (`routes/unsubscribe.tsx`): the "Unsubscribe" link in
  the footer of notification and digest mail ([notifications](notifications.md),
  "Unsubscribe") opens `/unsubscribe?token=…`, public like the other link pages
  (`AuthLayout`, `LinkResult`). Opening it changes nothing (mail scanners follow
  links): it only reads `GET /v1/notifications/unsubscribe/{token}` and shows what
  the link stops above the button (the notification type's label in the UI
  language, or the digest and its modes), keeping the generic text when that read
  fails for any reason (a 400 included, no toast). Its button POSTs
  `{ "List-Unsubscribe": "One-Click" }` to the same path. The API answers every
  refusal (forged, expired, account gone) with the same 400, GET and POST alike, so
  the page can only say "invalid or expired" (no retry); any other failure shows its
  detail and keeps the button. Done and invalid both link on to `/account/notifications`.
- **The breached-password alert** (`components/breached-password-banner.tsx`,
  `features/notifications/breach-alert.ts`): while the user has an unread
  `security.passwordBreached` notification (the API has no `/me` flag for
  it), a red banner in the signed-in layout links to `/account/security`.
  It reads `GET /v1/notifications?read=false&type=…` under the notifications
  `list` key, so the realtime event and every mark-read refresh it (without
  realtime it polls like the inbox). Reading the notification, or changing the password in
  `PasswordSection` (which fetches and marks every unread alert read, with a
  toast if that fails), hides it; none while impersonating.
  In the list the row gets a shield icon, a tint and a "Change your password"
  link to the same page (the API sends the notification without a link).
- **Maintenance and read-only mode** (`lib/mode.ts`, `components/mode-banner.tsx`,
  `components/maintenance-notice.tsx`): `GET /v1/features` carries `mode`
  ([settings](settings.md), "Maintenance and read-only mode"). The signed-in layout
  knows it before its first paint (`_app`'s `beforeLoad` fetches the switches; a
  failure holds nothing back) and keeps it fresh with `useModeWatch()`: when the
  user does something (pointer, keys, scrolling) at least a minute after the last
  answer, when the tab returns after 30 s, and at once when any request is refused
  with 503 `read_only` or `maintenance` (`lib/errors.ts` asks again, and toasts once,
  however many requests were refused). While it is `normal` there is **no timer**: the
  API counts every request as activity, so a poll would keep an unattended tab signed
  in and defeat the idle timeout ([auth](auth.md), "Session lifetime"). Only while it
  is not `normal` it is asked every 15 s (about the `Retry-After` of the refusals, so
  the notice turns into the app by itself); the session's absolute lifetime still ends
  such a tab. The sign-in page does not know it (the switches need a
  session), and sign-in works in both modes.
  - **`read-only`:** `ModeBanner` (a status line like the other banners) and the
    writes are off. `useWritesPaused()` disables `SubmitButton` (every TanStack form),
    `ConfirmButton` and `ConfirmDialog`, the selection's bulk actions, the export and
    watch buttons; the notes pages show the rest (New, Edit, Delete, Restore are
    disabled, viewing is not). A feature's own write button does the same
    (`const paused = useWritesPaused()`, `disabled={paused}`); one left out still
    works, and the API refuses it with 503, which is the toast. A control whose route
    stays open in both modes passes `allowInMaintenance` (as the API's
    `@AllowInMaintenance()`): the confirmations of the ops panels and of the
    operators' platform settings, which is how the mode is turned off again.
  - **`maintenance`:** `MaintenanceNotice` replaces the whole layout (menu, page,
    socket), so nothing asks an API that refuses everything. It offers "Check again",
    "Sign out" and, to an operator who manages settings, "End maintenance"
    (`DELETE /v1/settings/platform.mode/platform`). The API answers 204 whatever it
    removed, so the notice asks for the mode afterwards: still `maintenance` (it is
    forced by `APP_MODE`, which only the environment changes) is an error toast
    saying so, not the success toast. That route is the operator tenant's, and a
    sign-in starts in the tenant the account chose last, so an operator whose
    session acts in another of their tenants first sees "Switch to <operator
    tenant>" (`GET /v1/auth/tenants` says which is one, `operator`; both tenant
    routes stay open in maintenance). Requests the mode refused (503
    `read_only`, `maintenance`) are not retried (`lib/errors.ts`): the refusal says
    to wait, and the mode watch learns when it has ended.
  - **Caddy** serves a static page for the web app's files while `MAINTENANCE_PAGE=on`
    ([deployment](deployment.md), "Maintenance page"); an installed app (the service
    worker) opens its cached shell and shows this notice.
  - **Tests:** `test/mode.test.tsx` (the app on msw: banner, notice, polling, the
    operator's button), `lib/mode.test.tsx` (the controls); a component test sets the
    mode with `renderComponent(ui, { features: { mode: 'read-only' } })`.
- **Realtime** (`lib/realtime.tsx`): one socket per signed-in session when
  `realtime` is on, reopened when the session changes (tenant switch,
  re-authentication, impersonation); `useRealtimeEvent()` reads it. The
  notifications, the panels, the lists of transfers and bulk runs, the
  approvals and the jobs still running are refetched on every reconnect.
  Jobs follow their events: the end (`data.export-ready`,
  `data.import-finished`, `bulk.finished`, `approval.applied`) and the failure
  (`data.failed`, `bulk.failed`) refetch the query of that id (others are left
  alone), and the progress (`data.progress`, `bulk.progress`) is written into
  the cached job or list item (`withProgress()`), so a queued job turns
  running on its first one. With a connected socket nothing is polled;
  `useLivePoll()` makes the poll a fallback: 1 s (2 s in lists) without one
  (`useRealtimeConnected()`), and fast again for a job whose end event came
  but which the queue still reports running. Tests play it with `fake.emit('connect')` / `emit('disconnect')`.
- **The dashboard** (`features/dashboard`, the home page `/`): cards for the
  approvals assigned to the user, their unread notifications, the latest audit
  entries (`Access.readAudit`), the notes changed last and a bar chart of notes
  created per week over eight weeks (`Note.read`), and a quick-actions card.
  Like the menu, the features contribute them: `features/<feature>/dashboard.ts`
  (default export `{ cards, actions }`; a card has an `id`, an `order`, optional
  `feature`, `permission` and `wide`, and a lazy `component`; an action a `to`,
  an i18n `label`, an `icon`), collected by `features/dashboard/registry.ts`,
  so removing a feature takes its cards. A card without its permission or switch
  is not rendered and asks for nothing; each asks only the existing routes
  (`/v1/notes` with `count=true` per week, as there is no aggregate route), its
  failures are quiet (no toast), and its texts are the feature's own namespace
  (`dashboard.*`). The frame, rows and spinner are `features/dashboard/card.tsx`.

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
  record's subject) keeps the field's own filter. For a list under a parent
  (`/v1/access/clients/{clientId}/…`) `pathParams` fills the route's
  placeholders, `query` adds fixed parameters, `headingLevel={2}` and
  `subtitle` fit it under a page's own `h1`, and `refetchInterval(rows)`
  asks again while rows are still settling.
  Its toolbar has the saved-views picker (`features/views`,
  [saved-views](saved-views.md), "In the web app").

- **Webhooks** (`features/webhooks`): managed per API client, as the API's
  `/v1/access/clients/{clientId}/webhook-endpoints` and `…/webhook-deliveries`
  routes are (`Access.manageClients`, WEBHOOKS and API_CLIENTS on).
  `/webhooks` picks the client, `/webhooks/{clientId}` lists its endpoints,
  `/webhooks/{clientId}/{id}` is one endpoint with its paged deliveries. The
  signing secret (create, rotate) is shown once in a dialog and kept in no
  cache (`gcTime: 0`, reset on close). A delivery's payload, headers and the
  receiver's response are remote text: rendered in `<pre>`, never as markup.
  The deliveries are a `ListPage` (`subject="WebhookDelivery"`, described by
  `GET /v1/lists/WebhookDelivery`): the route's `{clientId}` is filled by
  `pathParams`, the endpoint is a fixed `query={{ endpointId }}`, and the
  filters (status, event type, attempts, creation time) and numbered pages
  (`page`, as every `ListPage`; the route also takes a cursor) come from the
  description. Its rows are polled every 3 s while one is `pending`
  (`refetchInterval`), and a retry or a test event refreshes the list.

  `/webhooks/senders` (`Access.manageClients`, linked from `/webhooks`) manages the
  tenant's incoming-webhook senders (`/v1/webhook-senders`): create, describe,
  switch off, rotate the secret, delete. Create and rotate show the secret once
  in the same dialog (no cache keeps it), and each row has a copyable receiver
  URL (the API's `path` on the web app's origin).

- **Operations** (`features/ops`, `/ops`): the `/v1/ops/*` routes
  ([webhooks-and-realtime](webhooks-and-realtime.md), "Ops"), for users acting
  in the operator tenant (`me.tenant.operator`, either tenancy) who hold
  `Ops.view`; any other gets a not-found page and no request. They
  authenticate with the session cookie like every route (no separate token),
  so nothing secret is in the bundle. Three tabs, only the open one mounted:
  queues (counts, latest failures, retry failed), the outbox (counters, lag,
  dead letters: requeue and purge, one or all, behind a confirmation dialog;
  `Ops.manage`) and the live log. The log is the browser's `EventSource` on
  `GET /v1/ops/events` (same-origin, so the cookie rides along; Caddy flushes
  `text/event-stream` as it comes): closed on pause, on leaving the tab and on
  unmount, capped at 200 events (newest first), details shown as text. The
  browser reconnects a dropped stream itself; a refusal ends it
  ("Disconnected"). The routes' bodies are typed by the generated client
  (`GetResponse` and `operations` of `@nestjs-monorepo-template/api-client`,
  re-exported from `features/ops/queries.ts`); an event is a union by `source`
  (the engine), then `type`. Tests fake
  `EventSource` (`features/ops/ops.test.tsx`).

### Languages

`src/locales/<lng>/<ns>.json` for the API's five locales (`en`, `de`, `ar`,
`zh`, `ms`); every file is the namespace `<ns>` (loaded eagerly,
`import.meta.glob` in `i18n.ts`). A feature's texts:
`locales/<lng>/<feature>.json`, used with `useTranslation('<feature>')`;
`common` is the default; `nav` holds the group titles. A key missing in a
language falls back to `en`. `en` is complete; `de` (formal "Sie"), `ar`
(Modern Standard Arabic), `zh` (Simplified Chinese, informal "你") and `ms`
are translated, and a native speaker should review them. Words that are
loanwords in a language (Status, Team, Dashboard, Tag, Edit, Import, Format),
product terms, codes and brand names stay as in `en`. The texts of a new
feature (`pnpm feature:add`) start as English copies in every language: translate
them in `locales/<lng>/<feature>.json` with the other new keys, keeping the
`{{placeholders}}` and plural suffixes (`src/locales.test.ts` checks them; `ar`
has all six plural forms). `<html lang>` and `dir` (`rtl` for `ar`) follow the language; the
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

**Rich text** (`components/markdown/`): neither Dice UI nor shadcn's registry
has a Markdown editor, so the web app uses [Tiptap](https://tiptap.dev) (with
its official `@tiptap/markdown`) for editing and `react-markdown` for reading.
A rich text value is a Markdown string in the API's existing text field: no
API change, and a body written as plain text is already valid Markdown. Both
are lazy (`components/markdown/lazy.tsx`: `MarkdownText`, `LazyMarkdownEditor`,
the form field `MarkdownField`), so the main bundle does not grow. The viewer
is XSS-safe by construction: it builds React elements (never an HTML string),
HTML in the text is shown as text, images are not rendered, and only `http(s)`
and `mailto` links survive (`safe-url.ts`, shared with the editor's link
button), each `rel="noopener noreferrer"`. Notes use it when the
`notes.richText` flag ([settings](settings.md)) is on (`useRichText()` in
`features/notes/use-rich-text.ts`, on the generic `useFlag(key)` of
`features/settings/use-flag.ts`); off, the body stays a plain textarea and
plain text. A body the editor cannot keep whole (a `<name>` placeholder, an
image, raw HTML: ProseMirror's schema has no place for them) is checked when the
form opens, by parsing and writing it back, and edited in the plain textarea
with a notice instead, so opening a note never loses text. The form keeps the
control it opened with if the flag changes meanwhile. In tests, `src/test/setup.ts` gives jsdom the range boxes
ProseMirror asks for.

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
  `features/custom-fields`: its subject picker is
  `GET /v1/custom-fields/subjects` (each subject named by the API in the UI's
  language), so a feature that takes custom fields registers nothing in the
  web app. The account data export on `/account/privacy` lists
  `GET /v1/account/exports` (polled while one runs, refreshed after a
  request), not a list kept in the browser.
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
  held to its `attachmentLimits` (size, types). With
  `presignedUploads` on (`GET /v1/features`, `STORAGE_DRIVER=s3`) the
  dropzone sends files straight to the bucket (`uploadAttachment()` in
  `panels/api.ts`: presign, a PUT with progress, complete) and falls back to the
  API's multipart upload when the bucket cannot be reached
  ([attachments](attachments.md#direct-uploads-s3)). @mentions search
  `GET /v1/people?q=` (any member): the box shows the name (`@Maya Patel`),
  the body sent has `@user:<id>` (`comment-draft.ts`; an edit shows the
  names again), and a comment shows a mention by name from `mentionNames`,
  else from `GET /v1/people?key=` (the author's own mention, or someone who
  may not read the record, has no entry); authors are the
  API's `authorName` and `changedByName`. Comments and files reload on the
  realtime events `record.commented` and `record.attachments.changed`
  (polled only without realtime). A file whose malware scan is not done
  (`scanStatus: 'pending'`, [attachments](attachments.md)) shows a
  "Scanning…" badge and a disabled download (the API answers 409
  `attachment_scan_pending`); the list is read again on the `scanned` event
  and the download link appears. The scan acts as the system principal, so
  the event reaches only the record's watchers: while a file is pending the
  list is also read every 10 s with a connected socket (5 s without), for an
  uploader who does not watch the record. An image (`renditionStatus`) shows
  its `thumb` in the row, sized from `renditions.thumb` (`attachment-visual.tsx`),
  and opens its `preview` in a dialog with the original one click away; a
  placeholder stands in while the renditions are `pending`, and the file icon
  for an image that `failed`, is not processed, or whose thumbnail does not
  load. The worker acts as the system principal too, so the `processed` event
  reaches only the watchers: a `pending` image is polled like a pending scan.
  Thumbnails are an `<img>` on `GET /v1/attachments/{id}/download?rendition=thumb`,
  which redirects to the disk's signed link: that link's origin must be one
  the page may load images from (the dev proxy above; under Caddy the app's
  own origin with the local disk, the bucket's with S3, which Caddy derives
  from the S3 settings: [deployment](deployment.md), "The origins of files").
  An infected file is deleted by the
  API, so there is no rejected row: it leaves the list on `removed` or, for
  its uploader, when the `attachment.rejected` notification arrives (a toast
  shows its text and the list is read again). Texts are in the `records`
  namespace. Pass `canUpdate` (the record's own `can.update`) when the page
  has it: the panels' writes take the record's PATCH check, conditions
  included. Tests:
  `usePanelsApi()` (`test/panels-api.ts`) serves the panels' routes for a
  test-only subject; a feature's test description spreads
  `panelsDescription()`.

- **Watching** (`components/records/watch-button.tsx`, `features/watching`):
  `<WatchButton subject path id watching onToggled />` in a record page's
  header is the Watch / Stop watching toggle, shown only when the subject's
  `capabilities.watch` is true, the user may read the record and the record
  says `watching`; it calls the record's `POST`/`DELETE …/watch`. The page
  reads the record with `?include=can,watching` (only for a feature with the
  `watch` capability: any other answers 400; `features/notes/api.ts` is the
  example) and passes `note.watching`, so no `GET /v1/subscriptions` is made;
  `onToggled` sets the new `watching` on the page's cached record
  (`setNoteWatching`), and a stop from the list invalidates the cached
  records. A create seeds `watching: true` (the owner watches from the start).
  `/account/watching` lists
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
  `/transfers` lists the caller's exports, imports and bulk runs from the API
  (`GET /v1/data/transfers`, `GET /v1/bulk`: any device, scheduled reports
  included; nothing is kept in the browser) and their account exports across
  tenants (`GET /v1/account/exports`, the query the account page's export
  section shares). The kind and the status are filters the API applies; each
  row says when it started, finished and is kept until (`createdAt`,
  `finishedAt`, `expiresAt`), and once `expiresAt` has passed it offers no
  link. A filtered page can come back empty with a next cursor: "Show more"
  stays. `/reports` lists the scheduled reports (`REPORTS=off` hides it).
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
- **Timing** (`vitest.config.ts`, `src/test/setup.ts`): `maxWorkers: '50%'` (`'100%'` when `CI` is set: CI's web job
  runs this package alone),
  because `pnpm test` runs every package's Vitest at once; `testTimeout`
  15 s and Testing Library's `asyncUtilTimeout` 3 s, headroom for a loaded
  machine; `fsModuleCache: false`, since Vitest's module cache kept stale
  `import.meta.glob` results (the nav and the locales). The setup also stubs
  what jsdom lacks (`matchMedia`, pointer capture, `ResizeObserver`,
  `scrollIntoView`) and dismisses toasts between tests.

### Developer tooling: Storybook, the bundle budget, Lighthouse

CI runs these in `.github/workflows/web.yml` (pull requests touching
`apps/web` or `packages/`, and `main`).

- **Storybook** (`packages/ui`, Vite + React, set up with `storybook init`):
  `pnpm --filter @nestjs-monorepo-template/ui storybook` serves it on
  http://localhost:6006; `build-storybook` writes `storybook-static/`
  (a Turborepo task; CI publishes it as the `storybook` workflow artifact).
  `.storybook/preview.tsx` loads `globals.css`, so the stories wear the app's
  Tailwind theme, and adds toolbar switches for light/dark (the `.dark` class)
  and LTR/RTL (`dir` plus `DirectionProvider`); the a11y addon checks each
  story. A story sits next to its component (`button.stories.tsx`); the
  set is representative, add one when you add or change a component.
- **Bundle budget** (`apps/web/.size-limit.json`, [size-limit](https://github.com/ai/size-limit)
  with `@size-limit/file`): `pnpm --filter @nestjs-monorepo-template/web size`
  builds the app and measures, in brotli, the entry script, the entry styles
  and all scripts. The limits sit about 10% above the measured sizes
  (entry 64.6 kB, styles 19.6 kB, all 1.01 MB at the time); over a limit, the
  job fails the pull request, and its summary lists every size against its
  limit. Raise a limit in the same pull request that justifies it, never to
  get past a check.
- **Lighthouse CI** (`apps/web/lighthouserc.json`, `@lhci/cli`):
  `pnpm --filter @nestjs-monorepo-template/web lighthouse` audits the built
  app (performance, accessibility, best practices). Non-blocking: assertions
  are warnings and the job has `continue-on-error`; the scores are in the job
  summary and the reports in the `lighthouse` artifact. It audits the signed-out
  shell of the static build (no API behind it). Make it blocking by changing
  `warn` to `error` once the scores are stable.

### Installable and offline (PWA)

`vite-plugin-pwa` (`apps/web/vite.config.ts`, the documented `generateSW`
setup) writes the web manifest and a Workbox service worker at build time;
`src/main.tsx` registers it (`registerType: 'prompt'`: a new version waits
until the user taps "Reload" in the toast, so no page is swapped under them).
The worker **precaches the built shell only** (scripts, styles, icons) and has
no runtime caching, so no API response (user data) is ever stored by it;
navigations fall back to the shell except for the paths Caddy sends to the API
(`apps/web/pwa-paths.ts`: `/v1`, `/health`, `/metrics`, `/api`, `/api-json`,
`/api-yaml`, `/files`, `/socket.io`, `/.well-known`; a test keeps it in step
with the Caddyfile's `@api` matcher, so an export or attachment link reaches
the server). It is not active under `pnpm dev`.

- **Icons** are generated from `public/favicon.svg`: `pnpm --filter
  @nestjs-monorepo-template/web pwa:icons` (`@vite-pwa/assets-generator`,
  `pwa-assets.config.ts`). Name, colours: the `manifest` in `vite.config.ts`.
- **Install**: the user menu (`NavUser`) shows "Install the app" while the
  browser offers it (`beforeinstallprompt`, `src/lib/pwa.ts`, listened for
  from the first page load: the browser fires it once, before the menu
  exists); Safari and Firefox never do, there the user adds it from the
  browser's menu.
- **Offline banner** (`OfflineBanner`, in the `_app` layout): shown when
  `navigator.onLine` is false, or online with the realtime socket dropped.
- Strings: the `pwa` namespace, in all five languages.

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
   ([its README](https://github.com/lamberto15/nestjs-monorepo-template/blob/main/packages/api-client/README.md)):

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
