import { defineConfig } from 'drizzle-kit';

/**
 * Migrations come from the schema, never by hand: change a *.tables.ts file (merged in src/schema.ts),
 * run `pnpm db:generate`, review and commit the files it writes to drizzle/.
 * Paths are relative to this app (apps/api): the root's `pnpm db:*` scripts run here.
 * The app applies pending migrations at startup (createDatabase()).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  // For `pnpm db:studio` (generate and check don't connect): the development
  // database of `pnpm services:up`, as its owner, or STUDIO_DATABASE_URL on
  // purpose. Never DATABASE_URL: drizzle-kit loads a .env by itself, and
  // production's (the repository root's) must never be the one it touches.
  dbCredentials: {
    url:
      process.env.STUDIO_DATABASE_URL ||
      'postgres://app:app@127.0.0.1:5432/app',
  },
});
