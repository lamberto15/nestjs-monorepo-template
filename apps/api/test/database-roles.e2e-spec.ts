import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { inject } from 'vitest';
import {
  ensureAppRole,
  ensureMonitorRole,
} from '../src/core/database/roles.js';
import { databaseUrl } from './global-setup.js';
import { testDatabase } from './support.js';

/**
 * The database role api and worker connect as (docs/deployment.md, "Database
 * roles"), which every test of this suite exercises: it can do the app's
 * work, and nothing that would undo row-level security. The owner made it
 * through `migrateAll()` (global-setup.ts), as `node dist/migrate` does on a
 * deploy, from an owner that is no superuser.
 */
describe('the app role', () => {
  let database: Awaited<ReturnType<typeof testDatabase>>;
  let app: Client;
  beforeAll(async () => {
    database = await testDatabase();
    app = new Client({ connectionString: database.url });
    await app.connect();
  });
  afterAll(async () => {
    await app.end();
    await database.close();
  });

  /**
   * The SQLSTATE a statement fails with, as the app role: in a transaction of
   * its own, so a failure leaves the session usable, except for the few
   * statements PostgreSQL refuses inside one (CREATE DATABASE).
   */
  async function refused(statement: string) {
    const inTransaction = !/^create database/i.test(statement);
    if (inTransaction) {
      await app.query('begin');
    }
    try {
      await app.query(statement);
      return 'allowed';
    } catch (error) {
      return (error as { code?: string }).code;
    } finally {
      if (inTransaction) {
        await app.query('rollback');
      }
    }
  }
  const INSUFFICIENT_PRIVILEGE = '42501';

  it('is no superuser and bypasses no row-level security', async () => {
    const { rows } = await app.query(
      `select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit, rolcanlogin
       from pg_roles where rolname = current_user`,
    );
    expect(rows).toEqual([
      {
        rolsuper: false,
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolreplication: false,
        rolinherit: true,
        rolcanlogin: true,
      },
    ]);
  });

  it('owns nothing: the tables, sequences and schemas are the owner’s', async () => {
    const owned = await app.query(
      `select
         (select count(*) from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = current_user)::int as relations,
         (select count(*) from pg_namespace n join pg_roles r on r.oid = n.nspowner where r.rolname = current_user)::int as schemas,
         (select count(*) from pg_database d join pg_roles r on r.oid = d.datdba where r.rolname = current_user)::int as databases`,
    );
    expect(owned.rows[0]).toEqual({ relations: 0, schemas: 0, databases: 0 });
    // Every application table has the one owner, and it isn't this role.
    const owners = await app.query<{ rolname: string }>(
      `select distinct r.rolname from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_roles r on r.oid = c.relowner
       where c.relkind in ('r', 'p', 'S') and n.nspname in ('public', 'nest_outbox', 'nest_workflows', 'nest_webhooks')`,
    );
    expect(owners.rows).toHaveLength(1);
    expect(owners.rows[0].rolname).toMatch(/^owner_/);
  });

  it('cannot change the schema, the roles or its own attributes', async () => {
    expect(await refused('create table smuggled (id int)')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await refused('create schema smuggled')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await refused('alter table app_secrets add column smuggled int'),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refused('drop table app_secrets')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await refused('create index smuggled on app_secrets (value)')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await refused('truncate app_secrets')).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refused('alter table notes disable row level security')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await refused('create role smuggled')).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await refused('alter role current_user bypassrls')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await refused('create database smuggled')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await refused('create extension if not exists pgcrypto')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await refused("select set_config('log_statement', 'all', true)"),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('does the app’s work: rows, sequences, advisory locks, transaction settings', async () => {
    await app.query('begin');
    try {
      await app.query(
        `insert into app_secrets (name, value) values ('roles-test', 'x')`,
      );
      await app.query(
        `update app_secrets set value = 'y' where name = 'roles-test'`,
      );
      const read = await app.query(
        `select value from app_secrets where name = 'roles-test'`,
      );
      expect(read.rows).toEqual([{ value: 'y' }]);
      await app.query(`delete from app_secrets where name = 'roles-test'`);
      // The locks' fencing tokens, and identity columns (mfa_failures).
      const token = await app.query(
        `select nextval('locks_fencing_token_seq')::int as token`,
      );
      expect(token.rows[0].token).toBeGreaterThan(0);
      // What the seeder, the tree and the stores take, and what RLS (1a) will read.
      await app.query(`select pg_advisory_xact_lock(hashtext('roles-test'))`);
      const setting = await app.query(
        `select set_config('app.tenant_id', 'tenant-1', true) as set,
                current_setting('app.tenant_id', true) as value`,
      );
      expect(setting.rows[0]).toEqual({ set: 'tenant-1', value: 'tenant-1' });
    } finally {
      await app.query('rollback');
    }
    // The stores read their schema version before serving.
    for (const schema of ['nest_outbox', 'nest_workflows', 'nest_webhooks']) {
      const version = await app.query(
        `select max(version)::int as version from ${schema}.migrations`,
      );
      expect(version.rows[0].version).toBeGreaterThanOrEqual(1);
    }
  });

  it('reads and writes a table the owner adds later (default privileges)', async () => {
    await database.asOwner(
      'create table added_later (id integer generated always as identity primary key, name text not null)',
    );
    await app.query(`insert into added_later (name) values ('later')`);
    const { rows } = await app.query(`select id, name from added_later`);
    expect(rows).toEqual([{ id: 1, name: 'later' }]);
    expect(await refused('alter table added_later add column x int')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('is bootstrapped again without changes (every deploy runs it)', async () => {
    const lines: string[] = [];
    await ensureAppRole(
      { ownerUrl: database.ownerUrl, appUrl: database.url },
      (line) => lines.push(line),
    );
    expect(lines.at(-1)).toMatch(/^App role "app_[0-9a-f]+" checked: /);
    expect(lines.at(-1)).not.toContain('password set');
  });

  it('refuses a URL pair that names one role for both', async () => {
    await expect(
      ensureAppRole({ ownerUrl: database.ownerUrl, appUrl: database.ownerUrl }),
    ).rejects.toThrow(/both connect as/);
  });

  /** The server's superuser (the test container's, CI's POSTGRES_USER), on this test's database. */
  async function asAdmin(statement: string) {
    const admin = new Client({
      connectionString: databaseUrl(
        inject('postgresUrl'),
        new URL(database.url).pathname.slice(1),
      ),
    });
    await admin.connect();
    try {
      await admin.query(statement);
    } finally {
      await admin.end();
    }
  }
  const bootstrap = (appUrl = database.url) =>
    ensureAppRole({ ownerUrl: database.ownerUrl, appUrl });
  const appRole = () => decodeURIComponent(new URL(database.url).username);

  it('refuses the role once it is a member of another (that role’s rights would be its own)', async () => {
    // A role of the owner's making (CREATEROLE gives ADMIN on it), as
    // `GRANT owner TO app` would: the flags all stay false.
    const other = `member_${randomUUID().slice(0, 8)}`;
    await database.asOwner(`create role "${other}"`);
    try {
      await database.asOwner(`grant "${other}" to "${appRole()}"`);
      await expect(bootstrap()).rejects.toThrow(
        new RegExp(
          `is a member of "${other}".*run REVOKE "${other}" FROM "${appRole()}"`,
        ),
      );
      await database.asOwner(`revoke "${other}" from "${appRole()}"`);
      await bootstrap();
    } finally {
      await database.asOwner(`drop role if exists "${other}"`);
    }
  });

  it('refuses a table it can only read (every DML privilege, not any one)', async () => {
    // A table another role owns, on which the owner may pass on SELECT alone:
    // its GRANT ON ALL TABLES then grants the app SELECT (a warning, "not all
    // privileges were granted"), so only the check can catch it.
    const other = `other_${randomUUID().slice(0, 8)}`;
    const owner = decodeURIComponent(new URL(database.ownerUrl).username);
    await asAdmin(`create role "${other}"`);
    try {
      await asAdmin(
        `create table partly_readable (id int); alter table partly_readable owner to "${other}";
         grant select on partly_readable to "${owner}" with grant option`,
      );
      await expect(bootstrap()).rejects.toThrow(
        /can't use public\.partly_readable/,
      );
    } finally {
      await asAdmin(
        `drop table if exists partly_readable; drop role "${other}"`,
      );
    }
  });

  it('grants nothing in a schema the app doesn’t use', async () => {
    const schema = `unrelated_${randomUUID().slice(0, 8)}`;
    await database.asOwner(
      `create schema "${schema}"; create table "${schema}".secrets (id int)`,
    );
    await bootstrap();
    // By oid: without USAGE the app can't even name the table.
    const { rows } = await database.db.execute<{
      usage: boolean;
      select: boolean;
    }>(
      `select has_schema_privilege(current_user, n.oid, 'USAGE') as usage,
              has_table_privilege(current_user, c.oid, 'SELECT') as select
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = '${schema}' and c.relname = 'secrets'`,
    );
    expect(rows).toEqual([{ usage: false, select: false }]);
  });

  it('names the REVOKE when PUBLIC may CREATE in public (databases from PostgreSQL 14 and older)', async () => {
    await database.asOwner('grant create on schema public to public');
    try {
      await expect(bootstrap()).rejects.toThrow(
        /PUBLIC has CREATE there\): run REVOKE CREATE ON SCHEMA "public" FROM PUBLIC/,
      );
    } finally {
      await database.asOwner('revoke create on schema public from public');
    }
    await bootstrap();
  });

  it('refuses a role made with BYPASSRLS, with the ALTER ROLE that fixes it', async () => {
    const bad = `bad_${randomUUID().slice(0, 8)}`;
    await asAdmin(`create role "${bad}" login bypassrls createdb`);
    try {
      const url = new URL(database.url);
      url.username = bad;
      await expect(bootstrap(url.toString())).rejects.toThrow(
        new RegExp(`ALTER ROLE "${bad}" NOBYPASSRLS NOCREATEDB`),
      );
    } finally {
      await asAdmin(`drop role "${bad}"`);
    }
  });

  it('sets a rotated password (the server checks passwords: scram-sha-256) and the old one is refused', async () => {
    // A role of its own: the run's app role keeps its password.
    const rotated = `rotated_${randomUUID().slice(0, 8)}`;
    const url = (password: string) => {
      const parsed = new URL(database.url);
      parsed.username = rotated;
      parsed.password = password;
      return parsed.toString();
    };
    const first = randomBytes(12).toString('hex');
    const second = randomBytes(12).toString('hex');
    const connects = async (connectionString: string) => {
      const client = new Client({ connectionString });
      try {
        await client.connect();
        return 'connected';
      } catch (error) {
        return (error as { code?: string }).code;
      } finally {
        await client.end().catch(() => undefined);
      }
    };
    try {
      const lines: string[] = [];
      await ensureAppRole(
        { ownerUrl: database.ownerUrl, appUrl: url(first) },
        (line) => lines.push(line),
      );
      expect(lines.at(-1)).toMatch(/created: /);
      expect(await connects(url(first))).toBe('connected');
      expect(await connects(url(second))).toBe('28P01');
      lines.length = 0;
      await ensureAppRole(
        { ownerUrl: database.ownerUrl, appUrl: url(second) },
        (line) => lines.push(line),
      );
      expect(lines.at(-1)).toMatch(/checked, password set: /);
      expect(await connects(url(second))).toBe('connected');
      expect(await connects(url(first))).toBe('28P01');
    } finally {
      // DROP OWNED revokes what this database granted it (default privileges too).
      await asAdmin(`drop owned by "${rotated}"; drop role "${rotated}"`);
    }
  });

  /**
   * The PostgreSQL exporter's role (compose.monitoring.yaml): pg_monitor and
   * nothing else, made by the same bootstrap as the app role, from an owner
   * that is no superuser (it holds pg_monitor WITH ADMIN OPTION, as a managed
   * admin would: global-setup.ts).
   */
  describe('the monitoring role', () => {
    const monitor = `monitor_${randomUUID().slice(0, 8)}`;
    const password = randomBytes(12).toString('hex');
    const monitorUrl = (secret = password) => {
      const url = new URL(database.ownerUrl);
      url.username = monitor;
      url.password = secret;
      return url.toString();
    };
    const asMonitor = async <T>(fn: (client: Client) => Promise<T>) => {
      const client = new Client({ connectionString: monitorUrl() });
      await client.connect();
      try {
        return await fn(client);
      } finally {
        await client.end();
      }
    };
    const lines: string[] = [];
    const bootstrap = (role = monitor, secret = password) =>
      ensureMonitorRole(database.ownerUrl, { role, password: secret }, (line) =>
        lines.push(line),
      );
    afterAll(async () => {
      await asAdmin(
        `drop owned by "${monitor}"; drop role if exists "${monitor}"`,
      );
    });

    it('is created with pg_monitor only, owning nothing, reading statistics and never a row', async () => {
      await bootstrap();
      expect(lines.at(-1)).toMatch(
        new RegExp(`^Monitor role "${monitor}" created: pg_monitor only`),
      );
      const memberships = await database.db.execute<{ rolname: string }>(
        `select r.rolname from pg_auth_members m join pg_roles r on r.oid = m.roleid
         where m.member = '${monitor}'::regrole order by 1`,
      );
      expect(memberships.rows).toEqual([{ rolname: 'pg_monitor' }]);
      await asMonitor(async (client) => {
        const { rows } = await client.query(
          `select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolcanlogin
           from pg_roles where rolname = current_user`,
        );
        expect(rows).toEqual([
          {
            rolsuper: false,
            rolbypassrls: false,
            rolcreatedb: false,
            rolcreaterole: false,
            rolreplication: false,
            rolcanlogin: true,
          },
        ]);
        // What the exporter reads: pg_stat_* and the settings, of every database.
        const stats = await client.query(
          `select numbackends from pg_stat_database where datname = current_database()`,
        );
        expect(stats.rows).toHaveLength(1);
        const settings = await client.query(
          `select setting from pg_settings where name = 'max_connections'`,
        );
        expect(Number(settings.rows[0].setting)).toBeGreaterThan(0);
        // Never a row, nor the schema.
        const refused = async (statement: string) => {
          await client.query('begin');
          try {
            await client.query(statement);
            return 'allowed';
          } catch (error) {
            return (error as { code?: string }).code;
          } finally {
            await client.query('rollback');
          }
        };
        expect(await refused('select 1 from users')).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect(await refused('select 1 from app_secrets')).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect(await refused('select 1 from nest_outbox.migrations')).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect(await refused('create table smuggled (id int)')).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
        expect(await refused(`alter role current_user bypassrls`)).toBe(
          INSUFFICIENT_PRIVILEGE,
        );
      });
    });

    it('is bootstrapped again without changes, and a rotated password is set', async () => {
      lines.length = 0;
      await bootstrap();
      expect(lines.at(-1)).toMatch(/checked: pg_monitor only/);
      expect(lines.at(-1)).not.toContain('password set');
      const rotated = randomBytes(12).toString('hex');
      lines.length = 0;
      await bootstrap(monitor, rotated);
      expect(lines.at(-1)).toMatch(/checked, password set: pg_monitor only/);
      const client = new Client({ connectionString: monitorUrl(rotated) });
      await client.connect();
      await client.end();
      // Back to the suite's password for the tests that follow.
      await bootstrap();
    });

    it('refuses a role that is a member of more than pg_monitor, or that may read the tables', async () => {
      const other = `member_${randomUUID().slice(0, 8)}`;
      await database.asOwner(`create role "${other}"`);
      try {
        await database.asOwner(`grant "${other}" to "${monitor}"`);
        await expect(bootstrap()).rejects.toThrow(
          new RegExp(
            `is a member of "${other}" besides pg_monitor: run REVOKE "${other}" FROM "${monitor}"`,
          ),
        );
        await database.asOwner(`revoke "${other}" from "${monitor}"`);
      } finally {
        await database.asOwner(`drop role if exists "${other}"`);
      }
      await database.asOwner(`grant select on users to "${monitor}"`);
      try {
        await expect(bootstrap()).rejects.toThrow(
          /can read or write public\.users/,
        );
      } finally {
        await database.asOwner(`revoke select on users from "${monitor}"`);
      }
      await bootstrap();
      // Never the owner itself.
      const owner = decodeURIComponent(new URL(database.ownerUrl).username);
      await expect(bootstrap(owner)).rejects.toThrow(/names the owner/);
    });
  });
});
