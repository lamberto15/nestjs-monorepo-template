# The monorepo

One repository, one lockfile: a [pnpm workspace](https://pnpm.io/workspaces)
whose tasks [Turborepo](https://turborepo.dev) runs. The layout is in
[architecture](architecture.md), "The repository".

| Package | Where | What |
| --- | --- | --- |
| `@nestjs-monorepo-template/api` | `apps/api` | the NestJS app (API, workers, migrations) |
| `@nestjs-monorepo-template/api-client` | `packages/api-client` | the typed client, for frontends and scripts |
| `@nestjs-monorepo-template/web` | `apps/web` | the web app: React, Vite, TanStack Router and Query |
| `@nestjs-monorepo-template/ui` | `packages/ui` | shared components: shadcn/ui (Base UI) and Dice UI, as source |
| the root (`nestjs-monorepo-template`) | `.` | the scripts, tooling (Turborepo, oxlint, Prettier), Compose, docs |

## Commands

Run everything from the root. The root's scripts keep their names; each hands
its work to the packages:

| Root script | Runs |
| --- | --- |
| `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm test:e2e` | `turbo run <task>`: the task in every package that has it, dependencies first |
| `pnpm dev`, `pnpm dev:api`, `pnpm dev:web` | `turbo run dev --env-mode=loose` in every app, or `--filter` one: the API's `nest start --watch` and the web's `vite` (the client builds first) |
| `pnpm start:dev`, `pnpm start:debug`, `pnpm db:*`, `pnpm migrate`, `pnpm openapi:dump` | `pnpm --filter @nestjs-monorepo-template/api <script>`, in `apps/api` |
| `pnpm client:generate`, `pnpm client:check` | the API's dump, then the client's generator |
| `pnpm changeset`, `pnpm client:publish`, `pnpm release:notes` | the client's changesets and its publish (CI's), a template release's notes ([releases](releases.md)) |
| `pnpm services:up` / `services:down`, `pnpm format` | at the root |
| `pnpm setup`, `pnpm feature:add` / `feature:sync` / `feature:remove`, `pnpm deploy:rolling` / `deploy:blue-green` / `deploy:swarm` | Node scripts in `tools/` (the first-run wizard, the feature generator, the zero-downtime deploys) |

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

| Task | Before it | Cached |
| --- | --- | --- |
| `build` | the dependencies' `build` (`^build`) | `dist/**`; tests and docs don't change its hash |
| `lint` | `^build` (the API's tests read the client's types) | yes |
| `test` | `^build` | yes |
| `test:e2e` | `^build` (the API's e2e imports the built client) | no: it needs Docker or the services |
| `dev` | `^build` (the apps run on the built client) | no: persistent, it runs until stopped |

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

`apps/web` is a React single-page app; `packages/ui` holds its components.
`pnpm dev` runs the API and the app (http://localhost:5173) side by side;
`pnpm dev:api` or `pnpm dev:web` runs one.

- **Stack:** Vite, TanStack Router (file routes in `src/routes`, code
  splitting, `routeTree.gen.ts` written by its Vite plugin and committed),
  TanStack Query, nuqs (URL state), react-i18next, Tailwind 4, zod.
- **Calls the API** through `src/lib/api.ts`, the typed client with `baseUrl:
  ''` and `credentials: 'include'`. `server.proxy` in `vite.config.ts` sends
  `/v1`, `/health` and `/socket.io` (`ws: true`) to `http://localhost:3000`, so
  the API is same-origin (the `__Host-sid` cookie needs it).
- **Routes:** `__root.tsx` (router context `{ queryClient, session }`),
  `_app.tsx` (the signed-in layout, shadcn's `sidebar-07` block), `_app/index.tsx`
  (dashboard), `sign-in.tsx`. A new page is a file there; its menu entry is
  `features/<feature>/nav.ts` (default export: `group`, `order`, `to`, an
  i18n `label`, `icon`, optional `feature` and `permission`). `src/nav.ts`
  collects them (`import.meta.glob`) into the groups `workspace`,
  `administration`, `operators` (sorted by `order`; a group with nothing
  visible is hidden), so a feature never edits a shared file.
- **Languages:** `src/locales/<lng>/<ns>.json` for the API's five locales; every
  file is the namespace `<ns>` (loaded eagerly, `import.meta.glob` in `i18n.ts`).
  A feature's texts: `locales/<lng>/<feature>.json`, used with
  `useTranslation('<feature>')`; `common` is the default; `nav` holds the group
  titles. A key missing in a language falls back to `en`.
  `en` is complete; the others are copies of it until translated. `<html lang>`
  and `dir` (`rtl` for `ar`) follow the language; the theme (light, dark,
  system) is a class on `<html>`.
- **Components** come from the CLIs, never by hand: run them in `apps/web`
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
- **Record panels** (`components/records/panels/`): comments with
  @mentions, attachments, tags and revisions on a record's detail page. A
  feature mounts them with one element, each panel shown only when the
  feature keeps it and the user may read the record (writes need
  `<Subject>.update`):

  ```tsx
  <RecordPanels subject="Note" path="/v1/notes/{id}" id={note.id}
    capabilities={{ comments: true, attachments: true, tags: true, revisions: true }}
    tags={note.tags} />
  ```

  The API does not publish a record's capabilities, so the page states
  them. Texts are in the `records` namespace. Pass `canUpdate` (the record's
  own `can.update`) when the page has it: the panels' writes take the
  record's PATCH check, conditions included.
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
  user's id (`kind="user" active` for a delegate). `principalDirectoryQuery()`
  reads them all to name ids (comment authors, mentions, a setting's
  overrides). The route answers only callers who may list users or clients;
  for anyone else the picker says so and the directory is empty. In tests,
  `principalsHandler()` (`test/principals.ts`) answers it.
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
- **Scripts:** `build` (`tsc -b && vite build`, to `dist/`), `lint`, `test`
  (Vitest, jsdom, Testing Library). Turborepo builds the client first.
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
   import { createApiClient, unwrap } from '@nestjs-monorepo-template/api-client';

   const api = createApiClient({ baseUrl: '', credentials: 'include' });
   const note = await unwrap(api.GET('/v1/notes/{id}', { params: { path: { id } } }));
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
