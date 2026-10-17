import { defineConfig } from 'drizzle-kit';

/**
 * The test-only features' migrations (test/fixtures): generated from their
 * tables like the app's (`pnpm db:generate:fixtures`, never by hand), kept
 * apart so no app database ever gets them. global-setup.ts applies them to
 * the tests' template database after the app's (drizzle.config.ts).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './test/fixtures/tables.ts',
  out: './test/fixtures/drizzle',
});
