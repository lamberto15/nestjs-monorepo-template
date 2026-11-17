import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client } from 'pg';
import { migrateAll } from '../src/core/database/migrate-all.js';
import { testDatabase } from './support.js';

/**
 * A database migrated by drizzle-orm 0.x, as every deployed one before
 * Drizzle 1.0: its migrations tables hold only `id`, `hash` and
 * `created_at` (the journal's `when`), one row per migration
 * (fixtures/legacy-migrations.json, captured from the last commit of the
 * 0.x layout by tools/db/legacy-migrations.mjs). The first migrate of 1.0
 * adds `name` and `applied_at`, names each row after its folder
 * (<when, to the second, UTC>_<tag without its number>) and applies nothing
 * again (docs/upgrading.md, "Drizzle 1.0").
 */
type Legacy = { tag: string; created_at: number; hash: string };
const legacy = JSON.parse(
  readFileSync(
    new URL('./fixtures/legacy-migrations.json', import.meta.url),
    'utf8',
  ),
) as { app: Legacy[]; fixtures: Legacy[] };

const FOLDERS = {
  app: fileURLToPath(new URL('../drizzle', import.meta.url)),
  fixtures: fileURLToPath(new URL('./fixtures/drizzle', import.meta.url)),
};
const TABLES = {
  app: '__drizzle_migrations',
  fixtures: '__drizzle_fixture_migrations',
};

/** The folder `drizzle-kit up` made of a 0.x migration. */
const folderOf = ({ tag, created_at }: Legacy) =>
  `${new Date(created_at)
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)}_${tag.replace(/^\d{4}_/, '')}`;

describe('migrating a database of drizzle-orm 0.x (e2e)', () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  let owner: Client;
  beforeAll(async () => {
    database = await testDatabase();
    owner = new Client({ connectionString: database.ownerUrl });
    await owner.connect();
    // The schema is in place (the template's), its migrations tables as
    // 0.x's migrator made and filled them.
    for (const which of ['app', 'fixtures'] as const) {
      const table = `drizzle."${TABLES[which]}"`;
      await owner.query(`drop table ${table}`);
      await owner.query(
        `create table ${table} (id serial primary key, hash text not null, created_at bigint)`,
      );
      for (const row of legacy[which]) {
        await owner.query(
          `insert into ${table} (hash, created_at) values ($1, $2)`,
          [row.hash, row.created_at],
        );
      }
    }
  });
  afterAll(async () => {
    await owner.end();
    await database.close();
  });

  const rows = async (which: keyof typeof TABLES) =>
    (
      await owner.query<{
        id: number;
        hash: string;
        created_at: string;
        name: string | null;
        applied_at: Date | null;
      }>(
        `select id, hash, created_at, name, applied_at from drizzle."${TABLES[which]}" order by id`,
      )
    ).rows;

  /** The deploy's migrate (node dist/migrate), then the tests' own fixtures, as global-setup.ts runs them. */
  async function migrateAsDeployed() {
    await migrateAll({
      ownerUrl: database.ownerUrl,
      appUrl: database.url,
      maintenanceUrl: database.maintenanceUrl,
    });
    const fixtures = drizzle({ connection: database.ownerUrl });
    try {
      await migrate(fixtures, {
        migrationsFolder: FOLDERS.fixtures,
        migrationsTable: TABLES.fixtures,
      });
    } finally {
      await fixtures.$client.end();
    }
  }

  it('names every row after its folder, applies nothing again, and a second run changes nothing', async () => {
    await migrateAsDeployed();
    const after = { app: await rows('app'), fixtures: await rows('fixtures') };
    for (const which of ['app', 'fixtures'] as const) {
      const folders = readdirSync(FOLDERS[which]).sort();
      // Every migration on disk is one of the rows: none is left to apply.
      expect(legacy[which].map(folderOf)).toEqual(folders);
      expect(after[which]).toEqual(
        legacy[which].map((row, i) => ({
          id: i + 1,
          hash: row.hash,
          created_at: String(row.created_at),
          name: folderOf(row),
          // The upgrade leaves it empty for the rows it backfills.
          applied_at: null,
        })),
      );
    }
    await migrateAsDeployed();
    expect({
      app: await rows('app'),
      fixtures: await rows('fixtures'),
    }).toEqual(after);
  });
});
