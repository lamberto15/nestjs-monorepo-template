# apps/web and packages/ui: agent rules

The web app (Vite, React, TanStack Router) and its components. These add to
the root [AGENTS.md](../../AGENTS.md). In depth: docs/monorepo.md, "The web
app".

- **Components:** check Dice UI first, then shadcn, before writing one; add
  it with `shadcn add` (components, blocks, `@diceui/*`), then edit only what
  the task needs.
- **Generated, never hand-written:** the scaffold (`pnpm create vite`),
  shadcn components, the router's route tree (`src/routeTree.gen.ts`) and
  the typed client (`pnpm client:generate`).
- **Tests:** `*.test.tsx` next to the code, with `renderApp()`, the msw
  handlers and `findToast()` (docs/monorepo.md, "Tests"). One file:
  `pnpm --filter @nestjs-monorepo-template/web test src/features/notes/notes.test.tsx`.
  A browser test (`apps/web-e2e`) only for a user flow the change adds or
  changes.
