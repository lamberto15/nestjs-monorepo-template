import { sql } from 'drizzle-orm';
import type { Transaction } from '../core/database/drizzle.js';

/**
 * The demo seed runs only where both halves of a positive check say it
 * may: NODE_ENV says development (or test), and the database itself is
 * marked as a development database. app10 runs the same image as a
 * development machine, so NODE_ENV alone proves nothing; the marker is a
 * database-wide setting only a superuser can write (the app role, an
 * administrator or a SQL injection can't), which the development services
 * set when they create their database (dev/postgres/10-dev-database.sql).
 * Nothing is refused for looking like production: anything not shown to
 * be development is refused.
 */
export const DEV_DATABASE_SETTING = 'app.dev_database';

/** NODE_ENV as set, not the schema's default (an unset NODE_ENV reads as development there). */
const DEMO_NODE_ENVS = ['development', 'test'];

/** Thrown when the seed may not run here: the message says what to do. */
export class DemoSeedRefused extends Error {
  override readonly name = 'DemoSeedRefused';
}

/** Why NODE_ENV forbids the seed, or null when it allows it. */
export function nodeEnvRefusal(nodeEnv: string | undefined): string | null {
  return nodeEnv && DEMO_NODE_ENVS.includes(nodeEnv)
    ? null
    : `The demo seed runs only with NODE_ENV=development (or test); NODE_ENV is ${nodeEnv ? `"${nodeEnv}"` : 'not set'}. In development, set NODE_ENV=development in apps/api/.env.development (env.development.example has it).`;
}

/** Why the database's marker forbids the seed, or null when it allows it. */
export function markerRefusal(marked: boolean): string | null {
  return marked
    ? null
    : `This database isn't marked as a development database (${DEV_DATABASE_SETTING} = on), so the demo seed leaves it alone. The development services mark theirs when they create it; for one made before, run \`pnpm db:mark-dev\` (docs/development.md, "Demo data").`;
}

/**
 * Whether the current database carries the marker: read from the catalog
 * (pg_db_role_setting, readable by any role), not from the session, so it
 * holds whenever the connection was opened.
 */
export async function isDevDatabase(tx: Transaction): Promise<boolean> {
  // `Transaction` is typed over any driver's result; node-postgres' is `{ rows }`.
  const { rows } = (await tx.execute(sql`
    select exists (
      select 1
      from pg_db_role_setting s
      join pg_database d on d.oid = s.setdatabase
      where d.datname = current_database()
        and s.setrole = 0
        and ${`${DEV_DATABASE_SETTING}=on`} = any (s.setconfig)
    ) as marked
  `)) as unknown as { rows: { marked: boolean }[] };
  return rows[0]?.marked === true;
}
