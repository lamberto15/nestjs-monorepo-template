#!/usr/bin/env node
// The rows drizzle-orm 0.x's migrator wrote to its migrations table, one per
// migration of a commit that still has the 0.x layout (NNNN_<tag>.sql and
// meta/_journal.json): the sha256 of the file's text (hash) and the
// journal's `when` (created_at). test/migrations-upgrade.e2e-spec.ts
// rebuilds such a table and checks that Drizzle 1.0's migrator upgrades it.
// Captured once, from the last commit before `drizzle-kit up`:
//
//   node tools/db/legacy-migrations.mjs <commit> > apps/api/test/fixtures/legacy-migrations.json
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const commit = process.argv[2];
if (!/^[0-9a-f]{7,40}$/.test(commit ?? '')) {
  console.error('Usage: legacy-migrations.mjs <commit SHA>');
  process.exit(2);
}
const show = (file) =>
  execFileSync('git', ['show', `${commit}:${file}`], {
    maxBuffer: 256 * 1024 * 1024,
  });

/** As drizzle-orm 0.45's readMigrationFiles(): the file's text, hashed. */
const rows = (folder) =>
  JSON.parse(show(`${folder}/meta/_journal.json`).toString()).entries.map(
    ({ tag, when }) => ({
      tag,
      created_at: when,
      hash: createHash('sha256')
        .update(show(`${folder}/${tag}.sql`).toString())
        .digest('hex'),
    }),
  );

const full = execFileSync('git', ['rev-parse', commit], {
  encoding: 'utf8',
}).trim();
process.stdout.write(
  `${JSON.stringify(
    {
      commit: full,
      app: rows('apps/api/drizzle'),
      fixtures: rows('apps/api/test/fixtures/drizzle'),
    },
    null,
    2,
  )}\n`,
);
