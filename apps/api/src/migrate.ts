import { secretValue } from './core/config/secret-files.js';
import { migrateAll } from './core/database/migrate-all.js';

/**
 * Brings a PostgreSQL database up to this version, once per deploy (the
 * `migrate` service of compose.prod.yaml, before the app starts): as the
 * owner (DATABASE_OWNER_URL), the app's migrations (drizzle/), then the
 * outbox's, the workflows' and the webhooks' schemas, each under an advisory
 * lock, so a second run waits and then finds nothing to do; then the app's
 * role (DATABASE_URL's, what api and worker connect as) is created or
 * checked and granted what the schema needs (docs/deployment.md, "Database
 * roles").
 *
 *   DATABASE_OWNER_URL=postgres://… DATABASE_URL=postgres://… node dist/migrate
 *   DATABASE_OWNER_URL_FILE=/run/secrets/database_owner_url \
 *     DATABASE_URL_FILE=/run/secrets/database_url node dist/migrate
 *
 * Only the two URLs, each read the way the app reads its secrets
 * (secret-files.ts): the file first, the variable as the fallback.
 */
const owner = secretValue(process.env, 'DATABASE_OWNER_URL');
const app = secretValue(process.env, 'DATABASE_URL');
const problems = [...owner.problems, ...app.problems];
for (const { variable, message } of problems) {
  console.error(`${variable}: ${message}`);
}
if (problems.length > 0 || !owner.value || !app.value) {
  if (!owner.value || !app.value) {
    console.error(
      'DATABASE_OWNER_URL (the owner, runs the migrations) and DATABASE_URL (the app role api and worker use), or their _FILE variants, are both required.',
    );
  }
  process.exit(1);
}

await migrateAll({ ownerUrl: owner.value, appUrl: app.value }, (line) =>
  console.log(line),
);
