# The monorepo

One repository, one lockfile: a [pnpm workspace](https://pnpm.io/workspaces)
whose tasks [Turborepo](https://turborepo.dev) runs. The layout is in
[architecture](architecture.md), "The repository".

| Package | Where | What |
| --- | --- | --- |
| `@nestjs-monorepo-template/api` | `apps/api` | the NestJS app (API, workers, migrations) |
| `@nestjs-monorepo-template/api-client` | `packages/api-client` | the typed client, for frontends and scripts |
| the root (`nestjs-monorepo-template`) | `.` | the scripts, tooling (Turborepo, oxlint, Prettier), Compose, docs |

## Commands

Run everything from the root. The root's scripts keep their names; each hands
its work to the packages:

| Root script | Runs |
| --- | --- |
| `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm test:e2e` | `turbo run <task>`: the task in every package that has it, dependencies first |
| `pnpm start:dev`, `pnpm db:*`, `pnpm migrate`, `pnpm openapi:dump` | `pnpm --filter @nestjs-monorepo-template/api <script>`, in `apps/api` |
| `pnpm client:generate`, `pnpm client:check` | the API's dump, then the client's generator |
| `pnpm changeset`, `pnpm client:publish`, `pnpm release:notes` | the client's changesets and its publish (CI's), a template release's notes ([releases](releases.md)) |
| `pnpm services:up` / `services:down`, `pnpm format` | at the root |

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
  `migrate`) see the whole shell.
- CI keeps the cache between runs (`actions/cache`, `.github/workflows/ci.yml`).

## Adding a frontend app

No frontend is scaffolded: the framework is the project's choice. Any of
them fits the same way.

1. **Create it in `apps/`** with its own tool (`pnpm create vite apps/web`,
   `pnpm create next-app apps/web`…). Name it `@nestjs-monorepo-template/web`
   and keep `"private": true`.
2. **Depend on the client** through the workspace, then `pnpm install`:

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
   `".next/**", "!.next/cache/**"`), and a development task:

   ```json
   "dev": { "dependsOn": ["^build"], "cache": false, "persistent": true }
   ```

   Then `pnpm turbo run dev --filter=@nestjs-monorepo-template/web` (or a
   root script for it), next to `pnpm start:dev`.
4. **Call the API** with the typed client
   ([its README](../packages/api-client/README.md)):

   ```ts
   import { createApiClient, unwrap } from '@nestjs-monorepo-template/api-client';

   const api = createApiClient({ baseUrl: '', credentials: 'include' });
   const note = await unwrap(api.GET('/v1/notes/{id}', { params: { path: { id } } }));
   ```

   Paths, parameters and answers are checked by TypeScript (`moduleResolution`
   `bundler` or `nodenext`).
5. **Origins:** in development, either a dev-server proxy (Vite:
   `server.proxy` for `/v1`, and `/socket.io` with `ws: true` for realtime,
   to `http://localhost:3000`; then `baseUrl: ''` and `createRealtime({ url:
   location.origin })`), so the API is same-origin and the session cookie
   just works; or call `http://localhost:3000` directly, with the app's origin
   in `CORS_ORIGINS` and `WEB_URL` (`apps/api/.env.development`; the example
   has `http://localhost:5173`). In production, `CORS_ORIGINS` and `WEB_URL`
   in `.env`.
6. **Keep the client current:** after a route change, `pnpm
   client:generate` (commit `packages/api-client/openapi.json` and
   `src/schema.ts`), then `pnpm build`: the frontend's type check shows what
   the change broke. A running dev server sees the client's new `dist/`
   after `pnpm --filter @nestjs-monorepo-template/api-client build`.
7. **Deploy it** on its own (its image, a static host, a platform). The
   API's image is unaffected: `pnpm deploy` takes only the API's
   dependencies.

## A checkout from before the monorepo

The app's own files moved into `apps/api`. Once, from the root:

```bash
mv .env.development apps/api/   # the development settings, if you have them
mv .data apps/api/              # local files and mail written in development, if any
pnpm install
```

The old root `dist/` is unused (delete it). The production `.env` stays at
the root, and `docker compose up -d --build` deploys as before.
