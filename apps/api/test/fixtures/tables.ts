/**
 * The test-only features' tables: their own migrations (test/fixtures/drizzle,
 * `pnpm db:generate:fixtures`), applied to the tests' template database only
 * (global-setup.ts), never to an app's.
 */
export * from './test-items/test-items.tables.js';
export * from './encrypted/encrypted-fixture.tables.js';
